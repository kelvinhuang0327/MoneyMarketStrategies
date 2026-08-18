import { describe, expect, it } from "vitest";
import {
  buildMarketRegimeContextFeatureRows,
  computeMarketRegimeContextValues,
  MARKET_REGIME_ALIGNMENT_RULE,
  MARKET_REGIME_CONTEXT_FEATURE_FAMILY,
  MARKET_REGIME_CONTEXT_SOURCE_SERIES,
  MARKET_REGIME_CONTEXT_SOURCE_SYMBOL,
  MARKET_REGIME_FEATURE_FIELDS,
  MARKET_REGIME_MISSING_CONTEXT_RULE,
  MARKET_REGIME_TARGET_SYMBOL,
} from "./marketRegimeContextFeatureChallenger.js";
import { RESEARCH_FEATURE_NAMES } from "./features.js";
import type { MarketDataRow } from "./types.js";

function makeRow(
  symbol: string,
  date: string,
  close: number,
  volume = 1000,
  open = close,
  high = close,
  low = close,
): MarketDataRow {
  return {
    symbol,
    date,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe("marketRegimeContextFeatureChallenger", () => {
  it("freezes feature family contract and metadata correctly", () => {
    expect(MARKET_REGIME_CONTEXT_FEATURE_FAMILY.featureFamilyName).toBe(
      "0050_ADJUSTED_MARKET_REGIME_CONTEXT_V1",
    );
    expect(MARKET_REGIME_CONTEXT_FEATURE_FAMILY.newFeatureFields).toEqual([
      "market_return_20d",
      "market_volatility_10d",
    ]);
    expect(MARKET_REGIME_CONTEXT_FEATURE_FAMILY.currentIncumbentFeatureFields).toEqual([
      ...RESEARCH_FEATURE_NAMES,
    ]);
    expect(MARKET_REGIME_FEATURE_FIELDS).toEqual([
      "market_return_20d",
      "market_volatility_10d",
    ]);
    expect(MARKET_REGIME_CONTEXT_SOURCE_SYMBOL).toBe("0050");
    expect(MARKET_REGIME_CONTEXT_SOURCE_SERIES).toBe("SOURCE_QUALIFIED_ADJUSTED");
    expect(MARKET_REGIME_TARGET_SYMBOL).toBe("0056");
    expect(MARKET_REGIME_ALIGNMENT_RULE).toBe(
      "point_in_time_as_of_latest_source_date_on_or_before_target_feature_date",
    );
    expect(MARKET_REGIME_MISSING_CONTEXT_RULE).toBe(
      "require_at_least_21_trailing_source_observations_else_exclude_from_both_control_and_challenger",
    );
  });

  it("calculates market_return_20d and market_volatility_10d accurately against a known arithmetic fixture", () => {
    // Construct 25 daily rows of 0050 where close prices are known
    // Let days 1..21 have close = 100, 101, ..., 120 (constant +1 return each day)
    const sourceRows: MarketDataRow[] = [];
    const closes = [
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
      110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
      120,
    ];
    for (let i = 0; i < closes.length; i += 1) {
      const dayStr = String(i + 1).padStart(2, "0");
      sourceRows.push(makeRow("0050", `2024-01-${dayStr}`, closes[i]!));
    }

    const featureDate = "2024-01-21";
    const context = computeMarketRegimeContextValues(sourceRows, featureDate);

    // 20d return: close[20] / close[0] - 1 = 120 / 100 - 1 = 0.20
    expect(context.market_return_20d).toBeCloseTo(0.20, 8);
    expect(context.asOf0050Date).toBe("2024-01-21");
    expect(context.trailing0050RowCount).toBe(21);

    // 10 daily returns: offset 11..20 vs previous 10..19:
    // returns = [111/110-1, 112/111-1, ..., 120/119-1]
    const returns10: number[] = [];
    for (let offset = 11; offset <= 20; offset += 1) {
      returns10.push(closes[offset]! / closes[offset - 1]! - 1);
    }
    const meanRet = returns10.reduce((s, v) => s + v, 0) / 10;
    const variance = returns10.reduce((s, v) => s + (v - meanRet) ** 2, 0) / 10;
    const expectedVol = Math.sqrt(variance);

    expect(context.market_volatility_10d).toBeCloseTo(expectedVol, 8);
  });

  it("never consumes source observations after target featureDate (Point-in-Time guard)", () => {
    const sourceRows: MarketDataRow[] = [];
    for (let i = 1; i <= 25; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      // Prices jump wildly on days 22-25
      const close = i <= 21 ? 100 + i : 500 + i * 10;
      sourceRows.push(makeRow("0050", `2024-01-${dayStr}`, close));
    }

    const contextAt21 = computeMarketRegimeContextValues(sourceRows, "2024-01-21");
    expect(contextAt21.asOf0050Date).toBe("2024-01-21");
    expect(contextAt21.market_return_20d).toBeCloseTo(121 / 101 - 1, 8);

    // Verify that filtering rows before calling gives the exact same result
    const sourceRowsTruncated = sourceRows.slice(0, 21);
    const contextTruncated = computeMarketRegimeContextValues(sourceRowsTruncated, "2024-01-21");
    expect(contextAt21).toEqual(contextTruncated);
  });

  it("ensures appending future 0050 rows cannot alter earlier context", () => {
    const baseSource: MarketDataRow[] = [];
    for (let i = 1; i <= 22; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      baseSource.push(makeRow("0050", `2024-01-${dayStr}`, 100 + i));
    }

    const contextBeforeAppend = computeMarketRegimeContextValues(baseSource, "2024-01-22");

    const extendedSource = [
      ...baseSource,
      makeRow("0050", "2024-01-23", 999),
      makeRow("0050", "2024-01-24", 1),
    ];

    const contextAfterAppend = computeMarketRegimeContextValues(extendedSource, "2024-01-22");
    expect(contextBeforeAppend).toEqual(contextAfterAppend);
  });

  it("fails closed if source rows contain wrong symbol", () => {
    const wrongSymbolRows: MarketDataRow[] = [];
    for (let i = 1; i <= 25; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      wrongSymbolRows.push(makeRow("2330", `2024-01-${dayStr}`, 500));
    }
    const targetRows: MarketDataRow[] = [];
    for (let i = 1; i <= 30; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      targetRows.push(makeRow("0056", `2024-01-${dayStr}`, 30));
    }

    expect(() =>
      buildMarketRegimeContextFeatureRows({
        targetRows,
        source0050AdjustedRows: wrongSymbolRows,
      }),
    ).toThrow("source rows for market regime context must have symbol 0050");
  });

  it("correctly excludes rows lacking sufficient trailing history and reports deterministic missing context", () => {
    // 0050 has only 15 rows, 0056 has 30 rows
    const short0050: MarketDataRow[] = [];
    for (let i = 1; i <= 15; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      short0050.push(makeRow("0050", `2024-01-${dayStr}`, 100 + i));
    }

    const target0056: MarketDataRow[] = [];
    for (let i = 1; i <= 30; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      target0056.push(makeRow("0056", `2024-01-${dayStr}`, 30 + (i % 3)));
    }

    expect(() =>
      buildMarketRegimeContextFeatureRows({
        targetRows: target0056,
        source0050AdjustedRows: short0050,
      }),
    ).toThrow("no eligible feature rows produced after market context alignment");
  });

  it("builds 7-feature vectors matching control rows on identical eligible populations", () => {
    const source0050: MarketDataRow[] = [];
    const target0056: MarketDataRow[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const dayStr = String(i).padStart(2, "0");
      source0050.push(makeRow("0050", `2024-01-${dayStr}`, 100 + i));
      target0056.push(makeRow("0056", `2024-01-${dayStr}`, 30 + (i % 5)));
    }

    const result = buildMarketRegimeContextFeatureRows({
      targetRows: target0056,
      source0050AdjustedRows: source0050,
    });

    expect(result.featureRows.length).toBe(result.controlFeatureRows.length);
    expect(result.missingContextRows).toBe(0);
    expect(result.eligibleRowsRemovedForMarketContext).toBe(0);

    for (let i = 0; i < result.featureRows.length; i += 1) {
      const challengerRow = result.featureRows[i]!;
      const controlRow = result.controlFeatureRows[i]!;

      expect(challengerRow.featureDate).toBe(controlRow.featureDate);
      expect(challengerRow.targetDate).toBe(controlRow.targetDate);
      expect(challengerRow.forwardReturn).toBe(controlRow.forwardReturn);
      expect(challengerRow.target).toBe(controlRow.target);

      // Challenger features must be 7 elements (5 incumbent + 2 market context)
      expect(challengerRow.features.length).toBe(7);
      expect(controlRow.features.length).toBe(5);
      expect(challengerRow.features.slice(0, 5)).toEqual(controlRow.features);
    }
  });
});
