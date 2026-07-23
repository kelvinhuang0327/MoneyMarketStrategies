import { hashValue } from "./evidence.js";
import { standardize } from "./scaler.js";
import {
  fail,
  type LogisticRegressionConfig,
  type LogisticRegressionFit,
  type PartitionKind,
  type RowPartition,
  type StandardScalerFit,
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

function regularizedLoss(
  partition: RowPartition<"TRAINING">,
  weights: readonly number[],
  scaler: StandardScalerFit,
  config: LogisticRegressionConfig,
): number {
  const epsilon = 1e-12;
  const dataLoss = partition.rows.reduce((sum, row) => {
    const probability = sigmoid(dot(weights, [1, ...standardize(row.features, scaler)]));
    return sum - (
      row.target * Math.log(probability + epsilon)
      + (1 - row.target) * Math.log(1 - probability + epsilon)
    );
  }, 0) / partition.rows.length;
  const penalty = weights.slice(1).reduce((sum, weight) => sum + weight ** 2, 0);
  return dataLoss + (config.l2 / 2) * penalty;
}

export function fitLogisticRegression(
  untrustedPartition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
  partialConfig: Partial<LogisticRegressionConfig> = {},
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
  const weights = [0, 0, 0, 0, 0, 0];
  const initialRegularizedLoss = regularizedLoss(partition, weights, scaler, config);
  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const gradient = [0, 0, 0, 0, 0, 0];
    for (const row of partition.rows) {
      const inputs = [1, ...standardize(row.features, scaler)];
      const error = sigmoid(dot(weights, inputs)) - row.target;
      for (let index = 0; index < gradient.length; index += 1) {
        const input = inputs[index];
        if (input === undefined) fail("model input vector is incomplete");
        gradient[index] = (gradient[index] ?? 0) + error * input;
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
  const [
    intercept,
    first,
    second,
    third,
    fourth,
    fifth,
  ] = weights;
  if (
    intercept === undefined
    || first === undefined
    || second === undefined
    || third === undefined
    || fourth === undefined
    || fifth === undefined
  ) {
    fail("trained model weight vector is incomplete");
  }
  const typedWeights = Object.freeze([
    intercept,
    first,
    second,
    third,
    fourth,
    fifth,
  ] as const);
  const finalRegularizedLoss = regularizedLoss(partition, typedWeights, scaler, config);
  if (!(finalRegularizedLoss < initialRegularizedLoss)) {
    fail("training did not reduce regularized loss");
  }
  const state = {
    weights: typedWeights,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    config,
  };
  return Object.freeze({
    fitPartition: "TRAINING",
    weights: typedWeights,
    fitRowCount: partition.rows.length,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    initialRegularizedLoss,
    finalRegularizedLoss,
    config,
    stateSha256: hashValue(state),
  });
}

export function predictProbability(
  features: readonly [number, number, number, number, number],
  scaler: StandardScalerFit,
  model: LogisticRegressionFit,
): number {
  return sigmoid(dot(model.weights, [1, ...standardize(features, scaler)]));
}
