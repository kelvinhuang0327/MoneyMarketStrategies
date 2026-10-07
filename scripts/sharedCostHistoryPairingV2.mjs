import { compareSameEntryTrades } from "./costCoveredExitHistoryMetrics.mjs";
const key = (trade) => `${trade.openedAtTimestamp}:${trade.enteredQuantity}:${trade.entryCostMinor}`;

export function explainSharedCostPairsV2(baseline, candidate, candidateObservations) {
  const mechanism = compareSameEntryTrades(baseline, candidate);
  const base = [...baseline.completedTrades, ...(baseline.openTrade ? [baseline.openTrade] : [])];
  const next = [...candidate.completedTrades, ...(candidate.openTrade ? [candidate.openTrade] : [])];
  const baselineMap = new Map(base.map(t => [key(t), t]));
  const candidateMap = new Map(next.map(t => [key(t), t]));
  const detail = (trade) => ({ openedAtTimestamp: trade.openedAtTimestamp, enteredQuantity: trade.enteredQuantity,
    entryCostMinor: trade.entryCostMinor, rightCensored: trade.rightCensored,
    closedAtTimestamp: trade.closedAtTimestamp ?? null, netPnlMinor: trade.rightCensored ? null : trade.netPnlMinor,
    holdingCalendarDays: trade.holdingCalendarDays, costGateBlockCount: trade.costGateBlockCount });
  return { ...mechanism,
    exactEntryPairsIncludingOpen: next.filter(t => baselineMap.has(key(t))).map(t => {
      const old = baselineMap.get(key(t));
      return { baseline: detail(old), candidate: detail(t), comparableCompletedPair: !old.rightCensored && !t.rightCensored };
    }),
    unmatchedBaseline: base.filter(t => !candidateMap.has(key(t))).map(t => {
      const observation = candidateObservations.find(o => o.timestamp === t.openedAtTimestamp);
      return { ...detail(t), candidatePositionAtBaselineEntry: observation?.positionQuantity ?? null,
        reason: observation?.positionQuantity > 0 ? "CANDIDATE_HOLDING_A_DIFFERENT_ENTRY_AT_BASELINE_FILL_TIME"
          : "NO_IDENTICAL_FILLED_ENTRY_TIMESTAMP_QUANTITY_AND_COST" };
    }),
    unmatchedCandidate: next.filter(t => !baselineMap.has(key(t))).map(t => ({ ...detail(t),
      reason: "NO_IDENTICAL_BASELINE_FILLED_ENTRY_TIMESTAMP_QUANTITY_AND_COST" })),
    denominator: "Only identical filled-entry timestamp/quantity/actual cost, both closed, enter paired PnL. Every unmatched/open trade remains in whole-window equity/exposure and is listed separately.",
  };
}
