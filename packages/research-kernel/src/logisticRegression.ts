import { hashValue } from "./evidence.js";
import { standardize } from "./scaler.js";
import {
  fail,
  type LogisticRegressionConfig,
  type LogisticRegressionFit,
  type PartitionKind,
  type RowPartition,
  type StandardScalerFit,
  type TrainingClassWeightComputation,
  type TrainingClassWeights,
} from "./types.js";

export const DEFAULT_LOGISTIC_REGRESSION_CONFIG: LogisticRegressionConfig = Object.freeze({
  iterations: 2500,
  learningRate: 0.08,
  l2: 0.01,
});

export function normalizeLogisticRegressionConfig(
  partial: Partial<LogisticRegressionConfig> = {},
): LogisticRegressionConfig {
  const config = {
    iterations: partial.iterations ?? DEFAULT_LOGISTIC_REGRESSION_CONFIG.iterations,
    learningRate: partial.learningRate ?? DEFAULT_LOGISTIC_REGRESSION_CONFIG.learningRate,
    l2: partial.l2 ?? DEFAULT_LOGISTIC_REGRESSION_CONFIG.l2,
  };
  if (!Number.isInteger(config.iterations) || config.iterations <= 0) {
    fail(`logistic iterations must be a positive integer: ${config.iterations}`);
  }
  if (!Number.isFinite(config.learningRate) || config.learningRate <= 0) {
    fail(`logistic learning rate must be finite and positive: ${config.learningRate}`);
  }
  if (!Number.isFinite(config.l2) || config.l2 < 0) {
    fail(`logistic L2 must be finite and non-negative: ${config.l2}`);
  }
  return Object.freeze(config);
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function dot(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) fail("dot-product vectors differ in length");
  return left.reduce((sum, value, index) => {
    const rightValue = right[index];
    if (rightValue === undefined) fail("dot-product vector is incomplete");
    return sum + value * rightValue;
  }, 0);
}

export interface FitLogisticRegressionOptions {
  readonly classWeights?: TrainingClassWeights;
}

export function computeTrainingClassWeights(
  untrustedPartition: RowPartition<PartitionKind>,
): TrainingClassWeightComputation {
  if (untrustedPartition.kind !== "TRAINING") {
    fail(`class weights require TRAINING rows, received ${untrustedPartition.kind}`);
  }
  const partition = untrustedPartition as RowPartition<"TRAINING">;
  const trainingRowCount = partition.rows.length;
  if (trainingRowCount === 0) fail("cannot compute class weights on zero training rows");
  const trainingUpRows = partition.rows.filter((row) => row.target === 1).length;
  const trainingDownRows = trainingRowCount - trainingUpRows;
  if (trainingUpRows === 0 || trainingDownRows === 0) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: `training partition contains only one class (up=${trainingUpRows}, down=${trainingDownRows})`,
      sourcePartition: "TRAINING",
      trainingRowCount,
      trainingUpRows,
      trainingDownRows,
    });
  }
  return Object.freeze({
    status: "available" as const,
    weights: Object.freeze({
      sourcePartition: "TRAINING",
      trainingRowCount,
      trainingUpRows,
      trainingDownRows,
      weightUp: trainingRowCount / (2 * trainingUpRows),
      weightDown: trainingRowCount / (2 * trainingDownRows),
    }),
  });
}

function assertClassWeightsMatchPartition(
  partition: RowPartition<"TRAINING">,
  classWeights: TrainingClassWeights,
): void {
  if (classWeights.sourcePartition !== "TRAINING") {
    fail("class weights must be derived from the TRAINING partition");
  }
  const computed = computeTrainingClassWeights(partition);
  if (computed.status === "unavailable") {
    fail(`class weights are unavailable: ${computed.reason}`);
  }
  if (
    classWeights.trainingRowCount !== computed.weights.trainingRowCount
    || classWeights.trainingUpRows !== computed.weights.trainingUpRows
    || classWeights.trainingDownRows !== computed.weights.trainingDownRows
    || classWeights.weightUp !== computed.weights.weightUp
    || classWeights.weightDown !== computed.weights.weightDown
  ) {
    fail("supplied class weights do not match TRAINING labels");
  }
}

function observationClassWeight(
  target: 0 | 1,
  classWeights: TrainingClassWeights | undefined,
): number {
  if (classWeights === undefined) return 1;
  return target === 1 ? classWeights.weightUp : classWeights.weightDown;
}

function regularizedLoss(
  partition: RowPartition<"TRAINING">,
  weights: readonly number[],
  scaler: StandardScalerFit,
  config: LogisticRegressionConfig,
  classWeights: TrainingClassWeights | undefined,
): number {
  const epsilon = 1e-12;
  const dataLoss = partition.rows.reduce((sum, row) => {
    const probability = sigmoid(dot(weights, [1, ...standardize(row.features, scaler)]));
    const observationLoss = -(
      row.target * Math.log(probability + epsilon)
      + (1 - row.target) * Math.log(1 - probability + epsilon)
    );
    return sum + observationClassWeight(row.target, classWeights) * observationLoss;
  }, 0) / partition.rows.length;
  const penalty = weights.slice(1).reduce((sum, weight) => sum + weight ** 2, 0);
  return dataLoss + (config.l2 / 2) * penalty;
}

export function fitLogisticRegression(
  untrustedPartition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
  partialConfig: Partial<LogisticRegressionConfig> = {},
  options: FitLogisticRegressionOptions = {},
): LogisticRegressionFit {
  if (untrustedPartition.kind !== "TRAINING") {
    fail(`model fit requires TRAINING rows, received ${untrustedPartition.kind}`);
  }
  const partition = untrustedPartition as RowPartition<"TRAINING">;
  if (partition.rows.length === 0) fail("cannot fit model on zero training rows");
  if (
    scaler.fitPartition !== "TRAINING"
    || scaler.fitRowCount !== partition.rows.length
    || scaler.fitRowIdentitySha256 !== partition.rowIdentitySha256
  ) {
    fail("model rows do not match the training-only scaler fit");
  }
  const config = normalizeLogisticRegressionConfig(partialConfig);
  const classWeights = options.classWeights;
  if (classWeights !== undefined) {
    assertClassWeightsMatchPartition(partition, classWeights);
  }
  const featureCount = partition.rows[0]?.features.length;
  if (featureCount === undefined || featureCount === 0) {
    fail("training feature vector must not be empty");
  }
  if (partition.rows.some((row) => row.features.length !== featureCount)) {
    fail("training feature vectors differ in length");
  }
  const weights = Array.from({ length: featureCount + 1 }, () => 0);
  const initialRegularizedLoss = regularizedLoss(
    partition,
    weights,
    scaler,
    config,
    classWeights,
  );
  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    for (const row of partition.rows) {
      const inputs = [1, ...standardize(row.features, scaler)];
      const error = sigmoid(dot(weights, inputs)) - row.target;
      const observationWeight = observationClassWeight(row.target, classWeights);
      for (let index = 0; index < gradient.length; index += 1) {
        const input = inputs[index];
        if (input === undefined) fail("model input vector is incomplete");
        gradient[index] = (gradient[index] ?? 0) + observationWeight * error * input;
      }
    }
    for (let index = 0; index < weights.length; index += 1) {
      const weight = weights[index];
      const gradientValue = gradient[index];
      if (weight === undefined || gradientValue === undefined) fail("model state is incomplete");
      const regularization = index === 0 ? 0 : config.l2 * weight;
      weights[index] = weight - config.learningRate
        * (gradientValue / partition.rows.length + regularization);
    }
  }
  const typedWeights = Object.freeze([...weights]);
  const finalRegularizedLoss = regularizedLoss(
    partition,
    typedWeights,
    scaler,
    config,
    classWeights,
  );
  if (!(finalRegularizedLoss < initialRegularizedLoss)) {
    fail("training did not reduce regularized loss");
  }
  const state = classWeights === undefined
    ? {
      weights: typedWeights,
      fitRowIdentitySha256: partition.rowIdentitySha256,
      config,
    }
    : {
      weights: typedWeights,
      fitRowIdentitySha256: partition.rowIdentitySha256,
      config,
      classWeights,
    };
  return Object.freeze({
    fitPartition: "TRAINING",
    weights: typedWeights,
    fitRowCount: partition.rows.length,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    initialRegularizedLoss,
    finalRegularizedLoss,
    config,
    ...(classWeights === undefined ? {} : { classWeights }),
    stateSha256: hashValue(state),
  });
}

export function predictProbability(
  features: readonly number[],
  scaler: StandardScalerFit,
  model: LogisticRegressionFit,
): number {
  return sigmoid(dot(model.weights, [1, ...standardize(features, scaler)]));
}
