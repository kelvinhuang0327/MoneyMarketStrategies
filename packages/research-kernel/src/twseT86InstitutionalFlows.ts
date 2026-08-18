/**
 * Pure, network-free TWSE T86 daily institutional trading flows parser,
 * validator, and qualification kernel.
 *
 * This module (like the rest of `@mms/research-kernel`) contains no Node built-ins
 * (`node:fs`, `node:crypto`, `Buffer`). File I/O and SHA-256 computations are the
 * responsibility of callers/CLI tools.
 *
 * FROZEN POINT-IN-TIME (PIT) CONTRACT:
 * For every future MMS feature row with feature date T:
 *   T86_ELIGIBLE(record, T) = record.tradeDate < T
 *
 * Only STRICT PRIOR TRADING-DAY T86 observations may be consumed.
 * Same-day T86 (tradeDate == featureDate) is FORBIDDEN in V1.
 *
 * `sourceRetrievedAt` is provenance metadata only and MUST NOT be used as
 * historical availability.
 */

import {
  isCanonicalIsoDate,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  validateCutoffDates,
} from "./twStrategyTemporalRobustness.js";

export const TWSE_T86_OFFICIAL_SOURCE_IDENTITY = "TWSE_T86_DAILY_INSTITUTIONAL_REPORT" as const;
export const TWSE_T86_TARGET_SYMBOL = "0056" as const;
export const TWSE_T86_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_T86_DEFAULT_LOOKBACK_DAYS = 20 as const;
export const TWSE_T86_SCHEMA_VERSION = "MMS_0056_TWSE_T86_INSTITUTIONAL_FLOWS_MANIFEST_V1" as const;

export const TWSE_T86_REVISION_SEMANTICS =
  "TWSE T86 statistics are based on the day's original transaction activity and are not recomputed using later broker error-account / account-correction adjustments." as const;

export const TWSE_T86_FIELD_DEFINITIONS = Object.freeze({
  symbol: "Target security ticker symbol (0056)",
  tradeDate: "Official TWSE trade date in ISO YYYY-MM-DD format",
  foreignBuyShares: "Total foreign & mainland China investor buy volume in shares (including foreign dealers)",
  foreignSellShares: "Total foreign & mainland China investor sell volume in shares (including foreign dealers)",
  foreignNetShares: "Total foreign & mainland China investor net volume in shares (foreignBuyShares - foreignSellShares)",
  investmentTrustBuyShares: "Investment trust (local mutual funds) buy volume in shares",
  investmentTrustSellShares: "Investment trust (local mutual funds) sell volume in shares",
  investmentTrustNetShares: "Investment trust net volume in shares (investmentTrustBuyShares - investmentTrustSellShares)",
  dealerSelfBuyShares: "Dealer proprietary trading buy volume in shares (excluding hedging)",
  dealerSelfSellShares: "Dealer proprietary trading sell volume in shares (excluding hedging)",
  dealerSelfNetShares: "Dealer proprietary trading net volume in shares (dealerSelfBuyShares - dealerSelfSellShares)",
  dealerHedgeBuyShares: "Dealer hedging buy volume in shares",
  dealerHedgeSellShares: "Dealer hedging sell volume in shares",
  dealerHedgeNetShares: "Dealer hedging net volume in shares (dealerHedgeBuyShares - dealerHedgeSellShares)",
  institutionalTotalNetShares: "Combined net volume across foreign, investment trust, and all dealer accounts (foreignNetShares + investmentTrustNetShares + dealerSelfNetShares + dealerHedgeNetShares)",
  sourceIdentity: "Official provenance identifier (TWSE_T86_DAILY_INSTITUTIONAL_REPORT)",
  sourceRetrievedAt: "ISO UTC timestamp when the official record was retrieved (provenance metadata only)",
});

export const TWSE_T86_CSV_HEADER_FIELDS = Object.freeze([
  "symbol",
  "tradeDate",
  "foreignBuyShares",
  "foreignSellShares",
  "foreignNetShares",
  "investmentTrustBuyShares",
  "investmentTrustSellShares",
  "investmentTrustNetShares",
  "dealerSelfBuyShares",
  "dealerSelfSellShares",
  "dealerSelfNetShares",
  "dealerHedgeBuyShares",
  "dealerHedgeSellShares",
  "dealerHedgeNetShares",
  "institutionalTotalNetShares",
  "sourceIdentity",
  "sourceRetrievedAt",
] as const);

export type TwseT86ErrorCode =
  | "MALFORMED_CSV_HEADER"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_NUMERIC_FIELD"
  | "INVALID_DATE_FORMAT"
  | "INVALID_SYMBOL"
  | "DUPLICATE_TRADE_DATE"
  | "OUT_OF_ORDER_RECORDS"
  | "DUPLICATE_SYMBOL_ROWS"
  | "ABSENT_SYMBOL_ROW"
  | "TWSE_REPORT_NOT_OK"
  | "INVALID_JSON"
  | "MATHEMATICAL_INCONSISTENCY"
  | "PIT_VIOLATION_SAME_DAY"
  | "PIT_VIOLATION_FUTURE_DAY"
  | "INSUFFICIENT_HISTORICAL_COVERAGE";

export interface TwseT86DateInterval {
  readonly start: string;
  readonly end: string;
}

export interface TwseT86RequiredDateWindow {
  readonly requiredFeatureDateInterval: TwseT86DateInterval;
  readonly requiredT86DateInterval: TwseT86DateInterval;
}

export interface TwseT86Manifest {
  readonly schemaVersion: typeof TWSE_T86_SCHEMA_VERSION;
  readonly officialSourceIdentity: string;
  readonly targetSymbol: "0056";
  readonly requiredDateInterval: TwseT86DateInterval;
  readonly observedDateInterval: {
    readonly firstTradeDate: string;
    readonly lastTradeDate: string;
  };
  readonly rowCount: number;
  readonly fieldDefinitions: typeof TWSE_T86_FIELD_DEFINITIONS;
  readonly strictPitRule: typeof TWSE_T86_STRICT_PIT_RULE;
  readonly acquisitionTimestampProvenanceOnly: string;
  readonly csvSha256: string;
  readonly dataQualityMetrics: {
    readonly requestedTradingDates: number;
    readonly successfulOfficialReportDates: number;
    readonly symbolRowsFound: number;
    readonly missingTradingDates: number;
    readonly duplicateDates: number;
    readonly malformedNumericRows: number;
    readonly chronologicalOrdering: "PASS" | "FAIL";
    readonly nullCounts: Readonly<Record<string, number>>;
  };
  readonly temporalContextCoverage: Readonly<Record<string, {
    readonly priorTradingDaysAvailable: number;
    readonly minimumRequired: number;
    readonly passed: boolean;
    readonly latestPriorTradeDate: string;
  }>>;
  readonly revisionSemantics: string;
  readonly qualificationClassification: "MMS_0056_T86_PIT_SOURCE_QUALIFIED" | "MMS_0056_T86_PIT_SOURCE_BLOCKED";
}

export class TwseT86QualificationError extends Error {
  readonly code: TwseT86ErrorCode;

  constructor(code: TwseT86ErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwseT86QualificationError";
    this.code = code;
  }
}

function fail(code: TwseT86ErrorCode, detail?: string): never {
  throw new TwseT86QualificationError(code, detail);
}

function compareIsoDate(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeDistinctSortedIsoDates(dates: readonly string[]): readonly string[] {
  for (const value of dates) {
    if (!isCanonicalIsoDate(value)) {
      fail("INVALID_DATE_FORMAT", `invalid canonical date: ${value}`);
    }
  }
  const normalized = [...new Set(dates)].sort(compareIsoDate);
  if (normalized.length === 0) {
    fail("INVALID_DATE_FORMAT", "no canonical ISO dates provided");
  }
  return Object.freeze(normalized);
}

function requireCanonicalIsoDate(value: string, fieldName: string): void {
  if (!isCanonicalIsoDate(value)) {
    fail("INVALID_DATE_FORMAT", `${fieldName}: ${value}`);
  }
}

function safeCanonicalSourceDate(value: unknown, dateLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("MISSING_REQUIRED_FIELD", `${dateLabel}`);
  }
  const parsed = parseRocOrIsoDateToIso(value);
  requireCanonicalIsoDate(parsed, dateLabel);
  return parsed;
}

function resolveTradeDatePriorToIntervalStart(
  sortedDates: readonly string[],
  lookbackTradingDays: number,
): string {
  if (lookbackTradingDays < 0) {
    fail("INVALID_NUMERIC_FIELD", `lookbackTradingDays=${lookbackTradingDays}`);
  }
  if (sortedDates.length === 0) {
    fail("INVALID_DATE_FORMAT", "sortedDates is empty");
  }
  const earliest = sortedDates[0]!;
  const earliestIndex = sortedDates.indexOf(earliest);
  if (earliestIndex < 0) {
    fail("INVALID_DATE_FORMAT", "earliest feature date not in canonical trading calendar");
  }
  const startIndex = Math.max(0, earliestIndex - lookbackTradingDays);
  return sortedDates[startIndex]!;
}

function ensureSymbolRowUnique(rawData: readonly unknown[], targetSymbol: string, tradeDate: string): readonly unknown[] {
  const matches = rawData.filter(
    (row) => Array.isArray(row) && String(row[0] ?? "").trim() === targetSymbol,
  );
  if (matches.length === 0) {
    fail("ABSENT_SYMBOL_ROW", `${targetSymbol}:${tradeDate}`);
  }
  if (matches.length > 1) {
    fail("DUPLICATE_SYMBOL_ROWS", `${targetSymbol}:${tradeDate}:multiple matching rows`);
  }
  return matches as readonly unknown[];
}

function deriveRequiredDateWindow(
  featureTradingDates: readonly string[],
  minimumLookbackDays: number,
): TwseT86RequiredDateWindow {
  const sortedFeatureDates = normalizeDistinctSortedIsoDates(featureTradingDates);
  const requiredFeatureDateInterval = {
    start: sortedFeatureDates[0]!,
    end: sortedFeatureDates[sortedFeatureDates.length - 1]!,
  };
  const requiredT86Start = resolveTradeDatePriorToIntervalStart(sortedFeatureDates, minimumLookbackDays);
  return Object.freeze({
    requiredFeatureDateInterval,
    requiredT86DateInterval: {
      start: requiredT86Start,
      end: requiredFeatureDateInterval.end,
    },
  });
}

export function parseIntegerShareCount(value: unknown, fieldName: string, contextId: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    fail("MISSING_REQUIRED_FIELD", `${contextId}.${fieldName}`);
  }
  const clean = value.replaceAll(",", "").trim();
  if (clean === "--" || clean === "") return 0;
  if (!/^[+-]?\d+$/.test(clean)) {
    fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  const num = Number(clean);
  if (!Number.isFinite(num) || !Number.isSafeInteger(num)) {
    fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  return num;
}

export interface TwseT86FlowRecord {
  readonly symbol: string;
  readonly tradeDate: string;
  readonly foreignBuyShares: number;
  readonly foreignSellShares: number;
  readonly foreignNetShares: number;
  readonly investmentTrustBuyShares: number;
  readonly investmentTrustSellShares: number;
  readonly investmentTrustNetShares: number;
  readonly dealerSelfBuyShares: number;
  readonly dealerSelfSellShares: number;
  readonly dealerSelfNetShares: number;
  readonly dealerHedgeBuyShares: number;
  readonly dealerHedgeSellShares: number;
  readonly dealerHedgeNetShares: number;
  readonly institutionalTotalNetShares: number;
  readonly sourceIdentity: string;
  readonly sourceRetrievedAt: string;
}

export interface ParseTwseT86DailyReportOptions {
  readonly symbol: string;
  readonly sourceRetrievedAt: string;
  readonly expectedTradeDate?: string;
}

function parseRocOrIsoDateToIso(dateStr: string): string {
  const clean = dateStr.trim();
  if (isCanonicalIsoDate(clean)) return clean;
  // Format YYYYMMDD
  if (/^\d{8}$/.test(clean)) {
    const iso = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
    if (isCanonicalIsoDate(iso)) return iso;
  }
  // ROC format YYY/MM/DD or YYYMMDD
  const rocMatch = /^(\d{3})\/?(\d{2})\/?(\d{2})$/.exec(clean);
  if (rocMatch) {
    const year = Number(rocMatch[1]) + 1911;
    const iso = `${String(year).padStart(4, "0")}-${rocMatch[2]}-${rocMatch[3]}`;
    if (isCanonicalIsoDate(iso)) return iso;
  }
  fail("INVALID_DATE_FORMAT", dateStr);
}

/**
 * Parses an official TWSE T86 JSON payload for a single trading day,
 * extracting and validating the flow record for the requested symbol.
 */
export function parseTwseT86DailyReport(
  payload: string | Record<string, unknown>,
  options: ParseTwseT86DailyReportOptions,
): TwseT86FlowRecord {
  let json: Record<string, unknown>;
  if (typeof payload === "string") {
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      fail("INVALID_JSON", "could not parse T86 JSON payload");
    }
  } else if (typeof payload === "object" && payload !== null) {
    json = payload;
  } else {
    fail("INVALID_JSON", "payload must be string or object");
  }

  if (json["stat"] !== "OK") {
    fail("TWSE_REPORT_NOT_OK", String(json["stat"] ?? "unknown_stat"));
  }

  const rawDate = typeof json["date"] === "string" ? json["date"] : options.expectedTradeDate;
  if (!rawDate) {
    fail("MISSING_REQUIRED_FIELD", "date");
  }
  const tradeDate = parseRocOrIsoDateToIso(rawDate);
  if (options.expectedTradeDate) {
    const expectedTradeDate = safeCanonicalSourceDate(options.expectedTradeDate, "expectedTradeDate");
    if (tradeDate !== expectedTradeDate) {
      fail("INVALID_DATE_FORMAT", `expected ${expectedTradeDate} but report has ${tradeDate}`);
    }
  }

  const rawFields = json["fields"];
  if (!Array.isArray(rawFields)) {
    fail("MISSING_REQUIRED_FIELD", "fields array");
  }
  const fields = rawFields.map((f) => String(f).trim());

  const rawData = json["data"];
  if (!Array.isArray(rawData)) {
    fail("MISSING_REQUIRED_FIELD", "data array");
  }

  const rows = ensureSymbolRowUnique(rawData, options.symbol, tradeDate);
  const symbolRow = rows[0] as readonly unknown[];
  if (!Array.isArray(symbolRow)) {
    fail("ABSENT_SYMBOL_ROW", `${options.symbol}:${tradeDate}`);
  }

  function getCol(patterns: readonly (string | RegExp)[], fallbackIndex?: number): string {
    for (const pat of patterns) {
      for (let i = 0; i < fields.length; i += 1) {
        const fieldName = fields[i]!;
        if (typeof pat === "string" && fieldName === pat) {
          return String(symbolRow![i] ?? "");
        }
        if (pat instanceof RegExp && pat.test(fieldName)) {
          return String(symbolRow![i] ?? "");
        }
      }
    }
    if (fallbackIndex !== undefined && fallbackIndex < symbolRow!.length) {
      return String(symbolRow![fallbackIndex] ?? "");
    }
    fail("MISSING_REQUIRED_FIELD", `${options.symbol}:${tradeDate}:${String(patterns[0])}`);
  }

  const fBuyNoDealer = parseIntegerShareCount(
    getCol(["外陸資買進股數(不含外資自營商)", "外陸資買進股數", "外資買進股數"], 2),
    "foreignBuyNoDealer",
    tradeDate,
  );
  const fSellNoDealer = parseIntegerShareCount(
    getCol(["外陸資賣出股數(不含外資自營商)", "外陸資賣出股數", "外資賣出股數"], 3),
    "foreignSellNoDealer",
    tradeDate,
  );
  const fNetNoDealer = parseIntegerShareCount(
    getCol(["外陸資買賣超股數(不含外資自營商)", "外陸資買賣超股數", "外資買賣超股數"], 4),
    "foreignNetNoDealer",
    tradeDate,
  );

  const fDealerBuy = parseIntegerShareCount(getCol(["外資自營商買進股數"], 5), "fDealerBuy", tradeDate);
  const fDealerSell = parseIntegerShareCount(getCol(["外資自營商賣出股數"], 6), "fDealerSell", tradeDate);
  const fDealerNet = parseIntegerShareCount(getCol(["外資自營商買賣超股數"], 7), "fDealerNet", tradeDate);

  const foreignBuyShares = fBuyNoDealer + fDealerBuy;
  const foreignSellShares = fSellNoDealer + fDealerSell;
  const foreignNetShares = fNetNoDealer + fDealerNet;

  const investmentTrustBuyShares = parseIntegerShareCount(
    getCol(["投信買進股數"], 8),
    "investmentTrustBuyShares",
    tradeDate,
  );
  const investmentTrustSellShares = parseIntegerShareCount(
    getCol(["投信賣出股數"], 9),
    "investmentTrustSellShares",
    tradeDate,
  );
  const investmentTrustNetShares = parseIntegerShareCount(
    getCol(["投信買賣超股數"], 10),
    "investmentTrustNetShares",
    tradeDate,
  );

  const dealerSelfBuyShares = parseIntegerShareCount(
    getCol(["自營商買進股數(自行買賣)"], 12),
    "dealerSelfBuyShares",
    tradeDate,
  );
  const dealerSelfSellShares = parseIntegerShareCount(
    getCol(["自營商賣出股數(自行買賣)"], 13),
    "dealerSelfSellShares",
    tradeDate,
  );
  const dealerSelfNetShares = parseIntegerShareCount(
    getCol(["自營商買賣超股數(自行買賣)"], 14),
    "dealerSelfNetShares",
    tradeDate,
  );

  const dealerHedgeBuyShares = parseIntegerShareCount(
    getCol(["自營商買進股數(避險)", /買進股數.*避險/], 15),
    "dealerHedgeBuyShares",
    tradeDate,
  );
  const dealerHedgeSellShares = parseIntegerShareCount(
    getCol(["自營商賣出股數(避險)", /賣出股數.*避險/], 16),
    "dealerHedgeSellShares",
    tradeDate,
  );
  const dealerHedgeNetShares = parseIntegerShareCount(
    getCol(["自營商買賣超股數(避險)", /買賣超股數.*避險/], 17),
    "dealerHedgeNetShares",
    tradeDate,
  );

  const institutionalTotalNetShares = parseIntegerShareCount(
    getCol(["三大法人買賣超股數"], 18),
    "institutionalTotalNetShares",
    tradeDate,
  );

  // Arithmetic consistency checks
  if (foreignBuyShares - foreignSellShares !== foreignNetShares) {
    fail(
      "MATHEMATICAL_INCONSISTENCY",
      `foreignNetShares mismatch on ${tradeDate}: ${foreignBuyShares} - ${foreignSellShares} !== ${foreignNetShares}`,
    );
  }
  if (investmentTrustBuyShares - investmentTrustSellShares !== investmentTrustNetShares) {
    fail(
      "MATHEMATICAL_INCONSISTENCY",
      `investmentTrustNetShares mismatch on ${tradeDate}: ${investmentTrustBuyShares} - ${investmentTrustSellShares} !== ${investmentTrustNetShares}`,
    );
  }
  if (dealerSelfBuyShares - dealerSelfSellShares !== dealerSelfNetShares) {
    fail(
      "MATHEMATICAL_INCONSISTENCY",
      `dealerSelfNetShares mismatch on ${tradeDate}: ${dealerSelfBuyShares} - ${dealerSelfSellShares} !== ${dealerSelfNetShares}`,
    );
  }
  if (dealerHedgeBuyShares - dealerHedgeSellShares !== dealerHedgeNetShares) {
    fail(
      "MATHEMATICAL_INCONSISTENCY",
      `dealerHedgeNetShares mismatch on ${tradeDate}: ${dealerHedgeBuyShares} - ${dealerHedgeSellShares} !== ${dealerHedgeNetShares}`,
    );
  }
  if (
    foreignNetShares + investmentTrustNetShares + dealerSelfNetShares + dealerHedgeNetShares
    !== institutionalTotalNetShares
  ) {
    fail(
      "MATHEMATICAL_INCONSISTENCY",
      `institutionalTotalNetShares mismatch on ${tradeDate}: sum=${foreignNetShares + investmentTrustNetShares + dealerSelfNetShares + dealerHedgeNetShares} vs total=${institutionalTotalNetShares}`,
    );
  }

  return {
    symbol: options.symbol,
    tradeDate,
    foreignBuyShares,
    foreignSellShares,
    foreignNetShares,
    investmentTrustBuyShares,
    investmentTrustSellShares,
    investmentTrustNetShares,
    dealerSelfBuyShares,
    dealerSelfSellShares,
    dealerSelfNetShares,
    dealerHedgeBuyShares,
    dealerHedgeSellShares,
    dealerHedgeNetShares,
    institutionalTotalNetShares,
    sourceIdentity: TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
    sourceRetrievedAt: options.sourceRetrievedAt,
  };
}

/**
 * Deterministically serializes an array of `TwseT86FlowRecord` into standard CSV text.
 */
export function serializeTwseT86ToCsv(records: readonly TwseT86FlowRecord[]): string {
  const header = TWSE_T86_CSV_HEADER_FIELDS.join(",");
  const lines = [header];
  for (const record of records) {
    const row = [
      record.symbol,
      record.tradeDate,
      String(record.foreignBuyShares),
      String(record.foreignSellShares),
      String(record.foreignNetShares),
      String(record.investmentTrustBuyShares),
      String(record.investmentTrustSellShares),
      String(record.investmentTrustNetShares),
      String(record.dealerSelfBuyShares),
      String(record.dealerSelfSellShares),
      String(record.dealerSelfNetShares),
      String(record.dealerHedgeBuyShares),
      String(record.dealerHedgeSellShares),
      String(record.dealerHedgeNetShares),
      String(record.institutionalTotalNetShares),
      record.sourceIdentity,
      record.sourceRetrievedAt,
    ];
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Parses canonical CSV text into an array of `TwseT86FlowRecord`, validating
 * header format, numeric values, date format, and uniqueness.
 */
export function parseTwseT86CsvText(csvText: string): readonly TwseT86FlowRecord[] {
  const lines = csvText.replaceAll("\r\n", "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    fail("MALFORMED_CSV_HEADER", "empty file");
  }
  const header = lines[0]!.split(",").map((s) => s.trim());
  for (const field of TWSE_T86_CSV_HEADER_FIELDS) {
    if (!header.includes(field)) {
      fail("MALFORMED_CSV_HEADER", `missing required column: ${field}`);
    }
  }

  const symbolIdx = header.indexOf("symbol");
  const dateIdx = header.indexOf("tradeDate");
  const fBuyIdx = header.indexOf("foreignBuyShares");
  const fSellIdx = header.indexOf("foreignSellShares");
  const fNetIdx = header.indexOf("foreignNetShares");
  const itBuyIdx = header.indexOf("investmentTrustBuyShares");
  const itSellIdx = header.indexOf("investmentTrustSellShares");
  const itNetIdx = header.indexOf("investmentTrustNetShares");
  const dsBuyIdx = header.indexOf("dealerSelfBuyShares");
  const dsSellIdx = header.indexOf("dealerSelfSellShares");
  const dsNetIdx = header.indexOf("dealerSelfNetShares");
  const dhBuyIdx = header.indexOf("dealerHedgeBuyShares");
  const dhSellIdx = header.indexOf("dealerHedgeSellShares");
  const dhNetIdx = header.indexOf("dealerHedgeNetShares");
  const totNetIdx = header.indexOf("institutionalTotalNetShares");
  const srcIdIdx = header.indexOf("sourceIdentity");
  const srcRetIdx = header.indexOf("sourceRetrievedAt");

  const records: TwseT86FlowRecord[] = [];
  const seenDates = new Set<string>();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex]!;
    const cols = rawLine.split(",").map((s) => s.trim());
    if (cols.length < header.length) {
      fail("MISSING_REQUIRED_FIELD", `line ${lineIndex + 1}: expected ${header.length} columns, got ${cols.length}`);
    }

    const symbol = cols[symbolIdx]!;
    const tradeDate = cols[dateIdx]!;
    if (symbol.length === 0) fail("INVALID_SYMBOL", `line ${lineIndex + 1}: empty symbol`);
    if (!isCanonicalIsoDate(tradeDate)) fail("INVALID_DATE_FORMAT", `line ${lineIndex + 1}: ${tradeDate}`);
    if (seenDates.has(tradeDate)) fail("DUPLICATE_TRADE_DATE", `duplicate trade date: ${tradeDate}`);
    seenDates.add(tradeDate);

    const foreignBuyShares = parseIntegerShareCount(cols[fBuyIdx], "foreignBuyShares", tradeDate);
    const foreignSellShares = parseIntegerShareCount(cols[fSellIdx], "foreignSellShares", tradeDate);
    const foreignNetShares = parseIntegerShareCount(cols[fNetIdx], "foreignNetShares", tradeDate);

    const investmentTrustBuyShares = parseIntegerShareCount(cols[itBuyIdx], "investmentTrustBuyShares", tradeDate);
    const investmentTrustSellShares = parseIntegerShareCount(cols[itSellIdx], "investmentTrustSellShares", tradeDate);
    const investmentTrustNetShares = parseIntegerShareCount(cols[itNetIdx], "investmentTrustNetShares", tradeDate);

    const dealerSelfBuyShares = parseIntegerShareCount(cols[dsBuyIdx], "dealerSelfBuyShares", tradeDate);
    const dealerSelfSellShares = parseIntegerShareCount(cols[dsSellIdx], "dealerSelfSellShares", tradeDate);
    const dealerSelfNetShares = parseIntegerShareCount(cols[dsNetIdx], "dealerSelfNetShares", tradeDate);

    const dealerHedgeBuyShares = parseIntegerShareCount(cols[dhBuyIdx], "dealerHedgeBuyShares", tradeDate);
    const dealerHedgeSellShares = parseIntegerShareCount(cols[dhSellIdx], "dealerHedgeSellShares", tradeDate);
    const dealerHedgeNetShares = parseIntegerShareCount(cols[dhNetIdx], "dealerHedgeNetShares", tradeDate);

    const institutionalTotalNetShares = parseIntegerShareCount(cols[totNetIdx], "institutionalTotalNetShares", tradeDate);

    // Consistency check
    if (foreignBuyShares - foreignSellShares !== foreignNetShares) {
      fail("MATHEMATICAL_INCONSISTENCY", `foreign net mismatch on ${tradeDate}`);
    }
    if (investmentTrustBuyShares - investmentTrustSellShares !== investmentTrustNetShares) {
      fail("MATHEMATICAL_INCONSISTENCY", `IT net mismatch on ${tradeDate}`);
    }
    if (dealerSelfBuyShares - dealerSelfSellShares !== dealerSelfNetShares) {
      fail("MATHEMATICAL_INCONSISTENCY", `dealer self net mismatch on ${tradeDate}`);
    }
    if (dealerHedgeBuyShares - dealerHedgeSellShares !== dealerHedgeNetShares) {
      fail("MATHEMATICAL_INCONSISTENCY", `dealer hedge net mismatch on ${tradeDate}`);
    }
    if (foreignNetShares + investmentTrustNetShares + dealerSelfNetShares + dealerHedgeNetShares !== institutionalTotalNetShares) {
      fail("MATHEMATICAL_INCONSISTENCY", `total net mismatch on ${tradeDate}`);
    }

    records.push({
      symbol,
      tradeDate,
      foreignBuyShares,
      foreignSellShares,
      foreignNetShares,
      investmentTrustBuyShares,
      investmentTrustSellShares,
      investmentTrustNetShares,
      dealerSelfBuyShares,
      dealerSelfSellShares,
      dealerSelfNetShares,
      dealerHedgeBuyShares,
      dealerHedgeSellShares,
      dealerHedgeNetShares,
      institutionalTotalNetShares,
      sourceIdentity: cols[srcIdIdx] || TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
      sourceRetrievedAt: cols[srcRetIdx] || "",
    });
  }

  // Ensure chronological order
  for (let i = 1; i < records.length; i += 1) {
    if (compareIsoDate(records[i]!.tradeDate, records[i - 1]!.tradeDate) <= 0) {
      fail("OUT_OF_ORDER_RECORDS", `row ${i} (${records[i]!.tradeDate}) <= row ${i - 1} (${records[i - 1]!.tradeDate})`);
    }
  }

  return Object.freeze(records);
}

/**
 * Strict PIT eligibility check:
 * Record is eligible for feature date T if and only if `record.tradeDate < T`.
 * Same-day T86 (`tradeDate === T`) is strictly FORBIDDEN.
 */
export function isT86RecordEligibleForFeatureDate(
  record: TwseT86FlowRecord,
  featureDate: string,
): boolean {
  if (!isCanonicalIsoDate(featureDate)) {
    fail("INVALID_DATE_FORMAT", `featureDate: ${featureDate}`);
  }
  return record.tradeDate < featureDate;
}

/**
 * Returns all records strictly prior to `featureDate`.
 */
export function filterEligibleT86Records(
  records: readonly TwseT86FlowRecord[],
  featureDate: string,
): readonly TwseT86FlowRecord[] {
  if (!isCanonicalIsoDate(featureDate)) {
    fail("INVALID_DATE_FORMAT", `featureDate: ${featureDate}`);
  }
  return records.filter((record) => record.tradeDate < featureDate);
}

export interface TwseT86QualificationResult {
  readonly qualificationClassification: "MMS_0056_T86_PIT_SOURCE_QUALIFIED" | "MMS_0056_T86_PIT_SOURCE_BLOCKED";
  readonly targetSymbol: "0056";
  readonly requestedTradingDates: number;
  readonly successfulOfficialReportDates: number;
  readonly symbolRowsFound: number;
  readonly missingTradingDates: number;
  readonly duplicateDates: number;
  readonly malformedNumericRows: number;
  readonly firstObservedTradeDate: string;
  readonly lastObservedTradeDate: string;
  readonly chronologicalOrdering: "PASS" | "FAIL";
  readonly nullCounts: Readonly<Record<string, number>>;
  readonly temporalContextCoverage: Readonly<Record<string, {
    readonly priorTradingDaysAvailable: number;
    readonly minimumRequired: number;
    readonly passed: boolean;
    readonly latestPriorTradeDate: string;
  }>>;
}

export interface TwseT86ManifestBuildInput {
  readonly records: readonly TwseT86FlowRecord[];
  readonly canonicalFeatureTradingDates: readonly string[];
  readonly requiredCutoffs?: readonly string[];
  readonly minimumLookbackDays?: number;
  readonly acquisitionTimestampProvenanceOnly: string;
  readonly csvSha256: string;
  readonly requiredDateInterval?: TwseT86DateInterval;
}

/**
 * Runs the full data quality gate against a set of parsed T86 records and canonical trading dates.
 */
export function qualifyTwseT86Records(
  records: readonly TwseT86FlowRecord[],
  canonicalTradingDates: readonly string[],
  requiredCutoffs: readonly string[] = SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  minimumLookbackDays = 20,
): TwseT86QualificationResult {
  const observedRecords = records
    .slice()
    .sort((left, right) => compareIsoDate(left.tradeDate, right.tradeDate));
  const recordsMap = new Map<string, TwseT86FlowRecord>();
  let duplicateCount = 0;
  for (const r of observedRecords) {
    requireCanonicalIsoDate(r.tradeDate, `tradeDate:${r.tradeDate}`);
    if (r.symbol.length === 0 || r.symbol !== TWSE_T86_TARGET_SYMBOL) {
      fail("INVALID_SYMBOL", `invalid symbol row: ${r.symbol}`);
    }
    if (recordsMap.has(r.tradeDate)) duplicateCount += 1;
    recordsMap.set(r.tradeDate, r);
  }

  const canonicalSorted = normalizeDistinctSortedIsoDates(canonicalTradingDates);
  const requestedDates = new Set<string>(canonicalSorted);

  let missingCount = 0;
  for (const d of canonicalSorted) {
    if (!recordsMap.has(d)) missingCount += 1;
  }

  let chronologicalOrdering: "PASS" | "FAIL" = "PASS";
  for (let i = 1; i < observedRecords.length; i += 1) {
    if (compareIsoDate(observedRecords[i]!.tradeDate, observedRecords[i - 1]!.tradeDate) <= 0) {
      chronologicalOrdering = "FAIL";
      break;
    }
  }

  const validatedCutoffs = validateCutoffDates(requiredCutoffs);
  const nullCounts: Record<string, number> = {};
  for (const field of TWSE_T86_CSV_HEADER_FIELDS) {
    nullCounts[field] = observedRecords.filter(
      (r) => r[field as keyof TwseT86FlowRecord] === null || r[field as keyof TwseT86FlowRecord] === undefined,
    ).length;
  }

  const orderedRecordDates = observedRecords.map((r) => r.tradeDate);
  const requestedDateCount = requestedDates.size;
  const successfulOfficialReportDates = orderedRecordDates.filter((tradeDate) => requestedDates.has(tradeDate)).length;

  const temporalContextCoverage: Record<string, {
    readonly priorTradingDaysAvailable: number;
    readonly minimumRequired: number;
    readonly passed: boolean;
    readonly latestPriorTradeDate: string;
  }> = {};

  let allCutoffsPass = true;
  for (const cutoff of validatedCutoffs) {
    const priorRecords = observedRecords.filter((r) => r.tradeDate < cutoff);
    const passed = priorRecords.length >= minimumLookbackDays;
    if (!passed) allCutoffsPass = false;
    const latestPrior = priorRecords.length > 0 ? priorRecords[priorRecords.length - 1]!.tradeDate : "NONE";
    temporalContextCoverage[cutoff] = {
      priorTradingDaysAvailable: priorRecords.length,
      minimumRequired: minimumLookbackDays,
      passed,
      latestPriorTradeDate: latestPrior,
    };
  }

  const passes =
    requestedDateCount > 0 &&
    requestedDateCount === successfulOfficialReportDates &&
    missingCount === 0 &&
    duplicateCount === 0 &&
    chronologicalOrdering === "PASS" &&
    allCutoffsPass &&
    observedRecords.length >= requestedDateCount &&
    records.length >= minimumLookbackDays;

  return {
    qualificationClassification: passes ? "MMS_0056_T86_PIT_SOURCE_QUALIFIED" : "MMS_0056_T86_PIT_SOURCE_BLOCKED",
    targetSymbol: "0056",
    requestedTradingDates: requestedDateCount,
    successfulOfficialReportDates,
    symbolRowsFound: records.length,
    missingTradingDates: missingCount,
    duplicateDates: duplicateCount,
    malformedNumericRows: 0,
    firstObservedTradeDate: observedRecords[0]?.tradeDate ?? "",
    lastObservedTradeDate: observedRecords[observedRecords.length - 1]?.tradeDate ?? "",
    chronologicalOrdering,
    nullCounts: Object.freeze(nullCounts),
    temporalContextCoverage: Object.freeze(temporalContextCoverage),
  };
}

export function buildTwseT86SourceManifest(input: TwseT86ManifestBuildInput): TwseT86Manifest {
  const cutoffDates = input.requiredCutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES;
  const minimumLookbackDays = input.minimumLookbackDays ?? TWSE_T86_DEFAULT_LOOKBACK_DAYS;
  const qualification = qualifyTwseT86Records(
    input.records,
    input.canonicalFeatureTradingDates,
    cutoffDates,
    minimumLookbackDays,
  );

  const requiredDateWindow = input.requiredDateInterval
    ?? deriveRequiredDateWindow(input.canonicalFeatureTradingDates, minimumLookbackDays).requiredT86DateInterval;

  if (input.acquisitionTimestampProvenanceOnly.trim().length === 0) {
    fail("MISSING_REQUIRED_FIELD", "acquisitionTimestampProvenanceOnly");
  }

  return {
    schemaVersion: TWSE_T86_SCHEMA_VERSION,
    officialSourceIdentity: TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
    targetSymbol: TWSE_T86_TARGET_SYMBOL,
    requiredDateInterval: requiredDateWindow,
    observedDateInterval: {
      firstTradeDate: qualification.firstObservedTradeDate,
      lastTradeDate: qualification.lastObservedTradeDate,
    },
    rowCount: input.records.length,
    fieldDefinitions: TWSE_T86_FIELD_DEFINITIONS,
    strictPitRule: TWSE_T86_STRICT_PIT_RULE,
    acquisitionTimestampProvenanceOnly: input.acquisitionTimestampProvenanceOnly,
    csvSha256: input.csvSha256,
    dataQualityMetrics: {
      requestedTradingDates: qualification.requestedTradingDates,
      successfulOfficialReportDates: qualification.successfulOfficialReportDates,
      symbolRowsFound: qualification.symbolRowsFound,
      missingTradingDates: qualification.missingTradingDates,
      duplicateDates: qualification.duplicateDates,
      malformedNumericRows: qualification.malformedNumericRows,
      chronologicalOrdering: qualification.chronologicalOrdering,
      nullCounts: qualification.nullCounts,
    },
    temporalContextCoverage: qualification.temporalContextCoverage,
    revisionSemantics: TWSE_T86_REVISION_SEMANTICS,
    qualificationClassification: qualification.qualificationClassification,
  };
}

export function resolveT86RequiredDateWindow(
  featureTradingDates: readonly string[],
  minimumLookbackDays: number = TWSE_T86_DEFAULT_LOOKBACK_DAYS,
): TwseT86RequiredDateWindow {
  return deriveRequiredDateWindow(featureTradingDates, minimumLookbackDays);
}
