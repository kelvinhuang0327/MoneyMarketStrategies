import { describe, expect, it } from "vitest";

import {
  buildMiMargnMarginShortFeatureRows,
  computeMiMargnMarginShortFeatureValues,
  TWSE_MI_MARGN_FEATURE_CHANGE_OBSERVATIONS,
  TWSE_MI_MARGN_FEATURE_FIELDS,
  TWSE_MI_MARGN_FEATURE_FAMILY,
  TWSE_MI_MARGN_FEATURE_FAMILY_NAME,
  TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS,
  TWSE_MI_MARGN_FEATURE_STRICT_PIT_RULE,
  TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL,
} from "./twseMiMargnMarginShortFeatureChallenger.js";
import {
  TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
  type TwseMiMargnBalanceRecord,
} from "./twseMiMargnMarginShortBalances.js";
import type { MarketDataRow } from "./types.js";

function isoDate(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
}

function makeMiMargnRecord(
  index: number,
  marginPurchaseBalance: number,
  shortSaleBalance: number,
): TwseMiMargnBalanceRecord {
  return Object.freeze({
    tradeDate: isoDate(index),
    symbol: "0056",
    securityName: "元大高股息",
    marginPurchaseBalance,
    shortSaleBalance,
    marginPurchasePreviousDayBalance: Math.max(0, marginPurchaseBalance - 1),
    shortSalePreviousDayBalance: Math.max(0, shortSaleBalance - 1),
    sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
    sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
  });
}

function makeMarketRows(count: number): readonly MarketDataRow[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return Object.freeze({
      symbol: "0056",
      date: isoDate(index),
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 1_000 + index,
      source: "test-owned/in-memory",
    });
  }));
}

function makeHistory(count: number): readonly TwseMiMargnBalanceRecord[] {
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    makeMiMargnRecord(index, 100 + index, 200 - index)));
}

describe("0056 TWSE MI_MARGN margin/short feature challenger", () => {
  it("defines exactly the three requested features and strict PIT contract", () => {
    expect(TWSE_MI_MARGN_FEATURE_FAMILY_NAME).toBe("0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCES_V1");
    expect(TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL).toBe("0056");
    expect(TWSE_MI_MARGN_FEATURE_STRICT_PIT_RULE).toBe("tradeDate < featureDate");
    expect(TWSE_MI_MARGN_FEATURE_CHANGE_OBSERVATIONS).toBe(5);
    expect(TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS).toBe(20);
    expect(TWSE_MI_MARGN_FEATURE_FIELDS).toEqual([
      "margin_balance_change_5d",
      "short_balance_change_5d",
      "short_to_margin_balance_ratio_20d",
    ]);
    expect(TWSE_MI_MARGN_FEATURE_FAMILY.newFeatureFields).toEqual(TWSE_MI_MARGN_FEATURE_FIELDS);
    expect(TWSE_MI_MARGN_FEATURE_FAMILY.currentIncumbentFeatureFields).toEqual([
      "return_5d",
      "return_20d",
      "volatility_10d",
      "volume_ratio_20d",
      "drawdown_20d",
    ]);
  });

  it("uses exact five-observation changes and twenty-observation ratio math", () => {
    const records = makeHistory(25);
    const values = computeMiMargnMarginShortFeatureValues(records, isoDate(25));
    const marginStart = 100 + 19;
    const marginLatest = 100 + 24;
    const shortStart = 200 - 19;
    const shortLatest = 200 - 24;
    const marginTotal = records.slice(5).reduce((sum, record) => sum + record.marginPurchaseBalance, 0);
    const shortTotal = records.slice(5).reduce((sum, record) => sum + record.shortSaleBalance, 0);

    expect(values.margin_balance_change_5d).toBeCloseTo((marginLatest - marginStart) / marginStart, 12);
    expect(values.short_balance_change_5d).toBeCloseTo((shortLatest - shortStart) / shortStart, 12);
    expect(values.short_to_margin_balance_ratio_20d).toBeCloseTo(shortTotal / marginTotal, 12);
    expect(values.asOfMiMargnTradeDate).toBe(isoDate(24));
    expect(values.trailingMiMargnRowCount).toBe(25);
  });

  it("excludes same-day and future observations while accepting prior observations", () => {
    const records = [
      ...makeHistory(20),
      makeMiMargnRecord(20, 999_999_999, 999_999_999),
      makeMiMargnRecord(21, 888_888_888, 888_888_888),
    ];
    const baseline = computeMiMargnMarginShortFeatureValues(records.slice(0, 20), isoDate(20));
    const withSameDayAndFuture = computeMiMargnMarginShortFeatureValues(records, isoDate(20));

    expect(withSameDayAndFuture).toEqual(baseline);
    expect(withSameDayAndFuture.asOfMiMargnTradeDate).toBe(isoDate(19));
  });

  it("fails closed when fewer than twenty eligible observations exist", () => {
    expect(() => computeMiMargnMarginShortFeatureValues(makeHistory(19), isoDate(19))).toThrow(
      "insufficient eligible MI_MARGN observations",
    );
  });

  it("protects zero denominators with one and remains deterministic", () => {
    const zeroMarginRecords = Object.freeze(Array.from({ length: 20 }, (_, index) =>
      makeMiMargnRecord(index, 0, 5)));
    const first = computeMiMargnMarginShortFeatureValues(zeroMarginRecords, isoDate(20));
    const second = computeMiMargnMarginShortFeatureValues(zeroMarginRecords, isoDate(20));

    expect(first.short_to_margin_balance_ratio_20d).toBe(100);
    expect(first.margin_balance_change_5d).toBe(0);
    expect(first.short_balance_change_5d).toBe(0);
    expect(second).toEqual(first);
  });

  it("builds identical control and challenger populations and does not mutate inputs", () => {
    const targetRows = makeMarketRows(40);
    const miMargnRecords = makeHistory(30);
    const targetBefore = JSON.stringify(targetRows);
    const miBefore = JSON.stringify(miMargnRecords);

    const result = buildMiMargnMarginShortFeatureRows({ targetRows, miMargnRecords });

    expect(result.featureRows.length).toBe(result.controlFeatureRows.length);
    expect(result.featureRows.length).toBeGreaterThan(0);
    expect(result.controlFeatureRows[0]!.features).toHaveLength(5);
    expect(result.featureRows[0]!.features).toHaveLength(8);
    expect(result.featureRows.map((row) => row.featureDate)).toEqual(
      result.controlFeatureRows.map((row) => row.featureDate),
    );
    expect(result.featureRows[0]!.features.slice(0, 5)).toEqual(result.controlFeatureRows[0]!.features);
    expect(result.eligibleRowsRemovedForMiMargnContext).toBe(0);
    expect(result.missingContextRows).toBe(0);
    expect(JSON.stringify(targetRows)).toBe(targetBefore);
    expect(JSON.stringify(miMargnRecords)).toBe(miBefore);
  });
});
