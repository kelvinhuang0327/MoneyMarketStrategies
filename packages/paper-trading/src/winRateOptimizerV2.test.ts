import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runHistoricalCsvFile, parseHistoricalCsv } from "./historicalBaseline.js";
import { buildCandidateGrid, buildDevelopmentLayout, type WinRateParameters } from "./winRateOptimizer.js";
import {
  determineFuturePromotionStatusV2,
  optimizeParsedHistoricalDataV2,
  rankDevelopmentCandidatesV2,
  wilsonLowerBound95,
  type WinRateV2Candidate,
  type WinRateV2Metrics,
} from "./winRateOptimizerV2.js";

const EXPECTED_CSV_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7";
const TWSE_PROFILE = "twse-daily-ohlcv-close-v1";
const CSV_PATH = resolve(process.cwd(), "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv");
const PROVENANCE_PATH = resolve(process.cwd(), "data/market/p194-twstock-ohlcv-v1/provenance.json");
const CHAMPION: WinRateParameters = Object.freeze({
  entryAtOrBelowMinor: 10_000n,
  exitAtOrAboveMinor: 11_000n,
  targetQuantity: 3,
});

function metrics(wins: number, losses: number, breakevens: number): WinRateV2Metrics {
  const completedTradeCount = wins + losses + breakevens;
  return Object.freeze({
    completedTradeCount,
    wins,
    losses,
    breakevens,
    rawNetWinRate: completedTradeCount === 0 ? null : wins / completedTradeCount,
    wilsonLowerBound95: wilsonLowerBound95(wins, completedTradeCount),
  });
}

function candidate(
  id: string,
  parameters: WinRateParameters,
  wins: number,
  losses: number,
  breakevens = 0,
): WinRateV2Candidate {
  return Object.freeze({ id, parameters, stats: metrics(wins, losses, breakevens) });
}

function twseCsv(prices: readonly number[]): string {
  const rows = prices.map((price, index) => {
    const date = new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10);
    return `0050,${date},ignored,ignored,ignored,${price},ignored`;
  });
  return ["symbol,date,open,high,low,close,volume", ...rows].join("\n");
}

function repeatedMarketCsv(rowCount = 80): string {
  const pattern = [120, 80, 85, 130, 125, 90, 80, 130];
  return twseCsv(Array.from({ length: rowCount }, (_, index) => pattern[index % pattern.length]!));
}

function parseAndOptimizeV2(contents: string): Record<string, unknown> {
  const parsed = parseHistoricalCsv(contents, "0050", "optimizer v2 test input", TWSE_PROFILE);
  const inputSha256 = createHash("sha256").update(contents).digest("hex");
  return optimizeParsedHistoricalDataV2(parsed, inputSha256);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("Confidence Win Rate Optimizer V2", () => {
  it("imports the project-local CSV identity and concise provenance without rewriting it", async () => {
    const bytes = await readFile(CSV_PATH);
    const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8")) as Record<string, unknown>;
    const expectedKeys = [
      "schemaVersion", "artifactId", "sourceRepository", "sourceRelativePath", "producer", "provider",
      "providerVersion", "fetchedAtUtc", "csvSha256", "rowCount", "symbols", "perSymbolRowCounts",
      "actualDateRange", "schemaValidation", "pitValidation", "knownLimitations",
    ].sort();

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_CSV_SHA256);
    expect(Object.keys(provenance).sort()).toEqual(expectedKeys);
    expect(provenance).toMatchObject({
      artifactId: "p194-twstock-ohlcv-v1",
      sourceRelativePath: "outputs/retraining/p194_twstock_ohlcv_export.csv",
      csvSha256: EXPECTED_CSV_SHA256,
      rowCount: 8_014,
      symbols: ["2330", "2317", "2454", "0050", "0056"],
      perSymbolRowCounts: { "2330": 1_604, "2317": 1_603, "2454": 1_604, "0050": 1_599, "0056": 1_604 },
      actualDateRange: { start: "2020-01-02", end: "2026-08-11" },
      schemaValidation: "PASS",
      pitValidation: "BOUNDED_PASS_WITH_SOURCE_LIMITATION",
    });
  });

  it("runs the baseline from the project-local input and has no legacy runtime path dependency", async () => {
    const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8")) as Record<string, unknown>;
    const runtimePaths = [
      "package.json",
      "packages/paper-trading/src/historicalBaseline.ts",
      "packages/paper-trading/src/winRateOptimizer.ts",
      "packages/paper-trading/src/winRateOptimizerV2.ts",
    ];
    const runtimeSources = await Promise.all(runtimePaths.map((path) => readFile(resolve(process.cwd(), path), "utf8")));
    const baseline = await runHistoricalCsvFile(CSV_PATH, "0050", TWSE_PROFILE);

    expect(runtimeSources.join("\n")).not.toContain(
      `${String(provenance["sourceRepository"])}/${String(provenance["sourceRelativePath"])}`,
    );
    expect(baseline).toMatchObject({
      inputPath: CSV_PATH,
      inputSha256: EXPECTED_CSV_SHA256,
      symbol: "0050",
      acceptedRowCount: 1_599,
      startDate: "2020-01-02",
      endDate: "2026-08-11",
      SIMULATION_ONLY: true,
    });
  });

  it("uses the checked-in V1 artifact as the canonical historical identity and counts", async () => {
    const v1 = JSON.parse(await readFile(resolve(process.cwd(), "packages/paper-trading/win-rate-optimizer-v1.json"), "utf8")) as Record<string, unknown>;
    const selected = asRecord(v1["selectedChallenger"]);
    expect(v1["inputSha256"]).toBe(EXPECTED_CSV_SHA256);
    expect(selected).toMatchObject({
      id: "entry-10000-exit-10500",
      developmentCompletedTradeCount: 1,
      developmentWins: 1,
      developmentLosses: 0,
      developmentBreakevens: 0,
    });
  });

  it("calculates unrounded Wilson lower bounds with breakeven trials counted as non-wins", () => {
    expect(wilsonLowerBound95(0, 0)).toBeNull();
    expect(wilsonLowerBound95(1, 1)).toBeLessThan(1);
    expect(wilsonLowerBound95(2, 2)).toBeGreaterThan(wilsonLowerBound95(1, 1)!);
    expect(wilsonLowerBound95(3, 3)).toBeGreaterThan(wilsonLowerBound95(2, 2)!);
    expect(wilsonLowerBound95(5, 10)).toBeCloseTo(0.2365895936154873, 14);
    expect(metrics(1, 0, 1).rawNetWinRate).toBe(0.5);
  });

  it("ranks aggregate Wilson score before raw rate and parameter proximity, and omits zero-trade candidates", () => {
    const oneOfOne = candidate("one-of-one", {
      entryAtOrBelowMinor: 10_000n,
      exitAtOrAboveMinor: 10_500n,
      targetQuantity: 3,
    }, 1, 0);
    const twoOfTwo = candidate("two-of-two", {
      entryAtOrBelowMinor: 11_000n,
      exitAtOrAboveMinor: 12_000n,
      targetQuantity: 3,
    }, 2, 0);
    const zeroTrades = candidate("zero-trades", {
      entryAtOrBelowMinor: 9_000n,
      exitAtOrAboveMinor: 10_000n,
      targetQuantity: 3,
    }, 0, 0);
    const ranked = rankDevelopmentCandidatesV2([oneOfOne, zeroTrades, twoOfTwo], CHAMPION);

    expect(ranked.map(({ id }) => id)).toEqual(["two-of-two", "one-of-one"]);
    expect(wilsonLowerBound95(2, 2)).toBeGreaterThan(wilsonLowerBound95(1, 1)!);
  });

  it("uses raw win rate, champion distance, and deterministic parameter order only as tie-breaks", () => {
    const sameEvidence = metrics(1, 1, 0);
    const nearChampion = Object.freeze({
      id: "near",
      parameters: { entryAtOrBelowMinor: 10_000n, exitAtOrAboveMinor: 10_500n, targetQuantity: 3 },
      stats: sameEvidence,
    });
    const farther = Object.freeze({
      id: "far",
      parameters: { entryAtOrBelowMinor: 11_000n, exitAtOrAboveMinor: 12_000n, targetQuantity: 3 },
      stats: sameEvidence,
    });
    expect(rankDevelopmentCandidatesV2([farther, nearChampion], CHAMPION)[0]?.id).toBe("near");

    const higherRawRate = Object.freeze({
      id: "higher-raw",
      parameters: { entryAtOrBelowMinor: 11_000n, exitAtOrAboveMinor: 12_000n, targetQuantity: 3 },
      stats: Object.freeze({ ...sameEvidence, rawNetWinRate: 0.75 }),
    });
    const lowerRawRate = Object.freeze({
      id: "lower-raw",
      parameters: { entryAtOrBelowMinor: 10_000n, exitAtOrAboveMinor: 10_500n, targetQuantity: 3 },
      stats: Object.freeze({ ...sameEvidence, rawNetWinRate: 0.5 }),
    });
    expect(rankDevelopmentCandidatesV2([lowerRawRate, higherRawRate], CHAMPION)[0]?.id).toBe("higher-raw");

    const sameScore = metrics(1, 1, 0);
    const equidistantLater = Object.freeze({
      id: "later",
      parameters: { entryAtOrBelowMinor: 10_000n, exitAtOrAboveMinor: 11_500n, targetQuantity: 3 },
      stats: sameScore,
    });
    const equidistantEarlier = Object.freeze({
      id: "earlier",
      parameters: { entryAtOrBelowMinor: 9_500n, exitAtOrAboveMinor: 11_000n, targetQuantity: 3 },
      stats: sameScore,
    });
    expect(rankDevelopmentCandidatesV2([equidistantLater, equidistantEarlier], CHAMPION)[0]?.id).toBe("earlier");
  });

  it("does not allow P&L changes alone to affect candidate ranking", () => {
    const one = candidate("one", {
      entryAtOrBelowMinor: 10_000n,
      exitAtOrAboveMinor: 10_500n,
      targetQuantity: 3,
    }, 1, 0);
    const two = candidate("two", {
      entryAtOrBelowMinor: 11_000n,
      exitAtOrAboveMinor: 12_000n,
      targetQuantity: 3,
    }, 2, 0);
    const withPositivePnl = [
      { ...one, pnlMinor: 1_000_000n },
      { ...two, pnlMinor: 1n },
    ];
    const withNegativePnl = [
      { ...one, pnlMinor: -1n },
      { ...two, pnlMinor: -1_000_000n },
    ];

    expect(rankDevelopmentCandidatesV2(withPositivePnl, CHAMPION).map(({ id }) => id))
      .toEqual(rankDevelopmentCandidatesV2(withNegativePnl, CHAMPION).map(({ id }) => id));
  });

  it("keeps V1 chronological development folds and candidate grid bounds", () => {
    const layout = buildDevelopmentLayout(1_599);
    const grid = buildCandidateGrid(CHAMPION);
    expect(layout.developmentBoundary).toEqual({ startRow: 1, endRow: 1_279, rowCount: 1_279 });
    expect(layout.developmentFolds[0]?.validationRows).toEqual({ startRow: 427, endRow: 853, rowCount: 427 });
    expect(layout.developmentFolds[1]?.validationRows).toEqual({ startRow: 854, endRow: 1_279, rowCount: 426 });
    expect(grid).toHaveLength(19);
    expect(grid.length).toBeLessThanOrEqual(25);
  });

  it("keeps old V1 holdout evidence out of promotion and requires strict Wilson improvement on future rows", () => {
    const champion = metrics(1, 0, 0);
    const stronger = metrics(2, 0, 0);
    expect(determineFuturePromotionStatusV2(champion, stronger, "2026-08-11", "2026-08-11"))
      .toBe("NO_PROMOTION");
    expect(determineFuturePromotionStatusV2(champion, stronger, "2026-08-12", "2026-08-11"))
      .toBe("PROMOTE");
    expect(determineFuturePromotionStatusV2(stronger, stronger, "2026-08-12", "2026-08-11"))
      .toBe("NO_PROMOTION");
  });

  it("freezes one reproducible challenger without assigning promotion authority to historical holdout", () => {
    const contents = repeatedMarketCsv();
    const first = parseAndOptimizeV2(contents);
    const repeated = parseAndOptimizeV2(contents);

    expect(first).toEqual(repeated);
    expect(first["objective"]).toBe("WIN_RATE_WILSON_LOWER_BOUND_95");
    expect(first["candidateCount"]).toBeLessThanOrEqual(25);
    expect(first["FROZEN_CHALLENGER_ID"]).toBe(asRecord(first["selectedFutureChallenger"])["id"]);
    expect(first["FROZEN_SELECTION_INPUT_SHA256"]).toBe(first["inputSha256"]);
    expect(first["FROZEN_SELECTION_POLICY_VERSION"]).toBe("wilson-lower-bound-95-development-v1");
    expect(first["V1_HOLDOUT_STATUS"]).toBe("HISTORICAL_DIAGNOSTIC_ONLY");
    expect(first["FUTURE_PROMOTION_STATUS"]).toBe("AWAITING_UNSEEN_DATA");
    expect(first).not.toHaveProperty("promotion");
  });
});
