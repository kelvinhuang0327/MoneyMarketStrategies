import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { explainSharedCostPairsV2 } from "./sharedCostHistoryPairingV2.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const encode = value => `${JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2)}\n`;

// Open-trade summaries expose remaining positionQuantity, not original enteredQuantity.
// Recover original entry size from the immutable entry fills, including partial exits.
export function recoverFilledEntryQuantity(summary, journal) {
  const fills = new Map(journal.filter(e => e.kind === "fill").map(e => [e.fillId, e]));
  const normalize = trade => {
    const entry = trade.entryFillIds.map(id => {
      const fill = fills.get(id);
      if (!fill || fill.side !== "buy" || !Number.isSafeInteger(fill.quantity) || fill.quantity <= 0) throw new Error("MISSING_OR_INVALID_ENTRY_FILL");
      return fill;
    });
    const enteredQuantity = entry.reduce((n, f) => n + f.quantity, 0);
    const entryCost = entry.reduce((n, f) => n + BigInt(f.executionPriceMinor) * BigInt(f.quantity) + BigInt(f.feeMinor), 0n);
    if (!enteredQuantity || !Number.isSafeInteger(enteredQuantity) || entryCost !== BigInt(trade.entryCostMinor)
      || (trade.enteredQuantity !== undefined && trade.enteredQuantity !== enteredQuantity)) throw new Error("ENTRY_FILL_RECONCILIATION_FAILED");
    return { ...trade, enteredQuantity };
  };
  return { ...summary, completedTrades: summary.completedTrades.map(normalize), openTrade: summary.openTrade ? normalize(summary.openTrade) : null };
}

export function auditSavedSharedCostHistoryV2() {
  const experiment = "packages/paper-trading/experiments/shared-cost-history-development-v2/";
  const plan = json(`${experiment}plan.json`);
  const inputSha = "3c1cb4201fa1248137082cb757f798bc22eeb62f2f05e2b43061aedceff67511";
  const resultPath = `${plan.outputDirectory}/${inputSha}.result.json`;
  const resultBytes = readFileSync(resolve(root, resultPath)), result = JSON.parse(resultBytes);
  const protocol = json(plan.protocol.path);
  const verify = pins => { for (const [path, hash] of Object.entries(pins)) if (sha(readFileSync(resolve(root, path))) !== hash) throw new Error(`HASH_MISMATCH: ${path}`); };
  verify(plan.originalEvidenceSha256); verify(plan.sourceSha256); verify(protocol.sourceSha256); verify(result.rawReplaySha256);
  verify({ [plan.originalInput.path]: plan.originalInput.sha256, [plan.csv.path]: plan.csv.sha256, [plan.protocol.path]: plan.protocol.sha256,
    [`${experiment}plan.json`]: result.planSha256, [`${plan.outputDirectory}/${inputSha}.input.json`]: inputSha });
  const mechanisms = result.results.map(row => {
    const baseline = recoverFilledEntryQuantity(row.baseline, json(`${plan.outputDirectory}/${inputSha}.${row.symbol}.baseline.replay.json`).replay.journal);
    const raw = json(`${plan.outputDirectory}/${inputSha}.${row.symbol}.candidate.replay.json`);
    const candidate = recoverFilledEntryQuantity(row.candidate, raw.replay.journal);
    return { symbol: row.symbol, ...explainSharedCostPairsV2(baseline, candidate, raw.observations) };
  });
  for (const row of result.results) for (const arm of ["baseline", "candidate", "costMatchedBenchmark"]) {
    const d = row[arm];
    if (d.completedTradeCount !== d.completedTrades.length || d.wins + d.losses + d.breakevens !== d.completedTradeCount
      || d.winRate !== (d.completedTradeCount ? d.wins / d.completedTradeCount : null)
      || BigInt(d.finalEquityMinor) !== BigInt(d.initialCapitalMinor) + BigInt(d.realizedPnlMinor) + BigInt(d.unrealizedPnlMinor)
      || !d.accountReconciliation.equityMatches) throw new Error("ACCOUNT_OR_DENOMINATOR_MISMATCH");
  }
  const priorPath = "../cost-covered-exit-cost-sensitivity-v1/packages/paper-trading/experiments/cost-covered-exit-cost-sensitivity-v1/result.json";
  const prior = json(priorPath).scenarios.find(s => s.id === "undiscounted_min20_plus_tax");
  if (!prior) throw new Error("MISSING_FIXED_COST_SCENARIO");
  for (const arm of ["baseline", "costMatchedBenchmark"]) {
    const d = result.aggregate[arm], old = prior.aggregate[arm];
    if (BigInt(d.finalEquityMinor) - BigInt(d.initialCapitalMinor) !== BigInt(old.netPnlMinor)
      || d.maximumDrawdownFraction !== old.maximumDrawdownFraction || d.completedTradeCount !== old.completedTradeCount) throw new Error("UNCHANGED_ARM_FIXED_FILL_COST_COMPARISON_FAILED");
  }
  const closedDifference = mechanisms.flatMap(m => m.pairs).filter(p => p.netPnlDifferenceMinor !== null).reduce((n, p) => n + BigInt(p.netPnlDifferenceMinor), 0n);
  const censored = mechanisms.flatMap(m => m.pairs.filter(p => p.netPnlDifferenceMinor === null).map(p => ({ symbol: m.symbol, ...p })));
  const markedDifference = BigInt(result.aggregate.candidate.finalEquityMinor) - BigInt(result.aggregate.baseline.finalEquityMinor);
  if (closedDifference + censored.reduce((n, p) => n + BigInt(p.candidateMarkedOpenPnlMinor) - BigInt(p.baselineNetPnlMinor), 0n) !== markedDifference) throw new Error("PAIRED_TO_WINDOW_RECONCILIATION_FAILED");
  return { schemaVersion: 2, classification: result.classification, status: "SAVED_HISTORY_AUDITED_WITH_OPEN_ENTRY_PAIRING_CORRECTION_NO_REPLAY",
    sourceResult: { path: resultPath, sha256: sha(resultBytes) }, planSha256: result.planSha256, inputSha256: inputSha,
    protocolSha256: result.protocolSha256, originalEvidenceCount: Object.keys(plan.originalEvidenceSha256).length,
    reportingCorrection: { reason: "Original pairing used absent enteredQuantity on right-censored open summaries. Recover original quantity from saved entry fills; never infer from remaining position after partial exits.",
      rawResultPreserved: true, strategyOrCostChanges: false, historicalReplaysAdded: 0,
      affectedSymbol: "0056", affectedEntryTimestamp: 1784698200000,
      previouslyUnmatchedEntryNowExact: true, stillExcludedFromCompletedPairPnl: true },
    perSymbol: result.results.map(row => ({ symbol: row.symbol, warmupRows: row.warmupRows, evaluationRows: row.evaluationRows,
      arms: Object.fromEntries(["baseline", "candidate", "costMatchedBenchmark"].map(arm => [arm,
        Object.fromEntries(Object.entries(row[arm]).filter(([k]) => !["equityAndExposureCurve", "simulationSettings", "perFillCostComponents"].includes(k)))])) })),
    aggregate: Object.fromEntries(Object.entries(result.aggregate).map(([a, d]) => [a, Object.fromEntries(Object.entries(d).filter(([k]) => k !== "equityAndExposureCurve"))])),
    sideEffects: result.sideEffects, mechanisms,
    pairedExplanation: { exactEntryCount: mechanisms.reduce((n, m) => n + m.matchedEntries, 0), bothClosedCount: mechanisms.reduce((n, m) => n + m.matchedBothClosed, 0),
      closedPairNetDifferenceMinor: closedDifference, censoredPairs: censored, markedWholeWindowDifferenceMinor: markedDifference,
      candidateMinusBaselineTerminalLiquidationEstimateMinor: result.results.reduce((n, row) => n + BigInt(row.candidate.terminalLiquidationEstimateEquityMinor) - BigInt(row.baseline.terminalLiquidationEstimateEquityMinor), 0n) },
    costComparison: { sourcePath: priorPath, sourceSha256: sha(readFileSync(resolve(root, priorPath))), baselineAndBenchmarkExactlyMatchPriorMin20CostSensitivity: true,
      priorCandidateFixedFillCompletedCount: prior.aggregate.candidate.completedTradeCount, priorCandidateFixedFillNetPnlMinor: prior.aggregate.candidate.netPnlMinor,
      actualV2CandidateCompletedCount: result.aggregate.candidate.completedTradeCount,
      explanation: "Costs enter actual v2 decisions and executions; prior candidate cost sensitivity only repriced v1 fills and retained v1 exit dates." },
    resources: result.resources, certifiedUnseenForwardRows: 0,
    checks: { ...result.checks, allOriginal13EvidenceHashesVerified: true, preregisteredSourceAndFrozenProtocolPinsUnchanged: true, all12NewReplayHashesVerified: true,
      completedAndOpenEntryQuantityReconciledFromActualFills: true, completedDenominatorsAndAccountPnlVerified: true, pairedAndCensoredPnlExplainWholeWindowDifference: true },
    limitations: result.limitations, disposition: "SMALL_DEVELOPMENT_POINT_GAIN_WITH_CENSORING_AND_DELAYED_LOSS_DOES_NOT_ESTABLISH_IMPROVEMENT_STOP_VARIANT_EXPANSION" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("No overrides; audit saved fixed result only");
  const summary = auditSavedSharedCostHistoryV2();
  const output = resolve(root, "packages/paper-trading/experiments/shared-cost-history-development-v2/result-summary.json");
  let saved = null;
  try { saved = readFileSync(output, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (saved !== null && saved !== encode(summary)) throw new Error("SAVED_AUDIT_SUMMARY_DIFFERS_NO_OVERWRITE");
  if (saved === null) writeFileSync(output, encode(summary), { flag: "wx" });
  process.stdout.write(encode({ status: summary.status, pairedExplanation: summary.pairedExplanation, checks: summary.checks }));
}
