import {
  CANONICAL_TRANSACTION_COST_BPS,
  RESEARCH_FEATURE_NAMES,
  buildMarketRegimeContextFeatureRows,
  filterRowsForCutoff,
  fitLogisticRegression,
  fitStandardScaler,
  hashFeatureRows,
  hashMarketRows,
  hashValue,
  resolveDataEndDate,
  selectValidationThreshold,
  createFinalTestEvaluator,
  buildFinalTestEconomicEvidence,
  splitChronologically,
  toMarketRows,
  validateCutoffDates,
  MARKET_REGIME_ALIGNMENT_RULE,
  MARKET_REGIME_CONTEXT_FEATURE_FAMILY,
  MARKET_REGIME_CONTEXT_SOURCE_SERIES,
  MARKET_REGIME_CONTEXT_SOURCE_SYMBOL,
  MARKET_REGIME_FEATURE_FIELDS,
  MARKET_REGIME_MISSING_CONTEXT_RULE,
  MARKET_REGIME_TARGET_SYMBOL,
  type DatasetVersion,
  type PerSymbolLogisticChallengerFeatureFamily,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
  type ThreeWayChronologicalSplit,
} from "@mms/research-kernel";

import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import {
  LongCashReplayError,
  type LongCashReplayGuardrails,
} from "./types.js";

const SCHEMA_VERSION = "MMS_0056_MARKET_REGIME_CONTEXT_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_MARKET_REGIME_CONTEXT_FEATURE_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = MARKET_REGIME_TARGET_SYMBOL;
const RESEARCH_MODE = "diagnostic-only" as const;

export interface MarketRegimeTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface MarketRegimeTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: MarketRegimeTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface MarketRegimeSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly eligibleRowsRemovedForMarketContext: number;
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

export interface MarketRegimeCutoffContextSummary {
  readonly marketContextSource: typeof MARKET_REGIME_CONTEXT_SOURCE_SYMBOL;
  readonly marketContextSourceSeries: typeof MARKET_REGIME_CONTEXT_SOURCE_SERIES;
  readonly marketContextDataAsOf: string;
  readonly marketReturn20dSummary: {
    readonly minimum: number;
    readonly mean: number;
    readonly maximum: number;
  };
  readonly marketVolatility10dSummary: {
    readonly minimum: number;
    readonly mean: number;
    readonly maximum: number;
  };
  readonly missingContextRows: number;
  readonly alignmentRule: typeof MARKET_REGIME_ALIGNMENT_RULE;
  readonly missingContextRule: typeof MARKET_REGIME_MISSING_CONTEXT_RULE;
  readonly earliestEligibleDate: string;
}

export interface MarketRegimeDeltasVsControl {
  readonly accuracyDelta: number;
  readonly balancedAccuracyDelta: number;
  readonly logLossDelta: number;
  readonly brierDelta: number;
  readonly excessReturnDelta: number;
  readonly maxDrawdownDelta: number;
  readonly tradeCountDelta: number;
}

export interface MarketRegimeTemporalCutoffResult {
  readonly cutoff: string;
  readonly asOf: string;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly sourceRowsAsOf: number;
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
  readonly controlMetrics: MarketRegimeSideMetrics;
  readonly challenger: PerSymbolLogisticChallengerSymbolEvidence;
  readonly challengerEconomic: FinalTestEconomicEdgeGroup;
  readonly challengerMetrics: MarketRegimeSideMetrics;
  readonly marketContext: MarketRegimeCutoffContextSummary;
  readonly deltasVsControl: MarketRegimeDeltasVsControl;
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface MarketRegimeTemporalSummary {
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

export interface MarketRegimeComparisonSummaryVsControl {
  readonly directionalWinsVsControl: number;
  readonly economicWinsVsControl: number;
  readonly bothWinsVsControl: number;
  readonly medianAccuracyDeltaVsControl: number;
  readonly medianBalancedAccuracyDeltaVsControl: number;
  readonly medianExcessDeltaVsControl: number;
  readonly latestExcessDeltaVsControl: number;
  readonly medianMaxDrawdownDeltaVsControl: number;
}

export interface MarketRegimeControlReproduction {
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

export type MarketRegimeAnswer = "YES" | "NO" | "MIXED";
export type MarketRegimeConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type MarketRegimeNextRoute =
  | "MARKET_REGIME_CONTEXT_CONFIRMATION_OR_UNIVERSE_EXPANSION"
  | "STOP_CURRENT_5_FEATURE_RESEARCH_LINE_AND_REASSESS_DATA_STRATEGY";

export interface MarketRegimeTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface MarketRegimeTemporalResult {
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
  readonly featureFamily: PerSymbolLogisticChallengerFeatureFamily;
  readonly cutoffRuns: readonly MarketRegimeTemporalCutoffResult[];
  readonly controlTemporalSummary: MarketRegimeTemporalSummary;
  readonly challengerTemporalSummary: MarketRegimeTemporalSummary;
  readonly comparisonSummaryVsControl: MarketRegimeComparisonSummaryVsControl;
  readonly controlReproduction: MarketRegimeControlReproduction;
  readonly doesMarketRegimeContextImproveDirectionalEvidence: MarketRegimeAnswer;
  readonly doesMarketRegimeContextImproveEconomicEvidence: MarketRegimeAnswer;
  readonly marketRegimeChallengerConclusion: MarketRegimeConclusion;
  readonly ceoNextRoute: MarketRegimeNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: MarketRegimeTemporalGuardrails;
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
  return Object.freeze([...new Set(messages.filter((m) => m.trim().length > 0))]);
}

function minimumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find minimum date in an empty collection");
  return values.reduce((min, val) => (val < min ? val : min), first);
}

function maximumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find maximum date in an empty collection");
  return values.reduce((max, val) => (val > max ? val : max), first);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute mean of zero values");
  return round(values.reduce((s, v) => s + v, 0) / values.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute median of zero values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - (sorted.length % 2 === 0 ? 1 : 0)]!;
  const upper = sorted[mid]!;
  return round((lower + upper) / 2);
}

function guardrails(): MarketRegimeTemporalGuardrails {
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

function buildSingleModelEvidence(
  split: ThreeWayChronologicalSplit,
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

  const predictions = scoredRows.map((r) => r.prediction);
  const probabilities = scoredRows.map((r) => r.probability);
  const predictedUpRate = predictions.length === 0
    ? 0
    : round(predictions.reduce((s: number, p) => s + (p === 1 ? 1 : 0), 0) / predictions.length);
  const meanProbabilityUp = probabilities.length === 0
    ? 0
    : round(probabilities.reduce((s: number, p) => s + p, 0) / probabilities.length);
  const actualUpRate = metrics.sampleCount === 0 ? 0 : round(metrics.positiveCount / metrics.sampleCount);

  return Object.freeze({
    symbol: TARGET_SYMBOL,
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
  eligibleRowsRemovedForMarketContext: number,
): MarketRegimeSideMetrics {
  const m = evidence.finalTestMetrics;
  return Object.freeze({
    trainingRows: evidence.trainingRows,
    validationRows: evidence.validationRows,
    finalTestRows: evidence.finalTestRows,
    eligibleRowsRemovedForMarketContext,
    selectedThreshold: evidence.thresholdSelection.selectedThreshold,
    accuracy: m.accuracy,
    majorityBaselineAccuracy: m.majorityBaseline,
    accuracyDeltaVsBaseline: round(m.accuracy - m.majorityBaseline),
    balancedAccuracy: m.balancedAccuracy,
    logLoss: m.logLoss,
    brierScore: m.brierScore,
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

function evaluateCutoff(
  input: MarketRegimeTemporalInput,
  cutoff: string,
): MarketRegimeTemporalCutoffResult {
  const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoff);
  const asOf = resolveDataEndDate(cutoffRawRows, cutoff);

  const symbolRows0056 = toMarketRows(cutoffRawRows, TARGET_SYMBOL);
  if (symbolRows0056.length === 0) fail(`0056 has no source rows at cutoff ${cutoff}`);
  if (symbolRows0056.some((row) => row.date > asOf)) {
    fail(`0056 source row exceeds resolved asOf at cutoff ${cutoff}`);
  }

  const source0050Rows = toMarketRows(cutoffRawRows, MARKET_REGIME_CONTEXT_SOURCE_SYMBOL);
  if (source0050Rows.length === 0) fail(`0050 has no source rows at cutoff ${cutoff}`);
  if (source0050Rows.some((row) => row.date > asOf)) {
    fail(`0050 source row exceeds resolved asOf at cutoff ${cutoff}`);
  }

  if (input.candidateDataQualityBasis !== "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH") {
    fail(`STOP_MMS_0056_MARKET_REGIME_ADJUSTED_0050_UNAVAILABLE: invalid basis ${input.candidateDataQualityBasis}`);
  }

  // Build PIT-safe market regime context feature rows
  const regimeResult = buildMarketRegimeContextFeatureRows({
    targetRows: symbolRows0056,
    source0050AdjustedRows: source0050Rows,
  });

  const controlFeatureRows = regimeResult.controlFeatureRows;
  const challengerFeatureRows = regimeResult.featureRows;

  // Split both on identical chronological boundaries
  const controlSplit = splitChronologically(controlFeatureRows);
  const challengerSplit = splitChronologically(challengerFeatureRows);

  if (
    controlSplit.trainEndDate !== challengerSplit.trainEndDate
    || controlSplit.validationStartDate !== challengerSplit.validationStartDate
    || controlSplit.validationEndDate !== challengerSplit.validationEndDate
    || controlSplit.finalTestStartDate !== challengerSplit.finalTestStartDate
    || controlSplit.training.rows.length !== challengerSplit.training.rows.length
    || controlSplit.validation.rows.length !== challengerSplit.validation.rows.length
    || controlSplit.finalTest.rows.length !== challengerSplit.finalTest.rows.length
  ) {
    fail(`STOP_MMS_0056_MARKET_REGIME_COMPARABILITY_UNRESOLVED: split boundaries mismatch at cutoff ${cutoff}`);
  }

  // Evaluate Control (5 features)
  const controlEvidence = buildSingleModelEvidence(controlSplit);
  const controlEconomic = replayEconomic(
    controlEvidence,
    input.roundTripCostBps,
    input.initialCapital,
  );
  const controlMetrics = extractSideMetrics(
    controlEvidence,
    controlEconomic,
    regimeResult.eligibleRowsRemovedForMarketContext,
  );

  // Evaluate Challenger (7 features)
  const challengerEvidence = buildSingleModelEvidence(challengerSplit);
  const challengerEconomic = replayEconomic(
    challengerEvidence,
    input.roundTripCostBps,
    input.initialCapital,
  );
  const challengerMetrics = extractSideMetrics(
    challengerEvidence,
    challengerEconomic,
    regimeResult.eligibleRowsRemovedForMarketContext,
  );

  // Compute market context summaries
  const marketReturn20dValues = challengerFeatureRows.map((r) => r.features[5]!);
  const marketVolatility10dValues = challengerFeatureRows.map((r) => r.features[6]!);

  const marketReturn20dSummary = Object.freeze({
    minimum: round(Math.min(...marketReturn20dValues)),
    mean: mean(marketReturn20dValues),
    maximum: round(Math.max(...marketReturn20dValues)),
  });

  const marketVolatility10dSummary = Object.freeze({
    minimum: round(Math.min(...marketVolatility10dValues)),
    mean: mean(marketVolatility10dValues),
    maximum: round(Math.max(...marketVolatility10dValues)),
  });

  const marketContext: MarketRegimeCutoffContextSummary = Object.freeze({
    marketContextSource: MARKET_REGIME_CONTEXT_SOURCE_SYMBOL,
    marketContextSourceSeries: MARKET_REGIME_CONTEXT_SOURCE_SERIES,
    marketContextDataAsOf: asOf,
    marketReturn20dSummary,
    marketVolatility10dSummary,
    missingContextRows: regimeResult.missingContextRows,
    alignmentRule: MARKET_REGIME_ALIGNMENT_RULE,
    missingContextRule: MARKET_REGIME_MISSING_CONTEXT_RULE,
    earliestEligibleDate: regimeResult.earliestEligibleDate,
  });

  const deltasVsControl: MarketRegimeDeltasVsControl = Object.freeze({
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
    "0050 adjusted market context features (market_return_20d, market_volatility_10d) applied point-in-time.",
    "Evaluation populations between Control (5 features) and Challenger (7 features) are strictly identical.",
    ...controlMetrics.warnings,
    ...challengerMetrics.warnings,
  ]);

  const normalized = {
    cutoff,
    asOf,
    symbol: TARGET_SYMBOL,
    sourceRowsAsOf: cutoffRawRows.length,
    symbolRowsAsOf: symbolRows0056.length,
    marketRowsSha256: hashMarketRows(symbolRows0056),
    featureRowsSha256: hashFeatureRows(controlFeatureRows),
    challengerFeatureRowsSha256: hashFeatureRows(challengerFeatureRows),
    controlFeatureNames: Object.freeze([...RESEARCH_FEATURE_NAMES]),
    featureNames: Object.freeze([...RESEARCH_FEATURE_NAMES, ...MARKET_REGIME_FEATURE_FIELDS]),
    featureFamily: MARKET_REGIME_CONTEXT_FEATURE_FAMILY,
    finalTestEndDate: maximumDate(challengerSplit.finalTest.rows.map((r) => r.targetDate)),
    dataQualityFindings: Object.freeze([]),
    control: controlEvidence,
    controlEconomic,
    controlMetrics,
    challenger: challengerEvidence,
    challengerEconomic,
    challengerMetrics,
    marketContext,
    deltasVsControl,
    warnings,
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function summarizeSideMetrics(
  metricsList: readonly MarketRegimeSideMetrics[],
): MarketRegimeTemporalSummary {
  const excessReturns = metricsList.map((m) => m.excessReturn);
  const accuracyDeltas = metricsList.map((m) => m.accuracyDeltaVsBaseline);
  const thresholds = metricsList.map((m) => m.selectedThreshold);

  return Object.freeze({
    cutoffCount: metricsList.length,
    positiveExcessCutoffs: excessReturns.filter((r) => r > 0).length,
    directionalBaselineWins: accuracyDeltas.filter((d) => d > 0).length,
    medianAccuracyDeltaVsBaseline: median(accuracyDeltas),
    medianExcessReturn: median(excessReturns),
    latestExcessReturn: excessReturns[excessReturns.length - 1] ?? 0,
    thresholdRange: Object.freeze({
      minimum: round(Math.min(...thresholds)),
      maximum: round(Math.max(...thresholds)),
    }),
  });
}

function summarizeComparisonVsControl(
  cutoffRuns: readonly MarketRegimeTemporalCutoffResult[],
): MarketRegimeComparisonSummaryVsControl {
  let directionalWinsVsControl = 0;
  let economicWinsVsControl = 0;
  let bothWinsVsControl = 0;

  const accuracyDeltas: number[] = [];
  const balancedAccuracyDeltas: number[] = [];
  const excessDeltas: number[] = [];
  const maxDrawdownDeltas: number[] = [];

  for (const run of cutoffRuns) {
    const d = run.deltasVsControl;
    const dirWin = d.accuracyDelta > 0;
    const ecoWin = d.excessReturnDelta > 0;
    if (dirWin) directionalWinsVsControl += 1;
    if (ecoWin) economicWinsVsControl += 1;
    if (dirWin && ecoWin) bothWinsVsControl += 1;

    accuracyDeltas.push(d.accuracyDelta);
    balancedAccuracyDeltas.push(d.balancedAccuracyDelta);
    excessDeltas.push(d.excessReturnDelta);
    maxDrawdownDeltas.push(d.maxDrawdownDelta);
  }

  return Object.freeze({
    directionalWinsVsControl,
    economicWinsVsControl,
    bothWinsVsControl,
    medianAccuracyDeltaVsControl: median(accuracyDeltas),
    medianBalancedAccuracyDeltaVsControl: median(balancedAccuracyDeltas),
    medianExcessDeltaVsControl: median(excessDeltas),
    latestExcessDeltaVsControl: excessDeltas[excessDeltas.length - 1] ?? 0,
    medianMaxDrawdownDeltaVsControl: median(maxDrawdownDeltas),
  });
}

function verifyControlReproduction(
  cutoffRuns: readonly MarketRegimeTemporalCutoffResult[],
): MarketRegimeControlReproduction {
  const observedThresholds = cutoffRuns.map((r) => r.controlMetrics.selectedThreshold);
  const observedExcess = cutoffRuns.map((r) => r.controlMetrics.excessReturn);
  const observedAccDeltas = cutoffRuns.map((r) => r.controlMetrics.accuracyDeltaVsBaseline);

  const positiveExcessCutoffs = observedExcess.filter((r) => r > 0).length;
  const directionalBaselineWins = observedAccDeltas.filter((d) => d > 0).length;
  const medianExcessReturn = median(observedExcess);
  const latestExcessReturn = observedExcess[observedExcess.length - 1] ?? 0;

  const expectedDatesMatch =
    cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((expected, index) => cutoffRuns[index]?.cutoff === expected.cutoff);

  const expected = Object.freeze({
    positiveExcessCutoffs: 3,
    directionalBaselineWins: 2,
    medianExcessReturn: 0.04711293,
    latestExcessReturn: -0.01025134,
    threshold: 0.575,
  });

  const observed = Object.freeze({
    positiveExcessCutoffs,
    directionalBaselineWins,
    medianExcessReturn,
    latestExcessReturn,
    observedThresholds: Object.freeze(observedThresholds),
  });

  if (!expectedDatesMatch) {
    return Object.freeze({
      status: "NOT_APPLICABLE" as const,
      expected,
      observed,
    });
  }

  const matchesExpected = CONTROL_EXPECTED_CUTOFFS.every((expectedCutoff) => {
    const run = cutoffRuns.find((r) => r.cutoff === expectedCutoff.cutoff);
    if (!run) return false;
    return (
      Math.abs(run.controlMetrics.accuracy - expectedCutoff.accuracy) < 1e-4
      && Math.abs(run.controlMetrics.majorityBaselineAccuracy - expectedCutoff.majorityBaseline) < 1e-4
      && Math.abs(run.controlMetrics.excessReturn - expectedCutoff.excessReturn) < 1e-4
    );
  });

  if (!matchesExpected) {
    fail("STOP_MMS_0056_MARKET_REGIME_CONTROL_DRIFT: control reproduction failed against accepted floats");
  }

  return Object.freeze({
    status: "PASS" as const,
    expected,
    observed,
  });
}

export function runPerSymbolMarketRegimeLogisticChallengerTemporal(
  input: MarketRegimeTemporalInput,
): MarketRegimeTemporalResult {
  const cutoffDates = validateCutoffDates(input.cutoffDates);
  if (input.initialCapital <= 0) fail("initial capital must be positive");
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(`canonical 10 bps transaction cost required, received ${input.roundTripCostBps}`);
  }

  const cutoffRuns = cutoffDates.map((cutoff) => evaluateCutoff(input, cutoff));

  const controlTemporalSummary = summarizeSideMetrics(cutoffRuns.map((r) => r.controlMetrics));
  const challengerTemporalSummary = summarizeSideMetrics(cutoffRuns.map((r) => r.challengerMetrics));
  const comparisonSummaryVsControl = summarizeComparisonVsControl(cutoffRuns);
  const controlReproduction = verifyControlReproduction(cutoffRuns);

  const doesMarketRegimeContextImproveDirectionalEvidence: MarketRegimeAnswer =
    comparisonSummaryVsControl.directionalWinsVsControl > cutoffRuns.length / 2
      ? "YES"
      : comparisonSummaryVsControl.directionalWinsVsControl > 0
        ? "MIXED"
        : "NO";

  const doesMarketRegimeContextImproveEconomicEvidence: MarketRegimeAnswer =
    comparisonSummaryVsControl.economicWinsVsControl > cutoffRuns.length / 2
      ? "YES"
      : comparisonSummaryVsControl.economicWinsVsControl > 0
        ? "MIXED"
        : "NO";

  const marketRegimeChallengerConclusion: MarketRegimeConclusion =
    comparisonSummaryVsControl.bothWinsVsControl >= 3
      ? "SUPPORTED"
      : comparisonSummaryVsControl.economicWinsVsControl >= 2
        || comparisonSummaryVsControl.directionalWinsVsControl >= 2
        ? "MIXED"
        : "NOT_SUPPORTED";

  const ceoNextRoute: MarketRegimeNextRoute =
    marketRegimeChallengerConclusion === "SUPPORTED"
      ? "MARKET_REGIME_CONTEXT_CONFIRMATION_OR_UNIVERSE_EXPANSION"
      : "STOP_CURRENT_5_FEATURE_RESEARCH_LINE_AND_REASSESS_DATA_STRATEGY";

  const symbolRows = toMarketRows(input.rawRows, TARGET_SYMBOL);
  const minDate = minimumDate(symbolRows.map((r) => r.date));
  const maxDate = maximumDate(symbolRows.map((r) => r.date));

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
    requestedCutoffDates: Object.freeze([...cutoffDates]),
    source: Object.freeze({
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange: Object.freeze({ min: minDate, max: maxDate }),
      fullRowCount: input.rawRows.length,
      symbolRowCount: symbolRows.length,
      dataAsOf: maxDate,
    }),
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames: Object.freeze([...RESEARCH_FEATURE_NAMES]),
    featureNames: Object.freeze([...RESEARCH_FEATURE_NAMES, ...MARKET_REGIME_FEATURE_FIELDS]),
    featureFamily: MARKET_REGIME_CONTEXT_FEATURE_FAMILY,
    cutoffRuns: Object.freeze(cutoffRuns),
    controlTemporalSummary,
    challengerTemporalSummary,
    comparisonSummaryVsControl,
    controlReproduction,
    doesMarketRegimeContextImproveDirectionalEvidence,
    doesMarketRegimeContextImproveEconomicEvidence,
    marketRegimeChallengerConclusion,
    ceoNextRoute,
    promotionDecision: "do_not_promote" as const,
    warnings: Object.freeze([
      "Diagnostic-only historical quantitative research study; no promotion, no order execution, no investment advice.",
      "Frozen broad-market regime context feature family (0050_ADJUSTED_MARKET_REGIME_CONTEXT_V1).",
      "Source-qualified adjusted 0050 historical series used for market regime context.",
      "Identical evaluation populations across Control and Challenger for every cutoff.",
    ]),
    guardrails: guardrails(),
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
