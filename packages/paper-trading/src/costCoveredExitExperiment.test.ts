import { describe, expect, it } from "vitest";
import { parseCostCoveredExitInput, runCostCoveredExitExperiment, descriptiveWilson95 } from "./costCoveredExitExperiment.js";

const freeze = Date.UTC(2026, 9, 7), step = 86_400_000, hash = "a".repeat(64);
function fixture(prices: number[], warmupPrice = 10_000) {
  return {
    schemaVersion: 1, dataKind: "SYNTHETIC",
    datasets: [{ symbol: "0056", source: { uri: "synthetic://cost-covered-v1", sha256: hash }, rows: [
      ...Array.from({ length: 39 }, (_, i) => ({ eventId: `warmup-${i}`, timestamp: freeze - (39 - i) * step, priceMinor: String(warmupPrice), receivedAtTimestamp: freeze - (39 - i) * step })),
      ...prices.map((price, i) => ({ eventId: `evaluation-${i}`, timestamp: freeze + (i + 1) * step, priceMinor: String(price), receivedAtTimestamp: freeze + (i + 1) * step })),
    ] }],
  };
}
function run(value: unknown) {
  return runCostCoveredExitExperiment(parseCostCoveredExitInput(value, freeze, freeze + 100 * step), hash, freeze);
}

describe("frozen single-candidate replay", () => {
  it("separates baseline cost loss and synthetic candidate recovery, preserving all journals", () => {
    const result = run(fixture([8_000, 10_000, 10_000, 11_000, 12_000]));
    const row = result.results[0]!;
    expect(row.baseline).toMatchObject({ completeTradeCount: 1, wins: 0, losses: 1 });
    expect(row.candidate).toMatchObject({ completeTradeCount: 1, wins: 1, losses: 0, openPositionQuantity: 0 });
    expect(row.candidate.exitDiagnostics).toMatchObject({ belowCost: 2, costCovered: 1 });
    expect(row.candidate.journal.length).toBeGreaterThan(0);
    expect(row.candidate.netWinRateWilson95!.lower).toBeLessThan(0.21);
    expect(result).toMatchObject({ status: "INCONCLUSIVE", classification: "SYNTHETIC_BEHAVIOR_ONLY" });
    expect(result.eligibility.meaning).toBe("MINIMUM_ELIGIBILITY_ONLY_NOT_STATISTICAL_PROOF");
    expect(row.candidate.maximumDrawdownFraction).toBeGreaterThanOrEqual(0);
  });
  it("shows a gap-down loss despite quote-time cost coverage; no winning-trade filter", () => {
    const row = run(fixture([8_000, 10_000, 11_000, 1_000])).results[0]!;
    expect(row.candidate).toMatchObject({ completeTradeCount: 1, wins: 0, losses: 1, netWinRate: 0 });
    expect(row.candidate.exitDiagnostics.costCovered).toBe(1);
    expect(row.candidate.netReturnAfterModeledCostsFraction).toBeLessThan(0);
  });
  it("forces a loss at 20 held bars", () => {
    const row = run(fixture([8_000, ...Array(21).fill(10_000)])).results[0]!;
    expect(row.candidate).toMatchObject({ completeTradeCount: 1, losses: 1 });
    expect(row.candidate.exitDiagnostics.forcedExits).toBe(1);
  });
  it("reports an open trade separately, excluding it from the win-rate denominator", () => {
    const result = run(fixture([8_000, 10_000, 10_000]));
    expect(result.results[0]!.candidate).toMatchObject({ completeTradeCount: 0, netWinRate: null, netWinRateWilson95: null, openPositionQuantity: 3 });
    expect(result.nonDeterminationReasons).toContain("OPEN_TRADES_NOT_SETTLED");
    expect(result.results[0]!.candidate.terminalLiquidationEstimateReturnFraction).toBeLessThan(result.results[0]!.candidate.netReturnAfterModeledCostsFraction);
  });
  it("distinguishes no signal, unfilled pending entry and risk refusal", () => {
    const noSignal = run(fixture([10_000, 10_000])).results[0]!.candidate;
    expect(noSignal).toMatchObject({ completeTradeCount: 0, netWinRate: null, pendingOrder: null });
    expect(noSignal.stages).toMatchObject({ flatNoSignalDecisions: 2, ordersSubmitted: 0, fills: 0 });
    const pending = run(fixture([8_000])).results[0]!.candidate;
    expect(pending.pendingOrder).toMatchObject({ side: "buy", remainingQuantity: 3 });
    expect(pending.stages).toMatchObject({ ordersSubmitted: 1, fills: 0 });
    const rejected = run(fixture([1_000_000], 2_000_000)).results[0]!.candidate;
    expect(rejected.stages).toMatchObject({ riskRejected: 1, ordersSubmitted: 0, fills: 0 });
  });
  it("ignores identical repeated events without advancing the held-bar counter or changing PnL", () => {
    const input = fixture([8_000, 10_000, 10_000, 11_000, 12_000]);
    const before = run(input).results[0]!.candidate;
    input.datasets[0]!.rows.splice(41, 0, { ...input.datasets[0]!.rows[40]! });
    const after = run(input).results[0]!.candidate;
    expect(after.exitDiagnostics).toEqual(before.exitDiagnostics);
    expect(after.completeTradeCount).toBe(before.completeTradeCount);
    expect(after.netReturnAfterModeledCostsFraction).toBe(before.netReturnAfterModeledCostsFraction);
    expect(after.stages.duplicateEvents).toBe(1);
  });
  it("rejects missing source data, conflicting duplicates, reordering and parameter overrides", () => {
    const missing = fixture([8_000]); missing.datasets[0]!.source.sha256 = "";
    expect(() => run(missing)).toThrow("missing source");
    const conflict = fixture([8_000]); conflict.datasets[0]!.rows.push({ ...conflict.datasets[0]!.rows.at(-1)!, priceMinor: "999" });
    expect(() => run(conflict)).toThrow("conflicting duplicate");
    const reversed = fixture([8_000]); reversed.datasets[0]!.rows.reverse();
    expect(() => run(reversed)).toThrow("chronological");
    expect(() => run({ ...fixture([8_000]), maxHoldBars: 99 })).toThrow("overrides");
    expect(() => run({ ...fixture([8_000]), dataKind: ["SYNTHETIC"] })).toThrow("schema/dataKind");
    const oversized = fixture([8_000]); oversized.datasets[0]!.rows.at(-1)!.priceMinor = "9007199254740992";
    expect(() => run(oversized)).toThrow("numeric precision");
  });
  it("rejects pre-freeze data even if it has never been downloaded by this program", () => {
    const prior = fixture([]);
    expect(() => run(prior)).toThrow("NO_UNSEEN_EVALUATION_ROWS");
  });
  it("admits chronological post-freeze real rows only with timely receipt; forbids fabricated future rows", () => {
    const value = { ...fixture([8_000, 10_000]), dataKind: "HISTORICAL" };
    value.datasets[0]!.source.uri = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?stockNo=0056";
    expect(parseCostCoveredExitInput(value, freeze, freeze + 3 * step).dataKind).toBe("HISTORICAL");
    expect(() => parseCostCoveredExitInput(value, freeze, freeze + step)).toThrow("future real");
    value.datasets[0]!.rows[39]!.receivedAtTimestamp = freeze + 2 * step;
    expect(() => parseCostCoveredExitInput(value, freeze, freeze + 3 * step)).toThrow("LATE_RECEIPT");
  });
  it("preserves causal earlier decisions when only future observations change", () => {
    const first = run(fixture([8_000, 10_000, 10_000, 11_000, 12_000])).results[0]!.candidate;
    const second = run(fixture([8_000, 10_000, 10_000, 50_000, 1_000])).results[0]!.candidate;
    expect(first.journal.filter((item) => item.timestamp <= freeze + 3 * step)).toEqual(second.journal.filter((item) => item.timestamp <= freeze + 3 * step));
  });
  it("uses a two-sided descriptive interval including breakevens in the complete-trade denominator", () => {
    expect(descriptiveWilson95(0, 0)).toBeNull();
    expect(descriptiveWilson95(0, 1)!.upper).toBeGreaterThan(0.79);
    expect(descriptiveWilson95(1, 2)!.lower).toBeLessThan(0.1);
    expect(descriptiveWilson95(1, 2)!.upper).toBeGreaterThan(0.9);
  });
});
