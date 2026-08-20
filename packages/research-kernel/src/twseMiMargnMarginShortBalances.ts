/**
 * Pure, network-free TWSE MI_MARGN daily margin/short-sale balance parser,
 * validator, and qualification kernel for symbol 0056.
 *
 * This module (like the rest of `@mms/research-kernel`) contains no Node built-ins
 * (`node:fs`, `node:crypto`, `Buffer`). File I/O, HTTPS, and SHA-256 are the
 * responsibility of callers/CLI tools.
 *
 * FROZEN POINT-IN-TIME (PIT) CONTRACT:
 * For every future MMS feature row with feature date T:
 *   MI_MARGN_ELIGIBLE(record, T) = record.tradeDate < T
 *
 * Only STRICT PRIOR TRADING-DAY observations may be consumed.
 * Same-day MI_MARGN (tradeDate == featureDate) is FORBIDDEN in V1.
 *
 * `sourceRetrievedAt` is provenance metadata for when this qualification run
 * retrieved the official record. It MUST NOT be used as historicalAvailableAt,
 * publicationTimestamp, or featureEligibilityTimestamp.
 *
 * Exact historical publication minutes are not invented from TWSE evening
 * production notes.
 */

import {
  isCanonicalIsoDate,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  validateCutoffDates,
} from "./twStrategyTemporalRobustness.js";

export const TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY = "TWSE_MI_MARGN_DAILY_MARGIN_TRADING" as const;
export const TWSE_MI_MARGN_SOURCE_OWNER = "Taiwan Stock Exchange Corporation" as const;
export const TWSE_MI_MARGN_SOURCE_FAMILY = "MI_MARGN" as const;
export const TWSE_MI_MARGN_TARGET_SYMBOL = "0056" as const;
export const TWSE_MI_MARGN_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_MI_MARGN_ENDPOINT_TEMPLATE =
  "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=ALL&response=json" as const;
export const TWSE_MI_MARGN_SCHEMA_VERSION = "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCES_MANIFEST_V1" as const;
export const TWSE_MI_MARGN_NO_DATA_STAT = "很抱歉，沒有符合條件的資料" as const;

export const TWSE_MI_MARGN_FIELD_DEFINITIONS = Object.freeze({
  tradeDate: "Official TWSE MI_MARGN report / trading date in ISO YYYY-MM-DD",
  symbol: "Target security ticker symbol (0056)",
  securityName: "Official security short name from the MI_MARGN 名稱 column",
  marginPurchaseBalance:
    "Official current-day 融資 今日餘額 for 0056 as published (source unit: 交易單位)",
  shortSaleBalance:
    "Official current-day 融券 今日餘額 for 0056 as published (source unit: 交易單位)",
  marginPurchasePreviousDayBalance:
    "Official 融資 前日餘額 adjacent raw field for source-integrity checks (not a feature)",
  shortSalePreviousDayBalance:
    "Official 融券 前日餘額 adjacent raw field for source-integrity checks (not a feature)",
  sourceIdentity: "Official provenance identifier (TWSE_MI_MARGN_DAILY_MARGIN_TRADING)",
  sourceRetrievedAt:
    "ISO UTC timestamp when this qualification run retrieved the official record (provenance only; not historicalAvailableAt, publicationTimestamp, or featureEligibilityTimestamp)",
});

export const TWSE_MI_MARGN_CSV_HEADER_FIELDS = Object.freeze([
  "tradeDate",
  "symbol",
  "securityName",
  "marginPurchaseBalance",
  "shortSaleBalance",
  "marginPurchasePreviousDayBalance",
  "shortSalePreviousDayBalance",
  "sourceIdentity",
  "sourceRetrievedAt",
] as const);

export type TwseMiMargnErrorCode =
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
  | "SOURCE_SCHEMA_UNRESOLVED"
  | "ROW_WIDTH_MISMATCH"
  | "NEGATIVE_BALANCE_NOT_ALLOWED"
  | "PIT_VIOLATION_SAME_DAY"
  | "PIT_VIOLATION_FUTURE_DAY";

export class TwseMiMargnQualificationError extends Error {
  readonly code: TwseMiMargnErrorCode;

  constructor(code: TwseMiMargnErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwseMiMargnQualificationError";
    this.code = code;
  }
}

function fail(code: TwseMiMargnErrorCode, detail?: string): never {
  throw new TwseMiMargnQualificationError(code, detail);
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
  const rocMatch = /^(\d{3})\/?(\d{2})\/?(\d{2})$/.exec(clean);
  if (rocMatch) {
    const year = Number(rocMatch[1]) + 1911;
    const iso = `${String(year).padStart(4, "0")}-${rocMatch[2]}-${rocMatch[3]}`;
    if (isCanonicalIsoDate(iso)) return iso;
  }
  fail("INVALID_DATE_FORMAT", dateStr);
}

export function isTwseMiMargnNoDataStat(stat: unknown): boolean {
  return typeof stat === "string" && stat.includes("沒有符合條件的資料");
}

/**
 * Strict non-negative integer parser for official MI_MARGN balance cells.
 * Accepts comma-separated or plain integer text. Rejects blank, "--",
 * non-numeric annotation, NaN/Infinity, and negatives.
 */
export function parseNonNegativeBalanceInteger(
  value: unknown,
  fieldName: string,
  contextId: string,
): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
    }
    if (value < 0) {
      fail("NEGATIVE_BALANCE_NOT_ALLOWED", `${contextId}.${fieldName}=${value}`);
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
  if (!Number.isFinite(num) || !Number.isSafeInteger(num)) {
    fail("INVALID_NUMERIC_FIELD", `${contextId}.${fieldName}=${value}`);
  }
  return num;
}

export interface TwseMiMargnBalanceRecord {
  readonly tradeDate: string;
  readonly symbol: "0056";
  readonly securityName: string;
  readonly marginPurchaseBalance: number;
  readonly shortSaleBalance: number;
  readonly marginPurchasePreviousDayBalance: number;
  readonly shortSalePreviousDayBalance: number;
  readonly sourceIdentity: typeof TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY;
  readonly sourceRetrievedAt: string;
}

export interface ParseTwseMiMargnDailyReportOptions {
  readonly symbol: string;
  readonly sourceRetrievedAt: string;
  readonly expectedTradeDate?: string;
}

interface ColumnGroup {
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseGroups(fields: readonly string[], rawGroups: unknown): readonly ColumnGroup[] | null {
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) return null;
  const groups: ColumnGroup[] = [];
  let cursor = 0;
  for (const raw of rawGroups) {
    const group = asRecord(raw);
    if (!group) return null;
    const title = typeof group["title"] === "string" ? group["title"].trim() : "";
    const span = group["span"];
    if (typeof span !== "number" || !Number.isSafeInteger(span) || span <= 0) return null;
    groups.push({ title, start: cursor, end: cursor + span });
    cursor += span;
  }
  if (cursor !== fields.length) return null;
  return Object.freeze(groups);
}

function indexOfHeaderInRange(
  fields: readonly string[],
  header: string,
  start: number,
  end: number,
  context: string,
): number {
  const hits: number[] = [];
  for (let i = start; i < end; i += 1) {
    if (fields[i] === header) hits.push(i);
  }
  if (hits.length !== 1) {
    fail("SOURCE_SCHEMA_UNRESOLVED", `${context}: expected unique header ${header} in range, found ${hits.length}`);
  }
  return hits[0]!;
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

interface SecurityTableBinding {
  readonly fields: readonly string[];
  readonly data: readonly unknown[];
  readonly symbolIndex: number;
  readonly nameIndex: number;
  readonly marginPurchaseBalanceIndex: number;
  readonly shortSaleBalanceIndex: number;
  readonly marginPurchasePreviousDayIndex: number;
  readonly shortSalePreviousDayIndex: number;
}

function bindSecurityTable(table: Record<string, unknown>): SecurityTableBinding | null {
  const rawFields = table["fields"];
  const rawData = table["data"];
  if (!Array.isArray(rawFields) || !Array.isArray(rawData)) return null;
  const fields = rawFields.map((field) => String(field).trim());
  if (!fields.includes("代號") || !fields.includes("名稱")) return null;
  if (!fields.includes("現金償還") || !fields.includes("現券償還")) return null;

  const groups = parseGroups(fields, table["groups"]);
  let marginStart: number;
  let marginEnd: number;
  let shortStart: number;
  let shortEnd: number;
  if (groups) {
    const marginGroup = groups.find((group) => group.title === "融資");
    const shortGroup = groups.find((group) => group.title === "融券");
    if (!marginGroup || !shortGroup) return null;
    marginStart = marginGroup.start;
    marginEnd = marginGroup.end;
    shortStart = shortGroup.start;
    shortEnd = shortGroup.end;
  } else {
    const cashRepay = uniqueHeaderIndex(fields, "現金償還");
    const stockRepay = uniqueHeaderIndex(fields, "現券償還");
    if (!(cashRepay < stockRepay)) return null;
    marginStart = cashRepay;
    marginEnd = stockRepay;
    shortStart = stockRepay;
    shortEnd = fields.length;
  }

  const symbolIndex = uniqueHeaderIndex(fields, "代號");
  const nameIndex = uniqueHeaderIndex(fields, "名稱");
  const marginPurchaseBalanceIndex = indexOfHeaderInRange(
    fields,
    "今日餘額",
    marginStart,
    marginEnd,
    "融資",
  );
  const shortSaleBalanceIndex = indexOfHeaderInRange(fields, "今日餘額", shortStart, shortEnd, "融券");
  const marginPurchasePreviousDayIndex = indexOfHeaderInRange(
    fields,
    "前日餘額",
    marginStart,
    marginEnd,
    "融資",
  );
  const shortSalePreviousDayIndex = indexOfHeaderInRange(
    fields,
    "前日餘額",
    shortStart,
    shortEnd,
    "融券",
  );

  const cashRepayIndex = uniqueHeaderIndex(fields, "現金償還");
  const stockRepayIndex = uniqueHeaderIndex(fields, "現券償還");
  if (!(cashRepayIndex >= marginStart && cashRepayIndex < marginEnd)) {
    fail("SOURCE_SCHEMA_UNRESOLVED", "現金償還 is not inside the 融資 column group");
  }
  if (!(stockRepayIndex >= shortStart && stockRepayIndex < shortEnd)) {
    fail("SOURCE_SCHEMA_UNRESOLVED", "現券償還 is not inside the 融券 column group");
  }

  return {
    fields: Object.freeze(fields),
    data: rawData,
    symbolIndex,
    nameIndex,
    marginPurchaseBalanceIndex,
    shortSaleBalanceIndex,
    marginPurchasePreviousDayIndex,
    shortSalePreviousDayIndex,
  };
}

function locateUniqueSecurityTable(json: Record<string, unknown>): SecurityTableBinding {
  const tables = json["tables"];
  if (!Array.isArray(tables)) {
    fail("SOURCE_SCHEMA_UNRESOLVED", "tables array");
  }
  const bindings: SecurityTableBinding[] = [];
  for (const rawTable of tables) {
    const table = asRecord(rawTable);
    if (!table) continue;
    const bound = bindSecurityTable(table);
    if (bound) bindings.push(bound);
  }
  if (bindings.length !== 1) {
    fail(
      "SOURCE_SCHEMA_UNRESOLVED",
      `expected exactly one per-security 融資融券 table, found ${bindings.length}`,
    );
  }
  return bindings[0]!;
}

export function parseTwseMiMargnDailyReport(
  payload: string | Record<string, unknown>,
  options: ParseTwseMiMargnDailyReportOptions,
): TwseMiMargnBalanceRecord {
  if (options.symbol !== TWSE_MI_MARGN_TARGET_SYMBOL) {
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
      fail("INVALID_JSON", "could not parse MI_MARGN JSON payload");
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
    symbol: TWSE_MI_MARGN_TARGET_SYMBOL,
    securityName,
    marginPurchaseBalance: parseNonNegativeBalanceInteger(
      row[binding.marginPurchaseBalanceIndex],
      "marginPurchaseBalance",
      contextId,
    ),
    shortSaleBalance: parseNonNegativeBalanceInteger(
      row[binding.shortSaleBalanceIndex],
      "shortSaleBalance",
      contextId,
    ),
    marginPurchasePreviousDayBalance: parseNonNegativeBalanceInteger(
      row[binding.marginPurchasePreviousDayIndex],
      "marginPurchasePreviousDayBalance",
      contextId,
    ),
    shortSalePreviousDayBalance: parseNonNegativeBalanceInteger(
      row[binding.shortSalePreviousDayIndex],
      "shortSalePreviousDayBalance",
      contextId,
    ),
    sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
    sourceRetrievedAt: options.sourceRetrievedAt,
  });
}

export function serializeTwseMiMargnToCsv(records: readonly TwseMiMargnBalanceRecord[]): string {
  const header = TWSE_MI_MARGN_CSV_HEADER_FIELDS.join(",");
  const lines = [header];
  for (const record of records) {
    lines.push(
      [
        record.tradeDate,
        record.symbol,
        record.securityName,
        String(record.marginPurchaseBalance),
        String(record.shortSaleBalance),
        String(record.marginPurchasePreviousDayBalance),
        String(record.shortSalePreviousDayBalance),
        record.sourceIdentity,
        record.sourceRetrievedAt,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseTwseMiMargnCsvText(csvText: string): readonly TwseMiMargnBalanceRecord[] {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    fail("MALFORMED_CSV_HEADER", "empty csv");
  }
  const header = lines[0]!;
  const expected = TWSE_MI_MARGN_CSV_HEADER_FIELDS.join(",");
  if (header !== expected) {
    fail("MALFORMED_CSV_HEADER", header);
  }
  const records: TwseMiMargnBalanceRecord[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i]!.split(",");
    if (cols.length !== TWSE_MI_MARGN_CSV_HEADER_FIELDS.length) {
      fail("ROW_WIDTH_MISMATCH", `line ${i + 1}`);
    }
    const tradeDate = cols[0]!;
    requireCanonicalIsoDate(tradeDate, `line ${i + 1}:tradeDate`);
    if (seen.has(tradeDate)) fail("DUPLICATE_TRADE_DATE", `duplicate trade date: ${tradeDate}`);
    seen.add(tradeDate);
    const symbol = cols[1]!;
    if (symbol !== TWSE_MI_MARGN_TARGET_SYMBOL) fail("INVALID_SYMBOL", symbol);
    const securityName = cols[2]!;
    if (securityName.trim().length === 0) fail("MISSING_REQUIRED_FIELD", `${tradeDate}:securityName`);
    records.push(
      Object.freeze({
        tradeDate,
        symbol: TWSE_MI_MARGN_TARGET_SYMBOL,
        securityName,
        marginPurchaseBalance: parseNonNegativeBalanceInteger(cols[3], "marginPurchaseBalance", tradeDate),
        shortSaleBalance: parseNonNegativeBalanceInteger(cols[4], "shortSaleBalance", tradeDate),
        marginPurchasePreviousDayBalance: parseNonNegativeBalanceInteger(
          cols[5],
          "marginPurchasePreviousDayBalance",
          tradeDate,
        ),
        shortSalePreviousDayBalance: parseNonNegativeBalanceInteger(
          cols[6],
          "shortSalePreviousDayBalance",
          tradeDate,
        ),
        sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: cols[8] ?? "",
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

export function isMiMargnRecordEligibleForFeatureDate(
  record: TwseMiMargnBalanceRecord,
  featureDate: string,
): boolean {
  requireCanonicalIsoDate(record.tradeDate, "record.tradeDate");
  requireCanonicalIsoDate(featureDate, "featureDate");
  return record.tradeDate < featureDate;
}

export function filterEligibleMiMargnRecords(
  records: readonly TwseMiMargnBalanceRecord[],
  featureDate: string,
): readonly TwseMiMargnBalanceRecord[] {
  requireCanonicalIsoDate(featureDate, "featureDate");
  return Object.freeze(records.filter((record) => isMiMargnRecordEligibleForFeatureDate(record, featureDate)));
}

export interface TwseMiMargnCutoffCoverage {
  readonly cutoff: string;
  readonly priorEligibleObservationCount: number;
  readonly latestPriorTradeDate: string;
}

export interface TwseMiMargnManifest {
  readonly schemaVersion: typeof TWSE_MI_MARGN_SCHEMA_VERSION;
  readonly sourceIdentity: typeof TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY;
  readonly officialSourceIdentity: typeof TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY;
  readonly sourceOwner: typeof TWSE_MI_MARGN_SOURCE_OWNER;
  readonly sourceFamily: typeof TWSE_MI_MARGN_SOURCE_FAMILY;
  readonly endpointTemplate: typeof TWSE_MI_MARGN_ENDPOINT_TEMPLATE;
  readonly symbol: "0056";
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly earliestObservedDate: string;
  readonly latestObservedDate: string;
  readonly rowCount: number;
  readonly sourceRetrievedAt: string;
  readonly acquisitionTimestampProvenanceOnly: string;
  readonly csvSha256: string;
  readonly pitRule: typeof TWSE_MI_MARGN_STRICT_PIT_RULE;
  readonly strictPitRule: typeof TWSE_MI_MARGN_STRICT_PIT_RULE;
  readonly sameDayEligibility: false;
  readonly exactHistoricalPublicationMinuteUsed: false;
  readonly fieldDefinitions: typeof TWSE_MI_MARGN_FIELD_DEFINITIONS;
  readonly duplicateTradeDateCount: number;
  readonly malformedRowCount: number;
  readonly missingSymbolObservationCount: number;
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
  readonly cutoffCoverage: readonly TwseMiMargnCutoffCoverage[];
  readonly revisionSemantics: string;
  readonly qualificationClassification:
    | "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCE_SOURCE_QUALIFIED"
    | "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCE_SOURCE_BLOCKED";
}

export interface TwseMiMargnManifestBuildInput {
  readonly records: readonly TwseMiMargnBalanceRecord[];
  readonly requestedStartDate: string;
  readonly requestedEndDate: string;
  readonly sourceRetrievedAt: string;
  readonly csvSha256: string;
  readonly successfulOfficialResponses: number;
  readonly nonTradingNoDataDates: number;
  readonly duplicateTradeDateCount: number;
  readonly malformedRowCount: number;
  readonly missingSymbolObservationCount: number;
  readonly cutoffs?: readonly string[];
}

export function buildTwseMiMargnSourceManifest(input: TwseMiMargnManifestBuildInput): TwseMiMargnManifest {
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
    if (record.symbol !== TWSE_MI_MARGN_TARGET_SYMBOL) fail("INVALID_SYMBOL", record.symbol);
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
    input.missingSymbolObservationCount === 0 &&
    chronologicalOrdering === "PASS" &&
    substantialCoverage &&
    intervalCovered &&
    observed.every((record) => record.symbol === TWSE_MI_MARGN_TARGET_SYMBOL);

  return Object.freeze({
    schemaVersion: TWSE_MI_MARGN_SCHEMA_VERSION,
    sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
    officialSourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
    sourceOwner: TWSE_MI_MARGN_SOURCE_OWNER,
    sourceFamily: TWSE_MI_MARGN_SOURCE_FAMILY,
    endpointTemplate: TWSE_MI_MARGN_ENDPOINT_TEMPLATE,
    symbol: TWSE_MI_MARGN_TARGET_SYMBOL,
    requestedStartDate: input.requestedStartDate,
    requestedEndDate: input.requestedEndDate,
    earliestObservedDate,
    latestObservedDate,
    rowCount: observed.length,
    sourceRetrievedAt: input.sourceRetrievedAt,
    acquisitionTimestampProvenanceOnly: input.sourceRetrievedAt,
    csvSha256: input.csvSha256,
    pitRule: TWSE_MI_MARGN_STRICT_PIT_RULE,
    strictPitRule: TWSE_MI_MARGN_STRICT_PIT_RULE,
    sameDayEligibility: false,
    exactHistoricalPublicationMinuteUsed: false,
    fieldDefinitions: TWSE_MI_MARGN_FIELD_DEFINITIONS,
    duplicateTradeDateCount,
    malformedRowCount: input.malformedRowCount,
    missingSymbolObservationCount: input.missingSymbolObservationCount,
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
      missing0056RowsOnDataDates: input.missingSymbolObservationCount,
      chronologicalOrdering,
    }),
    cutoffCoverage: Object.freeze(cutoffCoverage),
    revisionSemantics:
      "V1 uses official current-day 今日餘額 balances. Same-day eligibility is forbidden. sourceRetrievedAt is retrieval provenance only and is not a historical publication timestamp. Exact historical publication minutes are not used.",
    qualificationClassification: passes
      ? "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCE_SOURCE_QUALIFIED"
      : "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCE_SOURCE_BLOCKED",
  });
}
