import { fail, type FeatureRow, type FeatureVector, type MarketDataRow } from "./types.js";

export const RESEARCH_FEATURE_NAMES = Object.freeze([
  "return_5d",
  "return_20d",
  "volatility_10d",
  "volume_ratio_20d",
  "drawdown_20d",
] as const);

export const FEATURE_LOOKBACK_ROWS = 20;
export const TARGET_HORIZON_ROWS = 5;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute a mean from zero values");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function groupBySymbol(rows: readonly MarketDataRow[]): Map<string, MarketDataRow[]> {
  const grouped = new Map<string, MarketDataRow[]>();
  for (const row of rows) {
    const symbolRows = grouped.get(row.symbol) ?? [];
    symbolRows.push(row);
    grouped.set(row.symbol, symbolRows);
  }
  return grouped;
}

function featureVector(rows: readonly MarketDataRow[], index: number): FeatureVector {
  if (index < FEATURE_LOOKBACK_ROWS || index >= rows.length) {
    fail(`feature index ${index} is outside the historical lookback`);
  }
  const current = rows[index];
  if (current === undefined) fail(`missing market row at feature index ${index}`);

  const returns10: number[] = [];
  for (let offset = index - 9; offset <= index; offset += 1) {
    const row = rows[offset];
    const previous = rows[offset - 1];
    if (row === undefined || previous === undefined) fail("historical return window is incomplete");
    returns10.push(row.close / previous.close - 1);
  }
  const averageReturn = mean(returns10);
  const variance = mean(returns10.map((value) => (value - averageReturn) ** 2));
  const historicalVolumes = rows
    .slice(index - FEATURE_LOOKBACK_ROWS, index)
    .map((row) => row.volume);
  const averageVolume20 = mean(historicalVolumes);
  if (averageVolume20 <= 0) {
    fail(`zero historical volume mean at ${current.symbol}:${current.date}`);
  }

  const historicalCloses20 = rows
    .slice(index - FEATURE_LOOKBACK_ROWS + 1, index + 1)
    .map((row) => row.close);
  const firstHistoricalClose = historicalCloses20[0];
  if (firstHistoricalClose === undefined) fail("historical drawdown window is incomplete");
  let peak = firstHistoricalClose;
  let maximumDrawdown = 0;
  for (const close of historicalCloses20.slice(1)) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = (close - peak) / peak;
      if (drawdown < maximumDrawdown) maximumDrawdown = drawdown;
    }
  }

  const row5 = rows[index - 5];
  const row20 = rows[index - 20];
  if (row5 === undefined || row20 === undefined) fail("historical price window is incomplete");
  return Object.freeze([
    current.close / row5.close - 1,
    current.close / row20.close - 1,
    Math.sqrt(variance),
    current.volume / averageVolume20,
    maximumDrawdown,
  ]);
}

export function buildHistoricalFeatureRows(rows: readonly MarketDataRow[]): readonly FeatureRow[] {
  const samples: FeatureRow[] = [];
  for (const [symbol, symbolRows] of groupBySymbol(rows)) {
    if (symbolRows.length < FEATURE_LOOKBACK_ROWS + TARGET_HORIZON_ROWS + 1) {
      fail(`symbol ${symbol} has insufficient rows for lookback and target horizon`);
    }
    for (
      let index = FEATURE_LOOKBACK_ROWS;
      index + TARGET_HORIZON_ROWS < symbolRows.length;
      index += 1
    ) {
      const current = symbolRows[index];
      const target = symbolRows[index + TARGET_HORIZON_ROWS];
      const firstSource = symbolRows[index - FEATURE_LOOKBACK_ROWS];
      if (current === undefined || target === undefined || firstSource === undefined) {
        fail(`feature window is incomplete for ${symbol} at index ${index}`);
      }
      const forwardReturn = target.close / current.close - 1;
      samples.push(Object.freeze({
        symbol,
        featureDate: current.date,
        targetDate: target.date,
        featureSourceStartDate: firstSource.date,
        featureSourceEndDate: current.date,
        features: featureVector(symbolRows, index),
        target: forwardReturn > 0 ? 1 : 0,
        forwardReturn,
      }));
    }
  }
  samples.sort((left, right) =>
    compareText(left.featureDate, right.featureDate)
    || compareText(left.symbol, right.symbol));
  if (samples.length === 0) fail("no historical feature rows were produced");
  if (samples.some((row) =>
    row.featureSourceEndDate > row.featureDate
    || row.featureSourceStartDate > row.featureSourceEndDate
    || row.targetDate < row.featureDate)) {
    fail("historical feature or target date ordering is invalid");
  }
  return Object.freeze(samples);
}
