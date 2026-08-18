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
 * Ordinary Least Squares linear regression for continuous return prediction.
 *
 * Solves the normal equations X^T X β = X^T y using a deterministic
 * Gaussian elimination with partial pivoting. No regularization, no
 * external ML dependency.
 *
 * PIVOT_TOLERANCE is the only numerical safety constant; it is frozen
 * before result inspection and declared here for audit.
 */
export const PIVOT_TOLERANCE = 1e-12 as const;

export interface LinearRegressionFit {
  readonly fitPartition: "TRAINING";
  /** Coefficients: [intercept, coeff_0, coeff_1, ..., coeff_k]. */
  readonly coefficients: readonly number[];
  readonly fitRowCount: number;
  readonly fitRowIdentitySha256: string;
  readonly trainingMSE: number;
  readonly stateSha256: string;
}

/**
 * Solve a dense linear system A x = b using Gaussian elimination with
 * partial pivoting. A is an n×n matrix (row-major), b is length n.
 * Returns x of length n, or fails if the system is singular within
 * PIVOT_TOLERANCE.
 */
function solveLinearSystem(
  A: readonly (readonly number[])[],
  b: readonly number[],
): readonly number[] {
  const n = b.length;
  if (A.length !== n) fail("linear system matrix row count does not match");
  for (let i = 0; i < n; i += 1) {
    if (A[i]!.length !== n) fail("linear system matrix is not square");
  }
  // Copy into mutable augmented matrix
  const aug: number[][] = A.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col += 1) {
    // Partial pivoting: find the row with the largest absolute value in this column
    let maxVal = Math.abs(aug[col]![col]!);
    let maxRow = col;
    for (let row = col + 1; row < n; row += 1) {
      const absVal = Math.abs(aug[row]![col]!);
      if (absVal > maxVal) {
        maxVal = absVal;
        maxRow = row;
      }
    }
    if (maxVal < PIVOT_TOLERANCE) {
      fail("linear regression normal system is singular or near-singular");
    }
    // Swap rows
    if (maxRow !== col) {
      const temp = aug[col]!;
      aug[col] = aug[maxRow]!;
      aug[maxRow] = temp;
    }
    // Eliminate below
    const pivotValue = aug[col]![col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = aug[row]![col]! / pivotValue;
      for (let j = col; j <= n; j += 1) {
        aug[row]![j] = aug[row]![j]! - factor * aug[col]![j]!;
      }
    }
  }
  // Back substitution
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = aug[row]![n]!;
    for (let col = row + 1; col < n; col += 1) {
      sum -= aug[row]![col]! * x[col]!;
    }
    x[row] = sum / aug[row]![row]!;
  }
  // Validate solution is finite
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i])) {
      fail("linear regression produced a non-finite coefficient");
    }
  }
  return Object.freeze([...x]);
}

/**
 * Fit an ordinary least-squares linear regression on TRAINING rows.
 *
 * The model predicts continuous forward return:
 *   ŷ = β₀ + β₁·z₁ + β₂·z₂ + ... + βₖ·zₖ
 *
 * where z = standardize(features, scaler).
 *
 * Coefficients are computed via the normal equations:
 *   (X^T X) β = X^T y
 *
 * where X = [1, z₁, z₂, ..., zₖ] (design matrix with intercept column).
 */
export function fitLinearRegression(
  untrustedPartition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
): LinearRegressionFit {
  if (untrustedPartition.kind !== "TRAINING") {
    fail(`linear regression fit requires TRAINING rows, received ${untrustedPartition.kind}`);
  }
  const partition = untrustedPartition as RowPartition<"TRAINING">;
  if (partition.rows.length === 0) fail("cannot fit linear regression on zero training rows");
  if (
    scaler.fitPartition !== "TRAINING"
    || scaler.fitRowCount !== partition.rows.length
    || scaler.fitRowIdentitySha256 !== partition.rowIdentitySha256
  ) {
    fail("linear regression rows do not match the training-only scaler fit");
  }
  const firstRow = partition.rows[0];
  if (firstRow === undefined) fail("training row is missing");
  const featureCount = firstRow.features.length;
  if (featureCount === 0) fail("training feature vector must not be empty");
  if (partition.rows.some((row) => row.features.length !== featureCount)) {
    fail("training feature vectors differ in length");
  }

  const n = partition.rows.length;
  const p = featureCount + 1; // intercept + features

  // Build X^T X and X^T y using standardized features
  const XtX: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty: number[] = new Array<number>(p).fill(0);

  for (const row of partition.rows) {
    const z = standardize(row.features, scaler);
    const x = [1, ...z]; // design row with intercept
    const y = row.forwardReturn;
    for (let i = 0; i < p; i += 1) {
      const xi = x[i];
      if (xi === undefined) fail("design row is incomplete");
      Xty[i] = Xty[i]! + xi * y;
      for (let j = 0; j < p; j += 1) {
        const xj = x[j];
        if (xj === undefined) fail("design row is incomplete");
        XtX[i]![j] = XtX[i]![j]! + xi * xj;
      }
    }
  }

  // Solve normal equations
  const coefficients = solveLinearSystem(XtX, Xty);

  // Compute training MSE
  let totalSquaredError = 0;
  for (const row of partition.rows) {
    const predicted = predictReturn(row.features, scaler, coefficients);
    const residual = row.forwardReturn - predicted;
    totalSquaredError += residual * residual;
  }
  const trainingMSE = totalSquaredError / n;

  const state = {
    coefficients,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    trainingMSE,
  };

  return Object.freeze({
    fitPartition: "TRAINING",
    coefficients,
    fitRowCount: partition.rows.length,
    fitRowIdentitySha256: partition.rowIdentitySha256,
    trainingMSE,
    stateSha256: hashValue(state),
  });
}

/**
 * Predict continuous forward return for a single observation.
 */
export function predictReturn(
  features: FeatureVector,
  scaler: StandardScalerFit,
  coefficients: readonly number[],
): number {
  const z = standardize(features, scaler);
  const x = [1, ...z];
  if (x.length !== coefficients.length) {
    fail("coefficient count does not match design vector length");
  }
  let prediction = 0;
  for (let i = 0; i < x.length; i += 1) {
    const xi = x[i];
    const ci = coefficients[i];
    if (xi === undefined || ci === undefined) fail("prediction input is incomplete");
    prediction += xi * ci;
  }
  if (!Number.isFinite(prediction)) {
    fail("linear regression produced a non-finite prediction");
  }
  return prediction;
}
