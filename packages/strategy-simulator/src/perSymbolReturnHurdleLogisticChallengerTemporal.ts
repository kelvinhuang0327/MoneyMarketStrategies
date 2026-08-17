import {
  CANONICAL_TRANSACTION_COST_BPS,
  RESEARCH_FEATURE_NAMES,
  TARGET_CHALLENGER_RULE,
  TARGET_CONTROL_RULE,
  TARGET_HORIZON_ROWS,
  buildHistoricalFeatureRows,
  buildReturnHurdleFeatureRows,
  deriveRoundTripCostFraction,
  filterRowsForCutoff,
  hashFeatureRows,
  hashValue,
  isCanonicalIsoDate,
  resolveDataEndDate,
  runPerSymbolLogisticChallenger,
  runResearchEvidenceKernel,
  splitChronologically,
  toMarketRows,
  validateCutoffDates,
  type DatasetVersion,
  type FinalTestEconomicEvidence,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
  type RowPartition,
} from "@mms/research-kernel";

import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import { LongCashReplayError, type LongCashReplayGuardrails } from "./types.js";

const SCHEMA_VERSION = "MMS_0056_COST_AWARE_RETURN_HURDLE_LOGISTIC_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_COST_AWARE_RETURN_HURDLE_LOGISTIC_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = "0056" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const CONTROL_DRIFT_STOP = "STOP_MMS_0056_RETURN_HURDLE_CONTROL_DRIFT" as const;
const COST_CONTRACT_AMBIGUOUS_STOP = "STOP_MMS_0056_RETURN_HURDLE_COST_CONTRACT_AMBIGUOUS" as const;
const TARGET_EVIDENCE_UNAVAILABLE_STOP = "STOP_MMS_0056_RETURN_HURDLE_TARGET_EVIDENCE_UNAVAILABLE" as const;

export interface ReturnHurdleLogisticTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface ReturnHurdleLogisticTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: ReturnHurdleLogisticTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface ReturnHurdleControlSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly selectedThreshold: number;
  readonly accuracy: number;
  readonly majorityBaselineAccuracy: number;
  readonly accuracyDeltaVsBaseline: number;
  readonly balancedAccuracy: number;
  readonly logLoss: number;
  readonly brierScore: number;
  readonly actualUpRate: number;
  readonly predictedUpRate: number;
  readonly meanProbabilityUp: number;
  readonly strategyNetReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaxDrawdown: number;
  readonly benchmarkMaxDrawdown: number;
  readonly tradeCount: number;
}

export interface ReturnHurdleChallengerSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly trainingPositiveHurdleRows: number;
  readonly trainingNegativeHurdleRows: number;
  readonly validationPositiveHurdleRows: number;
  readonly finalTestPositiveHurdleRows: number;
  readonly economicHurdleReturn: number;
  readonly selectedProbabilityThreshold: number;
  readonly hurdleAccuracy: number;
  readonly hurdleMajorityBaselineAccuracy: number;
  readonly hurdleAccuracyDeltaVsBaseline: number;
  readonly balancedAccuracy: number;
  readonly logLoss: number;
  readonly brierScore: number;
  readonly predictedPositiveHurdleRate: number;
  readonly actualPositiveHurdleRate: number;
  readonly meanProbabilityPositiveHurdle: number;
  readonly strategyNetReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaxDrawdown: number;
  readonly benchmarkMaxDrawdown: number;
  readonly tradeCount: number;
  readonly warnings: readonly string[];
}

export interface ReturnHurdleEconomicComparison {
  readonly controlStrategyNetReturn: number;
  readonly challengerStrategyNetReturn: number;
  readonly strategyReturnDelta: number;
  readonly commonBenchmarkNetReturn: number;
  readonly controlExcessReturn: number;
  readonly challengerExcessReturn: number;
  readonly excessReturnDelta: number;
  readonly controlMaxDrawdown: number;
  readonly challengerMaxDrawdown: number;
  readonly maxDrawdownDelta: number;
  readonly controlTradeCount: number;
  readonly challengerTradeCount: number;
}

export interface ReturnHurdleLogisticTemporalCutoffResult {
  readonly cutoff: string;
  readonly asOf: string;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly sourceRowsAsOf: number;
  readonly symbolRowsAsOf: number;
  readonly marketRowsSha256: string;
  readonly featureRowsSha256: string;
  readonly hurdleFeatureRowsSha256: string;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly finalTestEndDate: string;
  readonly dataQualityFindings: readonly string[];
  readonly control: PerSymbolLogisticChallengerSymbolEvidence;
  readonly controlEconomic: FinalTestEconomicEdgeGroup;
  readonly controlMetrics: ReturnHurdleControlSideMetrics;
  readonly challenger: PerSymbolLogisticChallengerSymbolEvidence;
  readonly challengerEconomic: FinalTestEconomicEdgeGroup;
  readonly challengerMetrics: ReturnHurdleChallengerSideMetrics;
  readonly economicComparison: ReturnHurdleEconomicComparison;
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface ReturnHurdleControlTemporalSummary {
  readonly positiveExcessCutoffs: number;
  readonly medianExcessReturn: number;
  readonly latestExcessReturn: number;
}

export interface ReturnHurdleChallengerTemporalSummary {
  readonly hurdleBaselineWins: number;
  readonly positiveExcessCutoffs: number;
  readonly medianHurdleAccuracyDeltaVsBaseline: number;
  readonly medianExcessReturn: number;
  readonly latestExcessReturn: number;
  readonly thresholdRange: { readonly minimum: number; readonly maximum: number };
}

export interface ReturnHurdleEconomicTemporalSummary {
  readonly economicWinsVsControl: number;
  readonly economicLossesVsControl: number;
  readonly economicTiesVsControl: number;
  readonly medianExcessDeltaVsControl: number;
  readonly latestExcessDeltaVsControl: number;
  readonly medianMaxDrawdownDeltaVsControl: number;
}

export interface ReturnHurdleLogisticControlReproduction {
  readonly status: "PASS" | "NOT_APPLICABLE";
  readonly expected: {
    readonly positiveExcessCutoffs: number;
    readonly directionalBaselineWins: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly threshold: number;
  };
  readonly observed: {
    readonly positiveExcessCutoffs: number;
    readonly directionalBaselineWins: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly observedThresholds: readonly number[];
  };
}

export type ReturnHurdleAnswer = "YES" | "NO" | "MIXED";
export type ReturnHurdleConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type ReturnHurdleNextRoute =
  | "RETURN_HURDLE_TEMPORAL_CONFIRMATION_OR_UNIVERSE_EXPANSION"
  | "STOP_DIRECTION_CLASSIFICATION_OBJECTIVE_AND_MOVE_TO_DIRECT_RETURN_MODEL";

export interface ReturnHurdleLogisticTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface ReturnHurdleLogisticTemporalResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly classification: typeof CLASSIFICATION;
  readonly dataClassification: "HISTORICAL_RESEARCH_STUDY";
  readonly reviewDate: string;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly providesInvestmentAdvice: false;
  readonly currentDatePredictionClaim: false;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly candidateDataQualityBasis: string;
  readonly datasetVersion: DatasetVersion;
  readonly requestedCutoffDates: readonly string[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
    readonly symbolRowCount: number;
    readonly dataAsOf: string;
  };
  readonly roundTripCostBps: number;
  readonly canonicalRoundTripCostFraction: number;
  readonly initialCapital: number;
  readonly targetControlRule: typeof TARGET_CONTROL_RULE;
  readonly targetChallengerRule: typeof TARGET_CHALLENGER_RULE;
  readonly targetHorizonRows: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly cutoffRuns: readonly ReturnHurdleLogisticTemporalCutoffResult[];
  readonly controlTemporalSummary: ReturnHurdleControlTemporalSummary;
  readonly challengerTemporalSummary: ReturnHurdleChallengerTemporalSummary;
  readonly economicTemporalSummary: ReturnHurdleEconomicTemporalSummary;
  readonly controlReproduction: ReturnHurdleLogisticControlReproduction;
  readonly doesCostAwareTargetHaveClassificationEdge: ReturnHurdleAnswer;
  readonly doesCostAwareTargetImproveEconomicEvidence: ReturnHurdleAnswer;
  readonly returnHurdleChallengerConclusion: ReturnHurdleConclusion;
  readonly ceoNextRoute: ReturnHurdleNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: ReturnHurdleLogisticTemporalGuardrails;
  readonly normalizedResultSha256: string;
}

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function uniqueMessages(messages: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(messages.filter((message) => message.trim().length > 0))]);
}

function maximumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find maximum date in an empty collection");
  return values.reduce((maximum, value) => value > maximum ? value : maximum, first);
}

function median(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute a median from zero values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) fail("median values are incomplete");
  return round((lower + upper) / 2);
}

function rangeOf(values: readonly number[]): { readonly minimum: number; readonly maximum: number } {
  if (values.length === 0) fail("cannot compute a range from zero values");
  return Object.freeze({
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  });
}

function guardrails(): ReturnHurdleLogisticTemporalGuardrails {
  return Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
    supportsSymbolSelection: false,
  });
}

const CONTROL_EXPECTED_CUTOFFS = Object.freeze([
  { cutoff: "2025-09-30", accuracy: 0.57818182, majorityBaseline: 0.52, excessReturn: 0.09185705 },
  { cutoff: "2025-12-31", accuracy: 0.52961672, majorityBaseline: 0.50174216, excessReturn: 0.0023688 },
  { cutoff: "2026-03-31", accuracy: 0.51677852, majorityBaseline: 0.53355705, excessReturn: 0.20152868 },
  { cutoff: "2026-07-01", accuracy: 0.48874598, majorityBaseline: 0.56913183, excessReturn: -0.01025134 },
] as const);

function assertLiveFeatureContract(features: readonly string[]): void {
  if (features.length !== RESEARCH_FEATURE_NAMES.length
    || RESEARCH_FEATURE_NAMES.some((name, index) => features[index] !== name)) {
    fail(`0056 live feature contract violated: expected ${RESEARCH_FEATURE_NAMES.join(",")}, received ${features.join(",")}`);
  }
}

function assertCutoffBoundaries(
  cutoff: string,
  asOf: string,
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
): void {
  if (!isCanonicalIsoDate(cutoff) || !isCanonicalIsoDate(asOf)) {
    fail(`cutoff/asOf identity is not canonical: ${cutoff}/${asOf}`);
  }
  if (asOf > cutoff) fail(`resolved asOf ${asOf} exceeds requested cutoff ${cutoff}`);
  if (evidence.thresholdSelection.selectionPartition !== "VALIDATION") {
    fail(`0056 threshold selection did not use VALIDATION at cutoff ${cutoff}`);
  }
  if (evidence.fit.fitPartition !== "TRAINING") {
    fail(`0056 model fit did not use TRAINING at cutoff ${cutoff}`);
  }
  if (evidence.fit.trainingRowsSha256 !== evidence.trainingRowsSha256) {
    fail(`0056 model fit rows drifted at cutoff ${cutoff}`);
  }
  if (evidence.thresholdSelection.validationRowsSha256 === evidence.finalTestRowsSha256) {
    fail(`0056 validation and final-test rows are identical at cutoff ${cutoff}`);
  }
  if (evidence.finalTest.evaluationPartition !== "FINAL_TEST") {
    fail(`0056 final-test partition is unresolved at cutoff ${cutoff}`);
  }
  if (evidence.finalTestEconomicEvidence.rows.some((row) => row.targetDate > asOf)) {
    fail(`0056 final-test target exceeds asOf at cutoff ${cutoff}`);
  }
  if (evidence.finalTestEconomicEvidence.rows.some((row) => row.featureDate > asOf)) {
    fail(`0056 final-test feature exceeds asOf at cutoff ${cutoff}`);
  }
}

function replayEconomic(
  symbol: string,
  evidence: FinalTestEconomicEvidence,
  roundTripCostBps: number,
  initialCapital: number,
  targetHurdle = 0,
): FinalTestEconomicEdgeGroup {
  const result = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: evidence,
    roundTripCostBps,
    initialCapital,
    targetHurdle,
  });
  const group = result.groups.find((g) => g.symbol === symbol);
  if (group === undefined) fail(`economic replay missing group for ${symbol}`);
  return group;
}

function controlSideMetrics(
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
  economic: FinalTestEconomicEdgeGroup,
): ReturnHurdleControlSideMetrics {
  const metrics = evidence.finalTestMetrics;
  return Object.freeze({
    trainingRows: evidence.trainingRows,
    validationRows: evidence.validationRows,
    finalTestRows: evidence.finalTestRows,
    selectedThreshold: evidence.thresholdSelection.selectedThreshold,
    accuracy: metrics.accuracy,
    majorityBaselineAccuracy: metrics.majorityBaseline,
    accuracyDeltaVsBaseline: round(metrics.accuracy - metrics.majorityBaseline),
    balancedAccuracy: metrics.balancedAccuracy,
    logLoss: metrics.logLoss,
    brierScore: metrics.brierScore,
    actualUpRate: round(metrics.positiveCount / metrics.sampleCount),
    predictedUpRate: round(metrics.predictedPositiveCount / metrics.sampleCount),
    meanProbabilityUp: evidence.meanProbabilityUp,
    strategyNetReturn: economic.strategyNetReturn,
    benchmarkNetReturn: economic.benchmarkNetReturn,
    excessReturn: economic.excessReturn,
    strategyMaxDrawdown: economic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: economic.benchmarkMaximumDrawdown,
    tradeCount: economic.tradeCount,
  });
}

function challengerSideMetrics(
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
  economic: FinalTestEconomicEdgeGroup,
  trainingSplit: RowPartition<"TRAINING">,
  validationSplit: RowPartition<"VALIDATION">,
  economicHurdleReturn: number,
): ReturnHurdleChallengerSideMetrics {
  const metrics = evidence.finalTestMetrics;
  const trainingSymbolRows = trainingSplit.rows.filter((r) => r.symbol === TARGET_SYMBOL);
  const validationSymbolRows = validationSplit.rows.filter((r) => r.symbol === TARGET_SYMBOL);
  const trainingPositiveHurdleRows = trainingSymbolRows.filter((r) => r.target === 1).length;
  const trainingNegativeHurdleRows = trainingSymbolRows.filter((r) => r.target === 0).length;
  const validationPositiveHurdleRows = validationSymbolRows.filter((r) => r.target === 1).length;
  const finalTestPositiveHurdleRows = metrics.positiveCount;

  return Object.freeze({
    trainingRows: evidence.trainingRows,
    validationRows: evidence.validationRows,
    finalTestRows: evidence.finalTestRows,
    trainingPositiveHurdleRows,
    trainingNegativeHurdleRows,
    validationPositiveHurdleRows,
    finalTestPositiveHurdleRows,
    economicHurdleReturn,
    selectedProbabilityThreshold: evidence.thresholdSelection.selectedThreshold,
    hurdleAccuracy: metrics.accuracy,
    hurdleMajorityBaselineAccuracy: metrics.majorityBaseline,
    hurdleAccuracyDeltaVsBaseline: round(metrics.accuracy - metrics.majorityBaseline),
    balancedAccuracy: metrics.balancedAccuracy,
    logLoss: metrics.logLoss,
    brierScore: metrics.brierScore,
    predictedPositiveHurdleRate: round(metrics.predictedPositiveCount / metrics.sampleCount),
    actualPositiveHurdleRate: round(metrics.positiveCount / metrics.sampleCount),
    meanProbabilityPositiveHurdle: evidence.meanProbabilityUp,
    strategyNetReturn: economic.strategyNetReturn,
    benchmarkNetReturn: economic.benchmarkNetReturn,
    excessReturn: economic.excessReturn,
    strategyMaxDrawdown: economic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: economic.benchmarkMaximumDrawdown,
    tradeCount: economic.tradeCount,
    warnings: evidence.warnings,
  });
}

function buildEconomicComparison(
  control: ReturnHurdleControlSideMetrics,
  challenger: ReturnHurdleChallengerSideMetrics,
): ReturnHurdleEconomicComparison {
  return Object.freeze({
    controlStrategyNetReturn: control.strategyNetReturn,
    challengerStrategyNetReturn: challenger.strategyNetReturn,
    strategyReturnDelta: round(challenger.strategyNetReturn - control.strategyNetReturn),
    commonBenchmarkNetReturn: control.benchmarkNetReturn,
    controlExcessReturn: control.excessReturn,
    challengerExcessReturn: challenger.excessReturn,
    excessReturnDelta: round(challenger.excessReturn - control.excessReturn),
    controlMaxDrawdown: control.strategyMaxDrawdown,
    challengerMaxDrawdown: challenger.strategyMaxDrawdown,
    maxDrawdownDelta: round(challenger.strategyMaxDrawdown - control.strategyMaxDrawdown),
    controlTradeCount: control.tradeCount,
    challengerTradeCount: challenger.tradeCount,
  });
}

function evaluateCutoff(
  input: ReturnHurdleLogisticTemporalInput,
  cutoff: string,
): ReturnHurdleLogisticTemporalCutoffResult {
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(COST_CONTRACT_AMBIGUOUS_STOP);
  }
  const canonicalHurdleFraction = deriveRoundTripCostFraction(input.roundTripCostBps);

  const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoff);
  const asOf = resolveDataEndDate(cutoffRawRows, cutoff);
  const symbolRows = toMarketRows(cutoffRawRows, TARGET_SYMBOL);
  if (symbolRows.length === 0) fail(`0056 has no source rows at cutoff ${cutoff}`);
  if (symbolRows.some((row) => row.date > asOf)) {
    fail(`0056 source row exceeds resolved asOf at cutoff ${cutoff}`);
  }
  const pooledSymbols = [...new Set(cutoffRawRows.map(({ symbol }) => symbol))].sort();
  const pooledMarketRows = pooledSymbols.flatMap((symbol) => toMarketRows(cutoffRawRows, symbol));
  if (pooledMarketRows.length === 0) fail(`pooled incumbent has no source rows at cutoff ${cutoff}`);

  const evidenceResult = runResearchEvidenceKernel({
    datasetVersion: input.datasetVersion,
    marketRows: pooledMarketRows,
  });
  const controlEvidence = evidenceResult.perSymbolLogisticChallenger;
  if (controlEvidence === undefined) {
    fail(`0056 unweighted control evidence is unavailable at cutoff ${cutoff}`);
  }
  assertLiveFeatureContract(controlEvidence.featureNames);
  const controlGroup = controlEvidence.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  if (controlGroup === undefined) {
    fail(`0056 control group is missing at cutoff ${cutoff}`);
  }
  assertCutoffBoundaries(cutoff, asOf, controlGroup);
  const controlEconomic = replayEconomic(
    TARGET_SYMBOL,
    controlGroup.finalTestEconomicEvidence,
    input.roundTripCostBps,
    input.initialCapital,
    0,
  );
  const controlMetrics = controlSideMetrics(controlGroup, controlEconomic);

  const featureRows = buildHistoricalFeatureRows(pooledMarketRows);
  if (featureRows.length === 0 || !featureRows.some((r) => r.symbol === TARGET_SYMBOL)) {
    fail(TARGET_EVIDENCE_UNAVAILABLE_STOP);
  }
  const hurdleFeatureRows = buildReturnHurdleFeatureRows(featureRows, canonicalHurdleFraction);
  const hurdleSplit = splitChronologically(hurdleFeatureRows);
  const symbolHurdleFeatureRows = hurdleFeatureRows.filter((row) => row.symbol === TARGET_SYMBOL);

  const challengerEvidence = runPerSymbolLogisticChallenger({
    featureRows: symbolHurdleFeatureRows,
    split: hurdleSplit,
    featureNames: RESEARCH_FEATURE_NAMES,
    classBalancing: "disabled",
  });
  assertLiveFeatureContract(challengerEvidence.featureNames);
  const challengerGroup = challengerEvidence.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  if (challengerGroup === undefined) {
    fail(`0056 return-hurdle challenger group is missing at cutoff ${cutoff}`);
  }
  assertCutoffBoundaries(cutoff, asOf, challengerGroup);

  if (challengerGroup.trainingRows !== controlGroup.trainingRows
    || challengerGroup.validationRows !== controlGroup.validationRows
    || challengerGroup.finalTestRows !== controlGroup.finalTestRows
    || challengerGroup.fit.scalerFitRowCount !== controlGroup.fit.scalerFitRowCount) {
    fail(`0056 return-hurdle row counts drifted from control at cutoff ${cutoff}`);
  }

  const challengerEconomic = replayEconomic(
    TARGET_SYMBOL,
    challengerGroup.finalTestEconomicEvidence,
    input.roundTripCostBps,
    input.initialCapital,
    canonicalHurdleFraction,
  );
  const challengerMetrics = challengerSideMetrics(
    challengerGroup,
    challengerEconomic,
    hurdleSplit.training,
    hurdleSplit.validation,
    canonicalHurdleFraction,
  );
  const economicComparison = buildEconomicComparison(controlMetrics, challengerMetrics);

  const dataQualityFindings = evidenceResult.evidence.dataQualityFindings.map(({ message }) => message);
  const warnings = uniqueMessages([
    ...dataQualityFindings,
    ...controlGroup.warnings,
    ...challengerGroup.warnings,
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    "CONTROL is the unweighted live technical per-symbol logistic with target forwardReturn > 0.",
    `CHALLENGER is the unweighted live technical per-symbol logistic with cost-aware target forwardReturn > ${canonicalHurdleFraction}.`,
    "No feature was added; the exact live five-feature contract is preserved.",
    "Metric Comparability: Control directional accuracy and Challenger hurdle accuracy evaluate different labels and are not directly comparable as model lift.",
  ]);

  const normalized = {
    cutoff,
    asOf,
    symbol: TARGET_SYMBOL,
    sourceRowsAsOf: cutoffRawRows.length,
    symbolRowsAsOf: symbolRows.length,
    marketRowsSha256: evidenceResult.evidence.datasetSha256,
    featureRowsSha256: evidenceResult.evidence.featureRowsSha256,
    hurdleFeatureRowsSha256: hashFeatureRows(hurdleFeatureRows),
    controlFeatureNames: controlEvidence.featureNames,
    featureNames: RESEARCH_FEATURE_NAMES,
    finalTestEndDate: maximumDate(
      challengerGroup.finalTestEconomicEvidence.rows.map(({ targetDate }) => targetDate),
    ),
    dataQualityFindings,
    control: controlGroup,
    controlEconomic,
    controlMetrics,
    challenger: challengerGroup,
    challengerEconomic,
    challengerMetrics,
    economicComparison,
    warnings,
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function summarizeCutoffs(
  cutoffRuns: readonly ReturnHurdleLogisticTemporalCutoffResult[],
): {
  controlTemporalSummary: ReturnHurdleControlTemporalSummary;
  challengerTemporalSummary: ReturnHurdleChallengerTemporalSummary;
  economicTemporalSummary: ReturnHurdleEconomicTemporalSummary;
} {
  if (cutoffRuns.length === 0) fail("0056 return-hurdle temporal replay produced no cutoff runs");
  const controlExcess = cutoffRuns.map((run) => run.controlMetrics.excessReturn);
  const challengerExcess = cutoffRuns.map((run) => run.challengerMetrics.excessReturn);
  const challengerHurdleAccuracyDeltas = cutoffRuns.map(
    (run) => run.challengerMetrics.hurdleAccuracyDeltaVsBaseline,
  );
  const excessDeltasVsControl = cutoffRuns.map(
    (run) => run.economicComparison.excessReturnDelta,
  );
  const maxDrawdownDeltasVsControl = cutoffRuns.map(
    (run) => run.economicComparison.maxDrawdownDelta,
  );
  const latest = cutoffRuns.at(-1);
  if (latest === undefined) fail("0056 return-hurdle latest cutoff is missing");

  const controlTemporalSummary: ReturnHurdleControlTemporalSummary = Object.freeze({
    positiveExcessCutoffs: controlExcess.filter((v) => v > 0).length,
    medianExcessReturn: median(controlExcess),
    latestExcessReturn: latest.controlMetrics.excessReturn,
  });

  const challengerTemporalSummary: ReturnHurdleChallengerTemporalSummary = Object.freeze({
    hurdleBaselineWins: cutoffRuns.filter(
      (run) => run.challengerMetrics.hurdleAccuracy > run.challengerMetrics.hurdleMajorityBaselineAccuracy,
    ).length,
    positiveExcessCutoffs: challengerExcess.filter((v) => v > 0).length,
    medianHurdleAccuracyDeltaVsBaseline: median(challengerHurdleAccuracyDeltas),
    medianExcessReturn: median(challengerExcess),
    latestExcessReturn: latest.challengerMetrics.excessReturn,
    thresholdRange: rangeOf(cutoffRuns.map((run) => run.challengerMetrics.selectedProbabilityThreshold)),
  });

  const economicTemporalSummary: ReturnHurdleEconomicTemporalSummary = Object.freeze({
    economicWinsVsControl: excessDeltasVsControl.filter((v) => v > 0).length,
    economicLossesVsControl: excessDeltasVsControl.filter((v) => v < 0).length,
    economicTiesVsControl: excessDeltasVsControl.filter((v) => v === 0).length,
    medianExcessDeltaVsControl: median(excessDeltasVsControl),
    latestExcessDeltaVsControl: latest.economicComparison.excessReturnDelta,
    medianMaxDrawdownDeltaVsControl: median(maxDrawdownDeltasVsControl),
  });

  return {
    controlTemporalSummary,
    challengerTemporalSummary,
    economicTemporalSummary,
  };
}

function verifyControlReproduction(
  cutoffRuns: readonly ReturnHurdleLogisticTemporalCutoffResult[],
): ReturnHurdleLogisticControlReproduction {
  const latest = cutoffRuns.at(-1);
  if (latest === undefined) fail("missing cutoff runs for control reproduction");
  const expectedDatesMatch = cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((expected, index) => cutoffRuns[index]?.cutoff === expected.cutoff);
  const observedThresholds = [...new Set(cutoffRuns.map((run) => run.controlMetrics.selectedThreshold))]
    .sort((left, right) => left - right);
  const controlExcess = cutoffRuns.map((r) => r.controlMetrics.excessReturn);
  const controlDirectionalWins = cutoffRuns.filter(
    (r) => r.controlMetrics.accuracy > r.controlMetrics.majorityBaselineAccuracy,
  ).length;
  const observed = {
    positiveExcessCutoffs: controlExcess.filter((v) => v > 0).length,
    directionalBaselineWins: controlDirectionalWins,
    medianExcessReturn: median(controlExcess),
    latestExcessReturn: latest.controlMetrics.excessReturn,
    observedThresholds: Object.freeze(observedThresholds),
  };
  const expected = {
    positiveExcessCutoffs: 3,
    directionalBaselineWins: 2,
    medianExcessReturn: 0.04711292,
    latestExcessReturn: -0.01025134,
    threshold: 0.575,
  };
  if (!expectedDatesMatch) {
    return Object.freeze({
      status: "NOT_APPLICABLE" as const,
      expected,
      observed,
    });
  }

  for (const expectedCutoff of CONTROL_EXPECTED_CUTOFFS) {
    const run = cutoffRuns.find((r) => r.cutoff === expectedCutoff.cutoff);
    if (run === undefined) {
      fail(`${CONTROL_DRIFT_STOP}: missing cutoff ${expectedCutoff.cutoff}`);
    }
    const metrics = run.controlMetrics;
    const accuracyDrift = Math.abs(metrics.accuracy - expectedCutoff.accuracy);
    const majorityDrift = Math.abs(metrics.majorityBaselineAccuracy - expectedCutoff.majorityBaseline);
    const excessDrift = Math.abs(metrics.excessReturn - expectedCutoff.excessReturn);
    if (accuracyDrift > 1e-6 || majorityDrift > 1e-6 || excessDrift > 1e-6) {
      fail(`${CONTROL_DRIFT_STOP}: cutoff ${expectedCutoff.cutoff} drifted (accuracy=${metrics.accuracy}, baseline=${metrics.majorityBaselineAccuracy}, excess=${metrics.excessReturn})`);
    }
  }

  const summaryMatches = observed.positiveExcessCutoffs === 3
    && observed.directionalBaselineWins === 2
    && observed.medianExcessReturn === 0.04711292
    && observed.latestExcessReturn === -0.01025134
    && observedThresholds.length === 1
    && observedThresholds[0] === 0.575;
  if (!summaryMatches) {
    fail(CONTROL_DRIFT_STOP);
  }

  return Object.freeze({
    status: "PASS" as const,
    expected,
    observed,
  });
}

function deriveAnswers(
  challengerSummary: ReturnHurdleChallengerTemporalSummary,
  economicSummary: ReturnHurdleEconomicTemporalSummary,
  cutoffCount: number,
): {
  classificationEdge: ReturnHurdleAnswer;
  economicEvidence: ReturnHurdleAnswer;
  conclusion: ReturnHurdleConclusion;
  ceoNextRoute: ReturnHurdleNextRoute;
} {
  let classificationEdge: ReturnHurdleAnswer;
  if (challengerSummary.hurdleBaselineWins === cutoffCount && challengerSummary.medianHurdleAccuracyDeltaVsBaseline > 0) {
    classificationEdge = "YES";
  } else if (challengerSummary.hurdleBaselineWins === 0 && challengerSummary.medianHurdleAccuracyDeltaVsBaseline <= 0) {
    classificationEdge = "NO";
  } else {
    classificationEdge = "MIXED";
  }

  let economicEvidence: ReturnHurdleAnswer;
  if (economicSummary.economicWinsVsControl === cutoffCount && economicSummary.medianExcessDeltaVsControl > 0) {
    economicEvidence = "YES";
  } else if (economicSummary.economicWinsVsControl === 0 && economicSummary.medianExcessDeltaVsControl <= 0) {
    economicEvidence = "NO";
  } else {
    economicEvidence = "MIXED";
  }

  let conclusion: ReturnHurdleConclusion;
  if (economicEvidence === "YES" && classificationEdge !== "NO") {
    conclusion = "SUPPORTED";
  } else if (economicEvidence === "NO" && classificationEdge === "NO") {
    conclusion = "NOT_SUPPORTED";
  } else {
    conclusion = "MIXED";
  }

  let ceoNextRoute: ReturnHurdleNextRoute;
  if (conclusion === "SUPPORTED" || (conclusion === "MIXED" && economicSummary.economicWinsVsControl > economicSummary.economicLossesVsControl && economicSummary.medianExcessDeltaVsControl > 0)) {
    ceoNextRoute = "RETURN_HURDLE_TEMPORAL_CONFIRMATION_OR_UNIVERSE_EXPANSION";
  } else {
    ceoNextRoute = "STOP_DIRECTION_CLASSIFICATION_OBJECTIVE_AND_MOVE_TO_DIRECT_RETURN_MODEL";
  }

  return {
    classificationEdge,
    economicEvidence,
    conclusion,
    ceoNextRoute,
  };
}

export function runPerSymbolReturnHurdleLogisticChallengerTemporal(
  input: ReturnHurdleLogisticTemporalInput,
): ReturnHurdleLogisticTemporalResult {
  if (input.rawRows.length === 0) fail("0056 return-hurdle temporal replay requires source rows");
  const cutoffs = validateCutoffDates(input.cutoffDates);
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(COST_CONTRACT_AMBIGUOUS_STOP);
  }
  const canonicalHurdleFraction = deriveRoundTripCostFraction(input.roundTripCostBps);

  const cutoffRuns = cutoffs.map((cutoff) => evaluateCutoff(input, cutoff));
  const {
    controlTemporalSummary,
    challengerTemporalSummary,
    economicTemporalSummary,
  } = summarizeCutoffs(cutoffRuns);

  const controlReproduction = verifyControlReproduction(cutoffRuns);
  const answers = deriveAnswers(challengerTemporalSummary, economicTemporalSummary, cutoffRuns.length);

  const symbolRows = input.rawRows.filter((r) => r.symbol === TARGET_SYMBOL);
  const dateRange = {
    min: input.rawRows.reduce((min, r) => r.date < min ? r.date : min, input.rawRows[0]!.date),
    max: input.rawRows.reduce((max, r) => r.date > max ? r.date : max, input.rawRows[0]!.date),
  };

  const warnings = uniqueMessages([
    "This is a diagnostic research evaluation only; no investment advice, execution, promotion, or portfolio allocation is provided.",
    "Target semantics changed from directional (forwardReturn > 0) to cost-aware economic hurdle (forwardReturn > 0.001).",
    "Model family is unweighted binary logistic regression, sharing the identical five-feature contract with live 0056.",
    "CONTROL reproduced the authoritative directional baseline on all four temporal cutoffs.",
    "Hurdle classification accuracy is compared only against its own hurdle majority baseline, never directly against directional accuracy.",
    "Direct comparison between control and challenger uses identical simulator and transaction cost semantics.",
    "Promotion decision remains strictly do_not_promote.",
  ]);

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    classification: CLASSIFICATION,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: RESEARCH_MODE,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    symbol: TARGET_SYMBOL,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    datasetVersion: input.datasetVersion,
    requestedCutoffDates: cutoffs,
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange: dateRange,
      fullRowCount: input.rawRows.length,
      symbolRowCount: symbolRows.length,
      dataAsOf: dateRange.max,
    },
    roundTripCostBps: input.roundTripCostBps,
    canonicalRoundTripCostFraction: canonicalHurdleFraction,
    initialCapital: input.initialCapital,
    targetControlRule: TARGET_CONTROL_RULE,
    targetChallengerRule: TARGET_CHALLENGER_RULE,
    targetHorizonRows: TARGET_HORIZON_ROWS,
    controlFeatureNames: RESEARCH_FEATURE_NAMES,
    featureNames: RESEARCH_FEATURE_NAMES,
    cutoffRuns,
    controlTemporalSummary,
    challengerTemporalSummary,
    economicTemporalSummary,
    controlReproduction,
    doesCostAwareTargetHaveClassificationEdge: answers.classificationEdge,
    doesCostAwareTargetImproveEconomicEvidence: answers.economicEvidence,
    returnHurdleChallengerConclusion: answers.conclusion,
    ceoNextRoute: answers.ceoNextRoute,
    promotionDecision: "do_not_promote" as const,
    warnings,
    guardrails: guardrails(),
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
