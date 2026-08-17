import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  fail,
  type FeatureRow,
  type MarketDataRow,
  type PerSymbolLogisticChallengerFeatureFamily,
} from "./types.js";

export const LEGACY_TECHNICAL_FEATURE_FAMILY: PerSymbolLogisticChallengerFeatureFamily = Object.freeze({
  featureFamilyName: "legacy_breakout_20d_high",
  legacySourcePath: "gbgf/domain/stock_features.py",
  legacySourceSymbolOrFormula: "breakout_nd_high(rows, i, n) with n=20: close[i] > max(high[i-20:i])",
  newFeatureFields: Object.freeze(["breakout_20d_high"]),
  currentIncumbentFeatureFields: Object.freeze([...RESEARCH_FEATURE_NAMES]),
  whyNotDuplicative: "The live incumbent has no prior-high breakout field; drawdown_20d remains the governing incumbent field.",
  lookbackRowsRequired: 20,
  availableAtRule: "At feature date i, use close[i] and OHLCV rows i-20 through i-1 only; never use a future row.",
  missingValueRule: "Rows before 20 prior observations are excluded; no missing-value imputation is permitted.",
});

function compareDate(left: MarketDataRow, right: MarketDataRow): number {
  if (left.date < right.date) return -1;
  if (left.date > right.date) return 1;
  return 0;
}

function groupedMarketRows(
  marketRows: readonly MarketDataRow[],
): Map<string, readonly MarketDataRow[]> {
  const grouped = new Map<string, MarketDataRow[]>();
  for (const row of marketRows) {
    const rows = grouped.get(row.symbol) ?? [];
    rows.push(row);
    grouped.set(row.symbol, rows);
  }
  return new Map([...grouped.entries()].map(([symbol, rows]) => [
    symbol,
    Object.freeze([...rows].sort(compareDate)),
  ]));
}

export function buildLegacyBreakout20dHighValue(
  symbolRows: readonly MarketDataRow[],
  index: number,
): 0 | 1 {
  const lookback = LEGACY_TECHNICAL_FEATURE_FAMILY.lookbackRowsRequired;
  if (index < lookback || index >= symbolRows.length) {
    fail(`legacy breakout feature index ${index} lacks ${lookback} prior rows`);
  }
  const current = symbolRows[index];
  if (current === undefined) fail("legacy breakout feature current row is missing");
  const priorRows = symbolRows.slice(index - lookback, index);
  if (priorRows.length !== lookback) fail("legacy breakout feature lookback is incomplete");
  if (priorRows.some((row) => row.date > current.date)) {
    fail("legacy breakout feature reads a future row");
  }
  const priorHigh = Math.max(...priorRows.map((row) => row.high));
  return current.close > priorHigh ? 1 : 0;
}

export function buildLegacyBreakoutFeatureRows(
  marketRows: readonly MarketDataRow[],
): readonly FeatureRow[] {
  if (marketRows.length === 0) fail("legacy feature challenger requires market rows");
  const incumbentRows = buildHistoricalFeatureRows(marketRows);
  const rowsBySymbol = groupedMarketRows(marketRows);
  const candidateRows = incumbentRows.map((row) => {
    const symbolRows = rowsBySymbol.get(row.symbol);
    if (symbolRows === undefined) fail(`legacy feature source rows are missing for ${row.symbol}`);
    const index = symbolRows.findIndex(({ date }) => date === row.featureDate);
    if (index < 0) fail(`legacy feature source row is missing for ${row.symbol}:${row.featureDate}`);
    const sourceRows = symbolRows.slice(index - LEGACY_TECHNICAL_FEATURE_FAMILY.lookbackRowsRequired, index);
    if (sourceRows.length !== LEGACY_TECHNICAL_FEATURE_FAMILY.lookbackRowsRequired) {
      fail(`legacy feature source lookback is incomplete for ${row.symbol}:${row.featureDate}`);
    }
    if (sourceRows.some(({ date }) => date > row.featureDate)) {
      fail(`legacy feature source uses a future row for ${row.symbol}:${row.featureDate}`);
    }
    const breakout = buildLegacyBreakout20dHighValue(symbolRows, index);
    return Object.freeze({
      ...row,
      features: Object.freeze([...row.features, breakout]),
    });
  });
  return Object.freeze(candidateRows);
}
