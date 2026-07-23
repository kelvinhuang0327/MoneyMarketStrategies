import { hashValue } from "./evidence.js";
import {
  fail,
  type FeatureVector,
  type PartitionKind,
  type RowPartition,
  type StandardScalerFit,
} from "./types.js";

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute a mean from zero values");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function vector(values: readonly number[]): FeatureVector {
  if (values.length !== 5) fail(`expected five features, received ${values.length}`);
  const [first, second, third, fourth, fifth] = values;
  if (
    first === undefined
    || second === undefined
    || third === undefined
    || fourth === undefined
    || fifth === undefined
  ) {
    fail("feature vector is incomplete");
  }
  return Object.freeze([first, second, third, fourth, fifth]);
}

export function fitStandardScaler(
  partition: RowPartition<PartitionKind>,
): StandardScalerFit {
  if (partition.kind !== "TRAINING") {
    fail(`scaler fit requires TRAINING rows, received ${partition.kind}`);
  }
  if (partition.rows.length === 0) fail("cannot fit scaler on zero training rows");
  const means = vector(Array.from({ length: 5 }, (_, featureIndex) =>
    mean(partition.rows.map((row) => row.features[featureIndex] ?? fail("feature is missing")))));
  const standardDeviations = vector(Array.from({ length: 5 }, (_, featureIndex) => {
    const variance = mean(partition.rows.map((row) => {
      const value = row.features[featureIndex];
      const featureMean = means[featureIndex];
      if (value === undefined || featureMean === undefined) fail("feature is missing");
      return (value - featureMean) ** 2;
    }));
    const deviation = Math.sqrt(variance);
    return deviation > 1e-12 ? deviation : 1;
  }));
  const state = {
    means,
    standardDeviations,
    fitRowIdentitySha256: partition.rowIdentitySha256,
  };
  return Object.freeze({
    fitPartition: "TRAINING",
    means,
    standardDeviations,
    fitRowCount: partition.rows.length,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    stateSha256: hashValue(state),
  });
}

export function standardize(
  features: FeatureVector,
  scaler: StandardScalerFit,
): FeatureVector {
  return vector(features.map((value, index) => {
    const featureMean = scaler.means[index];
    const deviation = scaler.standardDeviations[index];
    if (featureMean === undefined || deviation === undefined) fail("scaler state is incomplete");
    return (value - featureMean) / deviation;
  }));
}
