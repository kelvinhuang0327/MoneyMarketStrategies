import {
  createFinalTestEvaluatorFromPredictor,
  selectValidationThresholdFromPredictor,
  THRESHOLD_TIE_BREAK_RULE,
  VALIDATION_THRESHOLD_GRID,
} from "./evaluation.js";
import { hashFeatureRows, hashValue } from "./evidence.js";
import { RESEARCH_FEATURE_NAMES } from "./features.js";
import { buildFinalTestEconomicEvidence } from "./finalTestEconomicEvidence.js";
import {
  fitGaussianNaiveBayes,
  GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
  predictGaussianNaiveBayesProbabilityUp,
  type GaussianNaiveBayesFit,
} from "./gaussianNaiveBayes.js";
import { fitStandardScaler } from "./scaler.js";
import {
  fail,
  type FeatureRow,
  type PartitionKind,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RowPartition,
  type ThreeWayChronologicalSplit,
} from "./types.js";

export interface GaussianNaiveBayesChallengerInput {
  readonly featureRows: readonly FeatureRow[];
  readonly split: ThreeWayChronologicalSplit;
  readonly featureNames: readonly string[];
}

export interface GaussianNaiveBayesFitEvidence {
  readonly fitPartition: "TRAINING";
  readonly trainingRowsSha256: string;
  readonly scalerFitRowCount: number;
  readonly modelFitRowCount: number;
  readonly scalerStateSha256: string;
  readonly modelStateSha256: string;
  readonly varianceFloor: number;
  readonly trainingUpRows: number;
  readonly trainingDownRows: number;
  readonly classPriorUp: number;
  readonly classPriorDown: number;
}

export interface GaussianNaiveBayesChallengerSymbolEvidence {
  readonly symbol: string;
  readonly trainingRows: number;
  readonly trainValidationPurgeRows: number;
  readonly validationRows: number;
  readonly validationFinalPurgeRows: number;
  readonly finalTestRows: number;
  readonly trainEndDate: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly finalTestStartDate: string;
  readonly trainingRowsSha256: string;
  readonly validationRowsSha256: string;
  readonly finalTestRowsSha256: string;
  readonly fit: GaussianNaiveBayesFitEvidence;
  readonly model: GaussianNaiveBayesFit;
  readonly thresholdSelection: PerSymbolLogisticChallengerSymbolEvidence["thresholdSelection"];
  readonly finalTest: PerSymbolLogisticChallengerSymbolEvidence["finalTest"];
  readonly finalTestEconomicEvidence: PerSymbolLogisticChallengerSymbolEvidence["finalTestEconomicEvidence"];
  readonly finalTestMetrics: PerSymbolLogisticChallengerSymbolEvidence["finalTestMetrics"];
  readonly majorityBaselineAccuracy: number;
  readonly accuracyDelta: number;
  readonly actualUpRate: number;
  readonly predictedUpRate: number;
  readonly meanProbabilityUp: number;
  readonly warnings: readonly string[];
}

export interface GaussianNaiveBayesChallengerEvidence {
  readonly schemaVersion: "MMS_GAUSSIAN_NAIVE_BAYES_CHALLENGER_V1";
  readonly researchMode: "diagnostic-only";
  readonly modelAlgorithm: "binary_gaussian_naive_bayes";
  readonly featureNames: readonly string[];
  readonly featureRowsSha256: string;
  readonly varianceFloor: number;
  readonly symbols: readonly string[];
  readonly groups: readonly GaussianNaiveBayesChallengerSymbolEvidence[];
  readonly warnings: readonly string[];
  readonly guardrails: {
    readonly providesInvestmentAdvice: false;
    readonly supportsOrderExecution: false;
    readonly supportsAutomaticPromotion: false;
    readonly supportsPortfolioOptimization: false;
    readonly supportsMultiSymbolAllocation: false;
    readonly supportsSymbolSelection: false;
  };
  readonly normalizedResultSha256: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function minimumFeatureDate(rows: readonly FeatureRow[]): string {
  const first = rows[0];
  if (first === undefined) fail("cannot find a minimum feature date in an empty partition");
  return rows.reduce(
    (minimum, row) => row.featureDate < minimum ? row.featureDate : minimum,
    first.featureDate,
  );
}

function filterPartition<K extends PartitionKind>(
  partition: RowPartition<K>,
  symbol: string,
): RowPartition<K> {
  const rows = partition.rows.filter((row) => row.symbol === symbol);
  if (rows.length === 0) {
    fail(`gaussian naive bayes challenger produced an empty ${partition.kind} partition for ${symbol}`);
  }
  return Object.freeze({
    kind: partition.kind,
    rows: Object.freeze([...rows]),
    rowIdentitySha256: hashFeatureRows(rows),
  });
}

function buildSymbolSplit(
  featureRows: readonly FeatureRow[],
  pooledSplit: ThreeWayChronologicalSplit,
  symbol: string,
): ThreeWayChronologicalSplit {
  const symbolRows = featureRows.filter((row) => row.symbol === symbol);
  if (symbolRows.length === 0) fail(`gaussian naive bayes challenger has no feature rows for ${symbol}`);
  const uniqueFeatureDates = Object.freeze(
    [...new Set(symbolRows.map((row) => row.featureDate))].sort(compareText),
  );
  const training = filterPartition(pooledSplit.training, symbol);
  const trainValidationPurge = filterPartition(pooledSplit.trainValidationPurge, symbol);
  const validation = filterPartition(pooledSplit.validation, symbol);
  const validationFinalPurge = filterPartition(pooledSplit.validationFinalPurge, symbol);
  const finalTest = filterPartition(pooledSplit.finalTest, symbol);

  return Object.freeze({
    uniqueFeatureDates,
    trainEndDate: pooledSplit.trainEndDate,
    validationStartDate: minimumFeatureDate(validation.rows),
    validationEndDate: pooledSplit.validationEndDate,
    finalTestStartDate: minimumFeatureDate(finalTest.rows),
    training,
    trainValidationPurge,
    validation,
    validationFinalPurge,
    finalTest,
  });
}

function assertLiveFeatureContract(featureNames: readonly string[]): void {
  if (featureNames.length !== RESEARCH_FEATURE_NAMES.length
    || RESEARCH_FEATURE_NAMES.some((name, index) => featureNames[index] !== name)) {
    fail("STOP_MMS_0056_GNB_PREPROCESSING_CONTRACT_REQUIRED");
  }
  if (featureNames.includes("breakout_20d_high") || featureNames.includes("intraday_range_pct")) {
    fail("STOP_MMS_0056_GNB_PREPROCESSING_CONTRACT_REQUIRED");
  }
}

function buildSymbolEvidence(
  split: ThreeWayChronologicalSplit,
  symbol: string,
  featureNames: readonly string[],
): GaussianNaiveBayesChallengerSymbolEvidence {
  const scaler = fitStandardScaler(split.training);
  const model = fitGaussianNaiveBayes(split.training, scaler);
  const predict = (features: FeatureRow["features"]) =>
    predictGaussianNaiveBayesProbabilityUp(features, scaler, model);
  const thresholdSelection = selectValidationThresholdFromPredictor(split.validation, predict);
  if (thresholdSelection.selectionPartition !== "VALIDATION") {
    fail(`gaussian naive bayes threshold selection did not use VALIDATION for ${symbol}`);
  }
  if (thresholdSelection.fixedThresholdGrid.length !== VALIDATION_THRESHOLD_GRID.length
    || thresholdSelection.fixedThresholdGrid.some((value, index) =>
      value !== VALIDATION_THRESHOLD_GRID[index])) {
    fail("gaussian naive bayes must reuse the existing validation threshold grid");
  }
  if (thresholdSelection.tieBreakRule.length !== THRESHOLD_TIE_BREAK_RULE.length
    || thresholdSelection.tieBreakRule.some((value, index) => value !== THRESHOLD_TIE_BREAK_RULE[index])) {
    fail("gaussian naive bayes must reuse the existing validation threshold tie-break");
  }
  const finalTestEvaluator = createFinalTestEvaluatorFromPredictor();
  const finalTestEvaluation = finalTestEvaluator.evaluate(
    split.finalTest,
    thresholdSelection.selectedThreshold,
    predict,
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
    frozenThreshold,
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
  );
  const meanProbabilityUp = scoredRows.reduce(
    (sum, row) => sum + row.probability,
    0,
  ) / scoredRows.length;

  return Object.freeze({
    symbol,
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
      varianceFloor: GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
      trainingUpRows: model.trainingUpRows,
      trainingDownRows: model.trainingDownRows,
      classPriorUp: model.classPriorUp,
      classPriorDown: model.classPriorDown,
    }),
    model,
    thresholdSelection,
    finalTest,
    finalTestEconomicEvidence,
    finalTestMetrics: metrics,
    majorityBaselineAccuracy: metrics.majorityBaseline,
    accuracyDelta: Number((metrics.accuracy - metrics.majorityBaseline).toFixed(8)),
    actualUpRate: Number((metrics.positiveCount / metrics.sampleCount).toFixed(8)),
    predictedUpRate: Number((metrics.predictedPositiveCount / metrics.sampleCount).toFixed(8)),
    meanProbabilityUp: Number(meanProbabilityUp.toFixed(8)),
    warnings: Object.freeze([
      `Feature set is fixed to ${featureNames.join(", ")} and is shared with the unweighted logistic control.`,
      "Model parameters were fit from TRAINING rows only.",
      `Gaussian Naive Bayes used implementation-level variance floor ${GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR}.`,
      ...model.nearZeroVarianceWarnings,
      "Threshold was selected from VALIDATION rows only and frozen before FINAL_TEST evaluation.",
      "FINAL_TEST rows are evaluation-only and are replayed without post-test tuning.",
    ]),
  });
}

export function runGaussianNaiveBayesChallenger(
  input: GaussianNaiveBayesChallengerInput,
): GaussianNaiveBayesChallengerEvidence {
  if (input.featureRows.length === 0) fail("gaussian naive bayes challenger requires feature rows");
  if (input.featureNames.length === 0) fail("gaussian naive bayes challenger requires feature names");
  assertLiveFeatureContract(input.featureNames);
  const symbols = [...new Set(input.featureRows.map((row) => row.symbol))].sort(compareText);
  if (symbols.length === 0) fail("gaussian naive bayes challenger requires at least one symbol");
  const groups = symbols.map((symbol) => buildSymbolEvidence(
    buildSymbolSplit(input.featureRows, input.split, symbol),
    symbol,
    input.featureNames,
  ));
  const normalized = {
    schemaVersion: "MMS_GAUSSIAN_NAIVE_BAYES_CHALLENGER_V1" as const,
    researchMode: "diagnostic-only" as const,
    modelAlgorithm: "binary_gaussian_naive_bayes" as const,
    featureNames: Object.freeze([...input.featureNames]),
    featureRowsSha256: hashFeatureRows(input.featureRows),
    varianceFloor: GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
    symbols: Object.freeze(symbols),
    groups: Object.freeze(groups),
    warnings: Object.freeze([
      "This is a model-family challenger experiment only; no feature, threshold, symbol, ranking, or promotion decision is changed by its observed result.",
      "All symbols use the pooled incumbent's chronological boundary dates and purge semantics.",
      "The challenger is evaluated on the same canonical feature rows, training-fitted scaler, validation threshold grid, and cost model as the logistic control.",
      `Variance floor ${GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR} is an implementation-level numerical-safety constant and is not selected from validation or FINAL_TEST.`,
    ]),
    guardrails: Object.freeze({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    } as const),
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
