/**
 * Pure, network-free TWSE MI_QFIIS daily foreign & mainland-investor shareholding
 * statistics parser, validator, and qualification kernel for symbol 0056.
 *
 * This module (like the rest of `@mms/research-kernel`) contains no Node built-ins
 * (`node:fs`, `node:crypto`, `Buffer`). File I/O, HTTPS, and SHA-256 are the
 * responsibility of callers/CLI tools.
 *
 * FROZEN POINT-IN-TIME (PIT) CONTRACT:
 * For every future MMS feature row with feature date T:
 *   MI_QFIIS_ELIGIBLE(record, T) = record.tradeDate < T
 *
 * Only STRICT PRIOR TRADING-DAY observations may be consumed.
 * Same-day MI_QFIIS (tradeDate == featureDate) is FORBIDDEN in V1.
 *
 * `sourceRetrievedAt` is provenance metadata for when this qualification run
 * retrieved the official record. It MUST NOT be used as historicalAvailableAt,
 * publicationTimestamp, or featureEligibilityTimestamp.
 *
 * Exact historical publication minutes are not invented from TWSE evening
 * production notes (17:00 / 21:30).
 */

import {
  isCanonicalIsoDate,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  validateCutoffDates,
} from "./twStrategyTemporalRobustness.js";

export const TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY = "TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT" as const;
export const TWSE_MI_QFIIS_SOURCE_OWNER = "Taiwan Stock Exchange Corporation" as const;
export const TWSE_MI_QFIIS_SOURCE_FAMILY = "MI_QFIIS" as const;
export const TWSE_MI_QFIIS_TARGET_SYMBOL = "0056" as const;
export const TWSE_MI_QFIIS_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE = "https://www.twse.com.tw/en/trading/foreign/mi-qfiis.html" as const;
export const TWSE_MI_QFIIS_ENDPOINT_TEMPLATE =
  "https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=YYYYMMDD&selectType=ALLBUT0999&response=json" as const;
export const TWSE_MI_QFIIS_SCHEMA_VERSION = "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_MANIFEST_V1" as const;
export const TWSE_MI_QFIIS_NO_DATA_STAT = "很抱歉，沒有符合條件的資料" as const;

export const TWSE_MI_QFIIS_FIELD_DEFINITIONS = Object.freeze({
  tradeDate: "Official TWSE MI_QFIIS report / trading date in ISO YYYY-MM-DD format",
  symbol: "Target security ticker symbol (0056)",
  securityName: "Official security short name from the MI_QFIIS 證券名稱 column",
  issuedShares:
    "Official total issued shares (發行股數) for 0056 as published (source unit: 股 / shares)",
  foreignHeldShares:
    "Official total foreign and mainland investor held shares (全體外資及陸資持有股數) for 0056 as published (source unit: 股 / shares)",
  foreignHoldingRatio:
    "Official total foreign and mainland investor shareholding ratio (全體外資及陸資持股比率) for 0056 as published (source unit: 百分比 / percentage points 0.0 - 100.0%)",
  foreignRemainingInvestableShares:
    "Official foreign and mainland investor remaining investable shares (外資及陸資尚可投資股數) for 0056 as published (source unit: 股 / shares)",
  foreignRemainingInvestableRatio:
    "Official foreign and mainland investor remaining investable ratio (外資及陸資尚可投資比率) for 0056 as published (source unit: 百分比 / percentage points 0.0 - 100.0%)",
  statutoryInvestmentLimitRatio:
    "Official foreign and mainland investor statutory investment limit ratio (外資及陸資共用法令投資上限比率) for 0056 as published (source unit: 百分比 / percentage points 0.0 - 100.0%)",
  sourceIdentity: "Official provenance identifier (TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT)",
  sourceRetrievedAt:
    "ISO UTC timestamp when this qualification run retrieved the official record (provenance only; not historicalAvailableAt, publicationTimestamp, or featureEligibilityTimestamp)",
});

export const TWSE_MI_QFIIS_CSV_HEADER_FIELDS = Object.freeze([
  "tradeDate",
  "symbol",
  "securityName",
  "issuedShares",
  "foreignHeldShares",
  "foreignHoldingRatio",
  "foreignRemainingInvestableShares",
  "foreignRemainingInvestableRatio",
  "statutoryInvestmentLimitRatio",
  "sourceIdentity",
  "sourceRetrievedAt",
] as const);

export type TwseMiQfiisErrorCode =
  | "MALFORMED_CSV_HEADER"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_NUMERIC_FIELD"
  | "INVALID_RATIO_FIELD"
  | "INVALID_DATE_FORMAT"
  | "INVALID_SYMBOL"
  | "DUPLICATE_TRADE_DATE"
  | "OUT_OF_ORDER_RECORDS"
  | "DUPLICATE_SYMBOL_ROWS"
  | "ABSENT_SYMBOL_ROW"
  | "TWSE_REPORT_NOT_OK"
  | "INVALID_JSON"
  | "SOURCE_SCHEMA_UNRESOLVED"
  | "ROW_WIDTH_MISMATCH"
  | "NEGATIVE_VALUE_NOT_ALLOWED"
  | "PIT_VIOLATION_SAME_DAY"
  | "PIT_VIOLATION_FUTURE_DAY";

export class TwseMiQfiisQualificationError extends Error {
  readonly code: TwseMiQfiisErrorCode;

  constructor(code: TwseMiQfiisErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwseMiQfiisQualificationError";
    this.code = code;
  }
}

function fail(code: TwseMiQfiisErrorCode, detail?: string): never {
  throw new TwseMiQfiisQualificationError(code, detail);
}

function compareIsoDate(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireCanonicalIsoDate(value: string, fieldName: string): void {
  if (!isCanonicalIsoDate(value)) {
    fail("INVALID_DATE_FORMAT", `${fieldName}: ${value}`);
  }
}

function parseRocOrIsoDateToIso(dateStr: string): string {
  const clean = dateStr.trim();
  if (isCanonicalIsoDate(clean)) return clean;
  if (/^\d{8}$/.test(clean)) {
    const iso = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
    if (isCanonicalIsoDate(iso)) return iso;
  }
  const rocMatch = /^(\d{2,3})\/?(\d{2})\/?(\d{2})$/.exec(clean);
  if (rocMatch) {
    const year = Number(rocMatch[1]) + 1911;
    const iso = `${String(year).padStart(4, "0")}-${rocMatch[2]}-${rocMatch[3]}`;
    if (isCanonicalIsoDate(iso)) return iso;
  }
  fail("INVALID_DATE_FORMAT", dateStr);
}

export function isTwseMiQfiisNoDataResponse(statOrPayload: unknown): boolean {
  if (typeof statOrPayload === "string") {
    return statOrPayload.includes("沒有符合條件的資料");
  }
  if (typeof statOrPayload === "object" && statOrPayload !== null) {
    const obj = statOrPayload as Record<string, unknown>;
    if (typeof obj["stat"] === "string" && obj["stat"].includes("沒有符合條件的資料")) {
      return true;
    }
    if (obj["total"] === 0 || obj["total"] === "0") {
      return true;
    }
    if (Array.isArray(obj["data"]) && obj["data"].length === 0) {
      return true;
    }
    if (Array.isArray(obj["tables"]) && obj["tables"].length > 0) {
      return obj["tables"].every((t) => {
        if (typeof t === "object" && t !== null) {
          const tObj = t as Record<string, unknown>;
          return Array.isArray(tObj["data"]) && tObj["data"].length === 0;
        }
        return false;
      });
    }
  }
  return false;
}

/**
 * Strict non-negative safe integer parser for official MI_QFIIS share count cells.
 * Accepts comma-separated or plain integer text. Rejects blank, "--",
 * non-numeric annotation, NaN/Infinity, decimals, and negatives.
 */
export function parseNonNegativeSafeInteger(
  value: unknown,
  fieldName: string,
  contextId: string,
): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
    }
    if (value < 0) {
      fail("NEGATIVE_VALUE_NOT_ALLOWED", `${contextId}.${fieldName}=${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    fail("MISSING_REQUIRED_FIELD", `${contextId}.${fieldName}`);
  }
  const clean = value.replaceAll(",", "").trim();
  if (clean === "" || clean === "--") {
    fail("MISSING_REQUIRED_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  if (!/^\d+$/.test(clean)) {
    fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  const num = Number(clean);
  if (!Number.isFinite(num) || !Number.isSafeInteger(num) || num < 0) {
    fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  return num;
}

/**
 * Strict non-negative percentage float parser for official MI_QFIIS ratio cells.
 * Values represent percentage points (0.0 to 100.0%) as published in TWSE tables.
 * Accepts comma-separated or plain decimal numbers or text.
 * Rejects blank, "--", NaN/Infinity, negatives, and values > 100.0.
 */
export function parseNonNegativePercentage(
  value: unknown,
  fieldName: string,
  contextId: string,
): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      fail("INVALID_RATIO_FIELD", `${contextId}.${fieldName}=${value}`);
    }
    if (value < 0) {
      fail("NEGATIVE_VALUE_NOT_ALLOWED", `${contextId}.${fieldName}=${value}`);
    }
    if (value > 100.0) {
      fail("INVALID_RATIO_FIELD", `${contextId}.${fieldName}=${value} > 100.0`);
    }
    return value;
  }
  if (typeof value !== "string") {
    fail("MISSING_REQUIRED_FIELD", `${contextId}.${fieldName}`);
  }
  const clean = value.replaceAll(",", "").trim();
  if (clean === "" || clean === "--") {
    fail("MISSING_REQUIRED_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    fail("INVALID_RATIO_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  const num = Number(clean);
  if (!Number.isFinite(num) || Number.isNaN(num) || num < 0 || num > 100.0) {
    fail("INVALID_RATIO_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  return num;
}

export interface TwseMiQfiisRecord {
  readonly tradeDate: string;
  readonly symbol: "0056";
  readonly securityName: string;
  readonly issuedShares: number;
  readonly foreignHeldShares: number;
  readonly foreignHoldingRatio: number;
  readonly foreignRemainingInvestableShares: number;
  readonly foreignRemainingInvestableRatio: number;
  readonly statutoryInvestmentLimitRatio: number;
  readonly sourceIdentity: typeof TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY;
  readonly sourceRetrievedAt: string;
}

export interface ParseTwseMiQfiisDailyReportOptions {
  readonly symbol: string;
  readonly sourceRetrievedAt: string;
  readonly expectedTradeDate?: string;
}

interface TableBinding {
  readonly fields: readonly string[];
  readonly data: readonly unknown[];
  readonly symbolIndex: number;
  readonly nameIndex: number;
  readonly issuedSharesIndex: number;
  readonly foreignRemainingInvestableSharesIndex: number;
  readonly foreignHeldSharesIndex: number;
  readonly foreignRemainingInvestableRatioIndex: number;
  readonly foreignHoldingRatioIndex: number;
  readonly statutoryInvestmentLimitRatioIndex: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function uniqueHeaderIndex(fields: readonly string[], header: string): number {
  const hits: number[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    if (fields[i] === header) hits.push(i);
  }
  if (hits.length !== 1) {
    fail("SOURCE_SCHEMA_UNRESOLVED", `expected unique header ${header}, found ${hits.length}`);
  }
  return hits[0]!;
}

function bindTable(fieldsRaw: unknown, dataRaw: unknown): TableBinding | null {
  if (!Array.isArray(fieldsRaw) || !Array.isArray(dataRaw)) return null;
  const fields = fieldsRaw.map((field) => String(field).trim());

  const requiredHeaders = [
    "證券代號",
    "證券名稱",
    "發行股數",
    "外資及陸資尚可投資股數",
    "全體外資及陸資持有股數",
    "外資及陸資尚可投資比率",
    "全體外資及陸資持股比率",
    "外資及陸資共用法令投資上限比率",
  ];

  for (const req of requiredHeaders) {
    if (!fields.includes(req)) return null;
  }

  const symbolIndex = uniqueHeaderIndex(fields, "證券代號");
  const nameIndex = uniqueHeaderIndex(fields, "證券名稱");
  const issuedSharesIndex = uniqueHeaderIndex(fields, "發行股數");
  const foreignRemainingInvestableSharesIndex = uniqueHeaderIndex(fields, "外資及陸資尚可投資股數");
  const foreignHeldSharesIndex = uniqueHeaderIndex(fields, "全體外資及陸資持有股數");
  const foreignRemainingInvestableRatioIndex = uniqueHeaderIndex(fields, "外資及陸資尚可投資比率");
  const foreignHoldingRatioIndex = uniqueHeaderIndex(fields, "全體外資及陸資持股比率");
  const statutoryInvestmentLimitRatioIndex = uniqueHeaderIndex(fields, "外資及陸資共用法令投資上限比率");

  return {
    fields: Object.freeze(fields),
    data: dataRaw,
    symbolIndex,
    nameIndex,
    issuedSharesIndex,
    foreignRemainingInvestableSharesIndex,
    foreignHeldSharesIndex,
    foreignRemainingInvestableRatioIndex,
    foreignHoldingRatioIndex,
    statutoryInvestmentLimitRatioIndex,
  };
}

function locateUniqueSecurityTable(json: Record<string, unknown>): TableBinding {
  // Case 1: Top-level fields and data
  if (json["fields"] && json["data"]) {
    const bound = bindTable(json["fields"], json["data"]);
    if (bound) return bound;
  }

  // Case 2: Multi-table response (tables array)
  if (Array.isArray(json["tables"])) {
    const bindings: TableBinding[] = [];
    for (const rawTable of json["tables"]) {
      const table = asRecord(rawTable);
      if (!table) continue;
      const bound = bindTable(table["fields"], table["data"]);
      if (bound) bindings.push(bound);
    }
    if (bindings.length === 1) {
      return bindings[0]!;
    }
    if (bindings.length > 1) {
      fail(
        "SOURCE_SCHEMA_UNRESOLVED",
        `expected exactly one per-security foreign ownership table, found ${bindings.length}`,
      );
    }
  }

  fail("SOURCE_SCHEMA_UNRESOLVED", "could not locate valid MI_QFIIS per-security fields and data table");
}

export function parseTwseMiQfiisDailyReport(
  payload: string | Record<string, unknown>,
  options: ParseTwseMiQfiisDailyReportOptions,
): TwseMiQfiisRecord {
  if (options.symbol !== TWSE_MI_QFIIS_TARGET_SYMBOL) {
    fail("INVALID_SYMBOL", options.symbol);
  }
  if (options.sourceRetrievedAt.trim().length === 0) {
    fail("MISSING_REQUIRED_FIELD", "sourceRetrievedAt");
  }

  let json: Record<string, unknown>;
  if (typeof payload === "string") {
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      fail("INVALID_JSON", "could not parse MI_QFIIS JSON payload");
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
    const expectedTradeDate = parseRocOrIsoDateToIso(options.expectedTradeDate);
    requireCanonicalIsoDate(expectedTradeDate, "expectedTradeDate");
    if (tradeDate !== expectedTradeDate) {
      fail("INVALID_DATE_FORMAT", `expected ${expectedTradeDate} but report has ${tradeDate}`);
    }
  }

  const binding = locateUniqueSecurityTable(json);
  const matches: unknown[][] = [];
  for (const rawRow of binding.data) {
    if (!Array.isArray(rawRow)) {
      fail("ROW_WIDTH_MISMATCH", `${tradeDate}: non-array data row`);
    }
    if (rawRow.length !== binding.fields.length) {
      fail(
        "ROW_WIDTH_MISMATCH",
        `${tradeDate}: row width ${rawRow.length} !== fields width ${binding.fields.length}`,
      );
    }
    const code = String(rawRow[binding.symbolIndex] ?? "").trim();
    if (code === options.symbol) matches.push(rawRow);
  }
  if (matches.length === 0) {
    fail("ABSENT_SYMBOL_ROW", `${options.symbol}:${tradeDate}`);
  }
  if (matches.length > 1) {
    fail("DUPLICATE_SYMBOL_ROWS", `${options.symbol}:${tradeDate}:count=${matches.length}`);
  }

  const row = matches[0]!;
  const securityName = String(row[binding.nameIndex] ?? "").trim();
  if (securityName.length === 0) {
    fail("MISSING_REQUIRED_FIELD", `${options.symbol}:${tradeDate}:securityName`);
  }

  const contextId = `${options.symbol}:${tradeDate}`;
  return Object.freeze({
    tradeDate,
    symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
    securityName,
    issuedShares: parseNonNegativeSafeInteger(row[binding.issuedSharesIndex], "issuedShares", contextId),
    foreignHeldShares: parseNonNegativeSafeInteger(
      row[binding.foreignHeldSharesIndex],
      "foreignHeldShares",
      contextId,
    ),
    foreignHoldingRatio: parseNonNegativePercentage(
      row[binding.foreignHoldingRatioIndex],
      "foreignHoldingRatio",
      contextId,
    ),
    foreignRemainingInvestableShares: parseNonNegativeSafeInteger(
      row[binding.foreignRemainingInvestableSharesIndex],
      "foreignRemainingInvestableShares",
      contextId,
    ),
    foreignRemainingInvestableRatio: parseNonNegativePercentage(
      row[binding.foreignRemainingInvestableRatioIndex],
      "foreignRemainingInvestableRatio",
      contextId,
    ),
    statutoryInvestmentLimitRatio: parseNonNegativePercentage(
      row[binding.statutoryInvestmentLimitRatioIndex],
      "statutoryInvestmentLimitRatio",
      contextId,
    ),
    sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
    sourceRetrievedAt: options.sourceRetrievedAt,
  });
}

export function serializeTwseMiQfiisToCsv(records: readonly TwseMiQfiisRecord[]): string {
  const header = TWSE_MI_QFIIS_CSV_HEADER_FIELDS.join(",");
  const lines = [header];
  for (const record of records) {
    lines.push(
      [
        record.tradeDate,
        record.symbol,
        record.securityName,
        String(record.issuedShares),
        String(record.foreignHeldShares),
        String(record.foreignHoldingRatio),
        String(record.foreignRemainingInvestableShares),
        String(record.foreignRemainingInvestableRatio),
        String(record.statutoryInvestmentLimitRatio),
        record.sourceIdentity,
        record.sourceRetrievedAt,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseTwseMiQfiisCsvText(csvText: string): readonly TwseMiQfiisRecord[] {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    fail("MALFORMED_CSV_HEADER", "empty csv");
  }
  const header = lines[0]!;
  const expected = TWSE_MI_QFIIS_CSV_HEADER_FIELDS.join(",");
  if (header !== expected) {
    fail("MALFORMED_CSV_HEADER", header);
  }
  const records: TwseMiQfiisRecord[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i]!.split(",");
    if (cols.length !== TWSE_MI_QFIIS_CSV_HEADER_FIELDS.length) {
      fail("ROW_WIDTH_MISMATCH", `line ${i + 1}`);
    }
    const tradeDate = cols[0]!;
    requireCanonicalIsoDate(tradeDate, `line ${i + 1}:tradeDate`);
    if (seen.has(tradeDate)) fail("DUPLICATE_TRADE_DATE", `duplicate trade date: ${tradeDate}`);
    seen.add(tradeDate);
    const symbol = cols[1]!;
    if (symbol !== TWSE_MI_QFIIS_TARGET_SYMBOL) fail("INVALID_SYMBOL", symbol);
    const securityName = cols[2]!;
    if (securityName.trim().length === 0) fail("MISSING_REQUIRED_FIELD", `${tradeDate}:securityName`);
    records.push(
      Object.freeze({
        tradeDate,
        symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
        securityName,
        issuedShares: parseNonNegativeSafeInteger(cols[3], "issuedShares", tradeDate),
        foreignHeldShares: parseNonNegativeSafeInteger(cols[4], "foreignHeldShares", tradeDate),
        foreignHoldingRatio: parseNonNegativePercentage(cols[5], "foreignHoldingRatio", tradeDate),
        foreignRemainingInvestableShares: parseNonNegativeSafeInteger(
          cols[6],
          "foreignRemainingInvestableShares",
          tradeDate,
        ),
        foreignRemainingInvestableRatio: parseNonNegativePercentage(
          cols[7],
          "foreignRemainingInvestableRatio",
          tradeDate,
        ),
        statutoryInvestmentLimitRatio: parseNonNegativePercentage(
          cols[8],
          "statutoryInvestmentLimitRatio",
          tradeDate,
        ),
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: cols[10] ?? "",
      }),
    );
  }
  for (let i = 1; i < records.length; i += 1) {
    if (compareIsoDate(records[i]!.tradeDate, records[i - 1]!.tradeDate) <= 0) {
      fail(
        "OUT_OF_ORDER_RECORDS",
        `row ${i} (${records[i]!.tradeDate}) <= row ${i - 1} (${records[i - 1]!.tradeDate})`,
      );
    }
  }
  return Object.freeze(records);
}

export function isMiQfiisRecordEligibleForFeatureDate(
  record: TwseMiQfiisRecord,
  featureDate: string,
): boolean {
  requireCanonicalIsoDate(record.tradeDate, "record.tradeDate");
  requireCanonicalIsoDate(featureDate, "featureDate");
  return record.tradeDate < featureDate;
}

export function filterEligibleMiQfiisRecords(
  records: readonly TwseMiQfiisRecord[],
  featureDate: string,
): readonly TwseMiQfiisRecord[] {
  requireCanonicalIsoDate(featureDate, "featureDate");
  return Object.freeze(records.filter((record) => isMiQfiisRecordEligibleForFeatureDate(record, featureDate)));
}

export interface TwseMiQfiisCutoffCoverage {
  readonly cutoff: string;
  readonly priorEligibleObservationCount: number;
  readonly latestPriorTradeDate: string;
}

export interface TwseMiQfiisManifest {
  readonly schemaVersion: typeof TWSE_MI_QFIIS_SCHEMA_VERSION;
  readonly sourceIdentity: typeof TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY;
  readonly officialSourceIdentity: typeof TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY;
  readonly sourceOwner: typeof TWSE_MI_QFIIS_SOURCE_OWNER;
  readonly sourceFamily: typeof TWSE_MI_QFIIS_SOURCE_FAMILY;
  readonly officialQueryPage: typeof TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE;
  readonly officialEndpointTemplate: typeof TWSE_MI_QFIIS_ENDPOINT_TEMPLATE;
  readonly symbol: typeof TWSE_MI_QFIIS_TARGET_SYMBOL;
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly earliestObservedDate: string;
  readonly latestObservedDate: string;
  readonly rowCount: number;
  readonly sourceRetrievedAt: string;
  readonly acquisitionTimestampProvenanceOnly: string;
  readonly csvSha256: string;
  readonly pitRule: typeof TWSE_MI_QFIIS_STRICT_PIT_RULE;
  readonly strictPitRule: typeof TWSE_MI_QFIIS_STRICT_PIT_RULE;
  readonly sameDayEligibility: false;
  readonly exactHistoricalPublicationMinuteUsed: false;
  readonly fieldDefinitions: typeof TWSE_MI_QFIIS_FIELD_DEFINITIONS;
  readonly duplicateTradeDateCount: number;
  readonly malformedRowCount: number;
  readonly missing0056ObservationCount: number;
  readonly dataQualityMetrics: {
    readonly requestedDateRange: { readonly start: string; readonly end: string };
    readonly successfulOfficialResponses: number;
    readonly nonTradingNoDataDates: number;
    readonly normalized0056Rows: number;
    readonly earliestObservedDate: string;
    readonly latestObservedDate: string;
    readonly duplicateTradeDates: number;
    readonly malformedRows: number;
    readonly missing0056RowsOnDataDates: number;
    readonly chronologicalOrdering: "PASS" | "FAIL";
  };
  readonly cutoffCoverage: readonly TwseMiQfiisCutoffCoverage[];
  readonly ratioUnitSemantics: string;
  readonly revisionSemantics: string;
  readonly qualificationClassification:
    | "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED"
    | "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_BLOCKED";
}

export interface TwseMiQfiisManifestBuildInput {
  readonly records: readonly TwseMiQfiisRecord[];
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly sourceRetrievedAt: string;
  readonly csvSha256: string;
  readonly successfulOfficialResponses: number;
  readonly nonTradingNoDataDates: number;
  readonly duplicateTradeDateCount: number;
  readonly malformedRowCount: number;
  readonly missing0056ObservationCount: number;
  readonly cutoffs?: readonly string[];
}

export function buildTwseMiQfiisSourceManifest(input: TwseMiQfiisManifestBuildInput): TwseMiQfiisManifest {
  requireCanonicalIsoDate(input.requestedStartDate, "requestedStartDate");
  requireCanonicalIsoDate(input.requestedEndDate, "requestedEndDate");
  if (input.sourceRetrievedAt.trim().length === 0) {
    fail("MISSING_REQUIRED_FIELD", "sourceRetrievedAt");
  }
  if (!/^[0-9a-f]{64}$/.test(input.csvSha256)) {
    fail("INVALID_NUMERIC_FIELD", `csvSha256=${input.csvSha256}`);
  }

  const observed = input.records.slice().sort((left, right) => compareIsoDate(left.tradeDate, right.tradeDate));
  const seen = new Set<string>();
  let duplicateTradeDateCount = input.duplicateTradeDateCount;
  let chronologicalOrdering: "PASS" | "FAIL" = "PASS";
  for (let i = 0; i < observed.length; i += 1) {
    const record = observed[i]!;
    if (record.symbol !== TWSE_MI_QFIIS_TARGET_SYMBOL) fail("INVALID_SYMBOL", record.symbol);
    requireCanonicalIsoDate(record.tradeDate, "tradeDate");
    if (seen.has(record.tradeDate)) duplicateTradeDateCount += 1;
    seen.add(record.tradeDate);
    if (i > 0 && compareIsoDate(record.tradeDate, observed[i - 1]!.tradeDate) <= 0) {
      chronologicalOrdering = "FAIL";
    }
  }

  const earliestObservedDate = observed[0]?.tradeDate ?? "";
  const latestObservedDate = observed[observed.length - 1]?.tradeDate ?? "";
  const cutoffs = validateCutoffDates(input.cutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES);
  const cutoffCoverage = cutoffs.map((cutoff) => {
    const prior = observed.filter((record) => record.tradeDate < cutoff);
    return Object.freeze({
      cutoff,
      priorEligibleObservationCount: prior.length,
      latestPriorTradeDate: prior.length > 0 ? prior[prior.length - 1]!.tradeDate : "NONE",
    });
  });

  const substantialCoverage = cutoffCoverage.every((row) => row.priorEligibleObservationCount > 0);
  const intervalCovered =
    earliestObservedDate !== "" &&
    latestObservedDate !== "" &&
    earliestObservedDate <= input.requestedStartDate &&
    latestObservedDate >= input.requestedEndDate;
  const passes =
    observed.length > 0 &&
    duplicateTradeDateCount === 0 &&
    input.malformedRowCount === 0 &&
    input.missing0056ObservationCount === 0 &&
    chronologicalOrdering === "PASS" &&
    substantialCoverage &&
    intervalCovered &&
    observed.every((record) => record.symbol === TWSE_MI_QFIIS_TARGET_SYMBOL);

  return Object.freeze({
    schemaVersion: TWSE_MI_QFIIS_SCHEMA_VERSION,
    sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
    officialSourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
    sourceOwner: TWSE_MI_QFIIS_SOURCE_OWNER,
    sourceFamily: TWSE_MI_QFIIS_SOURCE_FAMILY,
    officialQueryPage: TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE,
    officialEndpointTemplate: TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
    symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    earliestObservedDate,
    latestObservedDate,
    rowCount: observed.length,
    sourceRetrievedAt: input.sourceRetrievedAt,
    acquisitionTimestampProvenanceOnly: input.sourceRetrievedAt,
    csvSha256: input.csvSha256,
    pitRule: TWSE_MI_QFIIS_STRICT_PIT_RULE,
    strictPitRule: TWSE_MI_QFIIS_STRICT_PIT_RULE,
    sameDayEligibility: false,
    exactHistoricalPublicationMinuteUsed: false,
    fieldDefinitions: TWSE_MI_QFIIS_FIELD_DEFINITIONS,
    duplicateTradeDateCount,
    malformedRowCount: input.malformedRowCount,
    missing0056ObservationCount: input.missing0056ObservationCount,
    dataQualityMetrics: Object.freeze({
      requestedDateRange: Object.freeze({
        start: input.requestedStartDate,
        end: input.requestedEndDate,
      }),
      successfulOfficialResponses: input.successfulOfficialResponses,
      nonTradingNoDataDates: input.nonTradingNoDataDates,
      normalized0056Rows: observed.length,
      earliestObservedDate,
      latestObservedDate,
      duplicateTradeDates: duplicateTradeDateCount,
      malformedRows: input.malformedRowCount,
      missing0056RowsOnDataDates: input.missing0056ObservationCount,
      chronologicalOrdering,
    }),
    cutoffCoverage: Object.freeze(cutoffCoverage),
    ratioUnitSemantics:
      "Official ratio fields (foreignHoldingRatio, foreignRemainingInvestableRatio, statutoryInvestmentLimitRatio) represent percentage points (0.0 to 100.0%) as published in TWSE tables.",
    revisionSemantics:
      "V1 uses official current-day foreign & mainland investor shareholding statistics. Same-day eligibility is forbidden. sourceRetrievedAt is retrieval provenance only and is not a historical publication timestamp. Exact historical publication minutes are not used.",
    qualificationClassification: passes
      ? "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED"
      : "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_BLOCKED",
  });
}
