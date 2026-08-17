import { createFinalTestEvaluator, selectValidationThreshold } from "./evaluation.js";
import { hashFeatureRows, hashValue } from "./evidence.js";
import { buildFinalTestEconomicEvidence } from "./finalTestEconomicEvidence.js";
import { computeTrainingClassWeights, fitLogisticRegression } from "./logisticRegression.js";
import { fitStandardScaler } from "./scaler.js";
import {
  fail,
  type FeatureRow,
  type LogisticRegressionConfig,
  type PartitionKind,
  type PerSymbolLogisticChallengerEvidence,
  type PerSymbolLogisticChallengerFeatureFamily,
  type PerSymbolLogisticChallengerSymbolEvidence,
  type RowPartition,
  type ThreeWayChronologicalSplit,
  type TrainingClassWeights,
} from "./types.js";

export type PerSymbolLogisticClassBalancing = "disabled" | "training_inverse_frequency";

export interface PerSymbolLogisticChallengerInput {
  readonly featureRows: readonly FeatureRow[];
  readonly split: ThreeWayChronologicalSplit;
  readonly featureNames: readonly string[];
  readonly featureFamily?: PerSymbolLogisticChallengerFeatureFamily;
  readonly logisticRegression?: Partial<LogisticRegressionConfig>;
  readonly classBalancing?: PerSymbolLogisticClassBalancing;
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
    fail(`per-symbol challenger produced an empty ${partition.kind} partition for ${symbol}`);
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
  if (symbolRows.length === 0) fail(`per-symbol challenger has no feature rows for ${symbol}`);
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

function resolveTrainingClassWeights(
  training: RowPartition<"TRAINING">,
  classBalancing: PerSymbolLogisticClassBalancing,
): TrainingClassWeights | undefined {
  if (classBalancing === "disabled") return undefined;
  const computed = computeTrainingClassWeights(training);
  if (computed.status === "unavailable") {
    fail(`class-balanced challenger unavailable: ${computed.reason}`);
  }
  return computed.weights;
}

function buildSymbolEvidence(
  split: ThreeWayChronologicalSplit,
  symbol: string,
  featureNames: readonly string[],
  featureFamily: PerSymbolLogisticChallengerFeatureFamily | undefined,
  logisticRegression: Partial<LogisticRegressionConfig> | undefined,
  classBalancing: PerSymbolLogisticClassBalancing,
): PerSymbolLogisticChallengerSymbolEvidence {
  const scaler = fitStandardScaler(split.training);
  const classWeights = resolveTrainingClassWeights(split.training, classBalancing);
  const model = fitLogisticRegression(
    split.training,
    scaler,
    logisticRegression,
    classWeights === undefined ? {} : { classWeights },
  );
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
    frozenThreshold,
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
  );
  const meanProbabilityUp = scoredRows.reduce(
    (sum, row) => sum + row.probability,
    0,
  ) / scoredRows.length;
  const featureSetWarning = featureFamily === undefined
    ? `Feature set is fixed to ${featureNames.join(", ")} and is shared with the pooled incumbent.`
    : `Feature set is fixed to the incumbent fields plus additive family ${featureFamily.featureFamilyName}: ${featureFamily.newFeatureFields.join(", ")}.`;

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
      fitPartition: "TRAINING",
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
      ...(classWeights === undefined ? {} : {
        classBalancing: Object.freeze({
          mode: "training_inverse_frequency" as const,
          sourcePartition: "TRAINING" as const,
          trainingUpRows: classWeights.trainingUpRows,
          trainingDownRows: classWeights.trainingDownRows,
          weightUp: classWeights.weightUp,
          weightDown: classWeights.weightDown,
        }),
      }),
    }),
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
      featureSetWarning,
      "Model parameters were fit from TRAINING rows only.",
      ...(classWeights === undefined
        ? []
        : [
          "Training used inverse-frequency class weights computed from TRAINING labels only.",
          `Applied class weights: weight_up=${classWeights.weightUp}, weight_down=${classWeights.weightDown}.`,
        ]),
      "Threshold was selected from VALIDATION rows only and frozen before FINAL_TEST evaluation.",
      "FINAL_TEST rows are evaluation-only and are replayed without post-test tuning.",
    ]),
  });
}

export function runPerSymbolLogisticChallenger(
  input: PerSymbolLogisticChallengerInput,
): PerSymbolLogisticChallengerEvidence {
  if (input.featureRows.length === 0) fail("per-symbol challenger requires feature rows");
  if (input.featureNames.length === 0) fail("per-symbol challenger requires feature names");
  if (input.featureFamily !== undefined) {
    const incumbentNames = new Set(input.featureFamily.currentIncumbentFeatureFields);
    const newNames = new Set(input.featureFamily.newFeatureFields);
    if (newNames.size !== input.featureFamily.newFeatureFields.length) {
      fail("per-symbol challenger feature family contains duplicate new fields");
    }
    if (input.featureFamily.newFeatureFields.some((name) => incumbentNames.has(name))) {
      fail("per-symbol challenger feature family duplicates an incumbent field");
    }
    if (input.featureFamily.newFeatureFields.some((name) => !input.featureNames.includes(name))) {
      fail("per-symbol challenger feature family field is missing from the candidate vector");
    }
  }
  const classBalancing = input.classBalancing ?? "disabled";
  const symbols = [...new Set(input.featureRows.map((row) => row.symbol))].sort(compareText);
  if (symbols.length === 0) fail("per-symbol challenger requires at least one symbol");
  const groups = symbols.map((symbol) => buildSymbolEvidence(
    buildSymbolSplit(input.featureRows, input.split, symbol),
    symbol,
    input.featureNames,
    input.featureFamily,
    input.logisticRegression,
    classBalancing,
  ));
  const normalized = {
    schemaVersion: "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1" as const,
    researchMode: "diagnostic-only" as const,
    modelAlgorithm: "binary_logistic_regression" as const,
    featureNames: Object.freeze([...input.featureNames]),
    featureRowsSha256: hashFeatureRows(input.featureRows),
    ...(input.featureFamily === undefined ? {} : { featureFamily: input.featureFamily }),
    ...(classBalancing === "disabled" ? {} : { classBalancing }),
    symbols: Object.freeze(symbols),
    groups: Object.freeze(groups),
    warnings: Object.freeze([
      "This is a challenger experiment only; no feature, model-family, threshold, symbol, ranking, or promotion decision is changed by its observed result.",
      "All symbols use the pooled incumbent's chronological boundary dates and purge semantics.",
      "The challenger is evaluated on the same canonical feature rows and cost model as the incumbent.",
      ...(classBalancing === "disabled"
        ? []
        : [
          "Class weights were computed from TRAINING labels only; VALIDATION and FINAL_TEST labels do not enter the weights.",
        ]),
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
