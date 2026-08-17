import {
  RESEARCH_FEATURE_NAMES,
  buildHistoricalFeatureRows,
  filterRowsForCutoff,
  hashValue,
  isCanonicalIsoDate,
  resolveDataEndDate,
  runGaussianNaiveBayesChallenger,
  runPerSymbolLogisticChallenger,
  runResearchEvidenceKernel,
  splitChronologically,
  toMarketRows,
  validateCutoffDates,
  type DatasetVersion,
  type GaussianNaiveBayesChallengerSymbolEvidence,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
} from "@mms/research-kernel";

import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import { LongCashReplayError, type LongCashReplayGuardrails } from "./types.js";

const SCHEMA_VERSION = "MMS_0056_GAUSSIAN_NAIVE_BAYES_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_GAUSSIAN_NAIVE_BAYES_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = "0056" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const CONTROL_DRIFT_STOP = "STOP_MMS_0056_GNB_CONTROL_DRIFT" as const;
const PREPROCESSING_STOP = "STOP_MMS_0056_GNB_PREPROCESSING_CONTRACT_REQUIRED" as const;

export interface GaussianNaiveBayesTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface GaussianNaiveBayesTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: GaussianNaiveBayesTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface GaussianNaiveBayesSideMetrics {
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

export interface GaussianNaiveBayesChallengerMetrics extends GaussianNaiveBayesSideMetrics {
  readonly trainingUpRows: number;
  readonly trainingDownRows: number;
  readonly classPriorUp: number;
  readonly classPriorDown: number;
  readonly varianceFloor: number;
  readonly nearZeroVarianceWarnings: readonly string[];
}

export interface GaussianNaiveBayesControlDeltas {
  readonly accuracyDelta: number;
  readonly balancedAccuracyDelta: number;
  readonly logLossDelta: number;
  readonly brierDelta: number;
  readonly predictedUpRateDelta: number;
  readonly excessReturnDelta: number;
  readonly maxDrawdownDelta: number;
}

export interface GaussianNaiveBayesBalancedDeltas {
  readonly accuracyDelta: number;
  readonly balancedAccuracyDelta: number;
  readonly excessReturnDelta: number;
}

export interface GaussianNaiveBayesTemporalCutoffResult {
  readonly cutoff: string;
  readonly asOf: string;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly sourceRowsAsOf: number;
  readonly symbolRowsAsOf: number;
  readonly marketRowsSha256: string;
  readonly featureRowsSha256: string;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly finalTestEndDate: string;
  readonly dataQualityFindings: readonly string[];
  readonly control: PerSymbolLogisticChallengerSymbolEvidence;
  readonly controlEconomic: FinalTestEconomicEdgeGroup;
  readonly controlMetrics: GaussianNaiveBayesSideMetrics;
  readonly balancedLogistic: PerSymbolLogisticChallengerSymbolEvidence;
  readonly balancedLogisticEconomic: FinalTestEconomicEdgeGroup;
  readonly balancedLogisticMetrics: GaussianNaiveBayesSideMetrics;
  readonly gnb: GaussianNaiveBayesChallengerSymbolEvidence;
  readonly gnbEconomic: FinalTestEconomicEdgeGroup;
  readonly gnbMetrics: GaussianNaiveBayesChallengerMetrics;
  readonly deltasVsControl: GaussianNaiveBayesControlDeltas;
  readonly deltasVsBalanced: GaussianNaiveBayesBalancedDeltas;
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface GaussianNaiveBayesTemporalSummary {
  readonly cutoffCount: number;
  readonly positiveExcessCutoffs: number;
  readonly directionalBaselineWins: number;
  readonly medianAccuracyDeltaVsBaseline: number;
  readonly medianExcessReturn: number;
  readonly latestExcessReturn: number;
  readonly thresholdRange: { readonly minimum: number; readonly maximum: number };
  readonly directionalWinsVsControl: number;
  readonly economicWinsVsControl: number;
  readonly bothWinsVsControl: number;
  readonly medianAccuracyDeltaVsControl: number;
  readonly medianBalancedAccuracyDeltaVsControl: number;
  readonly medianExcessDeltaVsControl: number;
  readonly latestExcessDeltaVsControl: number;
  readonly directionalWinsVsBalanced: number;
  readonly economicWinsVsBalanced: number;
  readonly bothWinsVsBalanced: number;
  readonly medianAccuracyDeltaVsBalanced: number;
  readonly medianExcessDeltaVsBalanced: number;
}

export interface GaussianNaiveBayesControlReproduction {
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

export type GaussianNaiveBayesAnswer = "YES" | "NO" | "MIXED";
export type GaussianNaiveBayesConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type GaussianNaiveBayesNextRoute =
  | "GNB_UNIVERSE_EXPANSION_OR_CONFIRMATION"
  | "STOP_0056_MODEL_TWEAKS_AND_REASSESS_DATA_OR_MODEL_STRATEGY";

export interface GaussianNaiveBayesTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface GaussianNaiveBayesTemporalResult {
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
  readonly initialCapital: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly varianceFloor: number;
  readonly cutoffRuns: readonly GaussianNaiveBayesTemporalCutoffResult[];
  readonly temporalSummary: GaussianNaiveBayesTemporalSummary;
  readonly controlReproduction: GaussianNaiveBayesControlReproduction;
  readonly doesGnbImproveDirectionalEvidence: GaussianNaiveBayesAnswer;
  readonly doesGnbImproveEconomicEvidence: GaussianNaiveBayesAnswer;
  readonly gnbChallengerConclusion: GaussianNaiveBayesConclusion;
  readonly ceoNextRoute: GaussianNaiveBayesNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: GaussianNaiveBayesTemporalGuardrails;
  readonly normalizedResultSha256: string;
}

const CONTROL_EXPECTED_CUTOFFS = Object.freeze([
  { cutoff: "2025-09-30", accuracy: 0.57818182, majorityBaseline: 0.52, excessReturn: 0.09185705 },
  { cutoff: "2025-12-31", accuracy: 0.52961672, majorityBaseline: 0.50174216, excessReturn: 0.0023688 },
  { cutoff: "2026-03-31", accuracy: 0.51677852, majorityBaseline: 0.53355705, excessReturn: 0.20152868 },
  { cutoff: "2026-07-01", accuracy: 0.48874598, majorityBaseline: 0.56913183, excessReturn: -0.01025134 },
] as const);

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

function minimumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find minimum date in an empty collection");
  return values.reduce((minimum, value) => value < minimum ? value : minimum, first);
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
    minimum: round(Math.min(...values)),
    maximum: round(Math.max(...values)),
  });
}

function guardrails(): GaussianNaiveBayesTemporalGuardrails {
  return Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
    supportsSymbolSelection: false,
  });
}

function assertLiveFeatureContract(featureNames: readonly string[]): void {
  if (featureNames.length !== RESEARCH_FEATURE_NAMES.length
    || RESEARCH_FEATURE_NAMES.some((name, index) => featureNames[index] !== name)) {
    fail(PREPROCESSING_STOP);
  }
  if (featureNames.includes("breakout_20d_high") || featureNames.includes("intraday_range_pct")) {
    fail(PREPROCESSING_STOP);
  }
}

function assertCutoffBoundaries(
  cutoff: string,
  asOf: string,
  evidence: {
    readonly thresholdSelection: { readonly selectionPartition: string; readonly validationRowsSha256: string };
    readonly fit: { readonly fitPartition: string; readonly trainingRowsSha256: string };
    readonly trainingRowsSha256: string;
    readonly finalTestRowsSha256: string;
    readonly finalTest: { readonly evaluationPartition: string };
    readonly finalTestEconomicEvidence: {
      readonly rows: readonly { readonly targetDate: string; readonly featureDate: string }[];
    };
  },
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
  economicEvidence: PerSymbolLogisticChallengerSymbolEvidence["finalTestEconomicEvidence"],
  roundTripCostBps: number,
  initialCapital: number,
): FinalTestEconomicEdgeGroup {
  const economic = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: economicEvidence,
    roundTripCostBps,
    initialCapital,
  }).groups.find((group) => group.symbol === symbol);
  if (economic === undefined) fail(`economic replay is missing ${symbol}`);
  if (economic.transactionCostBps !== roundTripCostBps) {
    fail(`transaction cost drifted for ${symbol}`);
  }
  if (economic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH") {
    fail(`strategy policy drifted for ${symbol}`);
  }
  if (economic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK") {
    fail(`benchmark policy drifted for ${symbol}`);
  }
  return economic;
}

function sideMetrics(
  evidence: {
    readonly trainingRows: number;
    readonly validationRows: number;
    readonly finalTestRows: number;
    readonly thresholdSelection: { readonly selectedThreshold: number };
    readonly finalTestMetrics: {
      readonly accuracy: number;
      readonly majorityBaseline: number;
      readonly balancedAccuracy: number;
      readonly logLoss: number;
      readonly brierScore: number;
    };
    readonly accuracyDelta: number;
    readonly actualUpRate: number;
    readonly predictedUpRate: number;
    readonly meanProbabilityUp: number;
  },
  economic: FinalTestEconomicEdgeGroup,
): GaussianNaiveBayesSideMetrics {
  const metrics = evidence.finalTestMetrics;
  return Object.freeze({
    trainingRows: evidence.trainingRows,
    validationRows: evidence.validationRows,
    finalTestRows: evidence.finalTestRows,
    selectedThreshold: evidence.thresholdSelection.selectedThreshold,
    accuracy: metrics.accuracy,
    majorityBaselineAccuracy: metrics.majorityBaseline,
    accuracyDeltaVsBaseline: evidence.accuracyDelta,
    balancedAccuracy: metrics.balancedAccuracy,
    logLoss: metrics.logLoss,
    brierScore: metrics.brierScore,
    actualUpRate: evidence.actualUpRate,
    predictedUpRate: evidence.predictedUpRate,
    meanProbabilityUp: evidence.meanProbabilityUp,
    strategyNetReturn: economic.strategyNetReturn,
    benchmarkNetReturn: economic.benchmarkNetReturn,
    excessReturn: economic.excessReturn,
    strategyMaxDrawdown: economic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: economic.benchmarkMaximumDrawdown,
    tradeCount: economic.tradeCount,
  });
}

function gnbMetrics(
  evidence: GaussianNaiveBayesChallengerSymbolEvidence,
  economic: FinalTestEconomicEdgeGroup,
): GaussianNaiveBayesChallengerMetrics {
  return Object.freeze({
    ...sideMetrics(evidence, economic),
    trainingUpRows: evidence.model.trainingUpRows,
    trainingDownRows: evidence.model.trainingDownRows,
    classPriorUp: evidence.model.classPriorUp,
    classPriorDown: evidence.model.classPriorDown,
    varianceFloor: evidence.model.varianceFloor,
    nearZeroVarianceWarnings: evidence.model.nearZeroVarianceWarnings,
  });
}

function deltasVsControl(
  control: GaussianNaiveBayesSideMetrics,
  challenger: GaussianNaiveBayesSideMetrics,
): GaussianNaiveBayesControlDeltas {
  return Object.freeze({
    accuracyDelta: round(challenger.accuracy - control.accuracy),
    balancedAccuracyDelta: round(challenger.balancedAccuracy - control.balancedAccuracy),
    logLossDelta: round(challenger.logLoss - control.logLoss),
    brierDelta: round(challenger.brierScore - control.brierScore),
    predictedUpRateDelta: round(challenger.predictedUpRate - control.predictedUpRate),
    excessReturnDelta: round(challenger.excessReturn - control.excessReturn),
    maxDrawdownDelta: round(challenger.strategyMaxDrawdown - control.strategyMaxDrawdown),
  });
}

function deltasVsBalanced(
  balanced: GaussianNaiveBayesSideMetrics,
  challenger: GaussianNaiveBayesSideMetrics,
): GaussianNaiveBayesBalancedDeltas {
  return Object.freeze({
    accuracyDelta: round(challenger.accuracy - balanced.accuracy),
    balancedAccuracyDelta: round(challenger.balancedAccuracy - balanced.balancedAccuracy),
    excessReturnDelta: round(challenger.excessReturn - balanced.excessReturn),
  });
}

function evaluateCutoff(
  input: GaussianNaiveBayesTemporalInput,
  cutoff: string,
): GaussianNaiveBayesTemporalCutoffResult {
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
  );
  const controlMetrics = sideMetrics(controlGroup, controlEconomic);

  const featureRows = buildHistoricalFeatureRows(pooledMarketRows);
  const split = splitChronologically(featureRows);
  const symbolFeatureRows = featureRows.filter((row) => row.symbol === TARGET_SYMBOL);
  const balancedEvidence = runPerSymbolLogisticChallenger({
    featureRows: symbolFeatureRows,
    split,
    featureNames: RESEARCH_FEATURE_NAMES,
    classBalancing: "training_inverse_frequency",
  });
  assertLiveFeatureContract(balancedEvidence.featureNames);
  const balancedGroup = balancedEvidence.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  if (balancedGroup === undefined) {
    fail(`0056 class-balanced reference group is missing at cutoff ${cutoff}`);
  }
  assertCutoffBoundaries(cutoff, asOf, balancedGroup);
  if (balancedGroup.trainingRowsSha256 !== controlGroup.trainingRowsSha256) {
    fail(`0056 class-balanced training rows drifted from control at cutoff ${cutoff}`);
  }
  if (balancedGroup.fit.scalerStateSha256 !== controlGroup.fit.scalerStateSha256) {
    fail(PREPROCESSING_STOP);
  }
  const balancedEconomic = replayEconomic(
    TARGET_SYMBOL,
    balancedGroup.finalTestEconomicEvidence,
    input.roundTripCostBps,
    input.initialCapital,
  );
  const balancedMetrics = sideMetrics(balancedGroup, balancedEconomic);

  const gnbEvidence = runGaussianNaiveBayesChallenger({
    featureRows: symbolFeatureRows,
    split,
    featureNames: RESEARCH_FEATURE_NAMES,
  });
  assertLiveFeatureContract(gnbEvidence.featureNames);
  const gnbGroup = gnbEvidence.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  if (gnbGroup === undefined) {
    fail(`0056 gaussian naive bayes group is missing at cutoff ${cutoff}`);
  }
  assertCutoffBoundaries(cutoff, asOf, gnbGroup);
  if (gnbGroup.trainingRowsSha256 !== controlGroup.trainingRowsSha256) {
    fail(`0056 gaussian naive bayes training rows drifted from control at cutoff ${cutoff}`);
  }
  if (gnbGroup.fit.scalerStateSha256 !== controlGroup.fit.scalerStateSha256) {
    fail(PREPROCESSING_STOP);
  }
  const gnbEconomic = replayEconomic(
    TARGET_SYMBOL,
    gnbGroup.finalTestEconomicEvidence,
    input.roundTripCostBps,
    input.initialCapital,
  );
  const gnbSide = gnbMetrics(gnbGroup, gnbEconomic);
  const comparisonVsControl = deltasVsControl(controlMetrics, gnbSide);
  const comparisonVsBalanced = deltasVsBalanced(balancedMetrics, gnbSide);

  const dataQualityFindings = evidenceResult.evidence.dataQualityFindings.map(({ message }) => message);
  const warnings = uniqueMessages([
    ...dataQualityFindings,
    ...controlGroup.warnings,
    ...balancedGroup.warnings,
    ...gnbGroup.warnings,
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    "CONTROL is the unweighted live technical per-symbol logistic; BALANCED_LOGISTIC_REFERENCE adds only TRAINING-only class weights; GNB_CHALLENGER changes only the model family.",
    "No feature was added; breakout_20d_high is not part of this challenger.",
    ...gnbSide.nearZeroVarianceWarnings,
  ]);
  const normalized = {
    cutoff,
    asOf,
    symbol: TARGET_SYMBOL,
    sourceRowsAsOf: cutoffRawRows.length,
    symbolRowsAsOf: symbolRows.length,
    marketRowsSha256: evidenceResult.evidence.datasetSha256,
    featureRowsSha256: evidenceResult.evidence.featureRowsSha256,
    controlFeatureNames: controlEvidence.featureNames,
    featureNames: RESEARCH_FEATURE_NAMES,
    finalTestEndDate: maximumDate(
      gnbGroup.finalTestEconomicEvidence.rows.map(({ targetDate }) => targetDate),
    ),
    dataQualityFindings,
    control: controlGroup,
    controlEconomic,
    controlMetrics,
    balancedLogistic: balancedGroup,
    balancedLogisticEconomic: balancedEconomic,
    balancedLogisticMetrics: balancedMetrics,
    gnb: gnbGroup,
    gnbEconomic,
    gnbMetrics: gnbSide,
    deltasVsControl: comparisonVsControl,
    deltasVsBalanced: comparisonVsBalanced,
    warnings,
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function summarizeCutoffs(
  cutoffRuns: readonly GaussianNaiveBayesTemporalCutoffResult[],
): GaussianNaiveBayesTemporalSummary {
  if (cutoffRuns.length === 0) fail("0056 gaussian naive bayes temporal replay produced no cutoff runs");
  const gnbAccuracyDeltaVsBaseline = cutoffRuns.map((run) => run.gnbMetrics.accuracyDeltaVsBaseline);
  const gnbExcess = cutoffRuns.map((run) => run.gnbMetrics.excessReturn);
  const accuracyVsControl = cutoffRuns.map((run) => run.deltasVsControl.accuracyDelta);
  const balancedAccuracyVsControl = cutoffRuns.map((run) => run.deltasVsControl.balancedAccuracyDelta);
  const excessVsControl = cutoffRuns.map((run) => run.deltasVsControl.excessReturnDelta);
  const accuracyVsBalanced = cutoffRuns.map((run) => run.deltasVsBalanced.accuracyDelta);
  const excessVsBalanced = cutoffRuns.map((run) => run.deltasVsBalanced.excessReturnDelta);
  const latest = cutoffRuns.at(-1);
  if (latest === undefined) fail("0056 gaussian naive bayes latest cutoff is missing");
  return Object.freeze({
    cutoffCount: cutoffRuns.length,
    positiveExcessCutoffs: gnbExcess.filter((value) => value > 0).length,
    directionalBaselineWins: cutoffRuns.filter(({ gnbMetrics: metrics }) =>
      metrics.accuracy > metrics.majorityBaselineAccuracy).length,
    medianAccuracyDeltaVsBaseline: median(gnbAccuracyDeltaVsBaseline),
    medianExcessReturn: median(gnbExcess),
    latestExcessReturn: latest.gnbMetrics.excessReturn,
    thresholdRange: rangeOf(cutoffRuns.map((run) => run.gnbMetrics.selectedThreshold)),
    directionalWinsVsControl: accuracyVsControl.filter((value) => value > 0).length,
    economicWinsVsControl: excessVsControl.filter((value) => value > 0).length,
    bothWinsVsControl: cutoffRuns.filter((run) =>
      run.deltasVsControl.accuracyDelta > 0 && run.deltasVsControl.excessReturnDelta > 0).length,
    medianAccuracyDeltaVsControl: median(accuracyVsControl),
    medianBalancedAccuracyDeltaVsControl: median(balancedAccuracyVsControl),
    medianExcessDeltaVsControl: median(excessVsControl),
    latestExcessDeltaVsControl: latest.deltasVsControl.excessReturnDelta,
    directionalWinsVsBalanced: accuracyVsBalanced.filter((value) => value > 0).length,
    economicWinsVsBalanced: excessVsBalanced.filter((value) => value > 0).length,
    bothWinsVsBalanced: cutoffRuns.filter((run) =>
      run.deltasVsBalanced.accuracyDelta > 0 && run.deltasVsBalanced.excessReturnDelta > 0).length,
    medianAccuracyDeltaVsBalanced: median(accuracyVsBalanced),
    medianExcessDeltaVsBalanced: median(excessVsBalanced),
  });
}

function assertControlReproduction(
  cutoffRuns: readonly GaussianNaiveBayesTemporalCutoffResult[],
): GaussianNaiveBayesControlReproduction {
  const observedCutoffs = cutoffRuns.map((run) => ({
    cutoff: run.cutoff,
    accuracy: run.controlMetrics.accuracy,
    majorityBaseline: run.controlMetrics.majorityBaselineAccuracy,
    excessReturn: run.controlMetrics.excessReturn,
  }));
  const expectedDatesMatch = cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((expected, index) => cutoffRuns[index]?.cutoff === expected.cutoff);
  const observedThresholds = [...new Set(cutoffRuns.map((run) => run.controlMetrics.selectedThreshold))]
    .sort((left, right) => left - right);
  const controlExcess = cutoffRuns.map((run) => run.controlMetrics.excessReturn);
  const controlDirectionalWins = cutoffRuns.filter(({ controlMetrics }) =>
    controlMetrics.accuracy > controlMetrics.majorityBaselineAccuracy).length;
  const observed = {
    positiveExcessCutoffs: controlExcess.filter((value) => value > 0).length,
    directionalBaselineWins: controlDirectionalWins,
    medianExcessReturn: median(controlExcess),
    latestExcessReturn: controlExcess.at(-1)!,
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
      status: "NOT_APPLICABLE",
      expected,
      observed,
    });
  }
  const matches = CONTROL_EXPECTED_CUTOFFS.every((expectedCutoff, index) => {
    const actual = observedCutoffs[index];
    return actual !== undefined
      && actual.cutoff === expectedCutoff.cutoff
      && actual.accuracy === expectedCutoff.accuracy
      && actual.majorityBaseline === expectedCutoff.majorityBaseline
      && actual.excessReturn === expectedCutoff.excessReturn;
  });
  const summaryMatches = observed.positiveExcessCutoffs === 3
    && observed.directionalBaselineWins === 2
    && observed.medianExcessReturn === 0.04711292
    && observed.latestExcessReturn === -0.01025134
    && observedThresholds.length === 1
    && observedThresholds[0] === 0.575;
  if (!matches || !summaryMatches) {
    fail(CONTROL_DRIFT_STOP);
  }
  return Object.freeze({
    status: "PASS",
    expected,
    observed,
  });
}

function classifyDeltas(values: readonly number[]): GaussianNaiveBayesAnswer {
  if (values.length === 0) return "NO";
  const positives = values.filter((value) => value > 0).length;
  if (positives === values.length) return "YES";
  if (positives === 0) return "NO";
  return "MIXED";
}

function classifyConclusion(
  directional: GaussianNaiveBayesAnswer,
  economic: GaussianNaiveBayesAnswer,
): GaussianNaiveBayesConclusion {
  if (directional === "YES" && economic === "YES") return "SUPPORTED";
  if (directional === "NO" && economic === "NO") return "NOT_SUPPORTED";
  return "MIXED";
}

function classifyNextRoute(
  conclusion: GaussianNaiveBayesConclusion,
  summary: GaussianNaiveBayesTemporalSummary,
): GaussianNaiveBayesNextRoute {
  const materiallyPositiveMixed = conclusion === "MIXED"
    && summary.directionalWinsVsControl >= 2
    && summary.economicWinsVsControl >= 2
    && summary.medianAccuracyDeltaVsControl > 0
    && summary.medianExcessDeltaVsControl > 0;
  if (conclusion === "SUPPORTED" || materiallyPositiveMixed) {
    return "GNB_UNIVERSE_EXPANSION_OR_CONFIRMATION";
  }
  return "STOP_0056_MODEL_TWEAKS_AND_REASSESS_DATA_OR_MODEL_STRATEGY";
}

export function runPerSymbolGaussianNaiveBayesChallengerTemporal(
  input: GaussianNaiveBayesTemporalInput,
): GaussianNaiveBayesTemporalResult {
  const cutoffDates = validateCutoffDates(input.cutoffDates);
  if (input.rawRows.length === 0) fail("0056 gaussian naive bayes temporal replay requires source rows");
  if (!Number.isFinite(input.roundTripCostBps) || input.roundTripCostBps < 0) {
    fail(`roundTripCostBps is invalid: ${input.roundTripCostBps}`);
  }
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0) {
    fail(`initialCapital is invalid: ${input.initialCapital}`);
  }
  if (input.candidateDataQualityBasis.trim().length === 0) {
    fail("candidateDataQualityBasis must not be blank");
  }

  const symbolRows = input.rawRows.filter(({ symbol }) => symbol === TARGET_SYMBOL);
  if (symbolRows.length === 0) fail("0056 gaussian naive bayes temporal replay requires 0056 source rows");
  const allDates = symbolRows.map(({ date }) => date);
  const cutoffRuns = cutoffDates.map((cutoff) => evaluateCutoff(input, cutoff));
  const temporalSummary = summarizeCutoffs(cutoffRuns);
  const controlReproduction = assertControlReproduction(cutoffRuns);
  const directionalAnswer = classifyDeltas(cutoffRuns.map((run) => run.deltasVsControl.accuracyDelta));
  const economicAnswer = classifyDeltas(cutoffRuns.map((run) => run.deltasVsControl.excessReturnDelta));
  const conclusion = classifyConclusion(directionalAnswer, economicAnswer);
  const ceoNextRoute = classifyNextRoute(conclusion, temporalSummary);
  const controlFeatureNames = cutoffRuns[0]?.controlFeatureNames;
  if (controlFeatureNames === undefined) fail("0056 control feature inventory is unavailable");
  assertLiveFeatureContract(controlFeatureNames);
  const varianceFloor = cutoffRuns[0]?.gnbMetrics.varianceFloor;
  if (varianceFloor === undefined) fail("0056 gaussian naive bayes variance floor is unavailable");
  if (cutoffRuns.some((run) => run.gnbMetrics.varianceFloor !== varianceFloor)) {
    fail("gaussian naive bayes variance floor must be identical across cutoffs");
  }
  const warnings = uniqueMessages([
    ...cutoffRuns.flatMap((run) => run.dataQualityFindings),
    "Only 0056 was evaluated; no other symbol was selected, ranked, optimized, or promoted.",
    "Each cutoff used source rows available on or before that cutoff and refit the scaler, gaussian naive bayes parameters, and validation threshold independently.",
    "CHALLENGER differs from CONTROL only by replacing binary logistic regression with TRAINING-only Gaussian Naive Bayes.",
    "BALANCED_LOGISTIC_REFERENCE is a descriptive secondary comparison and was not modified.",
    "Economic evidence is descriptive only and uses the canonical long/cash simulator, same-window buy-and-hold benchmark, and the supplied 10 bps cost assumption.",
    "No current unresolved prediction labels enter any historical replay.",
    "Promotion remains do_not_promote regardless of gaussian naive bayes result.",
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
    requestedCutoffDates: cutoffDates,
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange: {
        min: minimumDate(allDates),
        max: maximumDate(allDates),
      },
      fullRowCount: input.rawRows.length,
      symbolRowCount: symbolRows.length,
      dataAsOf: maximumDate(allDates),
    },
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames,
    featureNames: RESEARCH_FEATURE_NAMES,
    varianceFloor,
    cutoffRuns,
    temporalSummary,
    controlReproduction,
    doesGnbImproveDirectionalEvidence: directionalAnswer,
    doesGnbImproveEconomicEvidence: economicAnswer,
    gnbChallengerConclusion: conclusion,
    ceoNextRoute,
    promotionDecision: "do_not_promote" as const,
    warnings,
    guardrails: guardrails(),
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
