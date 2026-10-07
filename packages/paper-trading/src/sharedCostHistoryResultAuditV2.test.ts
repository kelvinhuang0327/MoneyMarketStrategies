import { describe, expect, it } from "vitest";
import { recoverFilledEntryQuantity } from "../../../scripts/auditSharedCostHistoryResultV2.mjs";
import { explainSharedCostPairsV2 } from "../../../scripts/sharedCostHistoryPairingV2.mjs";

const fill = { kind: "fill", fillId: "entry", side: "buy", quantity: 3, executionPriceMinor: "50", feeMinor: "20" };
const trade = { openedAtTimestamp: 1, enteredQuantity: 3, entryFillIds: ["entry"], entryCostMinor: "170", rightCensored: false,
  netPnlMinor: "-40", closedAtTimestamp: 3, holdingCalendarDays: 2, holdingTradingIntervals: 2, costGateBlockCount: 0 };
const openFields = Object.fromEntries(Object.entries(trade).filter(([key]) => key !== "enteredQuantity"));
const open = { ...openFields, positionQuantity: 3, rightCensored: true, netPnlMinor: undefined, closedAtTimestamp: undefined,
  markedOpenTradeNetPnlMinor: "-15" };

describe("saved v2 open-entry reporting audit", () => {
  it("pairs actual positionQuantity-only open schema to closed same entry without inventing completed PnL", () => {
    const baseline = recoverFilledEntryQuantity({ completedTrades: [trade], openTrade: null }, [fill]);
    const candidate = recoverFilledEntryQuantity({ completedTrades: [], openTrade: open }, [fill]);
    const d = explainSharedCostPairsV2(baseline, candidate, [{ timestamp: 1, positionQuantity: 3 }]);
    expect(d).toMatchObject({ matchedEntries: 1, matchedBothClosed: 0, unmatchedBaselineClosedTrades: 0,
      pairs: [{ netPnlDifferenceMinor: null, candidateMarkedOpenPnlMinor: "-15", classification: "CANDIDATE_OPEN_NO_CLOSED_TRADE_COMPARISON" }] });
    expect(d.unmatchedBaseline).toEqual([]);
    expect(d.unmatchedCandidate).toEqual([]);
  });
  it("uses all entry fills rather than remaining quantity after a partial exit", () => {
    const d = recoverFilledEntryQuantity({ completedTrades: [], openTrade: { ...open, positionQuantity: 1, entryFillIds: ["a", "b"], entryCostMinor: "190" } },
      [{ ...fill, fillId: "a", quantity: 1 }, { ...fill, fillId: "b", quantity: 2 }]);
    expect(d.openTrade.enteredQuantity).toBe(3);
    expect(d.openTrade.positionQuantity).toBe(1);
  });
  it("fails if an entry fill is missing or the actual quantity or basis differs", () => {
    expect(() => recoverFilledEntryQuantity({ completedTrades: [trade], openTrade: null }, [])).toThrow("MISSING_OR_INVALID_ENTRY_FILL");
    expect(() => recoverFilledEntryQuantity({ completedTrades: [{ ...trade, enteredQuantity: 4 }], openTrade: null }, [fill])).toThrow("ENTRY_FILL_RECONCILIATION_FAILED");
    expect(() => recoverFilledEntryQuantity({ completedTrades: [], openTrade: { ...open, entryCostMinor: "171" } }, [fill])).toThrow("ENTRY_FILL_RECONCILIATION_FAILED");
  });
});
