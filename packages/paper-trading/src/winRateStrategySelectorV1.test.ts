import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import {
  buildRollingMeanReversionCandidateGrid,
  buildRollingOriginFolds,
  evaluateRollingMeanReversionFold,
  isRollingMeanReversionCandidateEligible,
  loadProjectDevelopmentData,
  mergeParsedHistoricalCsv,
  rankRollingMeanReversionCandidates,
  selectRollingMeanReversionV1,
  type RollingMeanReversionCandidateDiagnostics,
  type RollingMeanReversionParameters,
} from "./winRateStrategySelectorV1.js";
import { wilsonLowerBound95 } from "./winRateOptimizerV2.js";

const TWSE_PROFILE = "twse-daily-ohlcv-close-v1";
const EXPECTED_HISTORICAL_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7";
const EXPECTED_FORWARD_SHA256 = "9e66a3fd594c0614ac1641b7a50e9d926014eaa4839347b524e25d52567b0aaf";

interface CsvRow {
  readonly date: string;
  readonly closeMinor: number;
  readonly openMinor?: number;
  readonly highMinor?: number;
  readonly lowMinor?: number;
  readonly volume?: number;
  readonly source?: string;
}

function majorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

function csv(rows: readonly CsvRow[]): string {
  const records = rows.map((row) => [
    "0050",
    row.date,
    majorUnits(row.openMinor ?? row.closeMinor),
    majorUnits(row.highMinor ?? row.closeMinor),
    majorUnits(row.lowMinor ?? row.closeMinor),
    majorUnits(row.closeMinor),
    String(row.volume ?? 100_000),
    row.source ?? "test/source",
  ].join(","));
  return ["symbol,date,open,high,low,close,volume,source", ...records].join("\n");
}

function parse(contents: string) {
  return parseHistoricalCsv(contents, "0050", "rolling selector test input", TWSE_PROFILE);
}

function closeSeries(count: number, prices = [10_000, 10_000, 10_000, 9_000, 10_000, 11_000, 10_000]): readonly CsvRow[] {
  const start = Date.UTC(2022, 0, 1);
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    closeMinor: prices[index % prices.length]!,
  })));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const INPUT_HASHES = Object.freeze({
  historicalSha256: sha256("synthetic historical input"),
  observedForwardSha256: sha256("synthetic observed-forward input"),
});

function diagnostic(
  candidateId: string,
  parameters: RollingMeanReversionParameters,
  wins: number,
  losses: number,
  breakevens: number,
  pnlMinor: string,
): RollingMeanReversionCandidateDiagnostics {
  const aggregateCompletedTradeCount = wins + losses + breakevens;
  return Object.freeze({
    candidateId,
    parameters,
    perFoldCompletedTradeCount: Object.freeze([
      Object.freeze({ foldId: "fold-1", completedTradeCount: Math.floor(aggregateCompletedTradeCount / 3) }),
      Object.freeze({ foldId: "fold-2", completedTradeCount: Math.floor(aggregateCompletedTradeCount / 3) }),
      Object.freeze({ foldId: "fold-3", completedTradeCount: aggregateCompletedTradeCount - 2 * Math.floor(aggregateCompletedTradeCount / 3) }),
    ]),
    aggregateCompletedTradeCount,
    WIN: wins,
    LOSS: losses,
    BREAKEVEN: breakevens,
    rawNetWinRate: aggregateCompletedTradeCount === 0 ? null : wins / aggregateCompletedTradeCount,
    WilsonLowerBound95: wilsonLowerBound95(wins, aggregateCompletedTradeCount),
    eligible: aggregateCompletedTradeCount >= 6,
    parameterDistanceFromGridCenter: 0,
    totalNetPnlMinor: pnlMinor,
    averageCompletedTradePnlMinor: aggregateCompletedTradeCount === 0
      ? null
      : Object.freeze({ numeratorMinor: pnlMinor, denominator: aggregateCompletedTradeCount }),
    feesMinor: "0",
  });
}

describe("bounded rolling mean-reversion strategy selector v1", () => {
  it("freezes the exact 24-candidate grid", () => {
    const grid = buildRollingMeanReversionCandidateGrid();
    expect(grid).toHaveLength(24);
    expect(Object.isFrozen(grid)).toBe(true);
    expect(grid.every(({ parameters }) => Object.isFrozen(parameters))).toBe(true);
    expect([...new Set(grid.map(({ parameters }) => parameters.lookback))]).toEqual([10, 20, 40]);
    expect([...new Set(grid.map(({ parameters }) => parameters.entryDiscount))]).toEqual([0.02, 0.04]);
    expect([...new Set(grid.map(({ parameters }) => parameters.takeProfit))]).toEqual([0.02, 0.04]);
    expect([...new Set(grid.map(({ parameters }) => parameters.maxHoldBars))]).toEqual([10, 20]);
  });

  it("keeps every rolling-origin validation window after its training history", () => {
    const folds = buildRollingOriginFolds(320);
    expect(folds).toHaveLength(3);
    expect(folds.map(({ validationStartIndex, validationEndIndex }) => [validationStartIndex, validationEndIndex]))
      .toEqual([[80, 160], [160, 240], [240, 320]]);
    expect(folds.every(({ trainingEndIndex, validationStartIndex }) => trainingEndIndex === validationStartIndex)).toBe(true);
    expect(folds[0]!.validationEndIndex).toBeLessThanOrEqual(folds[1]!.validationStartIndex);
    expect(folds[1]!.validationEndIndex).toBeLessThanOrEqual(folds[2]!.validationStartIndex);
  });

  it("does not let rows after a fold's validation end change its outcomes", () => {
    const baseRows = closeSeries(320);
    const changedTailRows = baseRows.map((row, index) => index < 160 ? row : { ...row, closeMinor: 30_000 });
    const first = parse(csv(baseRows));
    const second = parse(csv(changedTailRows));
    const fold = buildRollingOriginFolds(320)[0]!;
    const candidate = buildRollingMeanReversionCandidateGrid()[0]!;
    const inputHash = sha256("fold-test");

    expect(evaluateRollingMeanReversionFold(first, fold, candidate, inputHash))
      .toEqual(evaluateRollingMeanReversionFold(second, fold, candidate, inputHash));
  });

  it("rejects a candidate with no completed trade in any validation fold", () => {
    expect(isRollingMeanReversionCandidateEligible([2, 0, 5], 7)).toBe(false);
  });

  it("rejects a candidate with fewer than six aggregate completed trades", () => {
    expect(isRollingMeanReversionCandidateEligible([1, 1, 3], 5)).toBe(false);
    expect(isRollingMeanReversionCandidateEligible([2, 2, 2], 6)).toBe(true);
  });

  it("does not rank completed-trade count after a candidate is eligible", () => {
    const parameters = buildRollingMeanReversionCandidateGrid()[0]!.parameters;
    const sixWins = diagnostic("six-wins", parameters, 6, 0, 0, "-999999");
    const thirtyTrades = diagnostic("thirty-trades", parameters, 20, 10, 0, "999999");

    expect(thirtyTrades.aggregateCompletedTradeCount).toBeGreaterThan(sixWins.aggregateCompletedTradeCount);
    expect(sixWins.WilsonLowerBound95).toBeGreaterThan(thirtyTrades.WilsonLowerBound95!);
    expect(rankRollingMeanReversionCandidates([thirtyTrades, sixWins]).map(({ candidateId }) => candidateId))
      .toEqual(["six-wins", "thirty-trades"]);
  });

  it("ranks Wilson lower bound before raw win rate", () => {
    const parameters = buildRollingMeanReversionCandidateGrid()[0]!.parameters;
    const perfectSmallSample = diagnostic("perfect-small", parameters, 6, 0, 0, "0");
    const lowerRawHigherWilson = diagnostic("higher-wilson", parameters, 20, 2, 0, "0");

    expect(perfectSmallSample.rawNetWinRate).toBeGreaterThan(lowerRawHigherWilson.rawNetWinRate!);
    expect(lowerRawHigherWilson.WilsonLowerBound95).toBeGreaterThan(perfectSmallSample.WilsonLowerBound95!);
    expect(rankRollingMeanReversionCandidates([perfectSmallSample, lowerRawHigherWilson])[0]?.candidateId)
      .toBe("higher-wilson");
  });

  it("does not let P&L changes alone affect ranking when outcomes are unchanged", () => {
    const grid = buildRollingMeanReversionCandidateGrid();
    const near = diagnostic("near", grid[8]!.parameters, 4, 2, 0, "-1000000");
    const far = diagnostic("far", grid[0]!.parameters, 4, 2, 0, "1000000");
    const changedPnl = [
      { ...near, totalNetPnlMinor: "999999999", averageCompletedTradePnlMinor: { numeratorMinor: "999999999", denominator: 6 } },
      { ...far, totalNetPnlMinor: "-999999999", averageCompletedTradePnlMinor: { numeratorMinor: "-999999999", denominator: 6 } },
    ];

    expect(rankRollingMeanReversionCandidates([far, near]).map(({ candidateId }) => candidateId))
      .toEqual(rankRollingMeanReversionCandidates(changedPnl).map(({ candidateId }) => candidateId));
  });

  it("uses normalized distance from the fixed-grid center and then lexical candidate ID for ties", () => {
    const grid = buildRollingMeanReversionCandidateGrid();
    const centered = diagnostic("z-centered", grid[8]!.parameters, 6, 0, 0, "0");
    const farther = diagnostic("a-farther", grid[0]!.parameters, 6, 0, 0, "0");
    expect(rankRollingMeanReversionCandidates([farther, centered])[0]?.candidateId).toBe("z-centered");

    const sameParametersA = diagnostic("a-lexical", grid[8]!.parameters, 6, 0, 0, "0");
    const sameParametersZ = diagnostic("z-lexical", grid[8]!.parameters, 6, 0, 0, "0");
    expect(rankRollingMeanReversionCandidates([sameParametersZ, sameParametersA]).map(({ candidateId }) => candidateId))
      .toEqual(["a-lexical", "z-lexical"]);
  });

  it("selects the same future challenger from the same development data", () => {
    const parsed = parse(csv(closeSeries(320)));
    const first = selectRollingMeanReversionV1(parsed, INPUT_HASHES);
    const repeated = selectRollingMeanReversionV1(parsed, INPUT_HASHES);

    expect(first).toEqual(repeated);
    expect(first["objective"]).toBe("WIN_RATE_WILSON_LOWER_BOUND_95");
    expect(first["candidateGrid"]).toMatchObject({ candidateCount: 24 });
    const candidates = first["candidates"] as readonly Record<string, unknown>[];
    expect(candidates).toHaveLength(24);
    expect(candidates[0]).toHaveProperty("perFoldCompletedTradeCount");
    expect(candidates[0]).toHaveProperty("aggregateCompletedTradeCount");
    expect(candidates[0]).toHaveProperty("WIN");
    expect(candidates[0]).toHaveProperty("LOSS");
    expect(candidates[0]).toHaveProperty("BREAKEVEN");
    expect(candidates[0]).toHaveProperty("rawNetWinRate");
    expect(candidates[0]).toHaveProperty("WilsonLowerBound95");
    expect(candidates[0]).toHaveProperty("eligible");
    expect(candidates[0]).toHaveProperty("totalNetPnlMinor");
    expect(candidates[0]).toHaveProperty("averageCompletedTradePnlMinor");
    expect(candidates[0]).toHaveProperty("feesMinor");
    if (first["selectionStatus"] === "SELECTED_FUTURE_CHALLENGER") {
      expect(first["FROZEN_SELECTION_POLICY"]).toBe("wilson-rolling-mean-reversion-v1");
    } else {
      expect(first["selectionStatus"]).toBe("NO_ELIGIBLE_CANDIDATE");
    }
  }, 60_000);

  it("deduplicates only value-equivalent overlapping boundary rows", () => {
    const same = { date: "2026-08-11", closeMinor: 10_500, source: "one" };
    const historical = parse(csv([same]));
    const observedForward = parse(csv([{ ...same, source: "two" }]));
    expect(mergeParsedHistoricalCsv(historical, observedForward).rowCount).toBe(1);

    const conflict = parse(csv([{ ...same, highMinor: 10_700 }]));
    expect(() => mergeParsedHistoricalCsv(historical, conflict)).toThrow(/conflict/);
  });

  it("rejects descending source chronology", () => {
    expect(() => parse(csv([
      { date: "2026-08-12", closeMinor: 10_500 },
      { date: "2026-08-11", closeMinor: 10_400 },
    ]))).toThrow(/chronological order/);
  });

  it("merges the pinned historical and observed-forward authorities through exactly 2026-09-29", async () => {
    const { parsed, inputHashes } = await loadProjectDevelopmentData(process.cwd());
    const historicalBytes = await readFile(resolve(process.cwd(), "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv"));
    const forwardBytes = await readFile(resolve(process.cwd(), "data/market/forward/0050-forward-v1/0050_forward.csv"));

    expect(parsed.rowCount).toBe(1_632);
    expect(parsed.startDate).toBe("2020-01-02");
    expect(parsed.endDate).toBe("2026-09-29");
    expect(inputHashes).toEqual({
      historicalSha256: EXPECTED_HISTORICAL_SHA256,
      observedForwardSha256: EXPECTED_FORWARD_SHA256,
    });
    expect(createHash("sha256").update(historicalBytes).digest("hex")).toBe(EXPECTED_HISTORICAL_SHA256);
    expect(createHash("sha256").update(forwardBytes).digest("hex")).toBe(EXPECTED_FORWARD_SHA256);
  });
});
