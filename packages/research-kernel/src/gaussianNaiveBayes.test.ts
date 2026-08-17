import { describe, expect, it } from "vitest";

import { splitChronologically } from "./chronologicalSplit.js";
import {
  createFinalTestEvaluatorFromPredictor,
  selectValidationThresholdFromPredictor,
  THRESHOLD_TIE_BREAK_RULE,
  VALIDATION_THRESHOLD_GRID,
} from "./evaluation.js";
import { hashFeatureRows } from "./evidence.js";
import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  fitGaussianNaiveBayes,
  GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR,
  predictGaussianNaiveBayesProbabilityUp,
} from "./gaussianNaiveBayes.js";
import { runGaussianNaiveBayesChallenger } from "./gaussianNaiveBayesChallenger.js";
import { fitStandardScaler, standardize } from "./scaler.js";
import {
  type FeatureRow,
  type FeatureVector,
  type MarketDataRow,
  type RowPartition,
} from "./types.js";

function trainingPartition(rows: readonly FeatureRow[]): RowPartition<"TRAINING"> {
  return Object.freeze({
    kind: "TRAINING",
    rows: Object.freeze([...rows]),
    rowIdentitySha256: hashFeatureRows(rows),
  });
}

function labeledRow(
  index: number,
  target: 0 | 1,
  features: FeatureVector,
): FeatureRow {
  return Object.freeze({
    symbol: "GNB",
    featureDate: `2024-01-${String(index + 1).padStart(2, "0")}`,
    targetDate: `2024-02-${String(index + 1).padStart(2, "0")}`,
    featureSourceStartDate: "2023-12-01",
    featureSourceEndDate: `2024-01-${String(index + 1).padStart(2, "0")}`,
    features: Object.freeze([...features]),
    target,
    forwardReturn: target === 1 ? 0.01 : -0.01,
  });
}

function knownFixtureRows(): FeatureRow[] {
  return [
    labeledRow(0, 0, [0, 0, 1, 1, -0.1]),
    labeledRow(1, 0, [0, 2, 1, 1, -0.1]),
    labeledRow(2, 1, [2, 2, 3, 2, -0.2]),
    labeledRow(3, 1, [4, 2, 3, 2, -0.2]),
  ];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationVariance(values: readonly number[]): number {
  const featureMean = mean(values);
  return mean(values.map((value) => (value - featureMean) ** 2));
}

function classStandardizedColumns(
  rows: readonly FeatureRow[],
  scaler: ReturnType<typeof fitStandardScaler>,
  target: 0 | 1,
): readonly (readonly number[])[] {
  const selected = rows.filter((row) => row.target === target)
    .map((row) => standardize(row.features, scaler));
  const featureCount = selected[0]?.length;
  if (featureCount === undefined) throw new Error("expected class rows");
  return Array.from({ length: featureCount }, (_, featureIndex) =>
    selected.map((features) => features[featureIndex] ?? Number.NaN));
}

function marketFixture(count = 180, lateDrift = 0): MarketDataRow[] {
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const cycle = Math.sin(index * Math.PI / 7);
    const close = 90 + cycle * 6 + index * 0.03 + (date > "2024-04-30" ? lateDrift : 0);
    return {
      symbol: "0056",
      date,
      open: close - 0.15,
      high: close + 0.7,
      low: close - 0.7,
      close,
      volume: 800 + (index % 9) * 21,
      source: "test-owned/in-memory",
    };
  });
}

describe("gaussian naive bayes TRAINING-only fit", () => {
  it("declares a fixed implementation-level variance floor before any scoring", () => {
    expect(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR).toBe(1e-12);
    expect(Number.isFinite(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR)).toBe(true);
    expect(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR).toBeGreaterThan(0);
  });

  it("computes known class priors as N_y / N from TRAINING rows only", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const model = fitGaussianNaiveBayes(partition, scaler);

    expect(model.trainingUpRows).toBe(2);
    expect(model.trainingDownRows).toBe(2);
    expect(model.classPriorUp).toBe(0.5);
    expect(model.classPriorDown).toBe(0.5);
    expect(model.up.prior).toBe(2 / 4);
    expect(model.down.prior).toBe(2 / 4);
    expect(model.varianceFloor).toBe(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR);
  });

  it("computes known per-class feature means on the shared training-fitted scaler", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const model = fitGaussianNaiveBayes(partition, scaler);
    const upColumns = classStandardizedColumns(rows, scaler, 1);
    const downColumns = classStandardizedColumns(rows, scaler, 0);

    expect(model.up.means).toEqual(upColumns.map((column) => mean(column)));
    expect(model.down.means).toEqual(downColumns.map((column) => mean(column)));
  });

  it("computes known per-class feature variances as TRAINING-class population variance", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const model = fitGaussianNaiveBayes(partition, scaler);
    const upColumns = classStandardizedColumns(rows, scaler, 1);
    const downColumns = classStandardizedColumns(rows, scaler, 0);

    expect(model.up.variances).toEqual(upColumns.map((column) => populationVariance(column)));
    expect(model.down.variances).toEqual(downColumns.map((column) => populationVariance(column)));
  });

  it("normalizes class log-scores into a finite probabilityUp in [0, 1]", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const model = fitGaussianNaiveBayes(partition, scaler);
    const extreme = Object.freeze([1e6, -1e6, 1e6, -1e6, 1e6]);
    const probabilities = [
      ...rows.map((row) => predictGaussianNaiveBayesProbabilityUp(row.features, scaler, model)),
      predictGaussianNaiveBayesProbabilityUp(extreme, scaler, model),
    ];

    for (const probability of probabilities) {
      expect(Number.isFinite(probability)).toBe(true);
      expect(probability).toBeGreaterThanOrEqual(0);
      expect(probability).toBeLessThanOrEqual(1);
    }
    expect(probabilities[0]).toBeLessThan(0.5);
    expect(probabilities[2]).toBeGreaterThan(0.5);
  });

  it("applies the predeclared variance floor deterministically for zero-variance features", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const model = fitGaussianNaiveBayes(partition, scaler);

    expect(model.down.variances[0]).toBe(0);
    expect(model.down.variances[2]).toBe(0);
    expect(model.down.variances[3]).toBe(0);
    expect(model.down.variances[4]).toBe(0);
    expect(model.up.variances[1]).toBe(0);
    expect(model.up.variances[2]).toBe(0);
    expect(model.up.variances[3]).toBe(0);
    expect(model.up.variances[4]).toBe(0);
    expect(model.down.flooredVariances.every((variance) => variance >= GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR))
      .toBe(true);
    expect(model.up.flooredVariances.every((variance) => variance >= GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR))
      .toBe(true);
    expect(model.down.nearZeroVarianceFeatureIndexes).toEqual([0, 2, 3, 4]);
    expect(model.up.nearZeroVarianceFeatureIndexes).toEqual([1, 2, 3, 4]);
    expect(model.nearZeroVarianceWarnings.some((warning) => warning.includes("feature 2"))).toBe(true);
    expect(model.varianceFloor).toBe(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR);

    const first = predictGaussianNaiveBayesProbabilityUp(rows[0]!.features, scaler, model);
    const second = predictGaussianNaiveBayesProbabilityUp(rows[0]!.features, scaler, model);
    expect(second).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(1);
  });

  it("does not change the variance floor after validation or FINAL_TEST metrics exist", () => {
    const rows = knownFixtureRows();
    const partition = trainingPartition(rows);
    const scaler = fitStandardScaler(partition);
    const before = fitGaussianNaiveBayes(partition, scaler);
    const predict = (features: FeatureVector) =>
      predictGaussianNaiveBayesProbabilityUp(features, scaler, before);
    const validation = Object.freeze({
      kind: "VALIDATION" as const,
      rows: Object.freeze(rows.map((row, index) => Object.freeze({
        ...row,
        symbol: "VAL",
        featureDate: `2024-03-${String(index + 1).padStart(2, "0")}`,
      }))),
      rowIdentitySha256: hashFeatureRows(rows),
    });
    const selection = selectValidationThresholdFromPredictor(validation, predict);
    expect(selection.selectedValidationMetrics.accuracy).toBeGreaterThanOrEqual(0);
    const after = fitGaussianNaiveBayes(partition, scaler);

    expect(after.varianceFloor).toBe(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR);
    expect(after.varianceFloor).toBe(before.varianceFloor);
    expect(after.stateSha256).toBe(before.stateSha256);
    expect(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR).toBe(1e-12);
  });

  it("ignores VALIDATION and FINAL_TEST labels when fitting GNB parameters", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const baselineScaler = fitStandardScaler(split.training);
    const baseline = fitGaussianNaiveBayes(split.training, baselineScaler);

    const flippedValidation = Object.freeze({
      ...split.validation,
      rows: Object.freeze(split.validation.rows.map((row) => Object.freeze({
        ...row,
        target: row.target === 1 ? 0 as const : 1 as const,
      }))),
    });
    const flippedFinalTest = Object.freeze({
      ...split.finalTest,
      rows: Object.freeze(split.finalTest.rows.map((row) => Object.freeze({
        ...row,
        target: 1 as const,
      }))),
    });
    const poisonedSplit = Object.freeze({
      ...split,
      validation: flippedValidation,
      finalTest: flippedFinalTest,
    });
    const poisonedScaler = fitStandardScaler(poisonedSplit.training);
    const poisoned = fitGaussianNaiveBayes(poisonedSplit.training, poisonedScaler);

    expect(poisonedScaler.stateSha256).toBe(baselineScaler.stateSha256);
    expect(poisoned.stateSha256).toBe(baseline.stateSha256);
    expect(poisoned.classPriorUp).toBe(baseline.classPriorUp);
    expect(poisoned.classPriorDown).toBe(baseline.classPriorDown);
    expect(poisoned.up.means).toEqual(baseline.up.means);
    expect(poisoned.down.variances).toEqual(baseline.down.variances);
  });

  it("fails closed when fit is requested from a non-TRAINING partition", () => {
    const rows = knownFixtureRows();
    const training = trainingPartition(rows);
    const scaler = fitStandardScaler(training);
    expect(() => fitGaussianNaiveBayes({
      kind: "VALIDATION",
      rows,
      rowIdentitySha256: hashFeatureRows(rows),
    }, scaler)).toThrow(/requires TRAINING rows/);
    expect(() => fitGaussianNaiveBayes({
      kind: "FINAL_TEST",
      rows,
      rowIdentitySha256: hashFeatureRows(rows),
    }, scaler)).toThrow(/requires TRAINING rows/);
  });

  it("uses the existing validation threshold grid and tie-break without retuning", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const evidence = runGaussianNaiveBayesChallenger({
      featureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
    });
    const group = evidence.groups[0];
    if (group === undefined) throw new Error("expected a GNB group");

    expect(group.thresholdSelection.selectionPartition).toBe("VALIDATION");
    expect(group.thresholdSelection.fixedThresholdGrid).toEqual([...VALIDATION_THRESHOLD_GRID]);
    expect(group.thresholdSelection.tieBreakRule).toEqual([...THRESHOLD_TIE_BREAK_RULE]);
    expect(group.thresholdSelection.fixedThresholdGrid)
      .toContain(group.thresholdSelection.selectedThreshold);
    expect(group.finalTest.evaluationPartition).toBe("FINAL_TEST");
    expect(group.finalTest.frozenThreshold).toBe(group.thresholdSelection.selectedThreshold);
    expect(group.fit.fitPartition).toBe("TRAINING");
    expect(group.fit.varianceFloor).toBe(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR);
    expect(evidence.featureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(evidence.featureNames).not.toContain("breakout_20d_high");
    expect(evidence.featureNames).not.toContain("intraday_range_pct");
  });

  it("does not change an earlier training fit hash when later rows are appended after the cutoff", () => {
    const earlyRows = buildHistoricalFeatureRows(marketFixture(120));
    const laterRows = buildHistoricalFeatureRows(marketFixture(180, 12));
    const earlyCutoff = earlyRows[earlyRows.length - 1]?.featureDate;
    if (earlyCutoff === undefined) throw new Error("expected an early cutoff date");
    const laterRestricted = laterRows.filter((row) => row.featureDate <= earlyCutoff);
    const earlyPartition = trainingPartition(earlyRows);
    const laterPartition = trainingPartition(laterRestricted);
    const earlyScaler = fitStandardScaler(earlyPartition);
    const laterScaler = fitStandardScaler(laterPartition);

    expect(laterPartition.rowIdentitySha256).toBe(earlyPartition.rowIdentitySha256);
    expect(fitGaussianNaiveBayes(laterPartition, laterScaler).stateSha256)
      .toBe(fitGaussianNaiveBayes(earlyPartition, earlyScaler).stateSha256);
  });

  it("produces independent fitted hashes when training windows differ", () => {
    const shorter = trainingPartition(buildHistoricalFeatureRows(marketFixture(120)));
    const longer = trainingPartition(buildHistoricalFeatureRows(marketFixture(180)));
    const shorterModel = fitGaussianNaiveBayes(shorter, fitStandardScaler(shorter));
    const longerModel = fitGaussianNaiveBayes(longer, fitStandardScaler(longer));

    expect(longer.rowIdentitySha256).not.toBe(shorter.rowIdentitySha256);
    expect(longerModel.stateSha256).not.toBe(shorterModel.stateSha256);
  });

  it("rejects a one-class TRAINING partition", () => {
    const rows = [labeledRow(0, 1, [0.1, 0.2, 0.3, 1, -0.01]), labeledRow(1, 1, [0.2, 0.1, 0.4, 1.1, -0.02])];
    const partition = trainingPartition(rows);
    expect(() => fitGaussianNaiveBayes(partition, fitStandardScaler(partition)))
      .toThrow(/requires both classes/);
  });
});

describe("gaussian naive bayes final-test evaluator isolation", () => {
  it("does not let FINAL_TEST scoring mutate trained parameters", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const scaler = fitStandardScaler(split.training);
    const model = fitGaussianNaiveBayes(split.training, scaler);
    const evaluator = createFinalTestEvaluatorFromPredictor();
    evaluator.evaluate(
      split.finalTest,
      0.5,
      (features) => predictGaussianNaiveBayesProbabilityUp(features, scaler, model),
    );
    evaluator.assertExactlyOnce();
    const after = fitGaussianNaiveBayes(split.training, scaler);
    expect(after.stateSha256).toBe(model.stateSha256);
    expect(after.varianceFloor).toBe(GAUSSIAN_NAIVE_BAYES_VARIANCE_FLOOR);
  });
});
