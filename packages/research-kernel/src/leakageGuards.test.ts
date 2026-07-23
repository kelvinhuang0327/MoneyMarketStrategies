import { describe, expect, it } from "vitest";

import {
  buildHistoricalFeatureRows,
  createFinalTestEvaluator,
  fitLogisticRegression,
  fitStandardScaler,
  runResearchEvidenceKernel,
  selectValidationThreshold,
  splitChronologically,
  validateAndNormalizeMarketRows,
  type FeatureRow,
  type MarketDataRow,
} from "./index.js";

function fixtureRows(count = 100): MarketDataRow[] {
  const start = Date.UTC(2023, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 80 + Math.sin(index * Math.PI / 8) * 7 + index * 0.02;
    return {
      symbol: "GUARD",
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.1,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 900 + (index % 11) * 19,
      source: "test-owned/in-memory",
    };
  });
}

function splitFixture() {
  return splitChronologically(
    buildHistoricalFeatureRows(validateAndNormalizeMarketRows(fixtureRows())),
  );
}

describe("leakage and fail-closed guards", () => {
  it("purges a target that crosses each chronological boundary", () => {
    const split = splitFixture();

    expect(split.trainValidationPurge.rows.every((row) =>
      row.featureDate <= split.trainEndDate && row.targetDate > split.trainEndDate)).toBe(true);
    expect(split.validationFinalPurge.rows.every((row) =>
      row.featureDate <= split.validationEndDate
      && row.targetDate > split.validationEndDate)).toBe(true);
  });

  it("fails closed when final-test rows reach a fit path", () => {
    const split = splitFixture();

    expect(() => fitStandardScaler(split.finalTest))
      .toThrow(/fit requires TRAINING rows/);
  });

  it("fails closed when final-test rows reach threshold selection", () => {
    const split = splitFixture();
    const scaler = fitStandardScaler(split.training);
    const model = fitLogisticRegression(split.training, scaler, { iterations: 300 });

    expect(() => selectValidationThreshold(split.finalTest, scaler, model))
      .toThrow(/requires VALIDATION rows/);
  });

  it("fails closed on a malformed date", () => {
    const rows = fixtureRows();
    const first = rows[0];
    if (first === undefined) throw new Error("test fixture row is missing");
    rows[0] = { ...first, date: "2023-02-30" };

    expect(() => validateAndNormalizeMarketRows(rows)).toThrow(/malformed canonical date/);
  });

  it("fails closed on a non-finite or invalid OHLCV value", () => {
    const nonFinite = fixtureRows();
    const first = nonFinite[0];
    if (first === undefined) throw new Error("test fixture row is missing");
    nonFinite[0] = { ...first, close: Number.NaN };

    expect(() => validateAndNormalizeMarketRows(nonFinite)).toThrow(/non-finite OHLCV/);

    const invalid = fixtureRows();
    const second = invalid[1];
    if (second === undefined) throw new Error("test fixture row is missing");
    invalid[1] = { ...second, high: second.low - 1 };

    expect(() => validateAndNormalizeMarketRows(invalid)).toThrow(/invalid OHLCV domain/);
  });

  it("fails closed on a duplicate symbol and date", () => {
    const rows = fixtureRows();
    const first = rows[0];
    if (first === undefined) throw new Error("test fixture row is missing");
    rows.splice(1, 0, { ...first });

    expect(() => validateAndNormalizeMarketRows(rows)).toThrow(/duplicate symbol\/date/);
  });

  it("fails closed on invalid input ordering", () => {
    const rows = fixtureRows();
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error("test fixture rows are missing");
    rows[0] = second;
    rows[1] = first;

    expect(() => validateAndNormalizeMarketRows(rows)).toThrow(/invalid market-row ordering/);
  });

  it("fails closed when a chronological partition is empty", () => {
    const rows: FeatureRow[] = Array.from({ length: 4 }, (_, index) => ({
      symbol: "SMALL",
      featureDate: `2024-01-0${index + 1}`,
      targetDate: `2024-01-0${index + 1}`,
      featureSourceStartDate: `2024-01-0${index + 1}`,
      featureSourceEndDate: `2024-01-0${index + 1}`,
      features: [0, 0, 0, 1, 0],
      target: index % 2 === 0 ? 1 : 0,
      forwardReturn: index % 2 === 0 ? 0.01 : -0.01,
    }));

    expect(() => splitChronologically(rows)).toThrow(/empty partition|insufficient/);
  });

  it("fails closed on a repeated final-test evaluation attempt", () => {
    const split = splitFixture();
    const scaler = fitStandardScaler(split.training);
    const model = fitLogisticRegression(split.training, scaler, { iterations: 300 });
    const selection = selectValidationThreshold(split.validation, scaler, model);
    const evaluator = createFinalTestEvaluator();

    evaluator.evaluate(split.finalTest, scaler, model, selection.selectedThreshold);

    expect(() =>
      evaluator.evaluate(split.finalTest, scaler, model, selection.selectedThreshold))
      .toThrow(/more than once/);
  });

  it("keeps automatic promotion disabled for every kernel result", () => {
    const result = runResearchEvidenceKernel({
      datasetVersion: {
        datasetId: "guard-fixture",
        version: "v1",
        source: "test-owned/in-memory",
      },
      marketRows: fixtureRows(),
      logisticRegression: { iterations: 300 },
    });

    expect(result.promotionDecision.automaticPromotion).toBe(false);
    expect(result.promotionDecision.manualApprovalRequired).toBe(true);
  });
});
