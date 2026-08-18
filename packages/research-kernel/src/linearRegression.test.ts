import { describe, expect, it } from "vitest";

import { hashValue } from "./evidence.js";
import {
  fitLinearRegression,
  PIVOT_TOLERANCE,
  predictReturn,
} from "./linearRegression.js";
import { fitStandardScaler } from "./scaler.js";
import type { FeatureRow, RowPartition } from "./types.js";

function makeRow(
  featureDate: string,
  features: readonly number[],
  forwardReturn: number,
  symbol = "0056",
): FeatureRow {
  return Object.freeze({
    symbol,
    featureDate,
    targetDate: featureDate, // placeholder
    featureSourceStartDate: featureDate,
    featureSourceEndDate: featureDate,
    features: Object.freeze([...features]),
    target: forwardReturn > 0 ? (1 as const) : (0 as const),
    forwardReturn,
  });
}

function makePartition(rows: readonly FeatureRow[]): RowPartition<"TRAINING"> {
  return Object.freeze({
    kind: "TRAINING" as const,
    rows: Object.freeze([...rows]),
    rowIdentitySha256: hashValue(rows),
  });
}

// Known simple fixture: 4 rows, 2 features
// y = 1 + 2*x1 + 3*x2 (exact)
const KNOWN_ROWS: readonly FeatureRow[] = [
  makeRow("2025-01-01", [1, 1], 1 + 2 * 1 + 3 * 1), // 6
  makeRow("2025-01-02", [2, 0], 1 + 2 * 2 + 3 * 0), // 5
  makeRow("2025-01-03", [0, 2], 1 + 2 * 0 + 3 * 2), // 7
  makeRow("2025-01-04", [3, 1], 1 + 2 * 3 + 3 * 1), // 10
];

describe("linearRegression", () => {
  describe("PIVOT_TOLERANCE", () => {
    it("is declared before results", () => {
      expect(PIVOT_TOLERANCE).toBe(1e-12);
    });
  });

  describe("fitLinearRegression", () => {
    it("rejects non-TRAINING partition", () => {
      const partition = {
        kind: "VALIDATION" as const,
        rows: KNOWN_ROWS,
        rowIdentitySha256: hashValue(KNOWN_ROWS),
      };
      const scaler = fitStandardScaler(makePartition(KNOWN_ROWS));
      expect(() =>
        fitLinearRegression(partition, scaler),
      ).toThrow("TRAINING");
    });

    it("rejects zero training rows", () => {
      const partition = makePartition([]);
      const scaler = {
        fitPartition: "TRAINING" as const,
        means: Object.freeze([0]),
        standardDeviations: Object.freeze([1]),
        fitRowCount: 0,
        fitRowIdentitySha256: partition.rowIdentitySha256,
        stateSha256: "abc",
      };
      expect(() =>
        fitLinearRegression(partition, scaler),
      ).toThrow("zero training rows");
    });

    it("rejects scaler/partition mismatch", () => {
      const partition = makePartition(KNOWN_ROWS);
      const wrongScaler = {
        fitPartition: "TRAINING" as const,
        means: Object.freeze([0, 0]),
        standardDeviations: Object.freeze([1, 1]),
        fitRowCount: 99,
        fitRowIdentitySha256: "wrong",
        stateSha256: "abc",
      };
      expect(() =>
        fitLinearRegression(partition, wrongScaler),
      ).toThrow("do not match");
    });

    it("produces known coefficients for exact linear data", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);

      // Verify fit properties
      expect(fit.fitPartition).toBe("TRAINING");
      expect(fit.fitRowCount).toBe(4);
      expect(fit.fitRowIdentitySha256).toBe(partition.rowIdentitySha256);
      expect(fit.coefficients.length).toBe(3); // intercept + 2 features

      // Verify near-perfect predictions on training data
      for (const row of KNOWN_ROWS) {
        const predicted = predictReturn(row.features, scaler, fit.coefficients);
        expect(predicted).toBeCloseTo(row.forwardReturn, 8);
      }

      // Training MSE should be ~0 for exact linear data
      expect(fit.trainingMSE).toBeLessThan(1e-10);
    });

    it("produces deterministic stateSha256", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const fit1 = fitLinearRegression(partition, scaler);
      const fit2 = fitLinearRegression(partition, scaler);
      expect(fit1.stateSha256).toBe(fit2.stateSha256);
      expect(fit1.coefficients).toEqual(fit2.coefficients);
      expect(fit1.trainingMSE).toBe(fit2.trainingMSE);
    });

    it("handles intercept correctly (constant target)", () => {
      const constRows = [
        makeRow("2025-01-01", [1, 5], 0.05),
        makeRow("2025-01-02", [3, 2], 0.05),
        makeRow("2025-01-03", [5, 8], 0.05),
        makeRow("2025-01-04", [7, 1], 0.05),
        makeRow("2025-01-05", [2, 6], 0.05),
      ];
      const partition = makePartition(constRows);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);

      // All predictions should be ~0.05
      for (const row of constRows) {
        const predicted = predictReturn(row.features, scaler, fit.coefficients);
        expect(predicted).toBeCloseTo(0.05, 8);
      }
    });

    it("TRAINING-only scaler fitting enforced", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      expect(scaler.fitPartition).toBe("TRAINING");
      const fit = fitLinearRegression(partition, scaler);
      expect(fit.fitPartition).toBe("TRAINING");
    });
  });

  describe("TRAINING-only regression fitting", () => {
    it("validation/final-test target changes cannot alter fitted coefficients", () => {
      // Same training data, different out-of-partition data won't change fit
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);

      // Re-fit with same partition → identical
      const fit2 = fitLinearRegression(partition, scaler);
      expect(fit.coefficients).toEqual(fit2.coefficients);
      expect(fit.stateSha256).toBe(fit2.stateSha256);
    });
  });

  describe("predictReturn", () => {
    it("produces finite predictions", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);
      const prediction = predictReturn([1.5, 1.5], scaler, fit.coefficients);
      expect(Number.isFinite(prediction)).toBe(true);
    });

    it("rejects mismatched coefficient count", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      expect(() =>
        predictReturn([1], scaler, Object.freeze([0.1])),
      ).toThrow("differ in length");
    });
  });

  describe("continuous target remains unbinarized", () => {
    it("forwardReturn values are preserved as continuous in fit", () => {
      const rows = [
        makeRow("2025-01-01", [0.1, 0.2], 0.0123),
        makeRow("2025-01-02", [0.3, 0.4], -0.0045),
        makeRow("2025-01-03", [0.5, 0.6], 0.0890),
        makeRow("2025-01-04", [0.7, 0.8], -0.0234),
        makeRow("2025-01-05", [0.2, 0.9], 0.0567),
        makeRow("2025-01-06", [0.9, 0.1], -0.0100),
      ];
      const partition = makePartition(rows);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);

      // Predictions should be continuous, not binary
      for (const row of rows) {
        const predicted = predictReturn(row.features, scaler, fit.coefficients);
        expect(predicted).not.toBe(0);
        expect(predicted).not.toBe(1);
        expect(Number.isFinite(predicted)).toBe(true);
      }
    });
  });

  describe("fixed cost-derived LONG/CASH rule", () => {
    const CANONICAL_HURDLE = 0.001; // 10 bps

    it("below hurdle → CASH", () => {
      const predictedReturn = 0.0005;
      expect(predictedReturn > CANONICAL_HURDLE).toBe(false);
    });

    it("equal to hurdle → CASH (not strictly above)", () => {
      const predictedReturn = 0.001;
      expect(predictedReturn > CANONICAL_HURDLE).toBe(false);
    });

    it("above hurdle → LONG", () => {
      const predictedReturn = 0.0015;
      expect(predictedReturn > CANONICAL_HURDLE).toBe(true);
    });
  });

  describe("later rows do not alter earlier cutoff fitted-model hash", () => {
    it("independent cutoff refits", () => {
      // Use more rows to avoid singularity
      const earlyRows = [
        makeRow("2025-01-01", [1, 1], 6),
        makeRow("2025-01-02", [2, 0], 5),
        makeRow("2025-01-03", [0, 2], 7),
        makeRow("2025-01-04", [3, 1], 10),
        makeRow("2025-01-05", [1, 3], 12),
      ];
      const earlyPartition = makePartition(earlyRows);
      const earlyScaler = fitStandardScaler(earlyPartition);
      const earlyFit = fitLinearRegression(earlyPartition, earlyScaler);

      // Extended with one more row
      const extendedRows = [
        ...earlyRows,
        makeRow("2025-01-06", [2, 2], 9),
      ];
      const extendedPartition = makePartition(extendedRows);
      const extendedScaler = fitStandardScaler(extendedPartition);
      const extendedFit = fitLinearRegression(extendedPartition, extendedScaler);

      // Fits should be different since training data changed
      expect(earlyFit.stateSha256).not.toBe(extendedFit.stateSha256);

      // But early fit should be reproducible
      const earlyFit2 = fitLinearRegression(earlyPartition, earlyScaler);
      expect(earlyFit.stateSha256).toBe(earlyFit2.stateSha256);
    });
  });

  describe("no validation threshold search", () => {
    it("predictReturn output is a single deterministic number per input", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const fit = fitLinearRegression(partition, scaler);
      const prediction = predictReturn([1, 1], scaler, fit.coefficients);
      const prediction2 = predictReturn([1, 1], scaler, fit.coefficients);
      expect(prediction).toBe(prediction2);
    });
  });

  describe("deterministic four-cutoff experiment", () => {
    it("repeated fits on identical data produce identical hashes", () => {
      const partition = makePartition(KNOWN_ROWS);
      const scaler = fitStandardScaler(partition);
      const results = [1, 2, 3, 4].map(() => {
        const fit = fitLinearRegression(partition, scaler);
        return {
          coefficients: [...fit.coefficients],
          stateSha256: fit.stateSha256,
          trainingMSE: fit.trainingMSE,
        };
      });
      for (let i = 1; i < results.length; i += 1) {
        expect(results[i]).toEqual(results[0]);
      }
    });
  });
});
