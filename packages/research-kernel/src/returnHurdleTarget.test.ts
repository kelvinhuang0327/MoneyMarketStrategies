import { describe, expect, it } from "vitest";

import {
  buildReturnHurdleFeatureRows,
  CANONICAL_ROUND_TRIP_COST_FRACTION,
  CANONICAL_TRANSACTION_COST_BPS,
  deriveRoundTripCostFraction,
  TARGET_CHALLENGER_RULE,
  TARGET_CONTROL_RULE,
} from "./returnHurdleTarget.js";
import type { FeatureRow } from "./types.js";

function makeFeatureRow(
  forwardReturn: number,
  featureDate = "2025-01-02",
  targetDate = "2025-01-09",
): FeatureRow {
  return Object.freeze({
    symbol: "0056",
    featureDate,
    targetDate,
    featureSourceStartDate: "2024-12-01",
    featureSourceEndDate: featureDate,
    features: Object.freeze([0.01, 0.02, 0.015, 1.1, -0.03]),
    target: forwardReturn > 0 ? 1 : 0,
    forwardReturn,
  });
}

describe("return-hurdle target derivation and labeling", () => {
  it("freezes the canonical cost hurdle constants", () => {
    expect(CANONICAL_TRANSACTION_COST_BPS).toBe(10);
    expect(CANONICAL_ROUND_TRIP_COST_FRACTION).toBe(0.001);
    expect(TARGET_CONTROL_RULE).toBe("forwardReturn > 0");
    expect(TARGET_CHALLENGER_RULE).toBe("forwardReturn > canonicalRoundTripCostFraction");
    expect(deriveRoundTripCostFraction(10)).toBe(0.001);
    expect(deriveRoundTripCostFraction(CANONICAL_TRANSACTION_COST_BPS)).toBe(CANONICAL_ROUND_TRIP_COST_FRACTION);
  });

  it("validates roundTripCostBps inputs", () => {
    expect(() => deriveRoundTripCostFraction(-1)).toThrow(/must be a finite number in \[0, 10000\]/);
    expect(() => deriveRoundTripCostFraction(10001)).toThrow(/must be a finite number in \[0, 10000\]/);
    expect(() => deriveRoundTripCostFraction(Number.NaN)).toThrow(/must be a finite number in \[0, 10000\]/);
  });

  it("control target strictly classifies forwardReturn > 0", () => {
    const rows = [
      makeFeatureRow(-0.005),
      makeFeatureRow(0),
      makeFeatureRow(0.0005),
      makeFeatureRow(0.001),
      makeFeatureRow(0.02),
    ];
    expect(rows[0]?.target).toBe(0);
    expect(rows[1]?.target).toBe(0);
    expect(rows[2]?.target).toBe(1);
    expect(rows[3]?.target).toBe(1);
    expect(rows[4]?.target).toBe(1);
  });

  it("challenger target uses the frozen canonical cost hurdle (0.001)", () => {
    const rows = [
      makeFeatureRow(-0.005),
      makeFeatureRow(0),
      makeFeatureRow(0.0009),
      makeFeatureRow(0.0010),
      makeFeatureRow(0.00100001),
      makeFeatureRow(0.0011),
      makeFeatureRow(0.02),
    ];
    const hurdleRows = buildReturnHurdleFeatureRows(rows, CANONICAL_ROUND_TRIP_COST_FRACTION);

    // returns below or equal to hurdle (0.001) are 0
    expect(hurdleRows[0]?.target).toBe(0); // -0.005 <= 0.001
    expect(hurdleRows[1]?.target).toBe(0); // 0 <= 0.001
    expect(hurdleRows[2]?.target).toBe(0); // 0.0009 <= 0.001
    expect(hurdleRows[3]?.target).toBe(0); // 0.0010 == 0.001 (not strictly greater)

    // returns strictly above hurdle (0.001) are 1
    expect(hurdleRows[4]?.target).toBe(1); // 0.00100001 > 0.001
    expect(hurdleRows[5]?.target).toBe(1); // 0.0011 > 0.001
    expect(hurdleRows[6]?.target).toBe(1); // 0.02 > 0.001
  });

  it("preserves exact features, dates, symbol, and forwardReturn values", () => {
    const original = [
      makeFeatureRow(0.0005, "2025-01-02", "2025-01-09"),
      makeFeatureRow(0.0050, "2025-01-03", "2025-01-10"),
    ];
    const hurdleRows = buildReturnHurdleFeatureRows(original, 0.001);

    expect(hurdleRows.length).toBe(original.length);
    hurdleRows.forEach((row, index) => {
      const src = original[index]!;
      expect(row.symbol).toBe(src.symbol);
      expect(row.featureDate).toBe(src.featureDate);
      expect(row.targetDate).toBe(src.targetDate);
      expect(row.featureSourceStartDate).toBe(src.featureSourceStartDate);
      expect(row.featureSourceEndDate).toBe(src.featureSourceEndDate);
      expect(row.features).toEqual(src.features);
      expect(row.forwardReturn).toBe(src.forwardReturn);
    });

    // Label difference on the borderline row:
    expect(original[0]?.target).toBe(1); // 0.0005 > 0
    expect(hurdleRows[0]?.target).toBe(0); // 0.0005 <= 0.001
    expect(original[1]?.target).toBe(1); // 0.0050 > 0
    expect(hurdleRows[1]?.target).toBe(1); // 0.0050 > 0.001
  });
});
