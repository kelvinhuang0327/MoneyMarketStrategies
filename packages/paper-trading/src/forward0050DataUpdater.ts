import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORWARD_0050_V1_CSV_PATH = "data/market/forward/0050-forward-v1/0050_forward.csv" as const;
export const FORWARD_0050_V1_PROVENANCE_PATH = "data/market/forward/0050-forward-v1/provenance.json" as const;
export const FORWARD_0050_V2_CSV_PATH = "data/market/forward/0050-forward-v2/0050_forward.csv" as const;
export const FORWARD_0050_V2_PROVENANCE_PATH = "data/market/forward/0050-forward-v2/provenance.json" as const;
export const FORWARD_0050_V2_ARTIFACT_ID = "0050-forward-v2" as const;
export const FORWARD_0050_HISTORICAL_CUTOFF = "2026-08-11" as const;
export const TWSE_STOCK_DAY_SOURCE = "TWSE STOCK_DAY monthly report API" as const;
export const TWSE_STOCK_DAY_ENDPOINT = "https://www.twse.com.tw/exchangeReport/STOCK_DAY" as const;

const CSV_HEADER = "symbol,date,open,high,low,close,volume,source";
const CSV_SOURCE = "twse/STOCK_DAY" as const;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_REQUEST_MS = 15_000;

export interface Forward0050Row {
  readonly symbol: "0050";
  readonly date: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly source: typeof CSV_SOURCE;
}

interface Forward0050Provenance {
  readonly schemaVersion: 1;
  readonly artifactId: "0050-forward-v1" | typeof FORWARD_0050_V2_ARTIFACT_ID;
  readonly symbol: "0050";
  readonly source: typeof TWSE_STOCK_DAY_SOURCE;
  readonly fetchedAtUtc: string;
  readonly dateRange: { readonly start: string | null; readonly end: string | null };
  readonly rowCount: number;
  readonly sha256: string;
  readonly historicalCutoff: typeof FORWARD_0050_HISTORICAL_CUTOFF;
  readonly purpose: "FORWARD_EVALUATION_ONLY";
  readonly sourceUrls: readonly string[];
  readonly throughDate?: string;
  readonly baseArtifact?: { readonly artifactId: string; readonly sha256: string };
  readonly refreshes?: readonly {
    readonly fetchedAtUtc: string;
    readonly throughDate: string;
    readonly sourceUrls: readonly string[];
    readonly newRowCount: number;
  }[];
}

export interface Forward0050RefreshResult {
  readonly artifactId: typeof FORWARD_0050_V2_ARTIFACT_ID;
  readonly dateRange: { readonly start: string | null; readonly end: string | null };
  readonly rowCount: number;
  readonly newRowCount: number;
  readonly sha256: string;
  readonly fetchedAtUtc: string;
  readonly throughDate: string;
  readonly sourceUrls: readonly string[];
}

export interface TwseMonthRowFetcher {
  (url: string): Promise<unknown>;
}

export interface Forward0050RefreshOptions {
  readonly root?: string;
  readonly throughDate?: string;
  readonly fetchedAtUtc?: string;
  readonly fetchMonth?: TwseMonthRowFetcher;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toTwdMinor(value: string, label: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new TypeError(`${label} must be a positive TWD price with at most two decimal places`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const minor = whole * 100n + fraction;
  if (minor <= 0n) throw new TypeError(`${label} must be greater than zero`);
  return minor;
}

function validateRow(row: Forward0050Row, label: string): void {
  if (row.symbol !== "0050" || row.source !== CSV_SOURCE) throw new TypeError(`${label} has an unsupported symbol or source`);
  if (!validDate(row.date) || row.date <= FORWARD_0050_HISTORICAL_CUTOFF) {
    throw new TypeError(`${label} must be after the frozen historical cutoff`);
  }
  const open = toTwdMinor(row.open, `${label}.open`);
  const high = toTwdMinor(row.high, `${label}.high`);
  const low = toTwdMinor(row.low, `${label}.low`);
  const close = toTwdMinor(row.close, `${label}.close`);
  if (high < open || high < close || low > open || low > close || high < low) {
    throw new TypeError(`${label} has inconsistent OHLC values`);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(row.volume)) throw new TypeError(`${label}.volume must be a non-negative whole-share count`);
}

function canonicalRow(row: Forward0050Row): string {
  return [row.symbol, row.date, row.open, row.high, row.low, row.close, row.volume, row.source].join(",");
}

function parseCsv(bytes: Uint8Array, label: string): readonly Forward0050Row[] {
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
  if (contents.includes("\r") && /\r(?!\n)/.test(contents)) throw new TypeError(`${label} must use LF or CRLF line endings`);
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== CSV_HEADER) throw new TypeError(`${label} has an unsupported header`);
  const rows: Forward0050Row[] = [];
  const seen = new Set<string>();
  let previousDate = "";
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(",");
    if (fields.length !== 8 || fields.some((field) => field === "" || field.trim() !== field)) {
      throw new TypeError(`${label} row ${index + 2} must contain eight non-empty unquoted fields`);
    }
    const [symbol, date, open, high, low, close, volume, source] = fields as [string, string, string, string, string, string, string, string];
    const row: Forward0050Row = Object.freeze({
      symbol: symbol as "0050",
      date,
      open,
      high,
      low,
      close,
      volume,
      source: source as typeof CSV_SOURCE,
    });
    validateRow(row, `${label} row ${index + 2}`);
    if (seen.has(date)) throw new TypeError(`${label} has duplicate date ${date}`);
    if (date <= previousDate) throw new TypeError(`${label} rows are not in chronological order`);
    seen.add(date);
    previousDate = date;
    rows.push(row);
  }
  return Object.freeze(rows);
}

function serializeCsv(rows: readonly Forward0050Row[]): Uint8Array {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) throw new Error("forward data row disappeared during serialization");
    validateRow(row, `forward row ${index + 1}`);
    if (index > 0 && row.date <= (rows[index - 1]?.date ?? "")) {
      throw new TypeError("forward rows must be strictly chronological and unique");
    }
  }
  const content = `${CSV_HEADER}\n${rows.map(canonicalRow).join("\n")}${rows.length > 0 ? "\n" : ""}`;
  return new TextEncoder().encode(content);
}

function rangeFor(rows: readonly Forward0050Row[]): { readonly start: string | null; readonly end: string | null } {
  return Object.freeze({ start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null });
}

function parseRocDate(value: string): string {
  const match = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (!match) throw new TypeError(`TWSE STOCK_DAY returned invalid ROC date ${value}`);
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!validDate(date)) throw new TypeError(`TWSE STOCK_DAY returned invalid calendar date ${value}`);
  return date;
}

function numericCell(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError(`${label} is not a numeric TWSE cell`);
  return String(value).replaceAll(",", "").trim();
}

function monthIndex(month: string): number {
  if (!/^\d{6}$/.test(month)) throw new TypeError("TWSE month must use YYYYMM format");
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(4, 6));
  if (monthNumber < 1 || monthNumber > 12) throw new TypeError("TWSE month has an invalid month number");
  return year * 12 + monthNumber - 1;
}

function monthsFromLastDateTo(lastDate: string, throughDate: string): readonly string[] {
  if (!validDate(lastDate) || !validDate(throughDate) || throughDate < lastDate) {
    throw new TypeError("forward refresh dates are invalid or out of order");
  }
  const start = lastDate.slice(0, 7).replace("-", "");
  const end = throughDate.slice(0, 7).replace("-", "");
  const months: string[] = [];
  for (let index = monthIndex(start); index <= monthIndex(end); index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    months.push(`${year}${String(month).padStart(2, "0")}`);
  }
  return Object.freeze(months);
}

export function twseStockDayUrl(month: string, symbol = "0050"): string {
  monthIndex(month);
  if (symbol !== "0050") throw new TypeError("0050 forward updater does not accept another symbol");
  return `${TWSE_STOCK_DAY_ENDPOINT}?response=json&date=${month}01&stockNo=0050`;
}

export function parseTwse0050MonthResponse(
  payload: unknown,
  month: string,
  throughDate: string,
): readonly Forward0050Row[] {
  monthIndex(month);
  if (!validDate(throughDate)) throw new TypeError("throughDate must be a valid ISO date");
  const response = asRecord(payload, "TWSE STOCK_DAY response");
  const status = response["stat"];
  const rawRows = response["data"];
  if (status === "很抱歉，沒有符合條件的資料!" && Array.isArray(rawRows) && rawRows.length === 0) {
    return Object.freeze([]);
  }
  if (status !== "OK" || !Array.isArray(response["fields"]) || !Array.isArray(rawRows)) {
    throw new TypeError(`TWSE STOCK_DAY response for 0050 ${month} was not successful`);
  }
  const fields = response["fields"] as readonly unknown[];
  const column = (name: string) => {
    const index = fields.indexOf(name);
    if (index < 0) throw new TypeError(`TWSE STOCK_DAY response is missing ${name}`);
    return index;
  };
  const dateIndex = column("日期");
  const volumeIndex = column("成交股數");
  const openIndex = column("開盤價");
  const highIndex = column("最高價");
  const lowIndex = column("最低價");
  const closeIndex = column("收盤價");
  const result = new Map<string, Forward0050Row>();
  for (const [index, value] of rawRows.entries()) {
    if (!Array.isArray(value) || value.length !== fields.length) {
      throw new TypeError(`TWSE STOCK_DAY row ${index + 1} is malformed`);
    }
    const date = parseRocDate(String(value[dateIndex]));
    if (date.slice(0, 7).replace("-", "") !== month) {
      throw new TypeError(`TWSE STOCK_DAY returned a date outside ${month}`);
    }
    if (date <= FORWARD_0050_HISTORICAL_CUTOFF || date > throughDate) continue;
    const row: Forward0050Row = Object.freeze({
      symbol: "0050",
      date,
      open: numericCell(value[openIndex], `${date}.open`),
      high: numericCell(value[highIndex], `${date}.high`),
      low: numericCell(value[lowIndex], `${date}.low`),
      close: numericCell(value[closeIndex], `${date}.close`),
      volume: numericCell(value[volumeIndex], `${date}.volume`),
      source: CSV_SOURCE,
    });
    validateRow(row, `0050 ${date}`);
    const existing = result.get(date);
    if (existing && canonicalRow(existing) !== canonicalRow(row)) {
      throw new TypeError(`TWSE_SOURCE_DUPLICATE_CONFLICT: 0050 ${date} is returned with conflicting values`);
    }
    result.set(date, row);
  }
  return Object.freeze([...result.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

async function fetchTwseMonth(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" },
    redirect: "manual",
    signal: AbortSignal.timeout(MAX_REQUEST_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`TWSE_ACCESS_DENIED: public TWSE request returned HTTP ${response.status}`);
  }
  if (response.status === 307 || response.status === 429 || response.status === 503) {
    throw new Error(`TWSE_SOURCE_BLOCKED: public TWSE request returned HTTP ${response.status}; stop without retry`);
  }
  if (!response.ok) throw new Error(`TWSE_REQUEST_FAILED: public TWSE request returned HTTP ${response.status}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new TypeError("TWSE_RESPONSE_NOT_JSON: public source did not return JSON");
  }
}

function parseProvenance(value: unknown, label: string): Forward0050Provenance {
  const record = asRecord(value, label);
  const dateRange = asRecord(record["dateRange"], `${label}.dateRange`);
  const artifactId = record["artifactId"];
  const fetchedAtUtc = record["fetchedAtUtc"];
  const rowCount = record["rowCount"];
  const sha = record["sha256"];
  const urls = record["sourceUrls"];
  const sourceUrlPattern = /^https:\/\/www\.twse\.com\.tw\/exchangeReport\/STOCK_DAY\?response=json&date=\d{8}&stockNo=0050$/;
  if (
    record["schemaVersion"] !== 1
    || (artifactId !== "0050-forward-v1" && artifactId !== FORWARD_0050_V2_ARTIFACT_ID)
    || record["symbol"] !== "0050"
    || record["source"] !== TWSE_STOCK_DAY_SOURCE
    || record["purpose"] !== "FORWARD_EVALUATION_ONLY"
    || record["historicalCutoff"] !== FORWARD_0050_HISTORICAL_CUTOFF
  ) {
    throw new TypeError(`${label} has an unsupported identity, source, cutoff, or purpose`);
  }
  if (typeof fetchedAtUtc !== "string" || !validUtcTimestamp(fetchedAtUtc)) throw new TypeError(`${label}.fetchedAtUtc is invalid`);
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) throw new TypeError(`${label}.rowCount is invalid`);
  if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) throw new TypeError(`${label}.sha256 is invalid`);
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || !sourceUrlPattern.test(url))) {
    throw new TypeError(`${label}.sourceUrls must identify the official TWSE STOCK_DAY endpoint`);
  }
  const start = dateRange["start"];
  const end = dateRange["end"];
  if (rowCount === 0) {
    if (start !== null || end !== null) throw new TypeError(`${label}.dateRange must be null when rowCount is zero`);
  } else if (
    typeof start !== "string" || typeof end !== "string"
    || !validDate(start) || !validDate(end) || start > end
  ) {
    throw new TypeError(`${label}.dateRange is invalid`);
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactId: artifactId as Forward0050Provenance["artifactId"],
    symbol: "0050",
    source: TWSE_STOCK_DAY_SOURCE,
    fetchedAtUtc,
    dateRange: Object.freeze({ start: start as string | null, end: end as string | null }),
    rowCount,
    sha256: sha,
    historicalCutoff: FORWARD_0050_HISTORICAL_CUTOFF,
    purpose: "FORWARD_EVALUATION_ONLY",
    sourceUrls: Object.freeze(urls as string[]),
    ...(typeof record["throughDate"] === "string" ? { throughDate: record["throughDate"] } : {}),
    ...(record["baseArtifact"] && typeof record["baseArtifact"] === "object"
      ? { baseArtifact: record["baseArtifact"] as NonNullable<Forward0050Provenance["baseArtifact"]> }
      : {}),
    ...(Array.isArray(record["refreshes"])
      ? { refreshes: record["refreshes"] as NonNullable<Forward0050Provenance["refreshes"]> }
      : {}),
  });
}

async function readBase(root: string): Promise<{
  readonly rows: readonly Forward0050Row[];
  readonly provenance: Forward0050Provenance;
  readonly bytes: Uint8Array;
}> {
  const v2Csv = resolve(root, FORWARD_0050_V2_CSV_PATH);
  const v2Provenance = resolve(root, FORWARD_0050_V2_PROVENANCE_PATH);
  const v1Csv = resolve(root, FORWARD_0050_V1_CSV_PATH);
  const v1Provenance = resolve(root, FORWARD_0050_V1_PROVENANCE_PATH);
  const [maybeV2Csv, maybeV2Provenance] = await Promise.all([
    readOptional(v2Csv),
    readOptional(v2Provenance),
  ]);
  if ((maybeV2Csv === null) !== (maybeV2Provenance === null)) {
    throw new TypeError("0050 v2 CSV and provenance must either both exist or both be absent");
  }
  const baseCsvPath = maybeV2Csv === null ? v1Csv : v2Csv;
  const baseProvenancePath = maybeV2Provenance === null ? v1Provenance : v2Provenance;
  const [bytes, provenanceBytes] = await Promise.all([
    maybeV2Csv ?? readFile(baseCsvPath),
    maybeV2Provenance ?? readFile(baseProvenancePath),
  ]);
  const provenance = parseProvenance(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes)), baseProvenancePath);
  const expectedId = maybeV2Csv === null ? "0050-forward-v1" : FORWARD_0050_V2_ARTIFACT_ID;
  const rows = parseCsv(bytes, baseCsvPath);
  if (provenance.artifactId !== expectedId) throw new TypeError(`${baseProvenancePath} has a mismatched artifactId`);
  if (sha256(bytes) !== provenance.sha256) throw new TypeError(`${baseCsvPath} SHA-256 does not match provenance`);
  if (rows.length !== provenance.rowCount) throw new TypeError(`${baseCsvPath} rowCount does not match provenance`);
  const actualRange = rangeFor(rows);
  if (actualRange.start !== provenance.dateRange.start || actualRange.end !== provenance.dateRange.end) {
    throw new TypeError(`${baseCsvPath} dateRange does not match provenance`);
  }
  if (rows.length === 0) throw new TypeError("0050 forward base snapshot contains no rows");
  return Object.freeze({ rows, provenance, bytes });
}

async function readOptional(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
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

export async function refresh0050ForwardSnapshot(options: Forward0050RefreshOptions = {}): Promise<Forward0050RefreshResult> {
  const root = options.root ?? process.cwd();
  const throughDate = options.throughDate ?? taipeiDate();
  const fetchedAtUtc = options.fetchedAtUtc ?? new Date().toISOString();
  if (!validDate(throughDate)) throw new TypeError("throughDate must be a valid ISO date");
  if (!validUtcTimestamp(fetchedAtUtc)) throw new TypeError("fetchedAtUtc must be a canonical UTC timestamp");
  const base = await readBase(root);
  const previousForwardEnd = base.rows.at(-1)?.date;
  if (!previousForwardEnd) throw new TypeError("0050 forward base snapshot has no last date");
  const fetchMonth = options.fetchMonth ?? fetchTwseMonth;
  const months = monthsFromLastDateTo(previousForwardEnd, throughDate);
  const fetchedSourceUrls: string[] = [];
  const newRowsByDate = new Map<string, Forward0050Row>();
  const baseRowsByDate = new Map(base.rows.map((row) => [row.date, row]));
  for (const month of months) {
    const url = twseStockDayUrl(month);
    fetchedSourceUrls.push(url);
    const monthRows = await fetchMonth(url).then((payload) => parseTwse0050MonthResponse(payload, month, throughDate));
    const responseByDate = new Map(monthRows.map((row) => [row.date, row]));
    for (const baseRow of base.rows) {
      if (baseRow.date.slice(0, 7).replace("-", "") !== month || baseRow.date > throughDate) continue;
      const sourceRow = responseByDate.get(baseRow.date);
      if (!sourceRow || canonicalRow(sourceRow) !== canonicalRow(baseRow)) {
        throw new Error(`TWSE_SOURCE_CORRECTION: 0050 ${baseRow.date} is missing or changed; no v2 output was written`);
      }
    }
    for (const row of monthRows) {
      if (row.date <= previousForwardEnd) {
        const baseRow = baseRowsByDate.get(row.date);
        if (!baseRow || canonicalRow(baseRow) !== canonicalRow(row)) {
          throw new Error(`TWSE_SOURCE_CORRECTION: 0050 ${row.date} conflicts with the existing snapshot; no v2 output was written`);
        }
        continue;
      }
      const duplicate = newRowsByDate.get(row.date);
      if (duplicate && canonicalRow(duplicate) !== canonicalRow(row)) {
        throw new Error(`TWSE_SOURCE_DUPLICATE_CONFLICT: 0050 ${row.date} conflicts across monthly responses`);
      }
      newRowsByDate.set(row.date, row);
    }
  }

  const rows = Object.freeze([...base.rows, ...[...newRowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date))]);
  const bytes = serializeCsv(rows);
  const sourceUrls = Object.freeze([...new Set([...base.provenance.sourceUrls, ...fetchedSourceUrls])]);
  const refreshes = Object.freeze([
    ...(base.provenance.refreshes ?? []),
    Object.freeze({ fetchedAtUtc, throughDate, sourceUrls: Object.freeze(fetchedSourceUrls), newRowCount: newRowsByDate.size }),
  ]);
  const provenance: Forward0050Provenance = Object.freeze({
    schemaVersion: 1,
    artifactId: FORWARD_0050_V2_ARTIFACT_ID,
    symbol: "0050",
    source: TWSE_STOCK_DAY_SOURCE,
    fetchedAtUtc,
    dateRange: rangeFor(rows),
    rowCount: rows.length,
    sha256: sha256(bytes),
    historicalCutoff: FORWARD_0050_HISTORICAL_CUTOFF,
    purpose: "FORWARD_EVALUATION_ONLY",
    sourceUrls,
    throughDate,
    baseArtifact: Object.freeze({ artifactId: base.provenance.artifactId, sha256: base.provenance.sha256 }),
    refreshes,
  });
  const targetCsv = resolve(root, FORWARD_0050_V2_CSV_PATH);
  const targetProvenance = resolve(root, FORWARD_0050_V2_PROVENANCE_PATH);
  await mkdir(dirname(targetCsv), { recursive: true });
  const nonce = randomUUID();
  const tempCsv = `${targetCsv}.${nonce}.tmp`;
  const tempProvenance = `${targetProvenance}.${nonce}.tmp`;
  try {
    await Promise.all([
      writeFile(tempCsv, bytes, { flag: "wx" }),
      writeFile(tempProvenance, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    ]);
    await rename(tempCsv, targetCsv);
    await rename(tempProvenance, targetProvenance);
  } finally {
    await Promise.allSettled([
      unlink(tempCsv),
      unlink(tempProvenance),
    ]);
  }
  return Object.freeze({
    artifactId: FORWARD_0050_V2_ARTIFACT_ID,
    dateRange: provenance.dateRange,
    rowCount: provenance.rowCount,
    newRowCount: newRowsByDate.size,
    sha256: provenance.sha256,
    fetchedAtUtc,
    throughDate,
    sourceUrls: provenance.sourceUrls,
  });
}

function assertNoUpdaterOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("0050 forward updater accepts no symbol, source, or date overrides");
}

async function main(args: readonly string[]): Promise<void> {
  assertNoUpdaterOverrides(args);
  const result = await refresh0050ForwardSnapshot({ root: PROJECT_ROOT });
  stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "OK", ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("TWSE_ACCESS_DENIED:") ? "ACCESS_DENIED"
      : message.startsWith("TWSE_SOURCE_BLOCKED:") ? "SOURCE_BLOCKED"
        : message.startsWith("TWSE_SOURCE_CORRECTION:") ? "SOURCE_CORRECTION"
          : message.startsWith("TWSE_SOURCE_DUPLICATE_CONFLICT:") ? "DUPLICATE_CONFLICT"
            : "UPDATE_FAILED";
    stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "ERROR", error: { code, message } })}\n`);
    process.exitCode = 1;
  });
}
