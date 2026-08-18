import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildT86InstitutionalFlowFeatureRows,
  computeT86InstitutionalFlowValues,
  TWSE_T86_FEATURE_FAMILY,
  TWSE_T86_FEATURE_FIELDS,
  TWSE_T86_FEATURE_FAMILY_NAME,
  TWSE_T86_FEATURE_LOOKBACK_DAYS,
  TWSE_T86_FEATURE_SURGE_DAYS,
  TWSE_T86_FEATURE_TARGET_SYMBOL,
} from "./twseT86InstitutionalFlowFeatureChallenger.js";
import { parseTwseT86CsvText, type TwseT86FlowRecord } from "./twseT86InstitutionalFlows.js";
import { parseTwStrategyResearchCsvText, toMarketRows } from "./twStrategyResearchRunner.js";
import type { MarketDataRow } from "./types.js";

function makeMarketRow(date: string, close: number, volume: number): MarketDataRow {
  return {
    symbol: "0056",
    date,
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume,
    source: "test-fixture",
  };
}

function makeT86Record(
  tradeDate: string,
  foreignNetShares: number,
  investmentTrustNetShares: number,
  dealerSelfNetShares: number = 0,
  dealerHedgeNetShares: number = 0,
): TwseT86FlowRecord {
  const institutionalTotalNetShares =
    foreignNetShares + investmentTrustNetShares + dealerSelfNetShares + dealerHedgeNetShares;
  return {
    symbol: "0056",
    tradeDate,
    foreignBuyShares: Math.max(0, foreignNetShares),
    foreignSellShares: Math.max(0, -foreignNetShares),
    foreignNetShares,
    investmentTrustBuyShares: Math.max(0, investmentTrustNetShares),
    investmentTrustSellShares: Math.max(0, -investmentTrustNetShares),
    investmentTrustNetShares,
    dealerSelfBuyShares: Math.max(0, dealerSelfNetShares),
    dealerSelfSellShares: Math.max(0, -dealerSelfNetShares),
    dealerSelfNetShares,
    dealerHedgeBuyShares: Math.max(0, dealerHedgeNetShares),
    dealerHedgeSellShares: Math.max(0, -dealerHedgeNetShares),
    dealerHedgeNetShares,
    institutionalTotalNetShares,
    sourceIdentity: "TWSE_T86_DAILY_INSTITUTIONAL_REPORT",
    sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
  };
}

function generateAlignedHistory(days: number = 30): {
  readonly marketRows: readonly MarketDataRow[];
  readonly t86Records: readonly TwseT86FlowRecord[];
  readonly dates: readonly string[];
} {
  const marketRows: MarketDataRow[] = [];
  const t86Records: TwseT86FlowRecord[] = [];
  const dates: string[] = [];

  const startUtc = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(startUtc + i * 86_400_000).toISOString().slice(0, 10);
    dates.push(d);
    const close = 30 + (i % 5) * 0.5 + i * 0.05;
    const volume = 10_000 + i * 500;
    const foreignNet = (i % 2 === 0 ? 1 : -1) * (1000 + i * 50);
    const itNet = 500 + i * 20;
    const dealerNet = (i % 3 === 0 ? 200 : -100);

    marketRows.push(makeMarketRow(d, close, volume));
    t86Records.push(makeT86Record(d, foreignNet, itNet, dealerNet, 0));
  }

  return {
    marketRows: Object.freeze(marketRows),
    t86Records: Object.freeze(t86Records),
    dates: Object.freeze(dates),
  };
}

describe("twseT86InstitutionalFlowFeatureChallenger", () => {
  it("defines the frozen feature family and fields correctly", () => {
    expect(TWSE_T86_FEATURE_FAMILY_NAME).toBe("0056_TWSE_T86_INSTITUTIONAL_FLOWS_V1");
    expect(TWSE_T86_FEATURE_TARGET_SYMBOL).toBe("0056");
    expect(TWSE_T86_FEATURE_LOOKBACK_DAYS).toBe(20);
    expect(TWSE_T86_FEATURE_SURGE_DAYS).toBe(5);
    expect(TWSE_T86_FEATURE_FIELDS).toEqual([
      "foreign_flow_ratio_20d",
      "trust_flow_ratio_20d",
      "institutional_net_surge_5d",
    ]);
    expect(TWSE_T86_FEATURE_FAMILY.newFeatureFields).toEqual(TWSE_T86_FEATURE_FIELDS);
    expect(TWSE_T86_FEATURE_FAMILY.lookbackRowsRequired).toBe(20);
  });

  it("computes deterministic 20d and 5d window math matching manual calculations", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(30);

    // Evaluate on date index 21 (dates[21] = '2024-01-22')
    const featureDate = dates[21]!;

    // Prior 20 dates are dates[1] through dates[20]
    const sliceMarket20 = marketRows.slice(1, 21);
    const sliceT86_20 = t86Records.slice(1, 21);

    // Prior 5 dates are dates[16] through dates[20]
    const sliceMarket5 = marketRows.slice(16, 21);
    const sliceT86_5 = t86Records.slice(16, 21);

    const expectedVol20 = sliceMarket20.reduce((s, r) => s + r.volume, 0);
    const expectedVol5 = sliceMarket5.reduce((s, r) => s + r.volume, 0);

    const expectedForeign20 = sliceT86_20.reduce((s, r) => s + r.foreignNetShares, 0);
    const expectedTrust20 = sliceT86_20.reduce((s, r) => s + r.investmentTrustNetShares, 0);
    const expectedTotal20 = sliceT86_20.reduce((s, r) => s + r.institutionalTotalNetShares, 0);
    const expectedTotal5 = sliceT86_5.reduce((s, r) => s + r.institutionalTotalNetShares, 0);

    const expectedForeignRatio20 = expectedForeign20 / expectedVol20;
    const expectedTrustRatio20 = expectedTrust20 / expectedVol20;
    const expectedSurge5 = (expectedTotal5 / expectedVol5) - (expectedTotal20 / expectedVol20);

    const values = computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate);

    expect(values.foreign_flow_ratio_20d).toBeCloseTo(expectedForeignRatio20, 10);
    expect(values.trust_flow_ratio_20d).toBeCloseTo(expectedTrustRatio20, 10);
    expect(values.institutional_net_surge_5d).toBeCloseTo(expectedSurge5, 10);
    expect(values.asOfT86TradeDate).toBe(dates[20]);
    expect(values.trailingT86RowCount).toBe(21);
  });

  it("strictly excludes same-day T86 observations (tradeDate === featureDate)", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(30);
    const featureDate = dates[21]!;

    const baseline = computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate);

    // Mutate the same-day T86 record (at index 21) with an extreme outlier
    const contaminatedT86 = t86Records.map((r, i) =>
      i === 21 ? makeT86Record(dates[21]!, 999_999_999, 999_999_999) : r,
    );

    const afterSameDayAnomalies = computeT86InstitutionalFlowValues(marketRows, contaminatedT86, featureDate);

    expect(afterSameDayAnomalies.foreign_flow_ratio_20d).toBe(baseline.foreign_flow_ratio_20d);
    expect(afterSameDayAnomalies.trust_flow_ratio_20d).toBe(baseline.trust_flow_ratio_20d);
    expect(afterSameDayAnomalies.institutional_net_surge_5d).toBe(baseline.institutional_net_surge_5d);
    expect(afterSameDayAnomalies.asOfT86TradeDate).toBe(dates[20]);
  });

  it("strictly excludes future T86 observations (tradeDate > featureDate)", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(30);
    const featureDate = dates[21]!;

    const baseline = computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate);

    // Mutate future T86 records (indices 22..29) with extreme values
    const contaminatedT86 = t86Records.map((r, i) =>
      i > 21 ? makeT86Record(r.tradeDate, -999_999_999, -999_999_999) : r,
    );

    const withFutureMutations = computeT86InstitutionalFlowValues(marketRows, contaminatedT86, featureDate);

    expect(withFutureMutations.foreign_flow_ratio_20d).toBe(baseline.foreign_flow_ratio_20d);
    expect(withFutureMutations.trust_flow_ratio_20d).toBe(baseline.trust_flow_ratio_20d);
    expect(withFutureMutations.institutional_net_surge_5d).toBe(baseline.institutional_net_surge_5d);
  });

  it("fails closed on insufficient historical lookback (< 20 prior observations)", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(20);

    // On dates[19], only 19 prior observations exist (indices 0..18)
    const featureDate = dates[19]!;

    expect(() => computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate)).toThrow(
      "insufficient trailing",
    );
  });

  it("demonstrates scale-invariant volume normalization", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(30);
    const featureDate = dates[21]!;

    const baseline = computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate);

    // Scale volume and flow shares by exactly 10x
    const scaledMarket = marketRows.map((r) => ({ ...r, volume: r.volume * 10 }));
    const scaledT86 = t86Records.map((r) =>
      makeT86Record(
        r.tradeDate,
        r.foreignNetShares * 10,
        r.investmentTrustNetShares * 10,
        r.dealerSelfNetShares * 10,
        r.dealerHedgeNetShares * 10,
      ),
    );

    const scaled = computeT86InstitutionalFlowValues(scaledMarket, scaledT86, featureDate);

    expect(scaled.foreign_flow_ratio_20d).toBeCloseTo(baseline.foreign_flow_ratio_20d, 10);
    expect(scaled.trust_flow_ratio_20d).toBeCloseTo(baseline.trust_flow_ratio_20d, 10);
    expect(scaled.institutional_net_surge_5d).toBeCloseTo(baseline.institutional_net_surge_5d, 10);
  });

  it("does not mutate input market rows or T86 records", () => {
    const { marketRows, t86Records, dates } = generateAlignedHistory(30);
    const featureDate = dates[25]!;

    // Deep freeze inputs
    marketRows.forEach((r) => Object.freeze(r));
    Object.freeze(marketRows);
    t86Records.forEach((r) => Object.freeze(r));
    Object.freeze(t86Records);

    expect(() => computeT86InstitutionalFlowValues(marketRows, t86Records, featureDate)).not.toThrow();

    const buildResult = buildT86InstitutionalFlowFeatureRows({
      targetRows: marketRows,
      t86Records,
    });

    expect(buildResult.featureRows.length).toBeGreaterThan(0);
    expect(buildResult.controlFeatureRows.length).toBe(buildResult.featureRows.length);
  });

  it("builds valid aligned feature rows on canonical CSV files without dropping rows", () => {
    const ohlcvCsvPath = "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System/outputs/retraining/p194_twstock_ohlcv_export.csv";
    const t86CsvPath = path.resolve("outputs/retraining/p196_0056_twse_t86_institutional_flows.csv");

    const ohlcvText = readFileSync(ohlcvCsvPath, "utf8");
    const t86Text = readFileSync(t86CsvPath, "utf8");

    const rawOhlcv = parseTwStrategyResearchCsvText(ohlcvText);
    const market0056 = toMarketRows(rawOhlcv, "0056");
    const t86_0056 = parseTwseT86CsvText(t86Text);

    const result = buildT86InstitutionalFlowFeatureRows({
      targetRows: market0056,
      t86Records: t86_0056,
    });

    expect(result.eligibleRowsRemovedForT86Context).toBe(0);
    expect(result.missingContextRows).toBe(0);
    expect(result.controlFeatureRows.length).toBe(result.featureRows.length);

    // Each control row has 5 features; each challenger row has 8 features
    expect(result.controlFeatureRows[0]!.features).toHaveLength(5);
    expect(result.featureRows[0]!.features).toHaveLength(8);

    // Verify first 5 features of challenger row match control row exactly
    for (let i = 0; i < 10; i += 1) {
      const c = result.controlFeatureRows[i]!;
      const ch = result.featureRows[i]!;
      expect(ch.symbol).toBe("0056");
      expect(ch.featureDate).toBe(c.featureDate);
      expect(ch.targetDate).toBe(c.targetDate);
      expect(ch.target).toBe(c.target);
      expect(ch.forwardReturn).toBe(c.forwardReturn);
      expect(ch.features.slice(0, 5)).toEqual(c.features);
    }
  });
});
