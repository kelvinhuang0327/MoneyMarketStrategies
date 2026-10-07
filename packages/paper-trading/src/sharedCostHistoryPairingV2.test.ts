import { describe, expect, it } from "vitest";
import { explainSharedCostPairsV2 } from "../../../scripts/sharedCostHistoryPairingV2.mjs";
const trade = { openedAtTimestamp: 1, enteredQuantity: 3, entryCostMinor: 201n, rightCensored: false,
  closedAtTimestamp: 3, holdingCalendarDays: 2, holdingTradingIntervals: 2, costGateBlockCount: 0, exitTrigger: null, netPnlMinor: 10n };

describe("v2 exact-entry comparison accounting", () => {
  it("keeps changed entries unmatched and explains the observed held position", () => {
    const old = { completedTrades: [trade, { ...trade, openedAtTimestamp: 5 }], openTrade: null };
    const next = { completedTrades: [{ ...trade, closedAtTimestamp: 8, holdingCalendarDays: 7 }], openTrade: null };
    const comparison = explainSharedCostPairsV2(old, next, [{ timestamp: 5, positionQuantity: 3 }]);
    expect(comparison).toMatchObject({ matchedBothClosed: 1, unmatchedBaselineClosedTrades: 1 });
    expect(comparison.unmatchedBaseline).toMatchObject([{ openedAtTimestamp: 5, candidatePositionAtBaselineEntry: 3,
      reason: "CANDIDATE_HOLDING_A_DIFFERENT_ENTRY_AT_BASELINE_FILL_TIME" }]);
  });
  it("lists both-open exact entries without inventing paired PnL or completed trades", () => {
    const open = { ...trade, rightCensored: true, closedAtTimestamp: undefined, markedOpenTradeNetPnlMinor: -15n };
    const comparison = explainSharedCostPairsV2({ completedTrades: [], openTrade: open }, { completedTrades: [], openTrade: open }, []);
    expect(comparison.matchedBothClosed).toBe(0);
    expect(comparison.exactEntryPairsIncludingOpen).toMatchObject([{ comparableCompletedPair: false,
      baseline: { rightCensored: true, netPnlMinor: null }, candidate: { rightCensored: true, netPnlMinor: null } }]);
    expect(comparison.unmatchedBaseline).toEqual([]);
    expect(comparison.unmatchedCandidate).toEqual([]);
  });
});
