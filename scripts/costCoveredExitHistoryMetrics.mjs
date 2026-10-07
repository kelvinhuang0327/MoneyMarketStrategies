const DAY_MS = 86_400_000;
const amount = (value) => BigInt(value);
const ratio = (numerator, denominator) => denominator === 0n ? null : Number(numerator) / Number(denominator);

export function summarizeHistoricalReplay(replay, observations, exitAudit, window, initialCapitalMinor, terminalLiquidationEquityMinor) {
  const initial = amount(initialCapitalMinor);
  const account = replay.accountSummary;
  const stats = replay.tradingStatistics;
  const fills = new Map(replay.journal.filter((item) => item.kind === "fill").map((item) => [item.fillId, item]));
  const orders = new Map();
  for (const event of replay.journal) if (event.kind === "order" && !orders.has(event.clientOrderId)) orders.set(event.clientOrderId, event);
  const audits = new Map(exitAudit.map((event) => [event.sourceEventId, event]));
  const index = new Map(observations.map((event, i) => [event.timestamp, i]));
  function tradeDetail(trade, closed) {
    const end = closed ? trade.closedAtTimestamp : window.endTimestamp;
    const startIndex = index.get(trade.openedAtTimestamp), endIndex = index.get(end);
    if (startIndex === undefined || (closed && endIndex === undefined)) throw new Error("trade holding endpoints lack market observations");
    const entry = trade.entryFillIds.map((id) => {
      const fill = fills.get(id);
      if (!fill || fill.side !== "buy") throw new Error("trade entry fill is missing");
      return fill;
    });
    const entryExecutionNotionalMinor = entry.reduce((sum, fill) => sum + amount(fill.executionPriceMinor) * BigInt(fill.quantity), 0n);
    const entryFeesMinor = entry.reduce((sum, fill) => sum + amount(fill.feeMinor), 0n);
    const entryCostMinor = entryExecutionNotionalMinor + entryFeesMinor;
    const lastExit = closed ? fills.get(trade.exitFillIds.at(-1)) : null;
    const submit = lastExit ? orders.get(lastExit.clientOrderId) : null;
    const trigger = submit ? audits.get(submit.sourceEventId) : null;
    const blocks = exitAudit.filter((event) => event.kind === "BELOW_COST_BLOCK" && event.timestamp >= trade.openedAtTimestamp && (closed ? event.timestamp < end : event.timestamp <= end));
    return {
      ...trade,
      rightCensored: !closed,
      entryExecutionNotionalMinor, entryFeesMinor, entryCostMinor,
      holdingTradingIntervals: (endIndex ?? observations.length - 1) - startIndex,
      holdingCalendarDays: (end - trade.openedAtTimestamp) / DAY_MS,
      costGateBlockCount: blocks.length,
      firstCostGateBlock: blocks[0] ?? null,
      exitTrigger: trigger ?? null,
      ...(!closed ? { markedOpenTradeNetPnlMinor: amount(account.unrealizedPnlMinor) + amount(trade.realizedPnlMinor) } : {}),
    };
  }
  const completedTrades = stats.completedTrades.map((trade) => tradeDetail(trade, true));
  const openTrade = stats.incompleteTrade === null ? null : tradeDetail(stats.incompleteTrade, false);
  const curve = replay.equityCurve.filter((point) => point.timestamp >= window.startTimestamp).map((point) => {
    const observed = observations[index.get(point.timestamp)];
    if (!observed) throw new Error("equity point lacks an accepted observation");
    return { ...point, equityMinor: amount(point.equityMinor), positionNotionalMinor: amount(observed.priceMinor) * BigInt(observed.positionQuantity) };
  });
  if (!curve.length) throw new Error("historical window has no equity observations");
  const path = [{ timestamp: window.startTimestamp, equityMinor: initial, positionNotionalMinor: 0n }, ...curve];
  if (path.at(-1).timestamp < window.endTimestamp) path.push({ ...path.at(-1), timestamp: window.endTimestamp });
  let peak = initial, maximumDrawdownFraction = 0;
  let exposureTimeNumerator = 0, heldTimeMs = 0;
  for (let i = 0; i < path.length; i += 1) {
    const point = path[i];
    if (point.equityMinor > peak) peak = point.equityMinor;
    maximumDrawdownFraction = Math.max(maximumDrawdownFraction, ratio(peak - point.equityMinor, peak) ?? 0);
    const duration = (path[i + 1]?.timestamp ?? point.timestamp) - point.timestamp;
    if (duration < 0) throw new Error("exposure observations are not chronological");
    exposureTimeNumerator += (ratio(point.positionNotionalMinor, initial) ?? 0) * duration;
    if (point.positionNotionalMinor > 0n) heldTimeMs += duration;
  }
  const totalTimeMs = window.endTimestamp - window.startTimestamp;
  const decisions = replay.journal.filter((event) => event.kind === "decision" && event.timestamp >= window.startTimestamp);
  const counts = {
    acceptedEvaluationEvents: observations.length,
    noSignalFlatDecisions: decisions.filter((event) => event.currentPositionQuantity === 0 && event.targetPositionQuantity === 0).length,
    riskRejected: decisions.filter((event) => event.status === "risk-rejected").length,
    ordersSubmitted: decisions.filter((event) => event.status === "order-submitted").length,
    fills: fills.size,
    decisionReasons: Object.fromEntries([...new Set(decisions.map((event) => event.reasonCode))].map((reason) => [reason, decisions.filter((event) => event.reasonCode === reason).length])),
  };
  return {
    strategyVersion: replay.strategyVersion, simulationSettings: replay.simulationSettings,
    completedTradeCount: completedTrades.length, wins: stats.wins, losses: stats.losses, breakevens: stats.breakevens,
    winRate: stats.netWinRate,
    netReturnAfterModeledCostsFraction: ratio(amount(account.equityMinor) - initial, initial),
    terminalLiquidationEstimateReturnFraction: ratio(amount(terminalLiquidationEquityMinor) - initial, initial),
    maximumDrawdownFraction,
    maximumExposureFractionOfInitialCapital: Math.max(0, ...curve.map((point) => ratio(point.positionNotionalMinor, initial) ?? 0)),
    averageExposureFractionOfInitialCapital: curve.reduce((sum, point) => sum + (ratio(point.positionNotionalMinor, initial) ?? 0), 0) / curve.length,
    calendarWeightedExposureFractionOfInitialCapital: totalTimeMs > 0 ? exposureTimeNumerator / totalTimeMs : null,
    fractionOfEvaluationEventsWithPosition: curve.filter((point) => point.positionNotionalMinor > 0n).length / curve.length,
    calendarTimeFractionWithPosition: totalTimeMs > 0 ? heldTimeMs / totalTimeMs : null,
    averageCompletedHoldingTradingIntervals: completedTrades.length ? completedTrades.reduce((sum, trade) => sum + trade.holdingTradingIntervals, 0) / completedTrades.length : null,
    averageCompletedHoldingCalendarDays: completedTrades.length ? completedTrades.reduce((sum, trade) => sum + trade.holdingCalendarDays, 0) / completedTrades.length : null,
    openPositionQuantity: account.positionQuantity, pendingOrder: account.activeOrder,
    initialCapitalMinor: initial, finalEquityMinor: amount(account.equityMinor), terminalLiquidationEstimateEquityMinor: amount(terminalLiquidationEquityMinor),
    realizedPnlMinor: amount(account.realizedPnlMinor), unrealizedPnlMinor: amount(account.unrealizedPnlMinor), feesPaidMinor: amount(account.feesPaidMinor),
    completedTrades, openTrade, counts, equityAndExposureCurve: path,
    accountReconciliation: replay.accountReconciliation,
  };
}

/** Exact-entry pairing is a mechanism diagnostic. Unmatched and open trades
 * remain in whole-window results; trades are never paired by ordinal or wins.
 */
export function compareSameEntryTrades(baseline, candidate) {
  const key = (trade) => `${trade.openedAtTimestamp}:${trade.enteredQuantity}:${trade.entryCostMinor}`;
  const baselineEntries = new Map(baseline.completedTrades.map((trade) => [key(trade), trade]));
  const pairs = [];
  for (const trade of [...candidate.completedTrades, ...(candidate.openTrade ? [candidate.openTrade] : [])]) {
    const reference = baselineEntries.get(key(trade));
    if (!reference) continue;
    pairs.push({
      openedAtTimestamp: trade.openedAtTimestamp, entryCostMinor: trade.entryCostMinor,
      baselineNetPnlMinor: reference.netPnlMinor,
      candidateNetPnlMinor: trade.rightCensored ? null : trade.netPnlMinor,
      candidateMarkedOpenPnlMinor: trade.rightCensored ? trade.markedOpenTradeNetPnlMinor : null,
      additionalHoldingTradingIntervals: trade.holdingTradingIntervals - reference.holdingTradingIntervals,
      additionalHoldingCalendarDays: trade.holdingCalendarDays - reference.holdingCalendarDays,
      candidateCostGateBlocks: trade.costGateBlockCount,
      candidateExitTrigger: trade.exitTrigger,
      netPnlDifferenceMinor: trade.rightCensored ? null : amount(trade.netPnlMinor) - amount(reference.netPnlMinor),
      classification: trade.rightCensored ? "CANDIDATE_OPEN_NO_CLOSED_TRADE_COMPARISON"
        : trade.costGateBlockCount > 0 && trade.exitTrigger?.kind === "FORCED_EXIT" && amount(trade.netPnlMinor) < 0n
          ? "BLOCKED_THEN_FORCED_LOSS" : "BOTH_CLOSED",
    });
  }
  const forcedLosses = candidate.completedTrades.filter((trade) => trade.costGateBlockCount > 0 && trade.exitTrigger?.kind === "FORCED_EXIT" && amount(trade.netPnlMinor) < 0n);
  const closedPairs = pairs.filter((pair) => pair.netPnlDifferenceMinor !== null);
  return {
    matchedEntries: pairs.length, matchedBothClosed: closedPairs.length,
    unmatchedBaselineClosedTrades: baseline.completedTrades.length - pairs.length,
    unmatchedCandidateClosedTrades: candidate.completedTrades.length - closedPairs.length,
    candidateBlockedThenForcedLossCount: forcedLosses.length,
    candidateBlockedThenForcedLossNetPnlMinor: forcedLosses.reduce((sum, trade) => sum + amount(trade.netPnlMinor), 0n),
    matchedPairsWithLongerHolding: pairs.filter((pair) => pair.additionalHoldingTradingIntervals > 0).length,
    matchedClosedPairsWithWorseNetPnl: closedPairs.filter((pair) => pair.netPnlDifferenceMinor < 0n).length,
    matchedClosedPairsWithBetterNetPnl: closedPairs.filter((pair) => pair.netPnlDifferenceMinor > 0n).length,
    matchedClosedPairsWithSameNetPnl: closedPairs.filter((pair) => pair.netPnlDifferenceMinor === 0n).length,
    pairs,
  };
}

/** Four independent equal-capital runs, not a shared-risk portfolio. Calendar
 * alignment carries the last observed mark; missing dates are disclosed outside.
 */
export function aggregateIndependentSummaries(summaries, window) {
  if (!summaries.length) throw new Error("no independent summaries");
  const initial = summaries.reduce((sum, item) => sum + amount(item.initialCapitalMinor), 0n);
  const times = [...new Set(summaries.flatMap((item) => item.equityAndExposureCurve.map((point) => point.timestamp)))].sort((a, b) => a - b);
  const indices = summaries.map(() => 0);
  const curve = times.map((timestamp) => {
    let equityMinor = 0n, positionNotionalMinor = 0n;
    for (let i = 0; i < summaries.length; i += 1) {
      const path = summaries[i].equityAndExposureCurve;
      while (path[indices[i] + 1]?.timestamp <= timestamp) indices[i] += 1;
      equityMinor += amount(path[indices[i]].equityMinor); positionNotionalMinor += amount(path[indices[i]].positionNotionalMinor);
    }
    return { timestamp, equityMinor, positionNotionalMinor };
  });
  let peak = initial, maximumDrawdownFraction = 0, exposureTimeNumerator = 0;
  for (let i = 0; i < curve.length; i += 1) {
    const point = curve[i];
    if (point.equityMinor > peak) peak = point.equityMinor;
    maximumDrawdownFraction = Math.max(maximumDrawdownFraction, ratio(peak - point.equityMinor, peak) ?? 0);
    exposureTimeNumerator += (ratio(point.positionNotionalMinor, initial) ?? 0) * ((curve[i + 1]?.timestamp ?? point.timestamp) - point.timestamp);
  }
  const completedTrades = summaries.flatMap((item) => item.completedTrades);
  const wins = summaries.reduce((sum, item) => sum + item.wins, 0);
  const totalTimeMs = window.endTimestamp - window.startTimestamp;
  const equity = summaries.reduce((sum, item) => sum + amount(item.finalEquityMinor), 0n);
  return {
    capitalMeaning: "SUM_OF_FOUR_INDEPENDENT_EQUAL_CAPITAL_RUNS_NOT_SHARED_RISK_PORTFOLIO",
    initialCapitalMinor: initial, finalEquityMinor: equity,
    completedTradeCount: completedTrades.length, wins,
    losses: summaries.reduce((sum, item) => sum + item.losses, 0), breakevens: summaries.reduce((sum, item) => sum + item.breakevens, 0),
    winRate: completedTrades.length ? wins / completedTrades.length : null,
    netReturnAfterModeledCostsFraction: ratio(equity - initial, initial),
    terminalLiquidationEstimateReturnFraction: ratio(summaries.reduce((sum, item) => sum + amount(item.terminalLiquidationEstimateEquityMinor), 0n) - initial, initial),
    maximumDrawdownFraction,
    maximumExposureFractionOfInitialCapital: Math.max(0, ...curve.map((point) => ratio(point.positionNotionalMinor, initial) ?? 0)),
    calendarWeightedExposureFractionOfInitialCapital: totalTimeMs > 0 ? exposureTimeNumerator / totalTimeMs : null,
    meanSymbolCalendarTimeFractionWithPosition: summaries.reduce((sum, item) => sum + (item.calendarTimeFractionWithPosition ?? 0), 0) / summaries.length,
    meanSymbolEvaluationEventFractionWithPosition: summaries.reduce((sum, item) => sum + item.fractionOfEvaluationEventsWithPosition, 0) / summaries.length,
    averageCompletedHoldingTradingIntervals: completedTrades.length ? completedTrades.reduce((sum, trade) => sum + trade.holdingTradingIntervals, 0) / completedTrades.length : null,
    averageCompletedHoldingCalendarDays: completedTrades.length ? completedTrades.reduce((sum, trade) => sum + trade.holdingCalendarDays, 0) / completedTrades.length : null,
    openPositionQuantities: summaries.map((item) => item.openPositionQuantity), openTradeCount: summaries.filter((item) => item.openTrade !== null).length,
    pendingOrderCount: summaries.filter((item) => item.pendingOrder !== null).length,
    feesPaidMinor: summaries.reduce((sum, item) => sum + amount(item.feesPaidMinor), 0n),
    equityAndExposureCurve: curve,
  };
}
