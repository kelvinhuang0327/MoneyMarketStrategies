import { hashValue } from "./evidence.js";
import { standardize } from "./scaler.js";
import {
  fail,
  type FeatureVector,
  type PartitionKind,
  type RowPartition,
  type StandardScalerFit,
} from "./types.js";

/**
 * Implementation-level variance floor for numerical safety only.
 * Declared before any performance evaluation. Identical across
 * cutoffs, classes, and features. Not a hyperparameter and not
 * selected from validation or FINAL_TEST evidence.
 */
export const GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR = 1e-12;

export interface GaussianNaiveBayesClassStats {
  readonly classLabel: 0 | 1;
  readonly count: number;
  readonly prior: number;
  readonly means: FeatureVector;
  readonly variances: FeatureVector;
  readonly flooredVariances: FeatureVector;
  readonly nearZeroVarianceFeatureIndexes: readonly number[];
}

export interface GaussianNaiveBayesFit {
  readonly fitPartition: "TRAINING";
  readonly fitRowCount: number;
  readonly fitRowIdentitySha256: string;
  readonly scalerStateSha256: string;
  readonly varianceFloor: number;
  readonly trainingUpRows: number;
  readonly trainingDownRows: number;
  readonly classPriorUp: number;
  readonly classPriorDown: number;
  readonly down: GaussianNaiveBayesClassStats;
  readonly up: GaussianNaiveBayesClassStats;
  readonly nearZeroVarianceWarnings: readonly string[];
  readonly stateSha256: string;
}

function vector(values: readonly number[]): FeatureVector {
  if (values.length === 0) fail("feature vector must not be empty");
  if (values.some((value) => !Number.isFinite(value))) {
    fail("feature vector contains a non-finite value");
  }
  return Object.freeze([...values]);
}

function classRows(
  rows: readonly { readonly features: FeatureVector; readonly target: 0 | 1 }[],
  classLabel: 0 | 1,
): readonly { readonly features: FeatureVector; readonly target: 0 | 1 }[] {
  return rows.filter((row) => row.target === classLabel);
}

function featureMean(rows: readonly { readonly features: FeatureVector }[], featureIndex: number): number {
  if (rows.length === 0) fail("cannot compute a class feature mean from zero rows");
  return rows.reduce((sum, row) => {
    const value = row.features[featureIndex];
    if (value === undefined) fail("class-conditional feature is missing");
    return sum + value;
  }, 0) / rows.length;
}

function featureVariance(
  rows: readonly { readonly features: FeatureVector }[],
  featureIndex: number,
  mean: number,
): number {
  if (rows.length === 0) fail("cannot compute a class feature variance from zero rows");
  return rows.reduce((sum, row) => {
    const value = row.features[featureIndex];
    if (value === undefined) fail("class-conditional feature is missing");
    return sum + (value - mean) ** 2;
  }, 0) / rows.length;
}

function buildClassStats(
  rows: readonly { readonly features: FeatureVector; readonly target: 0 | 1 }[],
  classLabel: 0 | 1,
  trainingRowCount: number,
  featureCount: number,
): GaussianNaiveBayesClassStats {
  if (rows.length === 0) {
    fail(`gaussian naive bayes requires TRAINING rows for class ${classLabel}`);
  }
  const means = vector(Array.from({ length: featureCount }, (_, featureIndex) =>
    featureMean(rows, featureIndex)));
  const variances = vector(Array.from({ length: featureCount }, (_, featureIndex) => {
    const mean = means[featureIndex];
    if (mean === undefined) fail("class-conditional mean is missing");
    return featureVariance(rows, featureIndex, mean);
  }));
  const nearZeroVarianceFeatureIndexes = Object.freeze(
    variances.flatMap((variance, featureIndex) =>
      variance < GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR ? [featureIndex] : []),
  );
  const flooredVariances = vector(variances.map((variance) =>
    Math.max(variance, GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR)));
  return Object.freeze({
    classLabel,
    count: rows.length,
    prior: rows.length / trainingRowCount,
    means,
    variances,
    flooredVariances,
    nearZeroVarianceFeatureIndexes,
  });
}

function gaussianLogLikelihood(value: number, mean: number, variance: number): number {
  return -0.5 * (Math.log(2 * Math.PI * variance) + ((value - mean) ** 2) / variance);
}

function classLogScore(features: FeatureVector, stats: GaussianNaiveBayesClassStats): number {
  if (features.length !== stats.means.length || features.length !== stats.flooredVariances.length) {
    fail("gaussian naive bayes feature vector and class statistics differ in length");
  }
  return features.reduce((sum, value, featureIndex) => {
    const mean = stats.means[featureIndex];
    const variance = stats.flooredVariances[featureIndex];
    if (mean === undefined || variance === undefined) fail("class-conditional statistics are incomplete");
    return sum + gaussianLogLikelihood(value, mean, variance);
  }, Math.log(stats.prior));
}

export function fitGaussianNaiveBayes(
  untrustedPartition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
): GaussianNaiveBayesFit {
  if (untrustedPartition.kind !== "TRAINING") {
    fail(`gaussian naive bayes fit requires TRAINING rows, received ${untrustedPartition.kind}`);
  }
  const partition = untrustedPartition as RowPartition<"TRAINING">;
  if (partition.rows.length === 0) fail("cannot fit gaussian naive bayes on zero training rows");
  if (
    scaler.fitPartition !== "TRAINING"
    || scaler.fitRowCount !== partition.rows.length
    || scaler.fitRowIdentitySha256 !== partition.rowIdentitySha256
  ) {
    fail("gaussian naive bayes rows do not match the training-only scaler fit");
  }
  const featureCount = partition.rows[0]?.features.length;
  if (featureCount === undefined || featureCount === 0) {
    fail("training feature vector must not be empty");
  }
  if (partition.rows.some((row) => row.features.length !== featureCount)) {
    fail("training feature vectors differ in length");
  }
  const standardizedRows = partition.rows.map((row) => Object.freeze({
    features: standardize(row.features, scaler),
    target: row.target,
  }));
  const downRows = classRows(standardizedRows, 0);
  const upRows = classRows(standardizedRows, 1);
  if (downRows.length === 0 || upRows.length === 0) {
    fail(
      `gaussian naive bayes requires both classes in TRAINING (up=${upRows.length}, down=${downRows.length})`,
    );
  }
  const down = buildClassStats(downRows, 0, partition.rows.length, featureCount);
  const up = buildClassStats(upRows, 1, partition.rows.length, featureCount);
  const nearZeroVarianceWarnings = Object.freeze([
    ...down.nearZeroVarianceFeatureIndexes.map((featureIndex) =>
      `Near-zero TRAINING variance for class down feature ${featureIndex}; applied variance floor ${GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR}.`),
    ...up.nearZeroVarianceFeatureIndexes.map((featureIndex) =>
      `Near-zero TRAINING variance for class up feature ${featureIndex}; applied variance floor ${GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR}.`),
  ]);
  const state = {
    fitRowIdentitySha256: partition.rowIdentitySha256,
    scalerStateSha256: scaler.stateSha256,
    varianceFloor: GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
    trainingUpRows: up.count,
    trainingDownRows: down.count,
    classPriorUp: up.prior,
    classPriorDown: down.prior,
    down,
    up,
  };
  return Object.freeze({
    fitPartition: "TRAINING",
    fitRowCount: partition.rows.length,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    scalerStateSha256: scaler.stateSha256,
    varianceFloor: GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
    trainingUpRows: up.count,
    trainingDownRows: down.count,
    classPriorUp: up.prior,
    classPriorDown: down.prior,
    down,
    up,
    nearZeroVarianceWarnings,
    stateSha256: hashValue(state),
  });
}

export function predictGaussianNaiveBayesProbabilityUp(
  features: FeatureVector,
  scaler: StandardScalerFit,
  model: GaussianNaiveBayesFit,
): number {
  if (
    scaler.fitPartition !== "TRAINING"
    || model.fitPartition !== "TRAINING"
    || scaler.stateSha256 !== model.scalerStateSha256
  ) {
    fail("gaussian naive bayes inference requires the matching training-only scaler");
  }
  const standardized = standardize(features, scaler);
  const logUp = classLogScore(standardized, model.up);
  const logDown = classLogScore(standardized, model.down);
  const maxLog = Math.max(logUp, logDown);
  const expUp = Math.exp(logUp - maxLog);
  const expDown = Math.exp(logDown - maxLog);
  const probabilityUp = expUp / (expUp + expDown);
  if (!Number.isFinite(probabilityUp) || probabilityUp < 0 || probabilityUp > 1) {
    fail(`gaussian naive bayes probabilityUp is outside [0, 1]: ${probabilityUp}`);
  }
  return probabilityUp;
}
