import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  createFrozenMeanReversionStrategy,
  CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH,
  CROSS_SYMBOL_VALIDATION_SYMBOLS,
  loadFrozenCrossSymbolChallenger,
} from "./crossSymbolWinRateValidationV1.js";
import { wilsonLowerBound95 } from "./winRateOptimizerV2.js";
import {
  formatTwdMinor,
  ZSCORE_HISTORICAL_CUTOFF,
  ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
  ZSCORE_SELECTION_ARTIFACT_PATH,
  type ZScoreMetrics,
  type ZScoreParameters,
} from "./zscoreWinRateSelector.js";
import {
  ROLLING_ZSCORE_MEAN_REVERSION_V1,
  RollingZScoreMeanReversionV1Strategy,
} from "./zscoreStrategy.js";
import {
  CROSS_SYMBOL_RESEARCH_RISK_V1,
  type CrossSymbolResearchRiskProfile,
} from "./crossSymbolResearchRisk.js";

export const ZSCORE_FORWARD_SYMBOLS = CROSS_SYMBOL_VALIDATION_SYMBOLS;
export const ZSCORE_FORWARD_DATA_DIRECTORY = "data/market/forward/cross-symbol-v1" as const;
export const ZSCORE_FORWARD_CSV_PATH = `${ZSCORE_FORWARD_DATA_DIRECTORY}/cross_symbol_forward.csv` as const;
export const ZSCORE_FORWARD_PROVENANCE_PATH = `${ZSCORE_FORWARD_DATA_DIRECTORY}/provenance.json` as const;
export const ZSCORE_FORWARD_RESULT_PATH = "packages/paper-trading/zscore-cross-symbol-forward-v1.json" as const;
export const ZSCORE_RISK_NORMALIZED_FORWARD_DATA_DIRECTORY = "data/market/forward/cross-symbol-risk-normalized-v1" as const;
export const ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH = `${ZSCORE_RISK_NORMALIZED_FORWARD_DATA_DIRECTORY}/cross_symbol_forward.csv` as const;
export const ZSCORE_RISK_NORMALIZED_FORWARD_PROVENANCE_PATH = `${ZSCORE_RISK_NORMALIZED_FORWARD_DATA_DIRECTORY}/provenance.json` as const;
export const ZSCORE_RISK_NORMALIZED_FORWARD_RESULT_PATH = "packages/paper-trading/zscore-risk-normalized-cross-symbol-forward-v1.json" as const;
export const ZSCORE_RISK_NORMALIZED_TASK_BRANCH = "feat/cross-symbol-research-risk-profile-v1" as const;
export const ZSCORE_RISK_NORMALIZED_FREEZE_COMMIT_SUBJECT = "feat(paper): freeze risk-normalized zscore challenger" as const;
export const ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID = "cross-symbol-risk-normalized-forward-v1" as const;
export const ZSCORE_FORWARD_EVALUATOR_VERSION = "TWSE exchangeReport/STOCK_DAY monthly report API response=json" as const;
export const ZSCORE_FORWARD_SOURCE = "TWSE STOCK_DAY monthly report API" as const;
export const ZSCORE_FORWARD_CSV_SOURCE = "twse/STOCK_DAY" as const;
export const ZSCORE_FORWARD_TASK_BRANCH = "feat/zscore-cross-symbol-win-rate-v1" as const;
export const ZSCORE_FREEZE_COMMIT_SUBJECT = "feat(paper): freeze zscore win-rate challenger" as const;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FRESH_CSV_HEADER = "symbol,date,open,high,low,close,volume,source";
const SOURCE_PROFILE = "twse-daily-ohlcv-close-v1" as const;
const MIN_SYMBOLS_WITH_TRADES = 3;
const MIN_AGGREGATE_TRADES = 12;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const PRICE_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export interface FreshMarketRow {
  readonly symbol: string;
  readonly date: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly source: typeof ZSCORE_FORWARD_CSV_SOURCE;
}

interface FreshProvenance {
  readonly schemaVersion: 1;
  readonly artifactId: "cross-symbol-forward-v1" | typeof ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID;
  readonly symbols: typeof ZSCORE_FORWARD_SYMBOLS;
  readonly source: typeof ZSCORE_FORWARD_SOURCE;
  readonly providerVersion: typeof ZSCORE_FORWARD_EVALUATOR_VERSION;
  readonly fetchedAtUtc: string;
  readonly historicalCutoff: typeof ZSCORE_HISTORICAL_CUTOFF;
  readonly actualDateRange: { readonly start: string | null; readonly end: string | null };
  readonly perSymbolRowCounts: Readonly<Record<string, number>>;
  readonly sha256: string;
  readonly purpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION";
  readonly sourceUrls: readonly string[];
}

interface FreshDataPaths {
  readonly directory: string;
  readonly csv: string;
  readonly provenance: string;
  readonly artifactId: FreshProvenance["artifactId"];
}

const LEGACY_FRESH_DATA_PATHS: FreshDataPaths = Object.freeze({
  directory: ZSCORE_FORWARD_DATA_DIRECTORY,
  csv: ZSCORE_FORWARD_CSV_PATH,
  provenance: ZSCORE_FORWARD_PROVENANCE_PATH,
  artifactId: "cross-symbol-forward-v1",
});

const RISK_NORMALIZED_FRESH_DATA_PATHS: FreshDataPaths = Object.freeze({
  directory: ZSCORE_RISK_NORMALIZED_FORWARD_DATA_DIRECTORY,
  csv: ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH,
  provenance: ZSCORE_RISK_NORMALIZED_FORWARD_PROVENANCE_PATH,
  artifactId: ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID,
});

interface InternalMetrics extends ZScoreMetrics {
  readonly netPnlMinor: bigint;
  readonly feesMinor: bigint;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function toTwdMinor(value: string, label: string): bigint {
  if (!PRICE_PATTERN.test(value)) throw new TypeError(`${label} must be a positive decimal with at most two places`);
  const [integer = "0", fraction = ""] = value.split(".");
  const minor = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (minor <= 0n) throw new TypeError(`${label} must be greater than zero`);
  return minor;
}

function validateMarketRow(row: FreshMarketRow, label: string): void {
  if (!(ZSCORE_FORWARD_SYMBOLS as readonly string[]).includes(row.symbol)) {
    throw new TypeError(`${label} has an unsupported symbol`);
  }
  if (!validDate(row.date) || row.date <= ZSCORE_HISTORICAL_CUTOFF) {
    throw new TypeError(`${label} must be strictly after the historical cutoff with a valid date`);
  }
  if (row.source !== ZSCORE_FORWARD_CSV_SOURCE) throw new TypeError(`${label} has an unsupported source`);
  const open = toTwdMinor(row.open, `${label}.open`);
  const high = toTwdMinor(row.high, `${label}.high`);
  const low = toTwdMinor(row.low, `${label}.low`);
  const close = toTwdMinor(row.close, `${label}.close`);
  if (high < open || high < close || low > open || low > close || high < low) {
    throw new TypeError(`${label} has inconsistent OHLC values`);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(row.volume)) throw new TypeError(`${label}.volume must be a non-negative integer`);
}

function parseFreshCsv(contents: string): readonly FreshMarketRow[] {
  if (contents.includes("\r") && /\r(?!\n)/.test(contents)) throw new TypeError("fresh CSV must use LF or CRLF line endings");
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== FRESH_CSV_HEADER) throw new TypeError("fresh CSV has an unsupported header");

  const rows: FreshMarketRow[] = [];
  const bySymbolDate = new Map<string, FreshMarketRow>();
  let previousPolicyOrder = -1;
  let previousDate = "";
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(",");
    if (fields.length !== 8 || fields.some((field) => field === "" || field.trim() !== field)) {
      throw new TypeError(`fresh CSV row ${index + 2} must contain eight non-empty unquoted fields`);
    }
    const [symbol, date, open, high, low, close, volume, source] = fields as [string, string, string, string, string, string, string, string];
    const row: FreshMarketRow = Object.freeze({
      symbol,
      date,
      open,
      high,
      low,
      close,
      volume,
      source: source as typeof ZSCORE_FORWARD_CSV_SOURCE,
    });
    validateMarketRow(row, `fresh CSV row ${index + 2}`);
    const duplicateKey = `${symbol}\u0000${date}`;
    if (bySymbolDate.has(duplicateKey)) throw new TypeError(`fresh CSV has a duplicate symbol/date: ${symbol} ${date}`);
    bySymbolDate.set(duplicateKey, row);
    const policyOrder = ZSCORE_FORWARD_SYMBOLS.indexOf(symbol as (typeof ZSCORE_FORWARD_SYMBOLS)[number]);
    if (policyOrder < previousPolicyOrder || (policyOrder === previousPolicyOrder && date <= previousDate)) {
      throw new TypeError("fresh CSV rows must follow the fixed symbol order and chronological date order");
    }
    previousPolicyOrder = policyOrder;
    previousDate = date;
    rows.push(row);
  }
  return Object.freeze(rows);
}

export function validateFreshCrossSymbolCsv(contents: string): readonly FreshMarketRow[] {
  return parseFreshCsv(contents);
}

export function serializeFreshCrossSymbolCsv(rows: readonly FreshMarketRow[]): string {
  const ordered = rows.slice().sort((left, right) => {
    const leftSymbol = ZSCORE_FORWARD_SYMBOLS.indexOf(left.symbol as (typeof ZSCORE_FORWARD_SYMBOLS)[number]);
    const rightSymbol = ZSCORE_FORWARD_SYMBOLS.indexOf(right.symbol as (typeof ZSCORE_FORWARD_SYMBOLS)[number]);
    if (leftSymbol !== rightSymbol) return leftSymbol - rightSymbol;
    return left.date < right.date ? -1 : left.date > right.date ? 1 : 0;
  });
  return `${FRESH_CSV_HEADER}\n${ordered.map((row) => [
    row.symbol, row.date, row.open, row.high, row.low, row.close, row.volume, row.source,
  ].join(",")).join("\n")}${ordered.length > 0 ? "\n" : ""}`;
}

function rocDateToIso(value: string): string {
  const match = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (!match) throw new TypeError(`TWSE STOCK_DAY returned an invalid ROC date: ${value}`);
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!validDate(iso)) throw new TypeError(`TWSE STOCK_DAY returned an invalid calendar date: ${value}`);
  return iso;
}

function decimalCell(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError(`${label} is not a numeric cell`);
  const normalized = String(value).replaceAll(",", "");
  if (!PRICE_PATTERN.test(normalized)) throw new TypeError(`${label} is not a valid OHLC price`);
  return normalized;
}

function volumeCell(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError(`${label} is not a numeric volume cell`);
  const normalized = String(value).replaceAll(",", "");
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) throw new TypeError(`${label} is not a valid whole-share volume`);
  return normalized;
}

function indexOfField(fields: readonly unknown[], name: string): number {
  const index = fields.indexOf(name);
  if (index < 0) throw new TypeError(`TWSE STOCK_DAY response is missing the ${name} field`);
  return index;
}

function parseTwseMonthPayload(payload: unknown, symbol: string, requestedMonth: string, throughDate: string): readonly FreshMarketRow[] {
  const response = asRecord(payload, "TWSE STOCK_DAY response");
  const status = response["stat"];
  const rawRows = response["data"];
  if (status === "很抱歉，沒有符合條件的資料!" && Array.isArray(rawRows) && rawRows.length === 0) return Object.freeze([]);
  if (status !== "OK" || !Array.isArray(response["fields"]) || !Array.isArray(rawRows)) {
    throw new TypeError(`TWSE STOCK_DAY response for ${symbol} ${requestedMonth} was not successful`);
  }
  const fields = response["fields"];
  const dateIndex = indexOfField(fields, "日期");
  const volumeIndex = indexOfField(fields, "成交股數");
  const openIndex = indexOfField(fields, "開盤價");
  const highIndex = indexOfField(fields, "最高價");
  const lowIndex = indexOfField(fields, "最低價");
  const closeIndex = indexOfField(fields, "收盤價");
  const monthKey = requestedMonth.slice(0, 6);
  const rows: FreshMarketRow[] = [];
  for (const [index, value] of rawRows.entries()) {
    if (!Array.isArray(value) || value.length !== fields.length) throw new TypeError(`TWSE STOCK_DAY row ${index + 1} is malformed`);
    const date = rocDateToIso(String(value[dateIndex]));
    if (date.slice(0, 7).replace("-", "") !== monthKey) throw new TypeError(`TWSE STOCK_DAY returned an out-of-month date for ${symbol}`);
    if (date <= ZSCORE_HISTORICAL_CUTOFF || date > throughDate) continue;
    const row: FreshMarketRow = Object.freeze({
      symbol,
      date,
      open: decimalCell(value[openIndex], `${symbol} ${date} open`),
      high: decimalCell(value[highIndex], `${symbol} ${date} high`),
      low: decimalCell(value[lowIndex], `${symbol} ${date} low`),
      close: decimalCell(value[closeIndex], `${symbol} ${date} close`),
      volume: volumeCell(value[volumeIndex], `${symbol} ${date} volume`),
      source: ZSCORE_FORWARD_CSV_SOURCE,
    });
    validateMarketRow(row, `${symbol} ${date}`);
    rows.push(row);
  }
  return Object.freeze(rows);
}

async function fetchTwseMonth(url: string, symbol: string, month: string, throughDate: string): Promise<readonly FreshMarketRow[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`TWSE request timeout: ${url}`)), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.status === 307 || response.status === 429 || response.status === 503) {
        throw new Error(`TWSE rate limit / challenge HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new TypeError(`TWSE response for ${symbol} ${month} was not JSON`);
      }
      return parseTwseMonthPayload(payload, symbol, month, throughDate);
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_RETRIES) await new Promise((resolveDelay) => setTimeout(resolveDelay, 400 * attempt));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "unknown TWSE request error";
  throw new Error(`TWSE STOCK_DAY fetch failed for ${symbol} ${month} after ${MAX_RETRIES} attempts: ${detail}`);
}

function taipeiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

function monthsFromCutoffTo(endDate: string): readonly string[] {
  const [cutoffYear = "", cutoffMonth = ""] = ZSCORE_HISTORICAL_CUTOFF.split("-");
  const [endYear = "", endMonth = ""] = endDate.split("-");
  let year = Number(cutoffYear);
  let month = Number(cutoffMonth);
  const lastYear = Number(endYear);
  const lastMonth = Number(endMonth);
  const months: string[] = [];
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}${String(month).padStart(2, "0")}01`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return Object.freeze(months);
}

function monthsFromDateTo(startDate: string, endDate: string): readonly string[] {
  if (!validDate(startDate) || !validDate(endDate)) throw new TypeError("forward fetch dates must be valid ISO dates");
  if (startDate > endDate) return Object.freeze([]);
  const [startYear = "", startMonth = ""] = startDate.split("-");
  const [endYear = "", endMonth = ""] = endDate.split("-");
  let year = Number(startYear);
  let month = Number(startMonth);
  const lastYear = Number(endYear);
  const lastMonth = Number(endMonth);
  const months: string[] = [];
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}${String(month).padStart(2, "0")}01`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return Object.freeze(months);
}

function rangeFor(rows: readonly FreshMarketRow[]): { readonly start: string | null; readonly end: string | null } {
  if (rows.length === 0) return Object.freeze({ start: null, end: null });
  const dates = rows.map(({ date }) => date).sort();
  return Object.freeze({ start: dates[0]!, end: dates.at(-1)! });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function parseFreshProvenance(
  value: unknown,
  expectedArtifactId: FreshProvenance["artifactId"] = "cross-symbol-forward-v1",
): FreshProvenance {
  const provenance = asRecord(value, "fresh cross-symbol provenance");
  if (
    provenance["schemaVersion"] !== 1
    || provenance["artifactId"] !== expectedArtifactId
    || provenance["source"] !== ZSCORE_FORWARD_SOURCE
    || provenance["providerVersion"] !== ZSCORE_FORWARD_EVALUATOR_VERSION
    || provenance["historicalCutoff"] !== ZSCORE_HISTORICAL_CUTOFF
    || provenance["purpose"] !== "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION"
  ) {
    throw new TypeError("fresh cross-symbol provenance has an unsupported identity or purpose");
  }
  if (JSON.stringify(provenance["symbols"]) !== JSON.stringify(ZSCORE_FORWARD_SYMBOLS)) {
    throw new TypeError("fresh cross-symbol provenance must preserve the four fixed symbols in policy order");
  }
  const fetchedAtUtc = provenance["fetchedAtUtc"];
  const sha = provenance["sha256"];
  if (typeof fetchedAtUtc !== "string" || !validUtcTimestamp(fetchedAtUtc)) throw new TypeError("fetchedAtUtc must be a canonical UTC timestamp");
  if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) throw new TypeError("fresh data sha256 must be a lowercase SHA-256 digest");
  const dateRange = asRecord(provenance["actualDateRange"], "provenance.actualDateRange");
  const start = dateRange["start"];
  const end = dateRange["end"];
  if (start !== null && (typeof start !== "string" || !validDate(start))) throw new TypeError("actualDateRange.start is invalid");
  if (end !== null && (typeof end !== "string" || !validDate(end))) throw new TypeError("actualDateRange.end is invalid");
  if ((start === null) !== (end === null) || (typeof start === "string" && typeof end === "string" && start > end)) {
    throw new TypeError("actualDateRange is inconsistent");
  }
  const rowCounts = asRecord(provenance["perSymbolRowCounts"], "provenance.perSymbolRowCounts");
  const normalizedCounts: Record<string, number> = {};
  for (const symbol of ZSCORE_FORWARD_SYMBOLS) {
    const count = rowCounts[symbol];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`perSymbolRowCounts.${symbol} must be a non-negative safe integer`);
    }
    normalizedCounts[symbol] = count;
  }
  if (Object.keys(rowCounts).some((symbol) => !(ZSCORE_FORWARD_SYMBOLS as readonly string[]).includes(symbol))) {
    throw new TypeError("perSymbolRowCounts contains an unsupported symbol");
  }
  const sourceUrls = provenance["sourceUrls"];
  if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string" || !url.startsWith("https://www.twse.com.tw/exchangeReport/STOCK_DAY?"))) {
    throw new TypeError("sourceUrls must identify the official TWSE STOCK_DAY endpoint");
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactId: expectedArtifactId,
    symbols: ZSCORE_FORWARD_SYMBOLS,
    source: ZSCORE_FORWARD_SOURCE,
    providerVersion: ZSCORE_FORWARD_EVALUATOR_VERSION,
    fetchedAtUtc,
    historicalCutoff: ZSCORE_HISTORICAL_CUTOFF,
    actualDateRange: Object.freeze({ start: start as string | null, end: end as string | null }),
    perSymbolRowCounts: Object.freeze(normalizedCounts),
    sha256: sha,
    purpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION",
    sourceUrls: Object.freeze(sourceUrls as string[]),
  });
}

function validateFreshProvenanceRows(
  rows: readonly FreshMarketRow[],
  provenance: FreshProvenance,
  freshDataSha256: string,
): void {
  if (provenance.sha256 !== freshDataSha256) throw new TypeError("fresh CSV SHA-256 does not match its provenance");
  const range = rangeFor(rows);
  if (range.start !== provenance.actualDateRange.start || range.end !== provenance.actualDateRange.end) {
    throw new TypeError("fresh CSV date range does not match its provenance");
  }
  for (const symbol of ZSCORE_FORWARD_SYMBOLS) {
    const count = rows.filter((row) => row.symbol === symbol).length;
    if (count !== provenance.perSymbolRowCounts[symbol]) throw new TypeError(`fresh CSV row count does not match provenance for ${symbol}`);
  }
}

function validateFrozenChallenger(
  value: unknown,
  requireRiskProfile = false,
): { readonly id: string; readonly parameters: ZScoreParameters } {
  const artifact = asRecord(value, "frozen z-score selection artifact");
  const selected = asRecord(artifact["selectedFutureCandidate"], "selectedFutureCandidate");
  if (requireRiskProfile) {
    const riskProfile = asRecord(artifact["riskProfile"], "riskProfile");
    if (
      riskProfile["id"] !== CROSS_SYMBOL_RESEARCH_RISK_V1.id
      || riskProfile["initialCapitalMinor"] !== Number(CROSS_SYMBOL_RESEARCH_RISK_V1.initialCapitalMinor)
      || riskProfile["maxExposureMinor"] !== Number(CROSS_SYMBOL_RESEARCH_RISK_V1.maxExposureMinor)
      || riskProfile["maxExposureFractionOfInitialCapital"] !== CROSS_SYMBOL_RESEARCH_RISK_V1.maxExposureFractionOfInitialCapital
      || riskProfile["currency"] !== CROSS_SYMBOL_RESEARCH_RISK_V1.currency
      || riskProfile["minorUnitsPerMajor"] !== CROSS_SYMBOL_RESEARCH_RISK_V1.minorUnitsPerMajor
    ) {
      throw new TypeError("frozen z-score artifact does not identify the fixed cross-symbol research risk profile");
    }
  }
  if (
    artifact["schemaVersion"] !== 1
    || artifact["strategyFamily"] !== ROLLING_ZSCORE_MEAN_REVERSION_V1
    || artifact["objective"] !== "WIN_RATE_WILSON_LOWER_BOUND_95"
    || artifact["historicalInputSha256"] !== "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7"
    || artifact["historicalDataEnd"] !== ZSCORE_HISTORICAL_CUTOFF
    || artifact["selectionStatus"] !== "SELECTED_FUTURE_CANDIDATE"
    || selected["strategyFamily"] !== ROLLING_ZSCORE_MEAN_REVERSION_V1
  ) {
    throw new TypeError("frozen z-score artifact is incomplete or has an unsupported selection identity");
  }
  const rawParameters = asRecord(selected["parameters"], "selectedFutureCandidate.parameters");
  const parameterKeys = Object.keys(rawParameters).sort();
  if (JSON.stringify(parameterKeys) !== JSON.stringify(["entryZ", "exitZ", "lookback", "maxHoldBars"].sort())) {
    throw new TypeError("frozen z-score parameters have unsupported fields");
  }
  const lookback = rawParameters["lookback"];
  const entryZ = rawParameters["entryZ"];
  const exitZ = rawParameters["exitZ"];
  const maxHoldBars = rawParameters["maxHoldBars"];
  if (!Number.isSafeInteger(lookback) || (lookback as number) <= 0) {
    throw new TypeError("frozen z-score lookback must be a positive safe integer");
  }
  if (typeof entryZ !== "number" || !Number.isFinite(entryZ) || entryZ <= 0) {
    throw new TypeError("frozen z-score entryZ must be a positive finite number");
  }
  if (typeof exitZ !== "number" || !Number.isFinite(exitZ) || exitZ >= entryZ) {
    throw new TypeError("frozen z-score exitZ must be finite and below entryZ");
  }
  if (!Number.isSafeInteger(maxHoldBars) || (maxHoldBars as number) <= 0) {
    throw new TypeError("frozen z-score maxHoldBars must be a positive safe integer");
  }
  const parameters: ZScoreParameters = Object.freeze({
    lookback: lookback as number,
    entryZ,
    exitZ,
    maxHoldBars: maxHoldBars as number,
  });
  const formatZ = (number: number): string => {
    const fixed = number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return fixed.startsWith("-") ? `neg${fixed.slice(1).replace(".", "p")}` : fixed.replace(".", "p");
  };
  const derivedId = `lookback-${parameters.lookback}-entryz-${formatZ(parameters.entryZ)}-exitz-${formatZ(parameters.exitZ)}-hold-${parameters.maxHoldBars}`;
  if (selected["id"] !== derivedId) throw new TypeError("frozen z-score candidate id does not match its authority parameters");
  const diagnostics = artifact["candidateDiagnostics"];
  if (!Array.isArray(diagnostics) || diagnostics.length !== 24) throw new TypeError("frozen artifact must record all 24 candidate diagnostics");
  return Object.freeze({ id: derivedId, parameters });
}

export function validateRiskNormalizedFrozenSelection(value: unknown): {
  readonly id: string;
  readonly parameters: ZScoreParameters;
} {
  return validateFrozenChallenger(value, true);
}

function tradeMetrics(
  parsed: ParsedHistoricalCsv,
  inputSha256: string,
  strategy: Parameters<typeof runPaperSession>[3],
  researchRiskProfile?: CrossSymbolResearchRiskProfile,
): InternalMetrics {
  const result = runPaperSession(parsed.session, inputSha256, undefined, strategy, researchRiskProfile);
  const statistics = asRecord(result["tradingStatistics"], "paper session tradingStatistics");
  const account = asRecord(result["accountSummary"], "paper session accountSummary");
  const completedTrades = statistics["completedTrades"];
  if (!Array.isArray(completedTrades)) throw new TypeError("paper session completedTrades must be an array");
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "completeTradeCount");
  const WIN = safeCount(statistics["wins"], "wins");
  const LOSS = safeCount(statistics["losses"], "losses");
  const BREAKEVEN = safeCount(statistics["breakevens"], "breakevens");
  if (completedTradeCount !== completedTrades.length || completedTradeCount !== WIN + LOSS + BREAKEVEN) {
    throw new Error(`fresh completed-trade outcomes do not reconcile for ${parsed.symbol}`);
  }
  const netPnlMinor = completedTrades.reduce((sum: bigint, rawTrade: unknown, index: number) => {
    const trade = asRecord(rawTrade, `completedTrades[${index}]`);
    const amount = trade["netPnlMinor"];
    if (typeof amount !== "bigint") throw new TypeError(`completedTrades[${index}].netPnlMinor is not a bigint`);
    return sum + amount;
  }, 0n);
  const feesMinor = account["feesPaidMinor"];
  if (typeof feesMinor !== "bigint" || feesMinor < 0n) throw new TypeError("account fees are not a non-negative bigint");
  return Object.freeze({
    completedTradeCount,
    WIN,
    LOSS,
    BREAKEVEN,
    rawNetWinRate: completedTradeCount === 0 ? null : WIN / completedTradeCount,
    WilsonLowerBound95: wilsonLowerBound95(WIN, completedTradeCount),
    netPnl: formatTwdMinor(netPnlMinor),
    fees: formatTwdMinor(feesMinor),
    netPnlMinor,
    feesMinor,
  });
}

function emptyMetrics(): InternalMetrics {
  return Object.freeze({
    completedTradeCount: 0,
    WIN: 0,
    LOSS: 0,
    BREAKEVEN: 0,
    rawNetWinRate: null,
    WilsonLowerBound95: null,
    netPnl: "0.00",
    fees: "0.00",
    netPnlMinor: 0n,
    feesMinor: 0n,
  });
}

function publicMetrics(metrics: InternalMetrics): ZScoreMetrics {
  return Object.freeze({
    completedTradeCount: metrics.completedTradeCount,
    WIN: metrics.WIN,
    LOSS: metrics.LOSS,
    BREAKEVEN: metrics.BREAKEVEN,
    rawNetWinRate: metrics.rawNetWinRate,
    WilsonLowerBound95: metrics.WilsonLowerBound95,
    netPnl: metrics.netPnl,
    fees: metrics.fees,
  });
}

function aggregateMetrics(perSymbol: readonly InternalMetrics[]): InternalMetrics {
  const completedTradeCount = perSymbol.reduce((sum, metric) => sum + metric.completedTradeCount, 0);
  const WIN = perSymbol.reduce((sum, metric) => sum + metric.WIN, 0);
  const LOSS = perSymbol.reduce((sum, metric) => sum + metric.LOSS, 0);
  const BREAKEVEN = perSymbol.reduce((sum, metric) => sum + metric.BREAKEVEN, 0);
  const netPnlMinor = perSymbol.reduce((sum, metric) => sum + metric.netPnlMinor, 0n);
  const feesMinor = perSymbol.reduce((sum, metric) => sum + metric.feesMinor, 0n);
  return Object.freeze({
    completedTradeCount,
    WIN,
    LOSS,
    BREAKEVEN,
    rawNetWinRate: completedTradeCount === 0 ? null : WIN / completedTradeCount,
    WilsonLowerBound95: wilsonLowerBound95(WIN, completedTradeCount),
    netPnl: formatTwdMinor(netPnlMinor),
    fees: formatTwdMinor(feesMinor),
    netPnlMinor,
    feesMinor,
  });
}

export function isFreshEvidenceSufficient(metrics: {
  readonly perSymbol: readonly { readonly completedTradeCount: number }[];
  readonly aggregate: { readonly completedTradeCount: number };
}): boolean {
  return metrics.perSymbol.length === ZSCORE_FORWARD_SYMBOLS.length
    && metrics.perSymbol.filter(({ completedTradeCount }) => completedTradeCount >= 1).length >= MIN_SYMBOLS_WITH_TRADES
    && metrics.aggregate.completedTradeCount >= MIN_AGGREGATE_TRADES;
}

export function decideFreshWinRateImprovement(
  legacy: { readonly WilsonLowerBound95: number | null },
  challenger: { readonly WilsonLowerBound95: number | null },
  sufficient: boolean,
): "YES" | "NO" | "NOT EVALUABLE" {
  if (!sufficient || legacy.WilsonLowerBound95 === null || challenger.WilsonLowerBound95 === null) return "NOT EVALUABLE";
  return challenger.WilsonLowerBound95 > legacy.WilsonLowerBound95 ? "YES" : "NO";
}

function resultAggregate(metrics: InternalMetrics): Record<string, unknown> {
  return Object.freeze({
    aggregateCompletedTrades: metrics.completedTradeCount,
    aggregateW: metrics.WIN,
    aggregateL: metrics.LOSS,
    aggregateBE: metrics.BREAKEVEN,
    aggregateRawNetWinRate: metrics.rawNetWinRate,
    aggregateWilsonLowerBound95: metrics.WilsonLowerBound95,
    netPnl: metrics.netPnl,
    fees: metrics.fees,
  });
}

export function evaluateZScoreCrossSymbolForward(input: {
  readonly freshDataBytes: Uint8Array;
  readonly freshProvenance: unknown;
  readonly legacyReferenceArtifact: unknown;
  readonly frozenSelectionArtifact: unknown;
  readonly frozenSelectionCommit: string;
  readonly researchRiskProfile?: CrossSymbolResearchRiskProfile;
  readonly freshArtifactId?: FreshProvenance["artifactId"];
}): Record<string, unknown> {
  if (!/^[a-f0-9]{40}$/.test(input.frozenSelectionCommit)) throw new TypeError("frozenSelectionCommit must be a full lowercase commit SHA");
  const legacy = loadFrozenCrossSymbolChallenger(input.legacyReferenceArtifact);
  const challenger = validateFrozenChallenger(input.frozenSelectionArtifact);
  const freshDataSha256 = sha256(input.freshDataBytes);
  const provenance = parseFreshProvenance(input.freshProvenance, input.freshArtifactId ?? "cross-symbol-forward-v1");
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(input.freshDataBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`fresh cross-symbol CSV is not valid UTF-8: ${detail}`);
  }
  const rows = parseFreshCsv(contents);
  validateFreshProvenanceRows(rows, provenance, freshDataSha256);
  const freshDateRange = rangeFor(rows);
  const perSymbolInternal = ZSCORE_FORWARD_SYMBOLS.map((symbol) => {
    const symbolRows = rows.filter((row) => row.symbol === symbol);
    if (symbolRows.length === 0) return Object.freeze({ symbol, legacy: emptyMetrics(), challenger: emptyMetrics() });
    const csv = `${FRESH_CSV_HEADER}\n${symbolRows.map((row) => [
      row.symbol, row.date, row.open, row.high, row.low, row.close, row.volume, row.source,
    ].join(",")).join("\n")}\n`;
    const parsed = parseHistoricalCsv(csv, symbol, ZSCORE_FORWARD_CSV_PATH, SOURCE_PROFILE);
    if (parsed.rowCount !== symbolRows.length || parsed.startDate <= ZSCORE_HISTORICAL_CUTOFF) {
      throw new TypeError(`fresh parsed rows do not reconcile for ${symbol}`);
    }
    const legacyMetrics = tradeMetrics(
      parsed,
      freshDataSha256,
      createFrozenMeanReversionStrategy(legacy),
      input.researchRiskProfile,
    );
    const challengerMetrics = tradeMetrics(
      parsed,
      freshDataSha256,
      new RollingZScoreMeanReversionV1Strategy(challenger.parameters),
      input.researchRiskProfile,
    );
    return Object.freeze({ symbol, legacy: legacyMetrics, challenger: challengerMetrics });
  });
  const legacyPerSymbol = Object.freeze(perSymbolInternal.map(({ symbol, legacy: metrics }) => Object.freeze({ symbol, ...publicMetrics(metrics) })));
  const challengerPerSymbol = Object.freeze(perSymbolInternal.map(({ symbol, challenger: metrics }) => Object.freeze({ symbol, ...publicMetrics(metrics) })));
  const legacyAggregate = aggregateMetrics(perSymbolInternal.map(({ legacy: metrics }) => metrics));
  const challengerAggregate = aggregateMetrics(perSymbolInternal.map(({ challenger: metrics }) => metrics));
  const legacySufficient = isFreshEvidenceSufficient({ perSymbol: legacyPerSymbol, aggregate: legacyAggregate });
  const challengerSufficient = isFreshEvidenceSufficient({ perSymbol: challengerPerSymbol, aggregate: challengerAggregate });
  const sufficient = legacySufficient && challengerSufficient;
  const tradingWinRateImprovement = decideFreshWinRateImprovement(legacyAggregate, challengerAggregate, sufficient);

  return Object.freeze({
    schemaVersion: 1,
    frozenSelectionCommit: input.frozenSelectionCommit,
    ...(input.researchRiskProfile === undefined ? {} : {
      riskProfile: Object.freeze({
        id: input.researchRiskProfile.id,
        initialCapitalMinor: Number(input.researchRiskProfile.initialCapitalMinor),
        maxExposureMinor: Number(input.researchRiskProfile.maxExposureMinor),
        maxExposureFractionOfInitialCapital: input.researchRiskProfile.maxExposureFractionOfInitialCapital,
        currency: input.researchRiskProfile.currency,
        minorUnitsPerMajor: input.researchRiskProfile.minorUnitsPerMajor,
      }),
    }),
    freshDataSha256,
    freshDateRange,
    freshSymbols: ZSCORE_FORWARD_SYMBOLS,
    freshRowsBySymbol: Object.freeze(Object.fromEntries(ZSCORE_FORWARD_SYMBOLS.map((symbol) => [
      symbol,
      rows.filter((row) => row.symbol === symbol).length,
    ]))),
    legacyReference: Object.freeze({
      identity: legacy.strategyFamily,
      candidateId: legacy.id,
      parameters: legacy.parameters,
      perSymbol: legacyPerSymbol,
      aggregate: resultAggregate(legacyAggregate),
    }),
    newFrozenChallenger: Object.freeze({
      identity: ROLLING_ZSCORE_MEAN_REVERSION_V1,
      candidateId: challenger.id,
      parameters: challenger.parameters,
      perSymbol: challengerPerSymbol,
      aggregate: resultAggregate(challengerAggregate),
    }),
    freshEvidenceSufficiency: Object.freeze({
      requirements: Object.freeze({
        minimumSymbolsWithAtLeastOneCompletedTrade: MIN_SYMBOLS_WITH_TRADES,
        minimumAggregateCompletedTrades: MIN_AGGREGATE_TRADES,
      }),
      legacyReference: Object.freeze({
        symbolsWithCompletedTrades: legacyPerSymbol.filter(({ completedTradeCount }) => completedTradeCount >= 1).length,
        aggregateCompletedTrades: legacyAggregate.completedTradeCount,
        sufficient: legacySufficient,
      }),
      newFrozenChallenger: Object.freeze({
        symbolsWithCompletedTrades: challengerPerSymbol.filter(({ completedTradeCount }) => completedTradeCount >= 1).length,
        aggregateCompletedTrades: challengerAggregate.completedTradeCount,
        sufficient: challengerSufficient,
      }),
    }),
    comparisonStatus: sufficient ? "SUFFICIENT_FRESH_TRADES" : "INSUFFICIENT_FRESH_TRADES",
    tradingWinRateImprovement,
  });
}

function officialMonthUrl(month: string, symbol: string): string {
  return `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${month}&stockNo=${symbol}`;
}

export async function fetchZScoreForwardRowsAfter(previousForwardEnd: string): Promise<{
  readonly rows: readonly FreshMarketRow[];
  readonly fetchedAtUtc: string;
}> {
  if (!validDate(previousForwardEnd)) throw new TypeError("previousForwardEnd must be a valid ISO date");
  const throughDate = taipeiDate();
  const fetchedRows: FreshMarketRow[] = [];
  for (const symbol of ZSCORE_FORWARD_SYMBOLS) {
    for (const month of monthsFromDateTo(previousForwardEnd, throughDate)) {
      const url = officialMonthUrl(month, symbol);
      const monthRows = await fetchTwseMonth(url, symbol, month, throughDate);
      fetchedRows.push(...monthRows);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
    }
  }
  const rows = parseFreshCsv(serializeFreshCrossSymbolCsv(fetchedRows));
  return Object.freeze({ rows, fetchedAtUtc: new Date().toISOString() });
}

function currentGitFreezeIdentity(
  expectedBranch: string = ZSCORE_FORWARD_TASK_BRANCH,
  expectedSubject: string = ZSCORE_FREEZE_COMMIT_SUBJECT,
): { readonly head: string; readonly branch: string; readonly subject: string } {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  const subject = execFileSync("git", ["show", "-s", "--format=%s", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  if (branch !== expectedBranch || subject !== expectedSubject || status !== "") {
    throw new TypeError("fresh fetch requires a clean z-score task branch at the Phase A freeze commit");
  }
  return Object.freeze({ head, branch, subject });
}

async function readJson(path: string, label: string): Promise<unknown> {
  const bytes = await readFile(resolve(PROJECT_ROOT, path));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`${label} is not valid UTF-8 JSON: ${detail}`);
  }
}

async function fetchAndWriteFreshData(
  paths: FreshDataPaths = LEGACY_FRESH_DATA_PATHS,
): Promise<{ readonly bytes: Uint8Array; readonly provenance: FreshProvenance }> {
  const throughDate = taipeiDate();
  const months = monthsFromCutoffTo(throughDate);
  const sourceUrls: string[] = [];
  const fetchedRows: FreshMarketRow[] = [];
  for (const symbol of ZSCORE_FORWARD_SYMBOLS) {
    for (const month of months) {
      const url = officialMonthUrl(month, symbol);
      sourceUrls.push(url);
      fetchedRows.push(...await fetchTwseMonth(url, symbol, month, throughDate));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
    }
  }
  const contents = serializeFreshCrossSymbolCsv(fetchedRows);
  const validatedRows = parseFreshCsv(contents);
  const bytes = encodeUtf8(contents);
  const perSymbolRowCounts = Object.fromEntries(ZSCORE_FORWARD_SYMBOLS.map((symbol) => [
    symbol,
    validatedRows.filter((row) => row.symbol === symbol).length,
  ]));
  const provenance: FreshProvenance = Object.freeze({
    schemaVersion: 1,
    artifactId: paths.artifactId,
    symbols: ZSCORE_FORWARD_SYMBOLS,
    source: ZSCORE_FORWARD_SOURCE,
    providerVersion: ZSCORE_FORWARD_EVALUATOR_VERSION,
    fetchedAtUtc: new Date().toISOString(),
    historicalCutoff: ZSCORE_HISTORICAL_CUTOFF,
    actualDateRange: rangeFor(validatedRows),
    perSymbolRowCounts: Object.freeze(perSymbolRowCounts),
    sha256: sha256(bytes),
    purpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION",
    sourceUrls: Object.freeze(sourceUrls),
  });
  const directory = resolve(PROJECT_ROOT, paths.directory);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(PROJECT_ROOT, paths.csv), bytes);
  await writeFile(resolve(PROJECT_ROOT, paths.provenance), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return Object.freeze({ bytes, provenance });
}

async function loadOrFetchFreshData(
  paths: FreshDataPaths = LEGACY_FRESH_DATA_PATHS,
  expectedBranch: string = ZSCORE_FORWARD_TASK_BRANCH,
  expectedSubject: string = ZSCORE_FREEZE_COMMIT_SUBJECT,
  checkFreezeBeforeRead = false,
): Promise<{ readonly bytes: Uint8Array; readonly provenance: unknown }> {
  if (checkFreezeBeforeRead) currentGitFreezeIdentity(expectedBranch, expectedSubject);
  const csvPath = resolve(PROJECT_ROOT, paths.csv);
  let csvExists = true;
  let provenanceExists = true;
  let bytes: Uint8Array | null = null;
  let provenance: unknown = null;
  try { bytes = await readFile(csvPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    csvExists = false;
  }
  try { provenance = await readJson(paths.provenance, "fresh cross-symbol provenance"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    provenanceExists = false;
  }
  if (csvExists !== provenanceExists) throw new TypeError("fresh data CSV and provenance must either both exist or both be absent");
  if (csvExists && bytes !== null) return Object.freeze({ bytes, provenance });
  currentGitFreezeIdentity(expectedBranch, expectedSubject);
  const fetched = await fetchAndWriteFreshData(paths);
  return Object.freeze({ bytes: fetched.bytes, provenance: fetched.provenance });
}

export function serializeZScoreForwardResult(result: Record<string, unknown>): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function runZScoreCrossSymbolForwardEvaluation(): Promise<Record<string, unknown>> {
  const frozenSelectionArtifact = await readJson(ZSCORE_SELECTION_ARTIFACT_PATH, "frozen z-score selection artifact");
  validateFrozenChallenger(frozenSelectionArtifact);
  const { head: frozenSelectionCommit } = currentGitFreezeIdentity();
  const [{ bytes, provenance }, legacyReferenceArtifact] = await Promise.all([
    loadOrFetchFreshData(),
    readJson(CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH, "legacy reference artifact"),
  ]);
  const result = evaluateZScoreCrossSymbolForward({
    freshDataBytes: bytes,
    freshProvenance: provenance,
    legacyReferenceArtifact,
    frozenSelectionArtifact,
    frozenSelectionCommit,
  });
  await writeFile(resolve(PROJECT_ROOT, ZSCORE_FORWARD_RESULT_PATH), serializeZScoreForwardResult(result), "utf8");
  return result;
}

export async function runRiskNormalizedZScoreCrossSymbolForwardEvaluation(): Promise<Record<string, unknown>> {
  const { head: frozenSelectionCommit } = currentGitFreezeIdentity(
    ZSCORE_RISK_NORMALIZED_TASK_BRANCH,
    ZSCORE_RISK_NORMALIZED_FREEZE_COMMIT_SUBJECT,
  );
  const frozenSelectionArtifact = await readJson(
    ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
    "frozen risk-normalized z-score selection artifact",
  );
  validateFrozenChallenger(frozenSelectionArtifact, true);
  const [{ bytes, provenance }, legacyReferenceArtifact] = await Promise.all([
    loadOrFetchFreshData(
      RISK_NORMALIZED_FRESH_DATA_PATHS,
      ZSCORE_RISK_NORMALIZED_TASK_BRANCH,
      ZSCORE_RISK_NORMALIZED_FREEZE_COMMIT_SUBJECT,
      true,
    ),
    readJson(CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH, "legacy reference artifact"),
  ]);
  const result = evaluateZScoreCrossSymbolForward({
    freshDataBytes: bytes,
    freshProvenance: provenance,
    legacyReferenceArtifact,
    frozenSelectionArtifact,
    frozenSelectionCommit,
    researchRiskProfile: CROSS_SYMBOL_RESEARCH_RISK_V1,
    freshArtifactId: ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID,
  });
  await writeFile(
    resolve(PROJECT_ROOT, ZSCORE_RISK_NORMALIZED_FORWARD_RESULT_PATH),
    serializeZScoreForwardResult(result),
    "utf8",
  );
  return result;
}

export function assertNoZScoreForwardCliOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("z-score forward evaluator accepts no symbol, data, strategy, or tuning overrides");
}

async function main(args: readonly string[]): Promise<void> {
  assertNoZScoreForwardCliOverrides(args);
  const result = await runZScoreCrossSymbolForwardEvaluation();
  stdout.write(`${JSON.stringify({
    resultPath: ZSCORE_FORWARD_RESULT_PATH,
    freshDataSha256: result["freshDataSha256"],
    freshDateRange: result["freshDateRange"],
    comparisonStatus: result["comparisonStatus"],
    tradingWinRateImprovement: result["tradingWinRateImprovement"],
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown z-score forward evaluation error";
    stderr.write(`paper:evaluate-zscore-forward: ${message}\n`);
    process.exitCode = 1;
  });
}
