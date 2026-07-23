import { fail, type DataQualityFinding, type MarketDataRow } from "./types.js";

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isCanonicalIsoDate(value: string): boolean {
  if (!CANONICAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDatasetVersionField(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) fail(`dataset version ${field} is empty`);
  return normalized;
}

export function validateDatasetVersion(
  version: { readonly datasetId: string; readonly version: string; readonly source: string },
): { readonly datasetId: string; readonly version: string; readonly source: string } {
  return Object.freeze({
    datasetId: validateDatasetVersionField(version.datasetId, "datasetId"),
    version: validateDatasetVersionField(version.version, "version"),
    source: validateDatasetVersionField(version.source, "source"),
  });
}

export function validateAndNormalizeMarketRows(
  inputRows: readonly MarketDataRow[],
): readonly MarketDataRow[] {
  if (inputRows.length === 0) fail("market data is empty");
  const normalized = inputRows.map((row, index): MarketDataRow => {
    const symbol = row.symbol.trim();
    const source = row.source.trim();
    if (symbol.length === 0 || source.length === 0) {
      fail(`symbol or source is empty at market row ${index + 1}`);
    }
    if (!isCanonicalIsoDate(row.date)) {
      fail(`malformed canonical date at ${symbol || "unknown"}:${row.date}`);
    }
    const numericValues = [row.open, row.high, row.low, row.close, row.volume];
    if (numericValues.some((value) => !Number.isFinite(value))) {
      fail(`non-finite OHLCV value at ${symbol}:${row.date}`);
    }
    if (
      row.open <= 0
      || row.high <= 0
      || row.low <= 0
      || row.close <= 0
      || row.volume < 0
      || row.high < row.low
      || row.high < row.open
      || row.high < row.close
      || row.low > row.open
      || row.low > row.close
    ) {
      fail(`invalid OHLCV domain at ${symbol}:${row.date}`);
    }
    return Object.freeze({
      symbol,
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      source,
    });
  });

  const seen = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const row = normalized[index];
    if (row === undefined) fail(`missing normalized row at index ${index}`);
    const identity = `${row.symbol}:${row.date}`;
    if (seen.has(identity)) fail(`duplicate symbol/date row: ${identity}`);
    seen.add(identity);
    if (index > 0) {
      const previous = normalized[index - 1];
      if (previous === undefined) fail(`missing prior normalized row at index ${index - 1}`);
      const order = compareText(previous.symbol, row.symbol) || compareText(previous.date, row.date);
      if (order >= 0) fail(`invalid market-row ordering at ${identity}`);
    }
  }
  return Object.freeze(normalized);
}

export function findPriceDiscontinuities(
  rows: readonly MarketDataRow[],
  threshold = 0.5,
): readonly DataQualityFinding[] {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    fail(`price discontinuity threshold must be finite and positive: ${threshold}`);
  }
  const findings: DataQualityFinding[] = [];
  let previous: MarketDataRow | undefined;
  for (const row of rows) {
    if (previous?.symbol === row.symbol) {
      const closeReturn = row.close / previous.close - 1;
      if (Math.abs(closeReturn) >= threshold) {
        findings.push(Object.freeze({
          code: "UNADJUSTED_PRICE_DISCONTINUITY_RISK",
          severity: "BLOCKING",
          message: `absolute close-to-close return meets or exceeds ${threshold}`,
          symbol: row.symbol,
          date: row.date,
          priorDate: previous.date,
          value: closeReturn,
        }));
      }
    }
    previous = row;
  }
  return Object.freeze(findings);
}
