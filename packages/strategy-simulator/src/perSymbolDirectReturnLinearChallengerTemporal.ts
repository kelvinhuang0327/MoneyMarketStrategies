import {
  CANONICAL_TRANSACTION_COST_BPS,
  RESEARCH_FEATURE_NAMES,
  TARGET_HORIZON_ROWS,
  buildHistoricalFeatureRows,
  deriveRoundTripCostFraction,
  filterRowsForCutoff,
  fitLinearRegression,
  fitStandardScaler,
  hashValue,
  isCanonicalIsoDate,
  predictReturn,
  resolveDataEndDate,
  runResearchEvidenceKernel,
  splitChronologically,
  toMarketRows,
  validateCutoffDates,
  type DatasetVersion,
  type FeatureRow,
  type LinearRegressionFit,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RawTwStrategyResearchRow,
  type StandardScalerFit,
  PIVOT_TOLERANCE,
} from "@mms/research-kernel";

import { simulateLongCashReplay } from "./simulateLongCashReplay.js";
import { compareLongCashReplayWithBenchmark } from "./compareLongCashReplay.js";
import { buildFinalTestPerSymbolEconomicEdge } from "./finalTestEconomicEdge.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";
import { LongCashReplayError, type LongCashReplayGuardrails, type LongCashReplayRow } from "./types.js";

const SCHEMA_VERSION = "MMS_0056_DIRECT_RETURN_LINEAR_REGRESSION_CHALLENGER_TEMPORAL_V1" as const;
const CLASSIFICATION = "MMS_0056_DIRECT_RETURN_LINEAR_REGRESSION_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = "0056" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const CONTROL_DRIFT_STOP = "STOP_MMS_0056_DIRECT_RETURN_CONTROL_DRIFT" as const;
const COST_CONTRACT_AMBIGUOUS_STOP = "STOP_MMS_0056_DIRECT_RETURN_COST_CONTRACT_AMBIGUOUS" as const;
const LINEAR_SYSTEM_UNRESOLVED_STOP = "STOP_MMS_0056_DIRECT_RETURN_LINEAR_SYSTEM_UNRESOLVED" as const;

// ── Frozen target contract (declared before any performance inspection) ──

const DIRECT_RETURN_TARGET = "forwardReturn" as const;
const TARGET_HORIZON = "5_TRADING_DAYS" as const;
const FORWARD_RETURN_SOURCE = "features.ts:buildHistoricalFeatureRows" as const;
const TARGET_UNIT = "FRACTIONAL_RETURN" as const;
const DIRECT_RETURN_ACTION_RULE = "predictedForwardReturn > canonicalRoundTripCostFraction" as const;

// ── Types ──

export interface DirectReturnLinearTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface DirectReturnLinearTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: DirectReturnLinearTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface DirectReturnRegressionMetrics {
  readonly targetMeanTraining: number;
  readonly targetStdTraining: number;
  readonly predictionMeanValidation: number;
  readonly predictionMeanFinalTest: number;
  readonly actualMeanValidation: number;
  readonly actualMeanFinalTest: number;
  readonly maeValidation: number;
  readonly rmseValidation: number;
  readonly maeFinalTest: number;
  readonly rmseFinalTest: number;
  readonly pearsonCorrelationValidation: number | null;
  readonly pearsonCorrelationFinalTest: number | null;
  readonly signAccuracyFinalTest: number;
}

export interface DirectReturnControlSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly selectedThreshold: number;
  readonly accuracy: number;
  readonly majorityBaselineAccuracy: number;
  readonly strategyNetReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaxDrawdown: number;
  readonly benchmarkMaxDrawdown: number;
  readonly tradeCount: number;
}

export interface DirectReturnChallengerSideMetrics {
  readonly trainingRows: number;
  readonly validationRows: number;
  readonly finalTestRows: number;
  readonly predictedLongRate: number;
  readonly canonicalCostHurdle: number;
  readonly strategyNetReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaxDrawdown: number;
  readonly benchmarkMaxDrawdown: number;
  readonly tradeCount: number;
  readonly warnings: readonly string[];
}

export interface DirectReturnEconomicComparison {
  readonly controlStrategyNetReturn: number;
  readonly directReturnStrategyNetReturn: number;
  readonly strategyReturnDelta: number;
  readonly commonBenchmarkNetReturn: number;
  readonly controlExcessReturn: number;
  readonly directReturnExcessReturn: number;
  readonly excessReturnDelta: number;
  readonly controlMaxDrawdown: number;
  readonly directReturnMaxDrawdown: number;
  readonly maxDrawdownDelta: number;
  readonly controlTradeCount: number;
  readonly directReturnTradeCount: number;
}

export interface DirectReturnLinearTemporalCutoffResult {
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
  readonly controlMetrics: DirectReturnControlSideMetrics;
  readonly regressionMetrics: DirectReturnRegressionMetrics;
  readonly challengerMetrics: DirectReturnChallengerSideMetrics;
  readonly economicComparison: DirectReturnEconomicComparison;
  readonly linearRegressionFit: {
    readonly coefficientCount: number;
    readonly trainingMSE: number;
    readonly stateSha256: string;
    readonly scalerStateSha256: string;
  };
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface DirectReturnTemporalSummary {
  readonly cutoffCount: number;
  readonly positiveExcessCutoffs: number;
  readonly medianExcessReturn: number;
  readonly minExcessReturn: number;
  readonly maxExcessReturn: number;
  readonly latestExcessReturn: number;
  readonly medianFinalTestMAE: number;
  readonly medianFinalTestRMSE: number;
  readonly medianFinalTestCorrelation: number | null;
  readonly predictedLongRateRange: { readonly minimum: number; readonly maximum: number };
}

export interface DirectReturnEconomicTemporalSummary {
  readonly economicWinsVsControl: number;
  readonly economicLossesVsControl: number;
  readonly economicTiesVsControl: number;
  readonly medianExcessDeltaVsControl: number;
  readonly latestExcessDeltaVsControl: number;
  readonly medianMaxDrawdownDeltaVsControl: number;
}

export interface DirectReturnControlReproduction {
  readonly status: "PASS" | "NOT_APPLICABLE";
  readonly expected: {
    readonly positiveExcessCutoffs: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly threshold: number;
  };
  readonly observed: {
    readonly positiveExcessCutoffs: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly observedThresholds: readonly number[];
  };
}

export type DirectReturnAnswer = "YES" | "NO" | "MIXED";
export type DirectReturnConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type DirectReturnNextRoute =
  | "DIRECT_RETURN_UNIVERSE_EXPANSION_OR_CONFIRMATION"
  | "STOP_0056_LOCAL_MODEL_TWEAKS_AND_REASSESS_FEATURE_DATA_STRATEGY";

export interface DirectReturnLinearTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface DirectReturnLinearTemporalResult {
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
  readonly targetContract: {
    readonly directReturnTarget: typeof DIRECT_RETURN_TARGET;
    readonly targetHorizon: typeof TARGET_HORIZON;
    readonly forwardReturnSource: typeof FORWARD_RETURN_SOURCE;
    readonly targetUnit: typeof TARGET_UNIT;
    readonly actionRule: typeof DIRECT_RETURN_ACTION_RULE;
    readonly pivotTolerance: number;
  };
  readonly targetHorizonRows: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly cutoffRuns: readonly DirectReturnLinearTemporalCutoffResult[];
  readonly challengerTemporalSummary: DirectReturnTemporalSummary;
  readonly economicTemporalSummary: DirectReturnEconomicTemporalSummary;
  readonly controlReproduction: DirectReturnControlReproduction;
  readonly doesDirectReturnModelShowPredictiveSignal: DirectReturnAnswer;
  readonly doesDirectReturnModelImproveEconomicEvidence: DirectReturnAnswer;
  readonly directReturnChallengerConclusion: DirectReturnConclusion;
  readonly ceoNextRoute: DirectReturnNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: DirectReturnLinearTemporalGuardrails;
  readonly normalizedResultSha256: string;
}

// ── Utility functions ──

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

function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX < 1e-15 || varY < 1e-15) return null;
  const r = covXY / Math.sqrt(varX * varY);
  if (!Number.isFinite(r)) return null;
  return round(r);
}

function computeMAE(predictions: readonly number[], actuals: readonly number[]): number {
  if (predictions.length !== actuals.length || predictions.length === 0) {
    fail("MAE requires non-empty equal-length arrays");
  }
  const sum = predictions.reduce((s, p, i) => s + Math.abs(p - actuals[i]!), 0);
  return round(sum / predictions.length);
}

function computeRMSE(predictions: readonly number[], actuals: readonly number[]): number {
  if (predictions.length !== actuals.length || predictions.length === 0) {
    fail("RMSE requires non-empty equal-length arrays");
  }
  const mse = predictions.reduce((s, p, i) => s + (p - actuals[i]!) ** 2, 0) / predictions.length;
  return round(Math.sqrt(mse));
}

function computeSignAccuracy(predictions: readonly number[], actuals: readonly number[]): number {
  if (predictions.length !== actuals.length || predictions.length === 0) {
    fail("sign accuracy requires non-empty equal-length arrays");
  }
  let correct = 0;
  for (let i = 0; i < predictions.length; i += 1) {
    const predSign = predictions[i]! > 0 ? 1 : 0;
    const actualSign = actuals[i]! > 0 ? 1 : 0;
    if (predSign === actualSign) correct += 1;
  }
  return round(correct / predictions.length);
}

function guardrails(): DirectReturnLinearTemporalGuardrails {
  return Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
    supportsSymbolSelection: false,
  });
}

// ── Control reproduction ──

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

function replayControlEconomic(
  symbol: string,
  evidence: import("@mms/research-kernel").FinalTestEconomicEvidence,
  roundTripCostBps: number,
  initialCapital: number,
): FinalTestEconomicEdgeGroup {
  const result = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: evidence,
    roundTripCostBps,
    initialCapital,
    targetHurdle: 0,
  });
  const group = result.groups.find((g) => g.symbol === symbol);
  if (group === undefined) fail(`economic replay missing group for ${symbol}`);
  return group;
}

// ── Direct return economic replay ──

function replayDirectReturnEconomic(
  symbol: string,
  finalTestRows: readonly FeatureRow[],
  scaler: StandardScalerFit,
  model: LinearRegressionFit,
  canonicalCostHurdle: number,
  roundTripCostBps: number,
  initialCapital: number,
): {
  economic: FinalTestEconomicEdgeGroup;
  predictedLongRate: number;
  predictions: readonly number[];
} {
  const symbolFinalTestRows = finalTestRows.filter((r) => r.symbol === symbol);
  if (symbolFinalTestRows.length === 0) fail(`no final-test rows for ${symbol}`);

  // Generate predictions and map to LONG/CASH via the fixed action rule
  const predictions: number[] = [];
  const replayRows: LongCashReplayRow[] = [];
  let longCount = 0;

  for (const row of symbolFinalTestRows) {
    const predictedReturn = predictReturn(row.features, scaler, model.coefficients);
    predictions.push(predictedReturn);
    // Fixed action rule: LONG if predictedReturn > canonicalCostHurdle, else CASH
    // Map to probabilityUp: 1.0 for LONG, 0.0 for CASH
    const isLong = predictedReturn > canonicalCostHurdle;
    if (isLong) longCount += 1;
    replayRows.push({
      entryDate: row.featureDate,
      exitDate: row.targetDate,
      probabilityUp: isLong ? 1.0 : 0.0,
      realizedForwardReturn: row.forwardReturn,
    });
  }

  // Replay through the canonical simulator
  // validationThreshold = 0.5 so that probabilityUp >= 0.5 → LONG
  // Since we mapped LONG to probabilityUp=1.0 and CASH to probabilityUp=0.0, this works exactly
  const replay = simulateLongCashReplay({
    symbol,
    validationThreshold: 0.5,
    roundTripCostBps,
    initialCapital,
    rows: replayRows,
  });

  const comparison = compareLongCashReplayWithBenchmark(replay);
  if (comparison.excessReturn !== replay.excessReturn) {
    fail(`canonical benchmark comparison drifted for ${symbol}`);
  }

  function compoundedGrossReturn(field: "strategyGrossReturn" | "benchmarkGrossReturn"): number {
    return round(replay.windows.reduce(
      (capitalFactor, window) => capitalFactor * (1 + window[field]),
      1,
    ) - 1);
  }

  function minimumDate(rows: readonly FeatureRow[], field: "featureDate" | "targetDate"): string {
    const first = rows[0];
    if (first === undefined) fail("empty rows");
    return rows.reduce((min, row) => row[field] < min ? row[field] : min, first[field]);
  }

  function maximumDateFromRows(rows: readonly FeatureRow[], field: "featureDate" | "targetDate"): string {
    const first = rows[0];
    if (first === undefined) fail("empty rows");
    return rows.reduce((max, row) => row[field] > max ? row[field] : max, first[field]);
  }

  const economic: FinalTestEconomicEdgeGroup = Object.freeze({
    symbol,
    finalTestRows: symbolFinalTestRows.length,
    evaluationStartDate: minimumDate(symbolFinalTestRows, "featureDate"),
    evaluationEndDate: maximumDateFromRows(symbolFinalTestRows, "targetDate"),
    operativeThreshold: 0.5,
    thresholdSelectionSource: "VALIDATION" as const,
    transactionCostBps: replay.roundTripCostBps,
    strategyPolicy: "VALIDATION_THRESHOLD_LONG_CASH" as const,
    benchmarkPolicy: "ALWAYS_LONG_BENCHMARK" as const,
    strategyGrossReturn: compoundedGrossReturn("strategyGrossReturn"),
    strategyNetReturn: replay.strategy.totalReturn,
    benchmarkGrossReturn: compoundedGrossReturn("benchmarkGrossReturn"),
    benchmarkNetReturn: replay.benchmark.totalReturn,
    excessReturn: replay.excessReturn,
    strategyMaximumDrawdown: replay.strategy.maximumDrawdown,
    benchmarkMaximumDrawdown: replay.benchmark.maximumDrawdown,
    tradeCount: replay.strategy.roundTripCount,
    longWindowCount: replay.strategy.longWindowCount,
    cashWindowCount: replay.strategy.cashWindowCount,
    replayWindowCount: replay.replayWindowCount,
    skippedOverlapCount: replay.skippedOverlapCount,
    warnings: Object.freeze([
      "Benchmark is the canonical cost-matched ALWAYS_LONG_BENCHMARK replay on the identical selected windows.",
      "Direct return linear regression action rule: LONG if predictedReturn > canonicalRoundTripCostFraction.",
    ]),
  });

  return {
    economic,
    predictedLongRate: round(longCount / symbolFinalTestRows.length),
    predictions: Object.freeze(predictions),
  };
}

// ── Per-cutoff evaluation ──

function evaluateCutoff(
  input: DirectReturnLinearTemporalInput,
  cutoff: string,
): DirectReturnLinearTemporalCutoffResult {
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(COST_CONTRACT_AMBIGUOUS_STOP);
  }
  const canonicalCostHurdle = deriveRoundTripCostFraction(input.roundTripCostBps);

  // 1. As-of filtering
  const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoff);
  const asOf = resolveDataEndDate(cutoffRawRows, cutoff);
  const symbolRows = toMarketRows(cutoffRawRows, TARGET_SYMBOL);
  if (symbolRows.length === 0) fail(`0056 has no source rows at cutoff ${cutoff}`);
  if (symbolRows.some((row) => row.date > asOf)) {
    fail(`0056 source row exceeds resolved asOf at cutoff ${cutoff}`);
  }

  // 2. Build pooled market rows (for control)
  const pooledSymbols = [...new Set(cutoffRawRows.map(({ symbol }) => symbol))].sort();
  const pooledMarketRows = pooledSymbols.flatMap((symbol) => toMarketRows(cutoffRawRows, symbol));
  if (pooledMarketRows.length === 0) fail(`pooled incumbent has no source rows at cutoff ${cutoff}`);

  // 3. Run control: existing unweighted logistic
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
  const controlEconomic = replayControlEconomic(
    TARGET_SYMBOL,
    controlGroup.finalTestEconomicEvidence,
    input.roundTripCostBps,
    input.initialCapital,
    );
  const controlMetrics: DirectReturnControlSideMetrics = Object.freeze({
    trainingRows: controlGroup.trainingRows,
    validationRows: controlGroup.validationRows,
    finalTestRows: controlGroup.finalTestRows,
    selectedThreshold: controlGroup.thresholdSelection.selectedThreshold,
    accuracy: controlGroup.finalTestMetrics.accuracy,
    majorityBaselineAccuracy: controlGroup.finalTestMetrics.majorityBaseline,
    strategyNetReturn: controlEconomic.strategyNetReturn,
    benchmarkNetReturn: controlEconomic.benchmarkNetReturn,
    excessReturn: controlEconomic.excessReturn,
    strategyMaxDrawdown: controlEconomic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: controlEconomic.benchmarkMaximumDrawdown,
    tradeCount: controlEconomic.tradeCount,
  });

  // 4. Build feature rows for 0056 only and split chronologically
  const featureRows = buildHistoricalFeatureRows(pooledMarketRows);
  const symbolFeatureRows = featureRows.filter((r) => r.symbol === TARGET_SYMBOL);
  if (symbolFeatureRows.length === 0) {
    fail(`0056 has no feature rows at cutoff ${cutoff}`);
  }
  const split = splitChronologically(symbolFeatureRows);

  // 5. Fit scaler on TRAINING only
  const scaler = fitStandardScaler(split.training);

  // 6. Fit linear regression on TRAINING only
  let linearFit: LinearRegressionFit;
  try {
    linearFit = fitLinearRegression(split.training, scaler);
  } catch (err) {
    if (err instanceof Error && err.message.includes("singular")) {
      fail(LINEAR_SYSTEM_UNRESOLVED_STOP);
    }
    throw err;
  }

  // 7. Evaluate on VALIDATION (diagnostic only)
  const validationPredictions = split.validation.rows.map((row) =>
    predictReturn(row.features, scaler, linearFit.coefficients),
  );
  const validationActuals = split.validation.rows.map((row) => row.forwardReturn);

  // 8. Evaluate on FINAL_TEST (untouched)
  const finalTestPredictions = split.finalTest.rows.map((row) =>
    predictReturn(row.features, scaler, linearFit.coefficients),
  );
  const finalTestActuals = split.finalTest.rows.map((row) => row.forwardReturn);

  // 9. Compute regression metrics
  const trainingReturns = split.training.rows.map((r) => r.forwardReturn);
  const targetMeanTraining = round(trainingReturns.reduce((s, v) => s + v, 0) / trainingReturns.length);
  const targetStdTraining = round(Math.sqrt(
    trainingReturns.reduce((s, v) => s + (v - targetMeanTraining) ** 2, 0) / trainingReturns.length,
  ));

  const regressionMetrics: DirectReturnRegressionMetrics = Object.freeze({
    targetMeanTraining,
    targetStdTraining,
    predictionMeanValidation: round(validationPredictions.reduce((s, v) => s + v, 0) / validationPredictions.length),
    predictionMeanFinalTest: round(finalTestPredictions.reduce((s, v) => s + v, 0) / finalTestPredictions.length),
    actualMeanValidation: round(validationActuals.reduce((s, v) => s + v, 0) / validationActuals.length),
    actualMeanFinalTest: round(finalTestActuals.reduce((s, v) => s + v, 0) / finalTestActuals.length),
    maeValidation: computeMAE(validationPredictions, validationActuals),
    rmseValidation: computeRMSE(validationPredictions, validationActuals),
    maeFinalTest: computeMAE(finalTestPredictions, finalTestActuals),
    rmseFinalTest: computeRMSE(finalTestPredictions, finalTestActuals),
    pearsonCorrelationValidation: pearsonCorrelation(validationPredictions, validationActuals),
    pearsonCorrelationFinalTest: pearsonCorrelation(finalTestPredictions, finalTestActuals),
    signAccuracyFinalTest: computeSignAccuracy(finalTestPredictions, finalTestActuals),
  });

  // 10. Replay direct return strategy through economic simulator
  const { economic: challengerEconomic, predictedLongRate } =
    replayDirectReturnEconomic(
      TARGET_SYMBOL,
      split.finalTest.rows,
      scaler,
      linearFit,
      canonicalCostHurdle,
      input.roundTripCostBps,
      input.initialCapital,
    );

  const challengerMetrics: DirectReturnChallengerSideMetrics = Object.freeze({
    trainingRows: split.training.rows.length,
    validationRows: split.validation.rows.length,
    finalTestRows: split.finalTest.rows.length,
    predictedLongRate,
    canonicalCostHurdle,
    strategyNetReturn: challengerEconomic.strategyNetReturn,
    benchmarkNetReturn: challengerEconomic.benchmarkNetReturn,
    excessReturn: challengerEconomic.excessReturn,
    strategyMaxDrawdown: challengerEconomic.strategyMaximumDrawdown,
    benchmarkMaxDrawdown: challengerEconomic.benchmarkMaximumDrawdown,
    tradeCount: challengerEconomic.tradeCount,
    warnings: Object.freeze([]),
  });

  // 11. Economic comparison
  const economicComparison: DirectReturnEconomicComparison = Object.freeze({
    controlStrategyNetReturn: controlMetrics.strategyNetReturn,
    directReturnStrategyNetReturn: challengerMetrics.strategyNetReturn,
    strategyReturnDelta: round(challengerMetrics.strategyNetReturn - controlMetrics.strategyNetReturn),
    commonBenchmarkNetReturn: controlMetrics.benchmarkNetReturn,
    controlExcessReturn: controlMetrics.excessReturn,
    directReturnExcessReturn: challengerMetrics.excessReturn,
    excessReturnDelta: round(challengerMetrics.excessReturn - controlMetrics.excessReturn),
    controlMaxDrawdown: controlMetrics.strategyMaxDrawdown,
    directReturnMaxDrawdown: challengerMetrics.strategyMaxDrawdown,
    maxDrawdownDelta: round(challengerMetrics.strategyMaxDrawdown - controlMetrics.strategyMaxDrawdown),
    controlTradeCount: controlMetrics.tradeCount,
    directReturnTradeCount: challengerMetrics.tradeCount,
  });

  const dataQualityFindings = evidenceResult.evidence.dataQualityFindings.map(({ message }) => message);
  const warnings = uniqueMessages([
    ...dataQualityFindings,
    ...controlGroup.warnings,
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    "CONTROL is the unweighted live technical per-symbol logistic with target forwardReturn > 0.",
    `CHALLENGER is ordinary linear regression predicting continuous forwardReturn, action rule: LONG if predictedReturn > ${canonicalCostHurdle}.`,
    "No feature was added; the exact live five-feature contract is preserved.",
    "No regularization was applied; coefficients come from ordinary least-squares normal equations.",
    `Pivot tolerance for matrix solver safety: ${PIVOT_TOLERANCE}.`,
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
      split.finalTest.rows.map(({ targetDate }) => targetDate),
    ),
    dataQualityFindings,
    control: controlGroup,
    controlEconomic,
    controlMetrics,
    regressionMetrics,
    challengerMetrics,
    economicComparison,
    linearRegressionFit: {
      coefficientCount: linearFit.coefficients.length,
      trainingMSE: linearFit.trainingMSE,
      stateSha256: linearFit.stateSha256,
      scalerStateSha256: scaler.stateSha256,
    },
    warnings,
  };

  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

// ── Temporal summaries ──

function summarizeCutoffs(
  cutoffRuns: readonly DirectReturnLinearTemporalCutoffResult[],
): {
  challengerTemporalSummary: DirectReturnTemporalSummary;
  economicTemporalSummary: DirectReturnEconomicTemporalSummary;
} {
  if (cutoffRuns.length === 0) fail("0056 direct return temporal replay produced no cutoff runs");

  const challengerExcess = cutoffRuns.map((run) => run.challengerMetrics.excessReturn);
  const excessDeltasVsControl = cutoffRuns.map((run) => run.economicComparison.excessReturnDelta);
  const maxDrawdownDeltasVsControl = cutoffRuns.map((run) => run.economicComparison.maxDrawdownDelta);
  const finalTestMAEs = cutoffRuns.map((run) => run.regressionMetrics.maeFinalTest);
  const finalTestRMSEs = cutoffRuns.map((run) => run.regressionMetrics.rmseFinalTest);
  const finalTestCorrelations = cutoffRuns
    .map((run) => run.regressionMetrics.pearsonCorrelationFinalTest)
    .filter((v): v is number => v !== null);
  const predictedLongRates = cutoffRuns.map((run) => run.challengerMetrics.predictedLongRate);

  const latest = cutoffRuns.at(-1);
  if (latest === undefined) fail("0056 direct return latest cutoff is missing");

  const challengerTemporalSummary: DirectReturnTemporalSummary = Object.freeze({
    cutoffCount: cutoffRuns.length,
    positiveExcessCutoffs: challengerExcess.filter((v) => v > 0).length,
    medianExcessReturn: median(challengerExcess),
    minExcessReturn: Math.min(...challengerExcess),
    maxExcessReturn: Math.max(...challengerExcess),
    latestExcessReturn: latest.challengerMetrics.excessReturn,
    medianFinalTestMAE: median(finalTestMAEs),
    medianFinalTestRMSE: median(finalTestRMSEs),
    medianFinalTestCorrelation: finalTestCorrelations.length > 0 ? median(finalTestCorrelations) : null,
    predictedLongRateRange: Object.freeze({
      minimum: Math.min(...predictedLongRates),
      maximum: Math.max(...predictedLongRates),
    }),
  });

  const economicTemporalSummary: DirectReturnEconomicTemporalSummary = Object.freeze({
    economicWinsVsControl: excessDeltasVsControl.filter((v) => v > 0).length,
    economicLossesVsControl: excessDeltasVsControl.filter((v) => v < 0).length,
    economicTiesVsControl: excessDeltasVsControl.filter((v) => v === 0).length,
    medianExcessDeltaVsControl: median(excessDeltasVsControl),
    latestExcessDeltaVsControl: latest.economicComparison.excessReturnDelta,
    medianMaxDrawdownDeltaVsControl: median(maxDrawdownDeltasVsControl),
  });

  return {
    challengerTemporalSummary,
    economicTemporalSummary,
  };
}

// ── Control reproduction ──

function verifyControlReproduction(
  cutoffRuns: readonly DirectReturnLinearTemporalCutoffResult[],
): DirectReturnControlReproduction {
  const latest = cutoffRuns.at(-1);
  if (latest === undefined) fail("missing cutoff runs for control reproduction");
  const expectedDatesMatch = cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((expected, index) => cutoffRuns[index]?.cutoff === expected.cutoff);
  const observedThresholds = [...new Set(cutoffRuns.map((run) => run.controlMetrics.selectedThreshold))]
    .sort((left, right) => left - right);
  const controlExcess = cutoffRuns.map((r) => r.controlMetrics.excessReturn);

  const observed = {
    positiveExcessCutoffs: controlExcess.filter((v) => v > 0).length,
    medianExcessReturn: median(controlExcess),
    latestExcessReturn: latest.controlMetrics.excessReturn,
    observedThresholds: Object.freeze(observedThresholds),
  };
  const expected = {
    positiveExcessCutoffs: 3,
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

// ── Answer derivation ──

function deriveAnswers(
  challengerSummary: DirectReturnTemporalSummary,
  economicSummary: DirectReturnEconomicTemporalSummary,
  cutoffCount: number,
): {
  predictiveSignal: DirectReturnAnswer;
  economicEvidence: DirectReturnAnswer;
  conclusion: DirectReturnConclusion;
  ceoNextRoute: DirectReturnNextRoute;
} {
  // Predictive signal: based on whether regression shows meaningful correlation
  let predictiveSignal: DirectReturnAnswer;
  const hasCorrelation = challengerSummary.medianFinalTestCorrelation !== null
    && challengerSummary.medianFinalTestCorrelation > 0;
  const hasPositiveExcess = challengerSummary.positiveExcessCutoffs > cutoffCount / 2;
  if (hasCorrelation && hasPositiveExcess) {
    predictiveSignal = "YES";
  } else if (!hasCorrelation && challengerSummary.positiveExcessCutoffs === 0) {
    predictiveSignal = "NO";
  } else {
    predictiveSignal = "MIXED";
  }

  // Economic evidence: direct comparison vs control
  let economicEvidence: DirectReturnAnswer;
  if (economicSummary.economicWinsVsControl === cutoffCount && economicSummary.medianExcessDeltaVsControl > 0) {
    economicEvidence = "YES";
  } else if (economicSummary.economicWinsVsControl === 0 && economicSummary.medianExcessDeltaVsControl <= 0) {
    economicEvidence = "NO";
  } else {
    economicEvidence = "MIXED";
  }

  let conclusion: DirectReturnConclusion;
  if (economicEvidence === "YES" && predictiveSignal !== "NO") {
    conclusion = "SUPPORTED";
  } else if (economicEvidence === "NO" && predictiveSignal === "NO") {
    conclusion = "NOT_SUPPORTED";
  } else {
    conclusion = "MIXED";
  }

  let ceoNextRoute: DirectReturnNextRoute;
  if (conclusion === "SUPPORTED" || (conclusion === "MIXED" && economicSummary.economicWinsVsControl > economicSummary.economicLossesVsControl && economicSummary.medianExcessDeltaVsControl > 0)) {
    ceoNextRoute = "DIRECT_RETURN_UNIVERSE_EXPANSION_OR_CONFIRMATION";
  } else {
    ceoNextRoute = "STOP_0056_LOCAL_MODEL_TWEAKS_AND_REASSESS_FEATURE_DATA_STRATEGY";
  }

  return {
    predictiveSignal,
    economicEvidence,
    conclusion,
    ceoNextRoute,
  };
}

// ── Main entry point ──

export function runPerSymbolDirectReturnLinearChallengerTemporal(
  input: DirectReturnLinearTemporalInput,
): DirectReturnLinearTemporalResult {
  if (input.rawRows.length === 0) fail("0056 direct return temporal replay requires source rows");
  const cutoffs = validateCutoffDates(input.cutoffDates);
  if (input.roundTripCostBps !== CANONICAL_TRANSACTION_COST_BPS) {
    fail(COST_CONTRACT_AMBIGUOUS_STOP);
  }
  const canonicalRoundTripCostFraction = deriveRoundTripCostFraction(input.roundTripCostBps);

  const cutoffRuns = cutoffs.map((cutoff) => evaluateCutoff(input, cutoff));
  const {
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
    "Model family changed from binary logistic regression to continuous ordinary least-squares linear regression.",
    "The target is the existing realized 5-trading-day forwardReturn, NOT binarized.",
    "Identical five-feature contract with the live 0056 logistic control is preserved.",
    "CONTROL reproduced the authoritative directional baseline on all four temporal cutoffs.",
    `Fixed economic action rule: LONG if predictedForwardReturn > ${canonicalRoundTripCostFraction} (canonical 10 bps round-trip cost fraction).`,
    "Direct comparison between control and challenger uses identical simulator and transaction cost semantics.",
    "No regularization, no validation-selected threshold, no final-test tuning.",
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
    canonicalRoundTripCostFraction,
    initialCapital: input.initialCapital,
    targetContract: {
      directReturnTarget: DIRECT_RETURN_TARGET,
      targetHorizon: TARGET_HORIZON,
      forwardReturnSource: FORWARD_RETURN_SOURCE,
      targetUnit: TARGET_UNIT,
      actionRule: DIRECT_RETURN_ACTION_RULE,
      pivotTolerance: PIVOT_TOLERANCE,
    },
    targetHorizonRows: TARGET_HORIZON_ROWS,
    controlFeatureNames: RESEARCH_FEATURE_NAMES,
    featureNames: RESEARCH_FEATURE_NAMES,
    cutoffRuns: Object.freeze(cutoffRuns),
    challengerTemporalSummary,
    economicTemporalSummary,
    controlReproduction,
    doesDirectReturnModelShowPredictiveSignal: answers.predictiveSignal,
    doesDirectReturnModelImproveEconomicEvidence: answers.economicEvidence,
    directReturnChallengerConclusion: answers.conclusion,
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
