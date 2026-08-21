import { describe, expect, it } from "vitest";

import {
  buildMiQfiisForeignOwnershipFeatureRows,
  computeMiQfiisForeignOwnershipFeatureValues,
  TWSE_MI_QFIIS_FEATURE_CHANGE_5D_OBSERVATIONS,
  TWSE_MI_QFIIS_FEATURE_CHANGE_20D_OBSERVATIONS,
  TWSE_MI_QFIIS_FEATURE_FIELDS,
  TWSE_MI_QFIIS_FEATURE_FAMILY,
  TWSE_MI_QFIIS_FEATURE_FAMILY_NAME,
  TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS,
  TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE,
  TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL,
} from "./twseMiQfiisForeignOwnershipFeatureChallenger.js";
import {
  TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
  type TwseMiQfiisRecord,
} from "./twseMiQfiisForeignOwnership.js";
import type { MarketDataRow } from "./types.js";

function isoDate(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
}

function makeMiQfiisRecord(
  index: number,
  foreignHoldingRatio: number,
  foreignHeldShares = 10_000_000,
  issuedShares = 1_000_000_000,
): TwseMiQfiisRecord {
  return Object.freeze({
    tradeDate: isoDate(index),
    symbol: "0056",
    securityName: "元大高股息",
    issuedShares,
    foreignHeldShares,
    foreignHoldingRatio,
    foreignRemainingInvestableShares: issuedShares - foreignHeldShares,
    foreignRemainingInvestableRatio: 100 - foreignHoldingRatio,
    statutoryInvestmentLimitRatio: 100,
    sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
    sourceRetrievedAt: "2026-08-20T13:54:35.121Z",
  });
}

function makeMarketRows(count: number, startIndex = 0): readonly MarketDataRow[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return Object.freeze({
      symbol: "0056",
      date: isoDate(startIndex + index),
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 1_000 + index,
      source: "test-owned/in-memory",
    });
  }));
}

function makeHistory(count: number, baseRatio = 10.0, step = 0.05): readonly TwseMiQfiisRecord[] {
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    makeMiQfiisRecord(index, Number((baseRatio + index * step).toFixed(4)))));
}

describe("0056 TWSE MI_QFIIS foreign ownership feature challenger", () => {
  it("1. defines exactly the three requested features and strict PIT contract", () => {
    expect(TWSE_MI_QFIIS_FEATURE_FAMILY_NAME).toBe("0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_V1");
    expect(TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL).toBe("0056");
    expect(TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE).toBe("tradeDate < featureDate");
    expect(TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS).toBe(21);
    expect(TWSE_MI_QFIIS_FEATURE_CHANGE_5D_OBSERVATIONS).toBe(6);
    expect(TWSE_MI_QFIIS_FEATURE_CHANGE_20D_OBSERVATIONS).toBe(21);
    expect(TWSE_MI_QFIIS_FEATURE_FIELDS).toEqual([
      "foreign_holding_ratio_lag1",
      "foreign_holding_ratio_change_5d",
      "foreign_holding_ratio_change_20d",
    ]);
    expect(TWSE_MI_QFIIS_FEATURE_FAMILY.newFeatureFields).toEqual(TWSE_MI_QFIIS_FEATURE_FIELDS);
    expect(TWSE_MI_QFIIS_FEATURE_FAMILY.currentIncumbentFeatureFields).toEqual([
      "return_5d",
      "return_20d",
      "volatility_10d",
      "volume_ratio_20d",
      "drawdown_20d",
    ]);
  });

  it("2. computes latest eligible lag-1 level correctly", () => {
    const records = makeHistory(25, 5.0, 0.1);
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));
    // Index 24 is the latest eligible tradeDate strictly < isoDate(25)
    const expectedLag1 = records[24]!.foreignHoldingRatio;
    expect(values.foreign_holding_ratio_lag1).toBe(expectedLag1);
    expect(values.asOfMiQfiisTradeDate).toBe(isoDate(24));
  });

  it("3. strictly excludes same-day observations (same-day exclusion)", () => {
    const records = [
      ...makeHistory(21, 5.0, 0.1),
      makeMiQfiisRecord(21, 99.99), // same-day observation as featureDate isoDate(21)
    ];
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(21));
    expect(values.foreign_holding_ratio_lag1).toBe(records[20]!.foreignHoldingRatio);
    expect(values.asOfMiQfiisTradeDate).toBe(isoDate(20));
    expect(values.trailingMiQfiisRowCount).toBe(21);
  });

  it("4. strictly excludes future-date observations (future-date exclusion)", () => {
    const records = [
      ...makeHistory(21, 5.0, 0.1),
      makeMiQfiisRecord(21, 88.88), // same-day
      makeMiQfiisRecord(22, 99.99), // future-day
    ];
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(21));
    expect(values.foreign_holding_ratio_lag1).toBe(records[20]!.foreignHoldingRatio);
    expect(values.asOfMiQfiisTradeDate).toBe(isoDate(20));
    expect(values.trailingMiQfiisRowCount).toBe(21);
  });

  it("5. confirms prior-date eligibility (prior-date eligibility)", () => {
    const records = makeHistory(30, 2.0, 0.05);
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));
    expect(values.trailingMiQfiisRowCount).toBe(25);
    expect(values.asOfMiQfiisTradeDate).toBe(isoDate(24));
  });

  it("6. computes exact 5-observation delta math without interpolation", () => {
    const records = makeHistory(25, 10.0, 0.25);
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));
    // eligible records are indices 0 to 24 (25 total).
    // latest 6 records are indices 19, 20, 21, 22, 23, 24.
    // latest is index 24, 5 observations earlier is index 19.
    const latestRatio = records[24]!.foreignHoldingRatio;
    const obs5EarlierRatio = records[19]!.foreignHoldingRatio;
    const expectedChange5d = latestRatio - obs5EarlierRatio;

    expect(values.foreign_holding_ratio_change_5d).toBeCloseTo(expectedChange5d, 10);
  });

  it("7. computes exact 20-observation delta math without interpolation", () => {
    const records = makeHistory(25, 10.0, 0.25);
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));
    // eligible records are indices 0 to 24 (25 total).
    // latest 21 records are indices 4 to 24.
    // latest is index 24, 20 observations earlier is index 4.
    const latestRatio = records[24]!.foreignHoldingRatio;
    const obs20EarlierRatio = records[4]!.foreignHoldingRatio;
    const expectedChange20d = latestRatio - obs20EarlierRatio;

    expect(values.foreign_holding_ratio_change_20d).toBeCloseTo(expectedChange20d, 10);
  });

  it("8. preserves percentage-point semantics retained without dividing by 100", () => {
    const records = [
      ...makeHistory(20, 1.0, 0.1),
      makeMiQfiisRecord(20, 0.38), // 0.38 percentage points
    ];
    const values = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(21));
    expect(values.foreign_holding_ratio_lag1).toBe(0.38);
    expect(values.foreign_holding_ratio_lag1).not.toBe(0.0038);
  });

  it("9. fails closed when fewer than 21 eligible observations exist (insufficient-history behavior)", () => {
    expect(() => computeMiQfiisForeignOwnershipFeatureValues(makeHistory(20), isoDate(20))).toThrow(
      "insufficient eligible MI_QFIIS observations",
    );
  });

  it("10. is strictly deterministic and preserves input immutability", () => {
    const records = makeHistory(25, 8.0, 0.1);
    const beforeRecordsJson = JSON.stringify(records);

    const first = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));
    const second = computeMiQfiisForeignOwnershipFeatureValues(records, isoDate(25));

    expect(second).toEqual(first);
    expect(JSON.stringify(records)).toBe(beforeRecordsJson);
  });

  it("11. builds identical control and challenger populations (population equivalence)", () => {
    // Provide 50 MI_QFIIS records starting at index 0, target rows from index 1 (50 rows)
    // For target row 20 (date isoDate(21)), there are 21 prior MI_QFIIS records (isoDate(0)..isoDate(20))
    const targetRows = makeMarketRows(50, 1);
    const miQfiisRecords = makeHistory(55, 10.0, 0.05);
    const targetBefore = JSON.stringify(targetRows);
    const miBefore = JSON.stringify(miQfiisRecords);

    const result = buildMiQfiisForeignOwnershipFeatureRows({ targetRows, miQfiisRecords });

    expect(result.featureRows.length).toBe(result.controlFeatureRows.length);
    expect(result.featureRows.length).toBeGreaterThan(0);
    expect(result.controlFeatureRows[0]!.features).toHaveLength(5);
    expect(result.featureRows[0]!.features).toHaveLength(8);
    expect(result.featureRows.map((row) => row.featureDate)).toEqual(
      result.controlFeatureRows.map((row) => row.featureDate),
    );
    expect(result.featureRows[0]!.features.slice(0, 5)).toEqual(result.controlFeatureRows[0]!.features);
    expect(result.eligibleRowsRemovedForMiQfiisContext).toBe(0);
    expect(result.missingContextRows).toBe(0);
    expect(JSON.stringify(targetRows)).toBe(targetBefore);
    expect(JSON.stringify(miQfiisRecords)).toBe(miBefore);
  });
});
