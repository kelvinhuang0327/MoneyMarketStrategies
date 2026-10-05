import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertNoForwardCliOverrides,
  determineForwardPromotionStatus,
  evaluateForwardWinRate,
  forwardWinRateCliFailure,
  loadFrozenForwardIdentities,
  runForwardWinRateEvaluationFiles,
  summarizeForwardSessionRuns,
  FORWARD_DATA_CSV_PATH,
  FORWARD_DATA_PROVENANCE_PATH,
  FORWARD_EVALUATION_OUTPUT_PATH,
  WIN_RATE_V2_ARTIFACT_PATH,
} from "./forwardWinRateEvaluator.js";
import { parsePaperSession, runPaperSession } from "./sessionRunner.js";
import type { SimulatedFillRule } from "./types.js";
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

function syntheticSession(input: {
  readonly closes: readonly { readonly id: string; readonly time: number; readonly priceMinor: string }[];
  readonly maxPositionQuantity?: number;
  readonly maxExposureMinor?: string;
}) {
  return parsePaperSession({
    schemaVersion: 1,
    dataKind: "SYNTHETIC",
    sourceLabel: "forward-diagnostics-synthetic-test",
    asset: { symbol: "0050", currencyCode: "TWD", minorUnit: "0.01" },
    simulation: {
      initialCashMinor: "1000000",
      risk: {
        maxPositionQuantity: input.maxPositionQuantity ?? 3,
        maxExposureMinor: input.maxExposureMinor ?? "1000000",
        maxMarketAgeMs: 1000,
      },
      terms: { label: "SYNTHETIC_ONLY", feeBps: 10, slippageBps: 20 },
      strategy: { entryAtOrBelowMinor: "10000", exitAtOrAboveMinor: "11000", targetQuantity: 3 },
    },
    events: input.closes.map(({ id, time, priceMinor }) => ({
      eventId: id,
      timestamp: time,
      symbol: "0050",
      priceMinor,
    })),
  });
}

function summarizeSyntheticSession(session: ReturnType<typeof syntheticSession>, fillRule?: SimulatedFillRule) {
  const inputSha256 = "a".repeat(64);
  const benchmarkStrategy = {
    strategyVersion: "cost-matched-always-long-benchmark-v1",
    strategyParameters: { policy: "ALWAYS_LONG", targetQuantity: session.simulation.strategy.targetQuantity },
    decide: () => session.simulation.strategy.targetQuantity,
  };
  const candidateRun = runPaperSession(session, inputSha256, fillRule, undefined, undefined, { captureEquityCurve: true });
  const benchmarkRun = runPaperSession(session, inputSha256, undefined, benchmarkStrategy, undefined, { captureEquityCurve: true });
  return summarizeForwardSessionRuns(
    candidateRun,
    benchmarkRun,
    session.events.length,
    session.simulation.initialCashMinor,
  );
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

  it("returns stable machine-readable codes for stale, duplicate, and frozen-version errors", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([{ date: "2026-08-13", close: "105.00" }]);
    const staleError = (() => {
      try {
        evaluateForwardWinRate({
          frozenArtifact: artifact,
          freshDataBytes: fresh.bytes,
          freshProvenance: { ...fresh.provenance, historicalCutoff: "2026-08-12" },
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(forwardWinRateCliFailure(staleError)).toMatchObject({
      schemaVersion: 1,
      status: "ERROR",
      error: { code: "STALE_FORWARD_SNAPSHOT" },
    });

    const duplicate = freshBundle([
      { date: "2026-08-13", close: "105.00" },
      { date: "2026-08-13", close: "106.00" },
    ]);
    const duplicateError = (() => {
      try {
        evaluateForwardWinRate({
          frozenArtifact: artifact,
          freshDataBytes: duplicate.bytes,
          freshProvenance: duplicate.provenance,
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(forwardWinRateCliFailure(duplicateError).error.code).toBe("INVALID_FORWARD_DATA");

    const dateRangeError = (() => {
      try {
        evaluateForwardWinRate({
          frozenArtifact: artifact,
          freshDataBytes: fresh.bytes,
          freshProvenance: { ...fresh.provenance, dateRange: { start: "2026-08-14", end: "2026-08-14" } },
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(forwardWinRateCliFailure(dateRangeError).error.code).toBe("INVALID_FORWARD_DATA");

    const sourceError = (() => {
      try {
        evaluateForwardWinRate({
          frozenArtifact: artifact,
          freshDataBytes: fresh.bytes,
          freshProvenance: { ...fresh.provenance, source: "unverified source" },
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(forwardWinRateCliFailure(sourceError).error.code).toBe("INVALID_FORWARD_DATA");

    const wrongStrategyError = (() => {
      try {
        loadFrozenForwardIdentities({ ...artifact, FROZEN_STRATEGY_VERSION: "unrecognized-version" });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(forwardWinRateCliFailure(wrongStrategyError).error.code).toBe("INVALID_FROZEN_ARTIFACT");
  });

  it("keeps the previous evaluation artifact unchanged when a required input is missing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mms-forward-eval-missing-"));
    try {
      const error = await runForwardWinRateEvaluationFiles(root).then(() => undefined, (reason: unknown) => reason);
      const failure = forwardWinRateCliFailure(error);
      const encoded = JSON.parse(JSON.stringify(failure)) as typeof failure;

      expect(encoded).toMatchObject({
        schemaVersion: 1,
        status: "ERROR",
        error: { code: "MISSING_INPUT_FILE" },
      });
      await expect(readFile(resolve(root, FORWARD_EVALUATION_OUTPUT_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite the evaluation artifact or any input when a snapshot is stale", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mms-forward-eval-stale-"));
    const artifact = await readFile(V2_ARTIFACT_PATH);
    const fresh = freshBundle([{ date: "2026-08-13", close: "105.00" }]);
    const oldProvenance = new TextEncoder().encode(JSON.stringify({
      ...fresh.provenance,
      historicalCutoff: "2026-08-12",
    }));
    const previousOutput = "previous-evaluation\n";
    const inputs = [
      [WIN_RATE_V2_ARTIFACT_PATH, artifact],
      [FORWARD_DATA_CSV_PATH, fresh.bytes],
      [FORWARD_DATA_PROVENANCE_PATH, oldProvenance],
    ] as const;
    try {
      for (const [relativePath, bytes] of inputs) {
        const path = resolve(root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      const outputPath = resolve(root, FORWARD_EVALUATION_OUTPUT_PATH);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, previousOutput, "utf8");

      const error = await runForwardWinRateEvaluationFiles(root).then(() => undefined, (reason: unknown) => reason);
      expect(forwardWinRateCliFailure(error).error.code).toBe("STALE_FORWARD_SNAPSHOT");
      expect(await readFile(outputPath, "utf8")).toBe(previousOutput);
      for (const [relativePath, bytes] of inputs) {
        expect(Buffer.from(await readFile(resolve(root, relativePath))).equals(Buffer.from(bytes))).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
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
    expect(result.champion.parameters).toMatchObject((artifact["championDevelopment"] as { parameters: Record<string, unknown> }).parameters);
    expect(result.champion.parameters).toMatchObject({
      currencyCode: "TWD",
      minorUnit: "0.01",
      entryAtOrBelowTwd: "100.00",
      exitAtOrAboveTwd: "110.00",
    });
    expect(result.challenger.id).toBe(artifact["FROZEN_CHALLENGER_ID"]);
    expect(result.challenger.parameters).toMatchObject(artifact["FROZEN_PARAMETERS"] as Record<string, unknown>);
    expect(result.challenger.parameters).toMatchObject({ entryAtOrBelowTwd: "110.00", exitAtOrAboveTwd: "120.00" });
    expect(result.priceUnit).toEqual({ currencyCode: "TWD", minorUnit: "0.01", minorUnitsPerMajor: 100 });
    expect(result.dataCoverage.providerSessionCompleteness).toBe("UNKNOWN");
    expect(result.dataCoverage.providerCompletenessReason)
      .toBe("NO_EXCHANGE_CALENDAR_OR_PROVIDER_COMPLETENESS_ATTESTATION");
    expect(result.champion.freshDataSha256).toBe(result.freshDataSha256);
    expect(result.challenger.freshDataSha256).toBe(result.freshDataSha256);
    expect(result.freshCompletedTradeCount).toEqual({
      champion: result.champion.completedTradeCount,
      challenger: result.challenger.completedTradeCount,
    });
  });

  it("separates a true no-signal window from missing forward data", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([
      { date: "2026-08-12", close: "130.00" },
      { date: "2026-08-13", close: "131.00" },
    ]);
    const result = evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });

    expect(result.freshRowCount).toBe(2);
    expect(result.champion.diagnostics.outcome).toBe("NO_SIGNAL");
    expect(result.challenger.diagnostics.outcome).toBe("NO_SIGNAL");
    expect(result.champion.diagnostics.stages.decisions.noTrade).toBe(2);
    expect(result.challenger.diagnostics.stages.orders.submitted).toBe(0);
    expect(result.champion.rawNetWinRate).toBeNull();
    expect(result.challenger.rawNetWinRate).toBeNull();
    expect(result.promotionStatus).toBe("INSUFFICIENT_FRESH_TRADES");
  });

  it("reports an open challenger position separately from completed-trade return", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([
      { date: "2026-08-12", close: "105.00" },
      { date: "2026-08-13", close: "111.00" },
    ]);
    const result = evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });
    const challenger = result.challenger;

    expect(result.champion.diagnostics.outcome).toBe("NO_SIGNAL");
    expect(challenger.diagnostics.outcome).toBe("OPEN_POSITION_AT_CUTOFF");
    expect(challenger.completedTradeCount).toBe(0);
    expect(challenger.rawNetWinRate).toBeNull();
    expect(challenger.diagnostics.stages.openPositionQuantity).toBe(3);
    expect(challenger.diagnostics.economics.completedTradeNetPnlMinor).toBe("0");
    expect(challenger.diagnostics.economics.unrealizedPnlMinor).not.toBe("0");
    expect(challenger.diagnostics.inconclusiveReasonCodes).toContain("OPEN_POSITION_AT_CUTOFF");
    expect(challenger.diagnostics.economics.costMatchedBenchmark.policy).toBe("ALWAYS_LONG");
    expect(challenger.diagnostics.economics.costMatchedBenchmark.excessNetReturnFraction).not.toBeNull();
    expect(result.promotionStatus).toBe("INSUFFICIENT_FRESH_TRADES");
  });

  it("reports no fresh data without turning the empty denominator into a 0% win rate", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([]);
    const result = evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: fresh.provenance,
    });

    expect(result.promotionStatus).toBe("NO_FRESH_DATA");
    expect(result.freshRowCount).toBe(0);
    expect(result.champion.diagnostics.outcome).toBe("NO_FRESH_DATA");
    expect(result.challenger.rawNetWinRate).toBeNull();
    expect(result.challenger.diagnostics.economics.netReturnFraction).toBeNull();
    expect(result.challenger.diagnostics.economics.costMatchedBenchmark.netReturnFraction).toBeNull();
  });

  it("rejects a truncated source whose row count no longer matches provenance", async () => {
    const artifact = await loadV2Artifact();
    const fresh = freshBundle([{ date: "2026-08-12", close: "105.00" }]);
    const incompleteProvenance = { ...fresh.provenance, rowCount: 2 };

    expect(() => evaluateForwardWinRate({
      frozenArtifact: artifact,
      freshDataBytes: fresh.bytes,
      freshProvenance: incompleteProvenance,
    })).toThrow(/rowCount does not match/);
  });

  it("distinguishes risk rejection and unfilled orders from no signal", () => {
    const riskRejected = summarizeSyntheticSession(syntheticSession({
      closes: [{ id: "risk-1", time: 1, priceMinor: "9000" }, { id: "risk-2", time: 2, priceMinor: "9500" }],
      maxPositionQuantity: 0,
    }));
    expect(riskRejected.outcome).toBe("RISK_REJECTED");
    expect(riskRejected.stages.decisions.riskRejected).toBeGreaterThan(0);
    expect(riskRejected.stages.orders.submitted).toBe(0);

    const noFill: SimulatedFillRule = () => ({ kind: "no-fill" });
    const unfilled = summarizeSyntheticSession(syntheticSession({
      closes: [{ id: "pending-1", time: 1, priceMinor: "9000" }, { id: "pending-2", time: 2, priceMinor: "9500" }],
    }), noFill);
    expect(unfilled.outcome).toBe("UNFILLED_ORDER_AT_CUTOFF");
    expect(unfilled.stages.orders.open).toBe(1);
    expect(unfilled.stages.fills.count).toBe(0);
    expect(unfilled.stages.openPositionQuantity).toBe(0);
  });

  it("deduplicates repeated market events while preserving later fill and trade counts", () => {
    const repeatedMarketEvent = { id: "dup-1", time: 1, priceMinor: "9000" };
    const diagnostic = summarizeSyntheticSession(syntheticSession({
      closes: [
        repeatedMarketEvent,
        repeatedMarketEvent,
        { id: "dup-2", time: 2, priceMinor: "9500" },
        { id: "dup-3", time: 3, priceMinor: "12000" },
        { id: "dup-4", time: 4, priceMinor: "12000" },
      ],
    }));

    expect(diagnostic.stages.processedEvents.duplicate).toBe(1);
    expect(diagnostic.stages.fills.count).toBe(2);
    expect(diagnostic.stages.fills.quantity).toBe(6);
    expect(diagnostic.stages.completedTradeCount).toBe(1);
  });

  it("reports completed-trade and marked-to-market economics against matched costs", () => {
    const diagnostic = summarizeSyntheticSession(syntheticSession({
      closes: [
        { id: "round-trip-1", time: 1, priceMinor: "9000" },
        { id: "round-trip-2", time: 2, priceMinor: "12000" },
        { id: "round-trip-3", time: 3, priceMinor: "13000" },
      ],
    }));

    expect(diagnostic.stages.completedTradeCount).toBe(1);
    expect(diagnostic.economics.completedTradeNetPnlMinor).not.toBe("0");
    expect(diagnostic.economics.netReturnFraction).toMatch(/^-?\d+\.\d{8}$/);
    expect(diagnostic.economics.maximumDrawdownFraction).toMatch(/^\d+\.\d{8}$/);
    expect(diagnostic.economics.costMatchedBenchmark.feeBps).toBe(10);
    expect(diagnostic.economics.costMatchedBenchmark.slippageBps).toBe(20);
    expect(diagnostic.economics.costMatchedBenchmark.fillModel).toBe("alwaysFillNextEvent");
    expect(diagnostic.economics.costMatchedBenchmark.netReturnFraction).not.toBeNull();
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
