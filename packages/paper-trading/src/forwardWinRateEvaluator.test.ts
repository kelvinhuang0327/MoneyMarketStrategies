import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoForwardCliOverrides,
  determineForwardPromotionStatus,
  evaluateForwardWinRate,
  loadFrozenForwardIdentities,
} from "./forwardWinRateEvaluator.js";
import { wilsonLowerBound95, type WinRateV2Metrics } from "./winRateOptimizerV2.js";

const V2_ARTIFACT_PATH = resolve(process.cwd(), "packages/paper-trading/win-rate-optimizer-v2.json");
const HISTORICAL_CSV_PATH = resolve(process.cwd(), "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv");
const FRESH_HEADER = "symbol,date,open,high,low,close,volume,source";

interface FreshRow {
  readonly date: string;
  readonly close: string;
}

function freshBundle(rows: readonly FreshRow[]) {
  const csv = [
    FRESH_HEADER,
    ...rows.map(({ date, close }) => `0050,${date},${close},${close},${close},${close},1000,twse/STOCK_DAY`),
  ].join("\n") + "\n";
  const bytes = new TextEncoder().encode(csv);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    provenance: {
      schemaVersion: 1,
      artifactId: "0050-forward-v1",
      symbol: "0050",
      source: "TWSE STOCK_DAY monthly report API",
      fetchedAtUtc: "2026-09-30T05:45:03.047Z",
      dateRange: { start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null },
      rowCount: rows.length,
      sha256,
      historicalCutoff: "2026-08-11",
      purpose: "FORWARD_EVALUATION_ONLY",
    },
  };
}

function metric(wins: number, losses: number, breakevens = 0): WinRateV2Metrics {
  const completedTradeCount = wins + losses + breakevens;
  return {
    completedTradeCount,
    wins,
    losses,
    breakevens,
    rawNetWinRate: completedTradeCount === 0 ? null : wins / completedTradeCount,
    wilsonLowerBound95: wilsonLowerBound95(wins, completedTradeCount),
  };
}

async function loadV2Artifact(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(V2_ARTIFACT_PATH, "utf8")) as Record<string, unknown>;
}

describe("forward win-rate evaluator", () => {
  it("loads the checked-in V2 objective, cutoff, champion, and frozen challenger", async () => {
    const artifact = await loadV2Artifact();
    const identities = loadFrozenForwardIdentities(artifact);
    const champion = artifact["championDevelopment"] as { parameters: Record<string, unknown> };

    expect(identities).toMatchObject({
      objective: "WIN_RATE_WILSON_LOWER_BOUND_95",
      selectionPolicyVersion: "wilson-lower-bound-95-development-v1",
      historicalCutoff: "2026-08-11",
      strategyVersion: "price-band-fixed-v1",
      challengerId: artifact["FROZEN_CHALLENGER_ID"],
    });
    expect(identities.championParameters).toEqual({
      entryAtOrBelowMinor: BigInt(champion.parameters["entryAtOrBelowMinor"] as string),
      exitAtOrAboveMinor: BigInt(champion.parameters["exitAtOrAboveMinor"] as string),
      targetQuantity: champion.parameters["targetQuantity"],
    });
    expect(identities.challengerParameters).toEqual({
      entryAtOrBelowMinor: BigInt((artifact["FROZEN_PARAMETERS"] as Record<string, string>)["entryAtOrBelowMinor"]!),
      exitAtOrAboveMinor: BigInt((artifact["FROZEN_PARAMETERS"] as Record<string, string>)["exitAtOrAboveMinor"]!),
      targetQuantity: (artifact["FROZEN_PARAMETERS"] as Record<string, number>)["targetQuantity"],
    });
  });

  it("rejects cutoff-day and earlier rows as fresh evidence", async () => {
    const artifact = await loadV2Artifact();
    for (const date of ["2026-08-10", "2026-08-11"]) {
      const fresh = freshBundle([{ date, close: "100.00" }]);
      expect(() => evaluateForwardWinRate({
        frozenArtifact: artifact,
        freshDataBytes: fresh.bytes,
        freshProvenance: fresh.provenance,
      })).toThrow(/on or before the historical cutoff/);
    }
  });

  it("runs both frozen strategies over the one shared fresh row set", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([
      { date: "2026-08-12", close: "90.00" },
      { date: "2026-08-13", close: "120.00" },
      { date: "2026-08-14", close: "95.00" },
      { date: "2026-08-17", close: "130.00" },
    ]);
    const result = evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });

    expect(result.freshRowCount).toBe(4);
    expect(result.freshDataSha256).toBe(fresh.provenance.sha256);
    expect(result.champion.parameters).toEqual((artifact["championDevelopment"] as { parameters: unknown }).parameters);
    expect(result.challenger.id).toBe(artifact["FROZEN_CHALLENGER_ID"]);
    expect(result.challenger.parameters).toEqual(artifact["FROZEN_PARAMETERS"]);
    expect(result.champion.freshDataSha256).toBe(result.freshDataSha256);
    expect(result.challenger.freshDataSha256).toBe(result.freshDataSha256);
    expect(result.freshCompletedTradeCount).toEqual({
      champion: result.champion.completedTradeCount,
      challenger: result.challenger.completedTradeCount,
    });
  });

  it("does not accept strategy or data overrides that could change frozen parameters", () => {
    expect(() => assertNoForwardCliOverrides([])).not.toThrow();
    expect(() => assertNoForwardCliOverrides(["--entry-at-or-below", "9000"])).toThrow(/no strategy, data, or tuning overrides/);
  });

  it("produces an identical result for repeated runs over identical fresh input", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([
      { date: "2026-08-12", close: "90.00" },
      { date: "2026-08-13", close: "120.00" },
      { date: "2026-08-14", close: "95.00" },
      { date: "2026-08-17", close: "130.00" },
    ]);
    const input = { frozenArtifact: artifact, freshDataBytes: fresh.bytes, freshProvenance: fresh.provenance };
    expect(evaluateForwardWinRate(input)).toEqual(evaluateForwardWinRate(input));
  });

  it("uses the V2 Wilson implementation for reported scores", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([
      { date: "2026-08-12", close: "90.00" },
      { date: "2026-08-13", close: "120.00" },
      { date: "2026-08-14", close: "95.00" },
      { date: "2026-08-17", close: "130.00" },
    ]);
    const result = evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });
    expect(result.champion.wilsonLowerBound95).toBe(
      wilsonLowerBound95(result.champion.wins, result.champion.completedTradeCount),
    );
    expect(result.challenger.wilsonLowerBound95).toBe(
      wilsonLowerBound95(result.challenger.wins, result.challenger.completedTradeCount),
    );
  });

  it("promotes only when the challenger Wilson score is strictly higher", () => {
    expect(determineForwardPromotionStatus(metric(1, 0), metric(2, 0), "2026-08-12", "2026-08-11"))
      .toBe("PROMOTE");
    expect(determineForwardPromotionStatus(metric(2, 0), metric(2, 0), "2026-08-12", "2026-08-11"))
      .toBe("NO_PROMOTION");
  });

  it("returns insufficient fresh trades when either strategy has no completed trade", () => {
    expect(determineForwardPromotionStatus(metric(0, 0), metric(1, 0), "2026-08-12", "2026-08-11"))
      .toBe("INSUFFICIENT_FRESH_TRADES");
    expect(determineForwardPromotionStatus(metric(1, 0), metric(0, 0), "2026-08-12", "2026-08-11"))
      .toBe("INSUFFICIENT_FRESH_TRADES");
  });

  it("keeps the frozen challenger identity independent of historical candidate-grid evidence", async () => {
    const artifact = await loadV2Artifact();
    const original = loadFrozenForwardIdentities(artifact);
    const championDevelopment = artifact["championDevelopment"] as Record<string, unknown>;
    const changedHistoricalDevelopment = {
      ...artifact,
      inputSha256: "f".repeat(64),
      FROZEN_SELECTION_INPUT_SHA256: "f".repeat(64),
      candidateGrid: [{ id: "changed-historical-candidate", developmentCompletedTradeCount: 99 }],
      rankedDevelopmentCandidateIds: ["changed-historical-candidate"],
      developmentBoundary: { startRow: 1, endRow: 2, rowCount: 2 },
      developmentFolds: [],
      championDevelopment: { ...championDevelopment, completedTradeCount: 99, wins: 0, losses: 99 },
    };

    expect(loadFrozenForwardIdentities(changedHistoricalDevelopment)).toEqual(original);
  });

  it("does not modify the immutable P194 historical artifact during forward evaluation", async () => {
    const artifact = await loadV2Artifact();
    const before = await readFile(HISTORICAL_CSV_PATH);
    const fresh = freshBundle([
      { date: "2026-08-12", close: "90.00" },
      { date: "2026-08-13", close: "120.00" },
      { date: "2026-08-14", close: "95.00" },
      { date: "2026-08-17", close: "130.00" },
    ]);
    evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });
    const after = await readFile(HISTORICAL_CSV_PATH);

    expect(createHash("sha256").update(after).digest("hex")).toBe(createHash("sha256").update(before).digest("hex"));
    expect(after).toEqual(before);
  });
});
