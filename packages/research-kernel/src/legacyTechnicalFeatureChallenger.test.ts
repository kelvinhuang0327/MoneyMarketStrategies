import { describe, expect, it } from "vitest";

import {
  buildLegacyBreakout20dHighValue,
  buildLegacyBreakoutFeatureRows,
  LEGACY_TECHNICAL_FEATURE_FAMILY,
  type MarketDataRow,
} from "./index.js";

function fixtureRows(count = 48): MarketDataRow[] {
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.1;
    return {
      symbol: "0056",
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.2,
      high: close + (index === 20 ? 3 : 0.5),
      low: close - 0.5,
      close,
      volume: 1_000 + index,
      source: "test-owned/in-memory",
    };
  });
}

describe("legacy breakout technical feature challenger", () => {
  it("freezes one additive field family and preserves the live incumbent fields", () => {
    expect(LEGACY_TECHNICAL_FEATURE_FAMILY.newFeatureFields).toEqual(["breakout_20d_high"]);
    expect(LEGACY_TECHNICAL_FEATURE_FAMILY.currentIncumbentFeatureFields).toEqual([
      "return_5d",
      "return_20d",
      "volatility_10d",
      "volume_ratio_20d",
      "drawdown_20d",
    ]);
    expect(LEGACY_TECHNICAL_FEATURE_FAMILY.currentIncumbentFeatureFields)
      .not.toContain("intraday_range_pct");

    const rows = buildLegacyBreakoutFeatureRows(fixtureRows());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.features.length > 0)).toBe(true);
    expect(rows.every((row) => row.features.length === 6)).toBe(true);
    expect(rows.every((row) => row.featureSourceEndDate === row.featureDate)).toBe(true);
  });

  it("uses only the current close and prior highs, never a future row", () => {
    const rows = fixtureRows();
    const beforeFutureMutation = buildLegacyBreakout20dHighValue(rows, 20);
    const futureMutated = rows.map((row, index) => index === 21 ? { ...row, high: 1_000_000 } : row);
    const afterFutureMutation = buildLegacyBreakout20dHighValue(futureMutated, 20);
    expect(afterFutureMutation).toBe(beforeFutureMutation);

    const currentBreakout = rows.map((row, index) => index === 20 ? { ...row, close: 110 } : row);
    expect(buildLegacyBreakout20dHighValue(currentBreakout, 20)).toBe(1);
  });
});
