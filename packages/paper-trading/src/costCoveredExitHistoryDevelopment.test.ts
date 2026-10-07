import { describe, expect, it } from "vitest";
import { aggregateIndependentSummaries, compareSameEntryTrades, summarizeHistoricalReplay } from "../../../scripts/costCoveredExitHistoryMetrics.mjs";

const day = 86_400_000, window = { startTimestamp: 0, endTimestamp: 4 * day };
function closedFixture() {
  return {
    strategyVersion: "TEST", simulationSettings: {},
    accountSummary: { cashMinor: 970n, equityMinor: 970n, positionQuantity: 0, markPriceMinor: 86n, realizedPnlMinor: -30n, unrealizedPnlMinor: 0n, feesPaidMinor: 2n, activeOrder: null },
    tradingStatistics: {
      wins: 0, losses: 1, breakevens: 0, netWinRate: 0,
      completedTrades: [{ tradeNumber: 1, openedAtTimestamp: day, closedAtTimestamp: 4 * day, enteredQuantity: 2, entryFillIds: ["buy"], exitFillIds: ["sell"], netPnlMinor: -30n }], incompleteTrade: null,
    },
    journal: [
      { kind: "fill", fillId: "buy", side: "buy", quantity: 2, executionPriceMinor: 100n, feeMinor: 1n, clientOrderId: "entry", timestamp: day },
      { kind: "order", clientOrderId: "exit", sourceEventId: "exit-signal", timestamp: day },
      { kind: "fill", fillId: "sell", side: "sell", quantity: 2, executionPriceMinor: 86n, feeMinor: 1n, clientOrderId: "exit", timestamp: 4 * day },
    ],
    equityCurve: [{ timestamp: 0, equityMinor: 1000n }, { timestamp: day, equityMinor: 999n }, { timestamp: 4 * day, equityMinor: 970n }],
    accountReconciliation: { equityMatches: true },
  };
}
const observations = [
  { timestamp: 0, priceMinor: 100n, positionQuantity: 0 },
  { timestamp: day, priceMinor: 100n, positionQuantity: 2 },
  { timestamp: 4 * day, priceMinor: 86n, positionQuantity: 0 },
];

describe("historical development metric derivations", () => {
  it("uses actual entry fees, actual filled holding endpoints and calendar-weighted exposure across gaps", () => {
    const summary = summarizeHistoricalReplay(closedFixture(), observations, [{ kind: "COST_COVERED_EXIT", sourceEventId: "exit-signal", timestamp: day }], window, 1000n, 970n);
    expect(summary.completedTrades[0]).toMatchObject({ entryCostMinor: 201n, entryFeesMinor: 1n, holdingCalendarDays: 3, holdingTradingIntervals: 1, exitTrigger: { kind: "COST_COVERED_EXIT" } });
    expect(summary.netReturnAfterModeledCostsFraction).toBe(-0.03);
    expect(summary.maximumDrawdownFraction).toBe(0.03);
    expect(summary.fractionOfEvaluationEventsWithPosition).toBeCloseTo(1 / 3);
    expect(summary.calendarTimeFractionWithPosition).toBe(0.75);
    expect(summary.calendarWeightedExposureFractionOfInitialCapital).toBeCloseTo(0.15);
  });
  it("keeps an open loss right-censored, including final-day gate blocks, with a null win denominator", () => {
    const fixture = closedFixture();
    const replay = {
      ...fixture,
      accountSummary: { ...fixture.accountSummary, cashMinor: 799n, equityMinor: 979n, positionQuantity: 2, unrealizedPnlMinor: -21n, realizedPnlMinor: 0n, feesPaidMinor: 1n },
      tradingStatistics: { wins: 0, losses: 0, breakevens: 0, netWinRate: null, completedTrades: [], incompleteTrade: { openedAtTimestamp: day, enteredQuantity: 2, positionQuantity: 2, realizedPnlMinor: 0n, entryFillIds: ["buy"], exitFillIds: [] } },
      journal: fixture.journal.filter((item) => item.kind === "fill" && item.side === "buy"),
      equityCurve: [fixture.equityCurve[0], fixture.equityCurve[1], { timestamp: 4 * day, equityMinor: "979" }],
    };
    const held = [observations[0], observations[1], { timestamp: 4 * day, priceMinor: 90n, positionQuantity: 2 }];
    const summary = summarizeHistoricalReplay(replay, held, [{ kind: "BELOW_COST_BLOCK", sourceEventId: "last", timestamp: 4 * day }], window, 1000n, 977n);
    expect(summary).toMatchObject({ completedTradeCount: 0, winRate: null, openPositionQuantity: 2, averageCompletedHoldingCalendarDays: null });
    expect(summary.openTrade).toMatchObject({ rightCensored: true, holdingCalendarDays: 3, costGateBlockCount: 1, markedOpenTradeNetPnlMinor: -21n });
    expect(summary.terminalLiquidationEstimateReturnFraction).toBeLessThan(summary.netReturnAfterModeledCostsFraction);
  });
  it("pairs only identical filled entries and exposes worse delayed forced losses without discarding unmatched winners", () => {
    const trade = { openedAtTimestamp: day, enteredQuantity: 2, entryCostMinor: 201n, rightCensored: false, costGateBlockCount: 0, exitTrigger: null, holdingTradingIntervals: 1, holdingCalendarDays: 1, netPnlMinor: -10n };
    const baseline = { completedTrades: [trade], openTrade: null };
    const delayed = { ...trade, holdingTradingIntervals: 3, holdingCalendarDays: 3, netPnlMinor: -30n, costGateBlockCount: 2, exitTrigger: { kind: "FORCED_EXIT" } };
    const unmatched = { ...trade, openedAtTimestamp: 10 * day, netPnlMinor: 100n };
    const comparison = compareSameEntryTrades(baseline, { completedTrades: [unmatched, delayed], openTrade: null });
    expect(comparison).toMatchObject({ matchedEntries: 1, matchedBothClosed: 1, unmatchedCandidateClosedTrades: 1, candidateBlockedThenForcedLossCount: 1, matchedClosedPairsWithWorseNetPnl: 1 });
    expect(comparison.pairs[0]).toMatchObject({ classification: "BLOCKED_THEN_FORCED_LOSS", additionalHoldingCalendarDays: 2, netPnlDifferenceMinor: -20n });
  });
  it("computes summed-equity drawdown rather than averaging constituent drawdowns, preserving zero trades", () => {
    const fields = { initialCapitalMinor: 1000n, finalEquityMinor: 1000n, terminalLiquidationEstimateEquityMinor: 1000n, completedTrades: [], wins: 0, losses: 0, breakevens: 0, openPositionQuantity: 0, openTrade: null, pendingOrder: null, feesPaidMinor: 0n, calendarTimeFractionWithPosition: 0.75, fractionOfEvaluationEventsWithPosition: 1 / 3 };
    const path = (middle: bigint) => [{ timestamp: 0, equityMinor: 1000n, positionNotionalMinor: 0n }, { timestamp: day, equityMinor: middle, positionNotionalMinor: 100n }, { timestamp: 4 * day, equityMinor: 1000n, positionNotionalMinor: 0n }];
    const result = aggregateIndependentSummaries([{ ...fields, equityAndExposureCurve: path(1100n) }, { ...fields, equityAndExposureCurve: path(900n) }], window);
    expect(result).toMatchObject({ initialCapitalMinor: 2000n, completedTradeCount: 0, winRate: null, maximumDrawdownFraction: 0, netReturnAfterModeledCostsFraction: 0 });
    expect(result.calendarWeightedExposureFractionOfInitialCapital).toBeCloseTo(0.075);
  });
});
