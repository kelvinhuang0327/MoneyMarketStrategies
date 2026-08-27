import {
  CANONICAL_TRANSACTION_COST_BPS,
  RESEARCH_FEATURE_NAMES,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  TWSE_MI_QFIIS_FEATURE_FAMILY,
  TWSE_MI_QFIIS_FEATURE_FIELDS,
  TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE,
  TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL,
  TWSE_MI_QFIIS_SUPPORTED_SYMBOLS,
  buildFinalTestEconomicEvidence,
  buildMiQfiisForeignOwnershipFeatureRows,
  createFinalTestEvaluator,
  filterRowsForCutoff,
  fitLogisticRegression,
  fitStandardScaler,
  hashFeatureRows,
  hashMarketRows,
  hashValue,
  resolveDataEndDate,
  selectValidationThreshold,
  splitChronologically,
  toMarketRows,
  validateCutoffDates,
  type DatasetVersion,
  type PerSymbolLogisticChallengerFeatureFamily,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
  type ThreeWayChronologicalSplit,
  type TwseMiQfiisRecord,
  type TwseMiQfiisSupportedSymbol,
} from "@mms/research-kernel";

import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import {
  LongCashReplayError,
  type LongCashReplayGuardrails,
} from "./types.js";

const SCHEMA_VERSION = "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_FEATURE_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_MI_QFIIS_FOREIGN_OWNERSHIP_FEATURE_CHALLENGER_V1_READY_FOR_CTO_REVIEW" as const;
const MULTI_SYMBOL_SCHEMA_VERSION =
  "MMS_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_FEATURE_CHALLENGER_TEMPORAL_V1" as const;
const MULTI_SYMBOL_CLASSIFICATION =
  "MMS_MI_QFIIS_FOREIGN_OWNERSHIP_MULTI_SYMBOL_OOS_V1_DIAGNOSTIC" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

export interface MiQfiisForeignOwnershipTemporalSource {
  readonly ohlcvPath: string;
  readonly ohlcvSha256: string;
  readonly miQfiisPath: string;
  readonly miQfiisSha256: string;
}

export interface MiQfiisForeignOwnershipTemporalInput {
  readonly targetSymbol?: TwseMiQfiisSupportedSymbol;
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly miQfiisRecords: readonly TwseMiQfiisRecord[];
  readonly cutoffDates: readonly string[];
  readonly source: MiQfiisForeignOwnershipTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface MiQfiisForeignOwnershipSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly eligibleRowsRemovedForMiQfiisContext: number;
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
  readonly warnings: readonly string[];
}

export interface MiQfiisFeatureDistributionSummary {
  readonly minimum: number;
  readonly mean: number;
  readonly maximum: number;
}

export interface MiQfiisForeignOwnershipCutoffContextSummary {
  readonly targetSymbol: TwseMiQfiisSupportedSymbol;
  readonly miQfiisDataAsOf: string;
  readonly foreignHoldingRatioLag1Summary: MiQfiisFeatureDistributionSummary;
  readonly foreignHoldingRatioChange5dSummary: MiQfiisFeatureDistributionSummary;
  readonly foreignHoldingRatioChange20dSummary: MiQfiisFeatureDistributionSummary;
  readonly missingContextRows: number;
  readonly strictPitRule: typeof TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE;
  readonly earliestEligibleDate: string;
}

export interface MiQfiisForeignOwnershipDeltasVsControl {
  readonly accuracyDelta: number;
  readonly balancedAccuracyDelta: number;
  readonly logLossDelta: number;
  readonly brierDelta: number;
  readonly excessReturnDelta: number;
  readonly maxDrawdownDelta: number;
  readonly tradeCountDelta: number;
}

export interface MiQfiisForeignOwnershipTemporalCutoffResult {
  readonly cutoff: string;
  readonly asOf: string;
  readonly symbol: TwseMiQfiisSupportedSymbol;
  readonly sourceRowsAsOf: number;
  readonly miQfiisRecordsAsOf: number;
  readonly symbolRowsAsOf: number;
  readonly marketRowsSha256: string;
  readonly featureRowsSha256: string;
  readonly challengerFeatureRowsSha256: string;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly featureFamily: PerSymbolLogisticChallengerFeatureFamily;
  readonly finalTestEndDate: string;
  readonly dataQualityFindings: readonly string[];
  readonly control: PerSymbolLogisticChallengerSymbolEvidence;
  readonly controlEconomic: FinalTestEconomicEdgeGroup;
  readonly controlMetrics: MiQfiisForeignOwnershipSideMetrics;
  readonly challenger: PerSymbolLogisticChallengerSymbolEvidence;
  readonly challengerEconomic: FinalTestEconomicEdgeGroup;
  readonly challengerMetrics: MiQfiisForeignOwnershipSideMetrics;
  readonly miQfiisContext: MiQfiisForeignOwnershipCutoffContextSummary;
  readonly deltasVsControl: MiQfiisForeignOwnershipDeltasVsControl;
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface MiQfiisForeignOwnershipTemporalSummary {
  readonly cutoffCount: number;
  readonly positiveExcessCutoffs: number;
  readonly directionalBaselineWins: number;
  readonly medianAccuracyDeltaVsBaseline: number;
  readonly medianExcessReturn: number;
  readonly latestExcessReturn: number;
  readonly thresholdRange: {
    readonly minimum: number;
    readonly maximum: number;
  };
}

export interface MiQfiisForeignOwnershipComparisonSummaryVsControl {
  readonly directionalWins: number;
  readonly calibrationWins: number;
  readonly economicWins: number;
  readonly directionalQualityWinsVsControl: number;
  readonly calibrationWinsVsControl: number;
  readonly economicWinsVsControl: number;
  readonly drawdownWinsVsControl: number;
  readonly allQualityWinsVsControl: number;
  readonly medianAccuracyDeltaVsControl: number;
  readonly medianBalancedAccuracyDeltaVsControl: number;
  readonly medianLogLossDeltaVsControl: number;
  readonly medianBrierDeltaVsControl: number;
  readonly medianExcessDeltaVsControl: number;
  readonly latestExcessDeltaVsControl: number;
  readonly medianMaxDrawdownDeltaVsControl: number;
}

export interface MiQfiisForeignOwnershipControlReproduction {
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

export type MiQfiisDecision =
  | "KEEP_MI_QFIIS_FEATURE_SLICE"
  | "REJECT_MI_QFIIS_FEATURE_SLICE"
  | "NEED_ONE_CONFIRMATION";

export type MiQfiisNextRoute =
  | "MI_QFIIS_FEATURE_SLICE_PRODUCTION_INTEGRATION"
  | "STOP_MI_QFIIS_FEATURE_RESEARCH_AND_REASSESS_ALTERNATIVE_DATA"
  | "COLLECT_FURTHER_TEMPORAL_CONFIRMATION"
  | "MULTI_SYMBOL_GENERALIZATION_GATE_ONLY";

export interface MiQfiisForeignOwnershipTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface MiQfiisForeignOwnershipTemporalResult {
  readonly schemaVersion: typeof SCHEMA_VERSION | typeof MULTI_SYMBOL_SCHEMA_VERSION;
  readonly classification: typeof CLASSIFICATION | typeof MULTI_SYMBOL_CLASSIFICATION;
  readonly dataClassification: "HISTORICAL_RESEARCH_STUDY";
  readonly reviewDate: string;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly providesInvestmentAdvice: false;
  readonly currentDatePredictionClaim: false;
  readonly symbol: TwseMiQfiisSupportedSymbol;
  readonly candidateDataQualityBasis: string;
  readonly datasetVersion: DatasetVersion;
  readonly requestedCutoffDates: readonly string[];
  readonly source: {
    readonly ohlcvPath: string;
    readonly ohlcvSha256: string;
    readonly miQfiisPath: string;
    readonly miQfiisSha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
    readonly symbolRowCount: number;
    readonly miQfiisRecordCount: number;
    readonly dataAsOf: string;
  };
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly featureFamily: PerSymbolLogisticChallengerFeatureFamily;
  readonly cutoffRuns: readonly MiQfiisForeignOwnershipTemporalCutoffResult[];
  readonly controlTemporalSummary: MiQfiisForeignOwnershipTemporalSummary;
  readonly challengerTemporalSummary: MiQfiisForeignOwnershipTemporalSummary;
  readonly comparisonSummaryVsControl: MiQfiisForeignOwnershipComparisonSummaryVsControl;
  readonly controlReproduction: MiQfiisForeignOwnershipControlReproduction;
  readonly decision: MiQfiisDecision;
  readonly nextRoute: MiQfiisNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: MiQfiisForeignOwnershipTemporalGuardrails;
  readonly normalizedResultSha256: string;
}

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function validateTargetSymbol(targetSymbol: string): asserts targetSymbol is TwseMiQfiisSupportedSymbol {
  if (!TWSE_MI_QFIIS_SUPPORTED_SYMBOLS.includes(targetSymbol as TwseMiQfiisSupportedSymbol)) {
    fail(`unsupported MI_QFIIS temporal target symbol: ${targetSymbol}`);
  }
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

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute mean of zero values");
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute median of zero values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) fail("median values are incomplete");
  return round((lower + upper) / 2);
}

function guardrails(): MiQfiisForeignOwnershipTemporalGuardrails {
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
  if (
    economic.transactionCostBps !== roundTripCostBps
    || economic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH"
    || economic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK"
  ) {
    fail(`frozen economic policy drifted for ${evidence.symbol}`);
  }
  return economic;
}

function buildSingleModelEvidence(
  split: ThreeWayChronologicalSplit,
  targetSymbol: TwseMiQfiisSupportedSymbol,
): PerSymbolLogisticChallengerSymbolEvidence {
  const scaler = fitStandardScaler(split.training);
  const model = fitLogisticRegression(split.training, scaler);
  const thresholdSelection = selectValidationThreshold(split.validation, scaler, model);
  const finalTestEvaluator = createFinalTestEvaluator();
  const finalTestEvaluation = finalTestEvaluator.evaluate(
    split.finalTest,
    scaler,
    model,
    thresholdSelection.selectedThreshold,
  );
  finalTestEvaluator.assertExactlyOnce();

  const {
    evaluationPartition,
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
    frozenThreshold,
    evaluatorExecutionCount,
    metrics,
    symbolReliability,
    probabilityCalibration,
    featureDateErrorCohortProfile,
    scoredRows,
  } = finalTestEvaluation;
  const finalTest = Object.freeze({
    evaluationPartition,
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
    frozenThreshold,
    evaluatorExecutionCount,
    metrics,
    symbolReliability,
    probabilityCalibration,
    featureDateErrorCohortProfile,
  });
  const finalTestEconomicEvidence = buildFinalTestEconomicEvidence(
    split.finalTest.rows,
    scoredRows,
    thresholdSelection.selectedThreshold,
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
  );

  const predictions = scoredRows.map((row) => row.prediction);
  const probabilities = scoredRows.map((row) => row.probability);
  const predictedUpRate = predictions.length === 0
    ? 0
    : round(predictions.reduce((sum: number, prediction) => sum + (prediction === 1 ? 1 : 0), 0) / predictions.length);
  const meanProbabilityUp = probabilities.length === 0
    ? 0
    : round(probabilities.reduce((sum, probability) => sum + probability, 0) / probabilities.length);
  const actualUpRate = metrics.sampleCount === 0 ? 0 : round(metrics.positiveCount / metrics.sampleCount);

  return Object.freeze({
    symbol: targetSymbol,
    trainingRows: split.training.rows.length,
    trainValidationPurgeRows: split.trainValidationPurge.rows.length,
    validationRows: split.validation.rows.length,
    validationFinalPurgeRows: split.validationFinalPurge.rows.length,
    finalTestRows: split.finalTest.rows.length,
    trainEndDate: split.trainEndDate,
    validationStartDate: split.validationStartDate,
    validationEndDate: split.validationEndDate,
    finalTestStartDate: split.finalTestStartDate,
    trainingRowsSha256: split.training.rowIdentitySha256,
    validationRowsSha256: split.validation.rowIdentitySha256,
    finalTestRowsSha256: split.finalTest.rowIdentitySha256,
    fit: Object.freeze({
      fitPartition: "TRAINING" as const,
      trainingRowsSha256: split.training.rowIdentitySha256,
      scalerFitRowCount: scaler.fitRowCount,
      modelFitRowCount: model.fitRowCount,
      scalerStateSha256: scaler.stateSha256,
      modelStateSha256: model.stateSha256,
      iterations: model.config.iterations,
      learningRate: model.config.learningRate,
      l2: model.config.l2,
      initialRegularizedLoss: model.initialRegularizedLoss,
      finalRegularizedLoss: model.finalRegularizedLoss,
    }),
    thresholdSelection,
    finalTest,
    finalTestEconomicEvidence,
    finalTestMetrics: metrics,
    majorityBaselineAccuracy: metrics.majorityBaseline,
    accuracyDelta: round(metrics.accuracy - metrics.majorityBaseline),
    actualUpRate,
    predictedUpRate,
    meanProbabilityUp,
    warnings: Object.freeze([
      `Model fit on TRAINING rows only (count=${split.training.rows.length}).`,
      `Threshold selected on VALIDATION rows only (count=${split.validation.rows.length}).`,
      `Final test evaluated on untouched partition (count=${split.finalTest.rows.length}).`,
    ]),
  });
}

function extractSideMetrics(
  evidence: PerSymbolLogisticChallengerSymbolEvidence,
  economic: FinalTestEconomicEdgeGroup,
  eligibleRowsRemovedForMiQfiisContext: number,
): MiQfiisForeignOwnershipSideMetrics {
  const metrics = evidence.finalTestMetrics;
  return Object.freeze({
    trainingRows: evidence.trainingRows,
    validationRows: evidence.validationRows,
    finalTestRows: evidence.finalTestRows,
    eligibleRowsRemovedForMiQfiisContext,
    selectedThreshold: evidence.thresholdSelection.selectedThreshold,
    accuracy: metrics.accuracy,
    majorityBaselineAccuracy: metrics.majorityBaseline,
    accuracyDeltaVsBaseline: round(metrics.accuracy - metrics.majorityBaseline),
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
    warnings: economic.warnings,
  });
}

function assertControlCutoffReproduction(
  cutoff: string,
  controlMetrics: MiQfiisForeignOwnershipSideMetrics,
  targetSymbol: TwseMiQfiisSupportedSymbol,
): void {
  if (targetSymbol !== TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL) return;
  const expected = CONTROL_EXPECTED_CUTOFFS.find((candidate) => candidate.cutoff === cutoff);
  if (expected === undefined) return;
  if (
    Math.abs(controlMetrics.accuracy - expected.accuracy) >= 1e-4
    || Math.abs(controlMetrics.majorityBaselineAccuracy - expected.majorityBaseline) >= 1e-4
    || Math.abs(controlMetrics.excessReturn - expected.excessReturn) >= 1e-4
  ) {
    fail(
      `STOP_CONTROL_REPRODUCTION_FAILURE: cutoff ${cutoff} drifted (accuracy=${controlMetrics.accuracy}, baseline=${controlMetrics.majorityBaselineAccuracy}, excess=${controlMetrics.excessReturn})`,
    );
  }
}

function featureDistribution(values: readonly number[]): MiQfiisFeatureDistributionSummary {
  if (values.length === 0) fail("MI_QFIIS feature distribution is empty");
  return Object.freeze({
    minimum: round(Math.min(...values)),
    mean: mean(values),
    maximum: round(Math.max(...values)),
  });
}

function evaluateCutoff(
  input: MiQfiisForeignOwnershipTemporalInput,
  cutoff: string,
  targetSymbol: TwseMiQfiisSupportedSymbol,
): MiQfiisForeignOwnershipTemporalCutoffResult {
  const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoff);
  const asOf = resolveDataEndDate(cutoffRawRows, cutoff);
  const symbolRows = toMarketRows(cutoffRawRows, targetSymbol);
  if (symbolRows.length === 0) fail(`${targetSymbol} has no source rows at cutoff ${cutoff}`);
  if (symbolRows.some((row) => row.date > asOf)) {
    fail(`${targetSymbol} source row exceeds resolved asOf at cutoff ${cutoff}`);
  }

  const cutoffMiQfiisRecords = input.miQfiisRecords.filter((record) => record.tradeDate <= asOf);
  if (cutoffMiQfiisRecords.length === 0) fail(`${targetSymbol} has no MI_QFIIS records at cutoff ${cutoff}`);
  const featureBuild = buildMiQfiisForeignOwnershipFeatureRows({
    targetSymbol,
    targetRows: symbolRows,
    miQfiisRecords: cutoffMiQfiisRecords,
  });
  const populationDrift = featureBuild.controlFeatureRows.length !== featureBuild.featureRows.length
    || featureBuild.controlFeatureRows.some((controlRow, index) => {
      const challengerRow = featureBuild.featureRows[index];
      return challengerRow === undefined
        || controlRow.symbol !== challengerRow.symbol
        || controlRow.featureDate !== challengerRow.featureDate
        || controlRow.targetDate !== challengerRow.targetDate
        || controlRow.featureSourceStartDate !== challengerRow.featureSourceStartDate
        || controlRow.featureSourceEndDate !== challengerRow.featureSourceEndDate
        || controlRow.target !== challengerRow.target
        || controlRow.forwardReturn !== challengerRow.forwardReturn;
    });
  if (populationDrift) {
    fail(`STOP_CONTROL_CHALLENGER_POPULATION_DRIFT: row identity mismatch at cutoff ${cutoff}`);
  }
  const controlSplit = splitChronologically(featureBuild.controlFeatureRows);
  const challengerSplit = splitChronologically(featureBuild.featureRows);

  if (
    controlSplit.trainEndDate !== challengerSplit.trainEndDate
    || controlSplit.validationStartDate !== challengerSplit.validationStartDate
    || controlSplit.validationEndDate !== challengerSplit.validationEndDate
    || controlSplit.finalTestStartDate !== challengerSplit.finalTestStartDate
    || controlSplit.training.rows.length !== challengerSplit.training.rows.length
    || controlSplit.validation.rows.length !== challengerSplit.validation.rows.length
    || controlSplit.finalTest.rows.length !== challengerSplit.finalTest.rows.length
  ) {
    fail(`STOP_TEMPORAL_SPLIT_DRIFT: control/challenger split mismatch at cutoff ${cutoff}`);
  }

  const controlEvidence = buildSingleModelEvidence(controlSplit, targetSymbol);
  const controlEconomic = replayEconomic(controlEvidence, input.roundTripCostBps, input.initialCapital);
  const controlMetrics = extractSideMetrics(
    controlEvidence,
    controlEconomic,
    featureBuild.eligibleRowsRemovedForMiQfiisContext,
  );
  assertControlCutoffReproduction(cutoff, controlMetrics, targetSymbol);

  const challengerEvidence = buildSingleModelEvidence(challengerSplit, targetSymbol);
  const challengerEconomic = replayEconomic(challengerEvidence, input.roundTripCostBps, input.initialCapital);
  const challengerMetrics = extractSideMetrics(
    challengerEvidence,
    challengerEconomic,
    featureBuild.eligibleRowsRemovedForMiQfiisContext,
  );

  const lag1Values = featureBuild.featureRows.map((row) => row.features[5]!);
  const change5dValues = featureBuild.featureRows.map((row) => row.features[6]!);
  const change20dValues = featureBuild.featureRows.map((row) => row.features[7]!);
  const latestMiQfiisTradeDate = maximumDate(cutoffMiQfiisRecords.map((record) => record.tradeDate));

  const miQfiisContext: MiQfiisForeignOwnershipCutoffContextSummary = Object.freeze({
    targetSymbol,
    miQfiisDataAsOf: latestMiQfiisTradeDate,
    foreignHoldingRatioLag1Summary: featureDistribution(lag1Values),
    foreignHoldingRatioChange5dSummary: featureDistribution(change5dValues),
    foreignHoldingRatioChange20dSummary: featureDistribution(change20dValues),
    missingContextRows: featureBuild.missingContextRows,
    strictPitRule: TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE,
    earliestEligibleDate: featureBuild.earliestEligibleDate,
  });

  const deltasVsControl: MiQfiisForeignOwnershipDeltasVsControl = Object.freeze({
    accuracyDelta: round(challengerMetrics.accuracy - controlMetrics.accuracy),
    balancedAccuracyDelta: round(challengerMetrics.balancedAccuracy - controlMetrics.balancedAccuracy),
    logLossDelta: round(challengerMetrics.logLoss - controlMetrics.logLoss),
    brierDelta: round(challengerMetrics.brierScore - controlMetrics.brierScore),
    excessReturnDelta: round(challengerMetrics.excessReturn - controlMetrics.excessReturn),
    maxDrawdownDelta: round(challengerMetrics.strategyMaxDrawdown - controlMetrics.strategyMaxDrawdown),
    tradeCountDelta: challengerMetrics.tradeCount - controlMetrics.tradeCount,
  });

  const warnings = uniqueMessages([
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    `${targetSymbol} MI_QFIIS features (foreign_holding_ratio_lag1, foreign_holding_ratio_change_5d, foreign_holding_ratio_change_20d) applied strictly point-in-time (tradeDate < featureDate).`,
    "Evaluation populations between Control (5 features) and Challenger (8 features) are strictly identical.",
    ...controlMetrics.warnings,
    ...challengerMetrics.warnings,
  ]);

  const normalized = {
    cutoff,
    asOf,
    symbol: targetSymbol,
    sourceRowsAsOf: cutoffRawRows.length,
    miQfiisRecordsAsOf: cutoffMiQfiisRecords.length,
    symbolRowsAsOf: symbolRows.length,
    marketRowsSha256: hashMarketRows(symbolRows),
    featureRowsSha256: hashFeatureRows(featureBuild.controlFeatureRows),
    challengerFeatureRowsSha256: hashFeatureRows(featureBuild.featureRows),
    controlFeatureNames: Object.freeze([...RESEARCH_FEATURE_NAMES]),
    featureNames: Object.freeze([...RESEARCH_FEATURE_NAMES, ...TWSE_MI_QFIIS_FEATURE_FIELDS]),
    featureFamily: TWSE_MI_QFIIS_FEATURE_FAMILY,
    finalTestEndDate: maximumDate(challengerSplit.finalTest.rows.map((row) => row.targetDate)),
    dataQualityFindings: Object.freeze([]),
    control: controlEvidence,
    controlEconomic,
    controlMetrics,
    challenger: challengerEvidence,
    challengerEconomic,
    challengerMetrics,
    miQfiisContext,
    deltasVsControl,
    warnings,
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function summarizeSideMetrics(
  metricsList: readonly MiQfiisForeignOwnershipSideMetrics[],
): MiQfiisForeignOwnershipTemporalSummary {
  const excessReturns = metricsList.map((metrics) => metrics.excessReturn);
  const accuracyDeltas = metricsList.map((metrics) => metrics.accuracyDeltaVsBaseline);
  const thresholds = metricsList.map((metrics) => metrics.selectedThreshold);
  return Object.freeze({
    cutoffCount: metricsList.length,
    positiveExcessCutoffs: excessReturns.filter((value) => value > 0).length,
    directionalBaselineWins: accuracyDeltas.filter((value) => value > 0).length,
    medianAccuracyDeltaVsBaseline: median(accuracyDeltas),
    medianExcessReturn: median(excessReturns),
    latestExcessReturn: excessReturns.at(-1) ?? 0,
    thresholdRange: Object.freeze({
      minimum: round(Math.min(...thresholds)),
      maximum: round(Math.max(...thresholds)),
    }),
  });
}

function summarizeComparisonVsControl(
  cutoffRuns: readonly MiQfiisForeignOwnershipTemporalCutoffResult[],
): MiQfiisForeignOwnershipComparisonSummaryVsControl {
  let directionalWins = 0;
  let calibrationWins = 0;
  let economicWins = 0;
  let drawdownWinsVsControl = 0;
  let allQualityWinsVsControl = 0;
  const accuracyDeltas: number[] = [];
  const balancedAccuracyDeltas: number[] = [];
  const logLossDeltas: number[] = [];
  const brierDeltas: number[] = [];
  const excessDeltas: number[] = [];
  const maxDrawdownDeltas: number[] = [];

  for (const run of cutoffRuns) {
    const deltas = run.deltasVsControl;
    const directionalWin = deltas.accuracyDelta > 0 && deltas.balancedAccuracyDelta > 0;
    const calibrationWin = deltas.logLossDelta <= 0 && deltas.brierDelta <= 0;
    const economicWin = deltas.excessReturnDelta > 0 && deltas.maxDrawdownDelta <= 0;
    const drawdownWin = deltas.maxDrawdownDelta <= 0;

    if (directionalWin) directionalWins += 1;
    if (calibrationWin) calibrationWins += 1;
    if (economicWin) economicWins += 1;
    if (drawdownWin) drawdownWinsVsControl += 1;
    if (directionalWin && calibrationWin && economicWin) allQualityWinsVsControl += 1;

    accuracyDeltas.push(deltas.accuracyDelta);
    balancedAccuracyDeltas.push(deltas.balancedAccuracyDelta);
    logLossDeltas.push(deltas.logLossDelta);
    brierDeltas.push(deltas.brierDelta);
    excessDeltas.push(deltas.excessReturnDelta);
    maxDrawdownDeltas.push(deltas.maxDrawdownDelta);
  }

  return Object.freeze({
    directionalWins,
    calibrationWins,
    economicWins,
    directionalQualityWinsVsControl: directionalWins,
    calibrationWinsVsControl: calibrationWins,
    economicWinsVsControl: economicWins,
    drawdownWinsVsControl,
    allQualityWinsVsControl,
    medianAccuracyDeltaVsControl: median(accuracyDeltas),
    medianBalancedAccuracyDeltaVsControl: median(balancedAccuracyDeltas),
    medianLogLossDeltaVsControl: median(logLossDeltas),
    medianBrierDeltaVsControl: median(brierDeltas),
    medianExcessDeltaVsControl: median(excessDeltas),
    latestExcessDeltaVsControl: excessDeltas.at(-1) ?? 0,
    medianMaxDrawdownDeltaVsControl: median(maxDrawdownDeltas),
  });
}

function verifyControlReproduction(
  cutoffRuns: readonly MiQfiisForeignOwnershipTemporalCutoffResult[],
  targetSymbol: TwseMiQfiisSupportedSymbol,
): MiQfiisForeignOwnershipControlReproduction {
  const observedExcess = cutoffRuns.map((run) => run.controlMetrics.excessReturn);
  const observedAccuracyDeltas = cutoffRuns.map((run) => run.controlMetrics.accuracyDeltaVsBaseline);
  const observedThresholds = cutoffRuns.map((run) => run.controlMetrics.selectedThreshold);
  const expected = Object.freeze({
    positiveExcessCutoffs: 3,
    directionalBaselineWins: 2,
    medianExcessReturn: 0.04711293,
    latestExcessReturn: -0.01025134,
    threshold: 0.575,
  });
  const observed = Object.freeze({
    positiveExcessCutoffs: observedExcess.filter((value) => value > 0).length,
    directionalBaselineWins: observedAccuracyDeltas.filter((value) => value > 0).length,
    medianExcessReturn: median(observedExcess),
    latestExcessReturn: observedExcess.at(-1) ?? 0,
    observedThresholds: Object.freeze(observedThresholds),
  });
  if (targetSymbol !== TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL) {
    return Object.freeze({ status: "NOT_APPLICABLE", expected, observed });
  }
  const expectedDatesMatch = cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((candidate, index) => cutoffRuns[index]?.cutoff === candidate.cutoff);
  if (!expectedDatesMatch) {
    return Object.freeze({ status: "NOT_APPLICABLE", expected, observed });
  }
  if (
    observed.positiveExcessCutoffs !== expected.positiveExcessCutoffs
    || observed.directionalBaselineWins !== expected.directionalBaselineWins
    || Math.abs(observed.medianExcessReturn - expected.medianExcessReturn) >= 1e-4
    || Math.abs(observed.latestExcessReturn - expected.latestExcessReturn) >= 1e-4
    || observed.observedThresholds.some((threshold) => threshold !== expected.threshold)
  ) {
    fail("STOP_CONTROL_REPRODUCTION_FAILURE: aggregate accepted control evidence drifted");
  }
  return Object.freeze({ status: "PASS", expected, observed });
}

function deriveDecision(
  directionalWins: number,
  calibrationWins: number,
  economicWins: number,
): MiQfiisDecision {
  if (directionalWins >= 3 && calibrationWins >= 3 && economicWins >= 3) {
    return "KEEP_MI_QFIIS_FEATURE_SLICE";
  }
  if (directionalWins <= 1 || calibrationWins <= 1 || economicWins <= 1) {
    return "REJECT_MI_QFIIS_FEATURE_SLICE";
  }
  return "NEED_ONE_CONFIRMATION";
}

export function runPerSymbolMiQfiisForeignOwnershipLogisticChallengerTemporal(
  input: MiQfiisForeignOwnershipTemporalInput,
): MiQfiisForeignOwnershipTemporalResult {
  const targetSymbol = input.targetSymbol ?? TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL;
  validateTargetSymbol(targetSymbol);
  const cutoffDates = validateCutoffDates(input.cutoffDates);
  if (
    cutoffDates.length !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES.length
    || cutoffDates.some((cutoff, index) => cutoff !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES[index])
  ) {
    fail("canonical four temporal cutoffs are required");
  }
  if (input.initialCapital <= 0) fail("initial capital must be positive");
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(`canonical 10 bps transaction cost required, received ${input.roundTripCostBps}`);
  }
  if (input.miQfiisRecords.length === 0) fail("MI_QFIIS records cannot be empty");
  if (input.miQfiisRecords.some((record) => record.symbol !== targetSymbol)) {
    fail(`STOP_MIXED_SYMBOL_INPUT: MI_QFIIS records must contain only ${targetSymbol}`);
  }

  const cutoffRuns = cutoffDates.map((cutoff) => evaluateCutoff(input, cutoff, targetSymbol));
  const controlTemporalSummary = summarizeSideMetrics(cutoffRuns.map((run) => run.controlMetrics));
  const challengerTemporalSummary = summarizeSideMetrics(cutoffRuns.map((run) => run.challengerMetrics));
  const comparisonSummaryVsControl = summarizeComparisonVsControl(cutoffRuns);
  const controlReproduction = verifyControlReproduction(cutoffRuns, targetSymbol);
  const decision = deriveDecision(
    comparisonSummaryVsControl.directionalWins,
    comparisonSummaryVsControl.calibrationWins,
    comparisonSummaryVsControl.economicWins,
  );
  const nextRoute: MiQfiisNextRoute = targetSymbol !== TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL
    ? "MULTI_SYMBOL_GENERALIZATION_GATE_ONLY"
    : decision === "KEEP_MI_QFIIS_FEATURE_SLICE"
      ? "MI_QFIIS_FEATURE_SLICE_PRODUCTION_INTEGRATION"
      : decision === "REJECT_MI_QFIIS_FEATURE_SLICE"
        ? "STOP_MI_QFIIS_FEATURE_RESEARCH_AND_REASSESS_ALTERNATIVE_DATA"
        : "COLLECT_FURTHER_TEMPORAL_CONFIRMATION";

  const symbolRows = toMarketRows(input.rawRows, targetSymbol);
  if (symbolRows.length === 0) fail(`${targetSymbol} has no source rows`);
  const minDate = minimumDate(symbolRows.map((row) => row.date));
  const maxDate = maximumDate(symbolRows.map((row) => row.date));
  const normalized = {
    schemaVersion: targetSymbol === TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL
      ? SCHEMA_VERSION
      : MULTI_SYMBOL_SCHEMA_VERSION,
    classification: targetSymbol === TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL
      ? CLASSIFICATION
      : MULTI_SYMBOL_CLASSIFICATION,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: RESEARCH_MODE,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    symbol: targetSymbol,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    datasetVersion: input.datasetVersion,
    requestedCutoffDates: Object.freeze([...cutoffDates]),
    source: Object.freeze({
      ohlcvPath: input.source.ohlcvPath,
      ohlcvSha256: input.source.ohlcvSha256,
      miQfiisPath: input.source.miQfiisPath,
      miQfiisSha256: input.source.miQfiisSha256,
      fullDateRange: Object.freeze({ min: minDate, max: maxDate }),
      fullRowCount: input.rawRows.length,
      symbolRowCount: symbolRows.length,
      miQfiisRecordCount: input.miQfiisRecords.length,
      dataAsOf: maxDate,
    }),
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames: Object.freeze([...RESEARCH_FEATURE_NAMES]),
    featureNames: Object.freeze([...RESEARCH_FEATURE_NAMES, ...TWSE_MI_QFIIS_FEATURE_FIELDS]),
    featureFamily: TWSE_MI_QFIIS_FEATURE_FAMILY,
    cutoffRuns: Object.freeze(cutoffRuns),
    controlTemporalSummary,
    challengerTemporalSummary,
    comparisonSummaryVsControl,
    controlReproduction,
    decision,
    nextRoute,
    promotionDecision: "do_not_promote" as const,
    warnings: Object.freeze([
      "Diagnostic-only historical quantitative research study; no promotion, no order execution, no investment advice.",
      targetSymbol === TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL
        ? "Frozen control reproduced before computing challenger comparison deltas."
        : "0056 discovery/control reproduction is not applied to this independently fitted OOS symbol.",
      "Strict point-in-time invariant (tradeDate < featureDate) enforced for all MI_QFIIS features.",
      "Evaluation populations between Control (5 features) and Challenger (8 features) are strictly identical.",
      ...uniqueMessages(cutoffRuns.flatMap((run) => run.warnings)),
    ]),
    guardrails: guardrails(),
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
