import {
  RESEARCH_FEATURE_NAMES,
  buildHistoricalFeatureRows,
  computeTrainingClassWeights,
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
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
  type RowPartition,
  type TrainingClassWeights,
} from "@mms/research-kernel";

import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import { LongCashReplayError, type LongCashReplayGuardrails } from "./types.js";

const SCHEMA_VERSION = "MMS_0056_CLASS_BALANCED_LOGISTIC_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_CLASS_BALANCED_LOGISTIC_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = "0056" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const CONTROL_DRIFT_STOP = "STOP_MMS_0056_BALANCED_LOGISTIC_CONTROL_DRIFT" as const;

export interface ClassBalancedLogisticTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface ClassBalancedLogisticTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: ClassBalancedLogisticTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface ClassBalancedLogisticSideMetrics {
  readonly trainingRows: number;
  readonly trainingUpRows: number;
  readonly trainingDownRows: number;
  readonly weightUp: number;
  readonly weightDown: number;
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
  readonly strategyNetReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaxDrawdown: number;
  readonly benchmarkMaxDrawdown: number;
  readonly tradeCount: number;
}

export interface ClassBalancedLogisticDeltas {
  readonly accuracyDelta: number;
  readonly balancedAccuracyDelta: number;
  readonly logLossDelta: number;
  readonly brierDelta: number;
  readonly predictedUpRateDelta: number;
  readonly excessReturnDelta: number;
  readonly maxDrawdownDelta: number;
}

export type ClassBalancedLogisticChallengerCutoff =
  | {
    readonly status: "available";
    readonly evidence: PerSymbolLogisticChallengerSymbolEvidence;
    readonly economic: FinalTestEconomicEdgeGroup;
    readonly metrics: ClassBalancedLogisticSideMetrics;
    readonly classWeights: TrainingClassWeights;
  }
  | {
    readonly status: "unavailable";
    readonly reason: string;
    readonly trainingRows: number;
    readonly trainingUpRows: number;
    readonly trainingDownRows: number;
  };

export interface ClassBalancedLogisticTemporalCutoffResult {
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
  readonly controlMetrics: ClassBalancedLogisticSideMetrics;
  readonly challenger: ClassBalancedLogisticChallengerCutoff;
  readonly deltas: ClassBalancedLogisticDeltas | null;
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface ClassBalancedLogisticTemporalSummary {
  readonly cutoffCount: number;
  readonly challengerPositiveExcessCutoffs: number;
  readonly controlPositiveExcessCutoffs: number;
  readonly challengerDirectionalBaselineWins: number;
  readonly controlDirectionalBaselineWins: number;
  readonly challengerMedianExcess: number | null;
  readonly controlMedianExcess: number;
  readonly challengerLatestExcess: number | null;
  readonly controlLatestExcess: number;
  readonly medianAccuracyDeltaVsControl: number | null;
  readonly medianBalancedAccuracyDeltaVsControl: number | null;
  readonly medianExcessDeltaVsControl: number | null;
  readonly thresholdRange: {
    readonly control: { readonly minimum: number; readonly maximum: number };
    readonly challenger: { readonly minimum: number; readonly maximum: number } | null;
  };
  readonly classWeightRanges: {
    readonly weightUp: { readonly minimum: number; readonly maximum: number } | null;
    readonly weightDown: { readonly minimum: number; readonly maximum: number } | null;
  };
}

export interface ClassBalancedLogisticControlReproduction {
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

export type ClassBalancedLogisticAnswer = "YES" | "NO" | "MIXED";
export type ClassBalancedLogisticConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type ClassBalancedLogisticNextRoute =
  | "BALANCED_LOGISTIC_CONFIRMATION_OR_UNIVERSE_EXPANSION"
  | "NEXT_MODEL_FAMILY_CHALLENGER_V1";

export interface ClassBalancedLogisticTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface ClassBalancedLogisticTemporalResult {
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
  readonly cutoffRuns: readonly ClassBalancedLogisticTemporalCutoffResult[];
  readonly temporalSummary: ClassBalancedLogisticTemporalSummary;
  readonly controlReproduction: ClassBalancedLogisticControlReproduction;
  readonly doesClassBalancingImproveDirectionalEvidence: ClassBalancedLogisticAnswer;
  readonly doesClassBalancingImproveEconomicEvidence: ClassBalancedLogisticAnswer;
  readonly classBalancedChallengerConclusion: ClassBalancedLogisticConclusion;
  readonly ceoNextRoute: ClassBalancedLogisticNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: ClassBalancedLogisticTemporalGuardrails;
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

function rangeOf(values: readonly number[]): { readonly minimum: number; readonly maximum: number } | null {
  if (values.length === 0) return null;
  return Object.freeze({
    minimum: round(Math.min(...values)),
    maximum: round(Math.max(...values)),
  });
}

function guardrails(): ClassBalancedLogisticTemporalGuardrails {
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
    fail("live control feature contract drifted");
  }
  if (featureNames.includes("breakout_20d_high") || featureNames.includes("intraday_range_pct")) {
    fail("class-balanced challenger must not add a feature");
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
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
  roundTripCostBps: number,
  initialCapital: number,
): FinalTestEconomicEdgeGroup {
  const economic = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: evidence.finalTestEconomicEvidence,
    roundTripCostBps,
    initialCapital,
  }).groups.find((group) => group.symbol === evidence.symbol);
  if (economic === undefined) fail(`economic replay is missing ${evidence.symbol}`);
  if (economic.transactionCostBps !== roundTripCostBps) {
    fail(`transaction cost drifted for ${evidence.symbol}`);
  }
  if (economic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH") {
    fail(`strategy policy drifted for ${evidence.symbol}`);
  }
  if (economic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK") {
    fail(`benchmark policy drifted for ${evidence.symbol}`);
  }
  return economic;
}

function sideMetrics(
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
  economic: FinalTestEconomicEdgeGroup,
  trainingUpRows: number,
  trainingDownRows: number,
  weightUp: number,
  weightDown: number,
): ClassBalancedLogisticSideMetrics {
  const metrics = evidence.finalTestMetrics;
  return Object.freeze({
    trainingRows: evidence.trainingRows,
    trainingUpRows,
    trainingDownRows,
    weightUp: round(weightUp),
    weightDown: round(weightDown),
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
    strategyNetReturn: economic.strategyNetReturn,
    benchmarkNetReturn: economic.benchmarkNetReturn,
    excessReturn: economic.excessReturn,
    strategyMaxDrawdown: economic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: economic.benchmarkMaximumDrawdown,
    tradeCount: economic.tradeCount,
  });
}

function deltas(
  control: ClassBalancedLogisticSideMetrics,
  challenger: ClassBalancedLogisticSideMetrics,
): ClassBalancedLogisticDeltas {
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

function trainingPartitionForSymbol(
  trainingRows: Parameters<typeof hashFeatureRows>[0],
): RowPartition<"TRAINING"> {
  const symbolRows = trainingRows.filter((row) => row.symbol === TARGET_SYMBOL);
  return Object.freeze({
    kind: "TRAINING",
    rows: Object.freeze([...symbolRows]),
    rowIdentitySha256: hashFeatureRows(symbolRows),
  });
}

function evaluateCutoff(
  input: ClassBalancedLogisticTemporalInput,
  cutoff: string,
): ClassBalancedLogisticTemporalCutoffResult {
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
    controlGroup,
    input.roundTripCostBps,
    input.initialCapital,
  );

  const featureRows = buildHistoricalFeatureRows(pooledMarketRows);
  const split = splitChronologically(featureRows);
  const training0056 = trainingPartitionForSymbol(split.training.rows);
  const computedWeights = computeTrainingClassWeights(training0056);
  const controlMetrics = sideMetrics(
    controlGroup,
    controlEconomic,
    computedWeights.status === "available"
      ? computedWeights.weights.trainingUpRows
      : computedWeights.trainingUpRows,
    computedWeights.status === "available"
      ? computedWeights.weights.trainingDownRows
      : computedWeights.trainingDownRows,
    1,
    1,
  );

  let challenger: ClassBalancedLogisticChallengerCutoff;
  let comparison: ClassBalancedLogisticDeltas | null = null;
  if (computedWeights.status === "unavailable") {
    challenger = Object.freeze({
      status: "unavailable" as const,
      reason: computedWeights.reason,
      trainingRows: computedWeights.trainingRowCount,
      trainingUpRows: computedWeights.trainingUpRows,
      trainingDownRows: computedWeights.trainingDownRows,
    });
  } else {
    const challengerEvidence = runPerSymbolLogisticChallenger({
      featureRows: featureRows.filter((row) => row.symbol === TARGET_SYMBOL),
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "training_inverse_frequency",
    });
    assertLiveFeatureContract(challengerEvidence.featureNames);
    const challengerGroup = challengerEvidence.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
    if (challengerGroup === undefined) {
      fail(`0056 class-balanced challenger group is missing at cutoff ${cutoff}`);
    }
    assertCutoffBoundaries(cutoff, asOf, challengerGroup);
    if (challengerGroup.fit.classBalancing === undefined) {
      fail(`0056 class-balanced weights were not recorded at cutoff ${cutoff}`);
    }
    if (challengerGroup.trainingRowsSha256 !== controlGroup.trainingRowsSha256) {
      fail(`0056 class-balanced training rows drifted from control at cutoff ${cutoff}`);
    }
    if (challengerGroup.fit.scalerStateSha256 !== controlGroup.fit.scalerStateSha256) {
      fail(`0056 class-balanced scaler drifted from control at cutoff ${cutoff}`);
    }
    const challengerEconomic = replayEconomic(
      challengerGroup,
      input.roundTripCostBps,
      input.initialCapital,
    );
    const challengerMetrics = sideMetrics(
      challengerGroup,
      challengerEconomic,
      computedWeights.weights.trainingUpRows,
      computedWeights.weights.trainingDownRows,
      computedWeights.weights.weightUp,
      computedWeights.weights.weightDown,
    );
    comparison = deltas(controlMetrics, challengerMetrics);
    challenger = Object.freeze({
      status: "available" as const,
      evidence: challengerGroup,
      economic: challengerEconomic,
      metrics: challengerMetrics,
      classWeights: computedWeights.weights,
    });
  }

  const dataQualityFindings = evidenceResult.evidence.dataQualityFindings.map(({ message }) => message);
  const warnings = uniqueMessages([
    ...dataQualityFindings,
    ...controlGroup.warnings,
    ...(challenger.status === "available" ? challenger.evidence.warnings : [challenger.reason]),
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    "CONTROL is the unweighted live technical per-symbol logistic; CHALLENGER adds only TRAINING-only class weights.",
    "No feature was added; breakout_20d_high is not part of this challenger.",
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
      controlGroup.finalTestEconomicEvidence.rows.map(({ targetDate }) => targetDate),
    ),
    dataQualityFindings,
    control: controlGroup,
    controlEconomic,
    controlMetrics,
    challenger,
    deltas: comparison,
    warnings,
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function availableChallengers(
  cutoffRuns: readonly ClassBalancedLogisticTemporalCutoffResult[],
): readonly Extract<ClassBalancedLogisticChallengerCutoff, { status: "available" }>[] {
  return cutoffRuns.flatMap((run) => run.challenger.status === "available" ? [run.challenger] : []);
}

function summarizeCutoffs(
  cutoffRuns: readonly ClassBalancedLogisticTemporalCutoffResult[],
): ClassBalancedLogisticTemporalSummary {
  if (cutoffRuns.length === 0) fail("0056 class-balanced temporal replay produced no cutoff runs");
  const controlExcess = cutoffRuns.map((run) => run.controlMetrics.excessReturn);
  const challengerAvailable = availableChallengers(cutoffRuns);
  const challengerExcess = challengerAvailable.map((run) => run.metrics.excessReturn);
  const accuracyDeltas = cutoffRuns.flatMap((run) => run.deltas === null ? [] : [run.deltas.accuracyDelta]);
  const balancedAccuracyDeltas = cutoffRuns.flatMap((run) =>
    run.deltas === null ? [] : [run.deltas.balancedAccuracyDelta]);
  const excessDeltas = cutoffRuns.flatMap((run) => run.deltas === null ? [] : [run.deltas.excessReturnDelta]);
  const controlThresholds = cutoffRuns.map((run) => run.controlMetrics.selectedThreshold);
  const challengerThresholds = challengerAvailable.map((run) => run.metrics.selectedThreshold);
  const weightUp = challengerAvailable.map((run) => run.classWeights.weightUp);
  const weightDown = challengerAvailable.map((run) => run.classWeights.weightDown);
  const controlThresholdRange = rangeOf(controlThresholds);
  if (controlThresholdRange === null) fail("0056 control threshold observations are missing");
  return Object.freeze({
    cutoffCount: cutoffRuns.length,
    challengerPositiveExcessCutoffs: challengerExcess.filter((value) => value > 0).length,
    controlPositiveExcessCutoffs: controlExcess.filter((value) => value > 0).length,
    challengerDirectionalBaselineWins: challengerAvailable.filter(({ metrics }) =>
      metrics.accuracy > metrics.majorityBaselineAccuracy).length,
    controlDirectionalBaselineWins: cutoffRuns.filter(({ controlMetrics }) =>
      controlMetrics.accuracy > controlMetrics.majorityBaselineAccuracy).length,
    challengerMedianExcess: challengerExcess.length === 0 ? null : median(challengerExcess),
    controlMedianExcess: median(controlExcess),
    challengerLatestExcess: (() => {
      const latest = cutoffRuns.at(-1);
      if (latest === undefined || latest.challenger.status !== "available") return null;
      return latest.challenger.metrics.excessReturn;
    })(),
    controlLatestExcess: controlExcess.at(-1)!,
    medianAccuracyDeltaVsControl: accuracyDeltas.length === 0 ? null : median(accuracyDeltas),
    medianBalancedAccuracyDeltaVsControl: balancedAccuracyDeltas.length === 0
      ? null
      : median(balancedAccuracyDeltas),
    medianExcessDeltaVsControl: excessDeltas.length === 0 ? null : median(excessDeltas),
    thresholdRange: Object.freeze({
      control: controlThresholdRange,
      challenger: rangeOf(challengerThresholds),
    }),
    classWeightRanges: Object.freeze({
      weightUp: rangeOf(weightUp),
      weightDown: rangeOf(weightDown),
    }),
  });
}

function assertControlReproduction(
  cutoffRuns: readonly ClassBalancedLogisticTemporalCutoffResult[],
  summary: ClassBalancedLogisticTemporalSummary,
): ClassBalancedLogisticControlReproduction {
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
  const observed = {
    positiveExcessCutoffs: summary.controlPositiveExcessCutoffs,
    directionalBaselineWins: summary.controlDirectionalBaselineWins,
    medianExcessReturn: summary.controlMedianExcess,
    latestExcessReturn: summary.controlLatestExcess,
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
  const summaryMatches = summary.controlPositiveExcessCutoffs === 3
    && summary.controlDirectionalBaselineWins === 2
    && summary.controlMedianExcess === 0.04711292
    && summary.controlLatestExcess === -0.01025134
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

function classifyDeltas(values: readonly number[]): ClassBalancedLogisticAnswer {
  if (values.length === 0) return "NO";
  const positives = values.filter((value) => value > 0).length;
  if (positives === values.length) return "YES";
  if (positives === 0) return "NO";
  return "MIXED";
}

function classifyConclusion(
  directional: ClassBalancedLogisticAnswer,
  economic: ClassBalancedLogisticAnswer,
): ClassBalancedLogisticConclusion {
  if (directional === "YES" && economic === "YES") return "SUPPORTED";
  if (directional === "NO" && economic === "NO") return "NOT_SUPPORTED";
  return "MIXED";
}

export function runPerSymbolLogisticClassBalancedChallengerTemporal(
  input: ClassBalancedLogisticTemporalInput,
): ClassBalancedLogisticTemporalResult {
  const cutoffDates = validateCutoffDates(input.cutoffDates);
  if (input.rawRows.length === 0) fail("0056 class-balanced temporal replay requires source rows");
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
  if (symbolRows.length === 0) fail("0056 class-balanced temporal replay requires 0056 source rows");
  const allDates = symbolRows.map(({ date }) => date);
  const cutoffRuns = cutoffDates.map((cutoff) => evaluateCutoff(input, cutoff));
  const temporalSummary = summarizeCutoffs(cutoffRuns);
  const controlReproduction = assertControlReproduction(cutoffRuns, temporalSummary);
  const accuracyDeltas = cutoffRuns.flatMap((run) => run.deltas === null ? [] : [run.deltas.accuracyDelta]);
  const excessDeltas = cutoffRuns.flatMap((run) => run.deltas === null ? [] : [run.deltas.excessReturnDelta]);
  const directionalAnswer = classifyDeltas(accuracyDeltas);
  const economicAnswer = classifyDeltas(excessDeltas);
  const conclusion = classifyConclusion(directionalAnswer, economicAnswer);
  const ceoNextRoute: ClassBalancedLogisticNextRoute =
    conclusion === "NOT_SUPPORTED"
      ? "NEXT_MODEL_FAMILY_CHALLENGER_V1"
      : "BALANCED_LOGISTIC_CONFIRMATION_OR_UNIVERSE_EXPANSION";
  const controlFeatureNames = cutoffRuns[0]?.controlFeatureNames;
  if (controlFeatureNames === undefined) fail("0056 control feature inventory is unavailable");
  assertLiveFeatureContract(controlFeatureNames);
  const warnings = uniqueMessages([
    ...cutoffRuns.flatMap((run) => run.dataQualityFindings),
    "Only 0056 was evaluated; no other symbol was selected, ranked, optimized, or promoted.",
    "Each cutoff used source rows available on or before that cutoff and refit the scaler, logistic model, and validation threshold independently.",
    "CHALLENGER differs from CONTROL only by TRAINING-only inverse-frequency class weights.",
    "Economic evidence is descriptive only and uses the canonical long/cash simulator, same-window buy-and-hold benchmark, and the supplied 10 bps cost assumption.",
    "No current unresolved prediction labels enter any historical replay.",
    "Promotion remains do_not_promote regardless of class-balancing result.",
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
    cutoffRuns,
    temporalSummary,
    controlReproduction,
    doesClassBalancingImproveDirectionalEvidence: directionalAnswer,
    doesClassBalancingImproveEconomicEvidence: economicAnswer,
    classBalancedChallengerConclusion: conclusion,
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
