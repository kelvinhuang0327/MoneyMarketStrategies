import { describe, expect, it } from "vitest";

import { hashFeatureRows } from "./evidence.js";
import {
  computeTrainingClassWeights,
  fitLogisticRegression,
} from "./logisticRegression.js";
import {
  buildHistoricalFeatureRows,
  RESEARCH_FEATURE_NAMES,
} from "./features.js";
import { runPerSymbolLogisticChallenger } from "./perSymbolLogisticChallenger.js";
import { fitStandardScaler } from "./scaler.js";
import { splitChronologically } from "./chronologicalSplit.js";
import {
  type FeatureRow,
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

function labeledRows(targets: readonly (0 | 1)[]): FeatureRow[] {
  return targets.map((target, index) => Object.freeze({
    symbol: "BAL",
    featureDate: `2024-01-${String(index + 1).padStart(2, "0")}`,
    targetDate: `2024-02-${String(index + 1).padStart(2, "0")}`,
    featureSourceStartDate: "2023-12-01",
    featureSourceEndDate: `2024-01-${String(index + 1).padStart(2, "0")}`,
    features: Object.freeze([
      target === 1 ? 0.04 : -0.03,
      target === 1 ? 0.08 : -0.05,
      0.02,
      1 + index * 0.01,
      target === 1 ? -0.01 : -0.04,
    ]),
    target,
    forwardReturn: target === 1 ? 0.01 : -0.01,
  }));
}

function marketFixture(count = 160, symbol = "BAL"): MarketDataRow[] {
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.sin(index * Math.PI / 7);
    const close = 90 + cycle * 6 + index * 0.03;
    return {
      symbol,
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.15,
      high: close + 0.7,
      low: close - 0.7,
      close,
      volume: 800 + (index % 9) * 21,
      source: "test-owned/in-memory",
    };
  });
}

describe("training-only inverse-frequency class weights", () => {
  it("computes weights only from TRAINING labels using the specified formula", () => {
    const targets = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0] as const;
    const partition = trainingPartition(labeledRows(targets));
    const computed = computeTrainingClassWeights(partition);
    const trainingRowCount = targets.length;
    const trainingUpRows = targets.filter((target) => target === 1).length;
    const trainingDownRows = trainingRowCount - trainingUpRows;

    expect(computed.status).toBe("available");
    if (computed.status !== "available") throw new Error("expected available weights");
    expect(computed.weights.sourcePartition).toBe("TRAINING");
    expect(computed.weights.trainingRowCount).toBe(trainingRowCount);
    expect(computed.weights.trainingUpRows).toBe(trainingUpRows);
    expect(computed.weights.trainingDownRows).toBe(trainingDownRows);
    expect(computed.weights.weightUp).toBe(trainingRowCount / (2 * trainingUpRows));
    expect(computed.weights.weightDown).toBe(trainingRowCount / (2 * trainingDownRows));
    expect(computed.weights.weightUp * trainingUpRows
      + computed.weights.weightDown * trainingDownRows).toBe(trainingRowCount);
  });

  it("marks a one-class TRAINING partition unavailable without inventing a weight", () => {
    const allUp = computeTrainingClassWeights(trainingPartition(labeledRows([1, 1, 1, 1])));
    const allDown = computeTrainingClassWeights(trainingPartition(labeledRows([0, 0, 0])));

    expect(allUp.status).toBe("unavailable");
    expect(allDown.status).toBe("unavailable");
    if (allUp.status !== "unavailable" || allDown.status !== "unavailable") {
      throw new Error("expected unavailable one-class weights");
    }
    expect(allUp.reason).toMatch(/only one class/);
    expect(allDown.reason).toMatch(/only one class/);
    expect(allUp).not.toHaveProperty("weights");
    expect(allDown).not.toHaveProperty("weights");
  });

  it("fails closed when class weights are requested from a non-TRAINING partition", () => {
    const rows = labeledRows([1, 0, 1, 0]);
    expect(() => computeTrainingClassWeights({
      kind: "VALIDATION",
      rows,
      rowIdentitySha256: hashFeatureRows(rows),
    })).toThrow(/class weights require TRAINING rows/);
    expect(() => computeTrainingClassWeights({
      kind: "FINAL_TEST",
      rows,
      rowIdentitySha256: hashFeatureRows(rows),
    })).toThrow(/class weights require TRAINING rows/);
  });

  it("reproduces the unweighted logistic fit exactly when weighting is disabled", () => {
    const partition = trainingPartition(labeledRows([1, 1, 0, 0, 1, 0, 0, 1]));
    const scaler = fitStandardScaler(partition);
    const unweighted = fitLogisticRegression(partition, scaler, { iterations: 400 });
    const disabled = fitLogisticRegression(partition, scaler, { iterations: 400 }, {});

    expect(disabled.weights).toEqual(unweighted.weights);
    expect(disabled.stateSha256).toBe(unweighted.stateSha256);
    expect(disabled.initialRegularizedLoss).toBe(unweighted.initialRegularizedLoss);
    expect(disabled.finalRegularizedLoss).toBe(unweighted.finalRegularizedLoss);
    expect(disabled.config).toEqual(unweighted.config);
    expect(disabled).not.toHaveProperty("classWeights");
    expect(unweighted).not.toHaveProperty("classWeights");
  });

  it("rejects class weights that do not match the TRAINING labels", () => {
    const partition = trainingPartition(labeledRows([1, 1, 0, 0, 0, 0]));
    const scaler = fitStandardScaler(partition);
    const computed = computeTrainingClassWeights(partition);
    if (computed.status !== "available") throw new Error("expected available weights");

    expect(() => fitLogisticRegression(partition, scaler, { iterations: 50 }, {
      classWeights: {
        ...computed.weights,
        weightUp: computed.weights.weightUp + 0.25,
      },
    })).toThrow(/do not match TRAINING labels/);
  });

  it("does not change the feature or scaler contract when weighting is enabled", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const scaler = fitStandardScaler(split.training);
    const computed = computeTrainingClassWeights(split.training);
    if (computed.status !== "available") throw new Error("expected available training weights");

    const unweighted = fitLogisticRegression(split.training, scaler, { iterations: 300 });
    const weighted = fitLogisticRegression(split.training, scaler, { iterations: 300 }, {
      classWeights: computed.weights,
    });
    const scalerAfter = fitStandardScaler(split.training);

    expect(RESEARCH_FEATURE_NAMES).toEqual([
      "return_5d",
      "return_20d",
      "volatility_10d",
      "volume_ratio_20d",
      "drawdown_20d",
    ]);
    expect(scalerAfter.stateSha256).toBe(scaler.stateSha256);
    expect(scalerAfter.means).toEqual(scaler.means);
    expect(scalerAfter.standardDeviations).toEqual(scaler.standardDeviations);
    expect(weighted.fitRowIdentitySha256).toBe(unweighted.fitRowIdentitySha256);
    expect(weighted.config).toEqual(unweighted.config);
    expect(weighted.classWeights).toEqual(computed.weights);
    expect(split.training.rows.every((row) => row.features.length === RESEARCH_FEATURE_NAMES.length))
      .toBe(true);
    expect(split.training.rows.some((row) =>
      Object.prototype.hasOwnProperty.call(row, "breakout_20d_high"))).toBe(false);
  });

  it("ignores VALIDATION and FINAL_TEST labels when computing and applying class weights", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const trainingWeights = computeTrainingClassWeights(split.training);
    if (trainingWeights.status !== "available") throw new Error("expected available training weights");

    const flippedValidation = Object.freeze({
      ...split.validation,
      rows: Object.freeze(split.validation.rows.map((row) => Object.freeze({
        ...row,
        target: row.target === 1 ? 0 : 1 as 0 | 1,
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

    expect(() => computeTrainingClassWeights(split.validation))
      .toThrow(/class weights require TRAINING rows/);
    expect(() => computeTrainingClassWeights(split.finalTest))
      .toThrow(/class weights require TRAINING rows/);
    expect(computeTrainingClassWeights(poisonedSplit.training)).toEqual(trainingWeights);

    const control = runPerSymbolLogisticChallenger({
      featureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "training_inverse_frequency",
      logisticRegression: { iterations: 250 },
    });
    const poisoned = runPerSymbolLogisticChallenger({
      featureRows,
      split: poisonedSplit,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "training_inverse_frequency",
      logisticRegression: { iterations: 250 },
    });
    const controlGroup = control.groups[0];
    const poisonedGroup = poisoned.groups[0];
    if (controlGroup === undefined || poisonedGroup === undefined) {
      throw new Error("expected a per-symbol group");
    }
    expect(poisonedGroup.fit.classBalancing).toEqual(controlGroup.fit.classBalancing);
    expect(poisonedGroup.fit.modelStateSha256).toBe(controlGroup.fit.modelStateSha256);
    expect(poisonedGroup.fit.scalerStateSha256).toBe(controlGroup.fit.scalerStateSha256);
    expect(poisonedGroup.fit.classBalancing?.trainingUpRows)
      .toBe(trainingWeights.weights.trainingUpRows);
    expect(poisonedGroup.fit.classBalancing?.trainingDownRows)
      .toBe(trainingWeights.weights.trainingDownRows);
  });

  it("does not change trained class weights when validation or final-test rows are appended", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const trainingWeights = computeTrainingClassWeights(split.training);
    if (trainingWeights.status !== "available") throw new Error("expected available training weights");

    const appendedFeatureRows = Object.freeze([
      ...featureRows,
      ...split.validation.rows,
      ...split.finalTest.rows,
    ]);
    const base = runPerSymbolLogisticChallenger({
      featureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "training_inverse_frequency",
      logisticRegression: { iterations: 250 },
    });
    const appended = runPerSymbolLogisticChallenger({
      featureRows: appendedFeatureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "training_inverse_frequency",
      logisticRegression: { iterations: 250 },
    });
    const baseGroup = base.groups[0];
    const appendedGroup = appended.groups[0];
    if (baseGroup === undefined || appendedGroup === undefined) {
      throw new Error("expected a per-symbol group");
    }
    expect(appendedGroup.fit.classBalancing).toEqual(baseGroup.fit.classBalancing);
    expect(appendedGroup.fit.classBalancing).toMatchObject({
      mode: "training_inverse_frequency",
      sourcePartition: "TRAINING",
      trainingUpRows: trainingWeights.weights.trainingUpRows,
      trainingDownRows: trainingWeights.weights.trainingDownRows,
      weightUp: trainingWeights.weights.weightUp,
      weightDown: trainingWeights.weights.weightDown,
    });
    expect(appendedGroup.fit.modelStateSha256).toBe(baseGroup.fit.modelStateSha256);
    expect(appendedGroup.trainingRowsSha256).toBe(split.training.rowIdentitySha256);
  });

  it("keeps disabled class balancing identical to the default per-symbol challenger", () => {
    const featureRows = buildHistoricalFeatureRows(marketFixture());
    const split = splitChronologically(featureRows);
    const defaultRun = runPerSymbolLogisticChallenger({
      featureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      logisticRegression: { iterations: 250 },
    });
    const disabledRun = runPerSymbolLogisticChallenger({
      featureRows,
      split,
      featureNames: RESEARCH_FEATURE_NAMES,
      classBalancing: "disabled",
      logisticRegression: { iterations: 250 },
    });
    expect(disabledRun.normalizedResultSha256).toBe(defaultRun.normalizedResultSha256);
    expect(disabledRun).not.toHaveProperty("classBalancing");
    expect(defaultRun.groups[0]?.fit).not.toHaveProperty("classBalancing");
  });
});
