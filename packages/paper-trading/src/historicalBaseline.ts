import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PAPER_TRADING_DEMO_SETTINGS } from "./fixture.js";
import { parsePaperSession, runPaperSession } from "./sessionRunner.js";

const REQUIRED_HEADERS = ["date", "symbol", "currencyCode", "minorUnit", "priceMinor"] as const;
const TWSE_REQUIRED_HEADERS = ["date", "symbol", "close"] as const;
const TWSE_SOURCE_PROFILE_ARGUMENT = "twse-daily-ohlcv-close-v1" as const;
const TWSE_SOURCE_PROFILE = "TWSE_DAILY_OHLCV_CLOSE_V1" as const;
const TWSE_CURRENCY_CODE = "TWD";
const TWSE_MINOR_UNITS_PER_MAJOR = 100;
const TWSE_MINOR_UNIT = "0.01";
const TWSE_CLOSE_EVENT_TIME = "13:30:00+08:00";

type HistoricalSourceProfile = typeof TWSE_SOURCE_PROFILE_ARGUMENT;

interface CsvRecord {
  readonly lineNumber: number;
  readonly fields: readonly string[];
}

export interface ParsedHistoricalCsv {
  readonly session: ReturnType<typeof parsePaperSession>;
  readonly symbol: string;
  readonly rowCount: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly sourceRows: readonly {
    readonly date: string;
    readonly valuesByColumn: Readonly<Record<string, string>>;
  }[];
  readonly sourceProfile?: typeof TWSE_SOURCE_PROFILE;
  readonly minorUnitsPerMajor?: number;
  readonly sourcePriceColumn?: "close";
}

function parseCsvLine(line: string, lineNumber: number): readonly string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let closedQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character !== ",") {
        throw new TypeError(`CSV line ${lineNumber} has characters after a closing quote`);
      }
      fields.push(field);
      field = "";
      closedQuote = false;
      continue;
    }

    if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"') {
      if (field.length !== 0) {
        throw new TypeError(`CSV line ${lineNumber} has a quote inside an unquoted field`);
      }
      inQuotes = true;
    } else {
      field += character;
    }
  }

  if (inQuotes) throw new TypeError(`CSV line ${lineNumber} has an unterminated quoted field`);
  fields.push(field);
  return Object.freeze(fields);
}

function csvRecords(contents: string): readonly CsvRecord[] {
  if (contents.includes("\0")) throw new TypeError("CSV input contains a NUL character");
  if (contents.includes("\r") && /\r(?!\n)/.test(contents)) {
    throw new TypeError("CSV input must use LF or CRLF line endings");
  }
  const normalized = contents.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    throw new TypeError("CSV input is empty");
  }
  return Object.freeze(lines.map((line, index) => Object.freeze({
    lineNumber: index + 1,
    fields: parseCsvLine(index === 0 ? line.replace(/^\uFEFF/, "") : line, index + 1),
  })));
}

function strictCell(value: string, lineNumber: number, columnName: string): string {
  if (value === "" || value.trim() !== value) {
    throw new TypeError(`CSV line ${lineNumber} column ${columnName} must be non-empty and have no surrounding whitespace`);
  }
  return value;
}

function parseDate(value: string, lineNumber: number): { readonly date: string; readonly timestamp: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`CSV line ${lineNumber} date must use YYYY-MM-DD`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`CSV line ${lineNumber} date is not a valid calendar date`);
  }
  return { date: value, timestamp };
}

function validateSymbol(value: string, lineNumber: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)) {
    throw new TypeError(`CSV line ${lineNumber} symbol must be 1-32 letters, digits, dots, underscores, or hyphens`);
  }
  return value;
}

function validateCurrencyCode(value: string, lineNumber: number): string {
  if (!/^[A-Z][A-Z0-9]{2,11}$/.test(value)) {
    throw new TypeError(`CSV line ${lineNumber} currencyCode must be an explicit uppercase currency code`);
  }
  return value;
}

function validateMinorUnit(value: string, lineNumber: number): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new TypeError(`CSV line ${lineNumber} minorUnit must be an explicit positive decimal string`);
  }
  return value;
}

function validatePriceMinor(value: string, lineNumber: number): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) === 0n) {
    throw new TypeError(`CSV line ${lineNumber} priceMinor must be a positive integer string in the stated minor unit`);
  }
  return value;
}

function twseCloseToPriceMinor(value: string, lineNumber: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new TypeError(`CSV line ${lineNumber} column close must be a non-negative finite decimal string`);
  }
  const fractionalDigits = match[2] ?? "";
  if (fractionalDigits.length > 2 && /[1-9]/.test(fractionalDigits.slice(2))) {
    throw new TypeError(
      `CSV line ${lineNumber} column close cannot be represented exactly with ${TWSE_MINOR_UNITS_PER_MAJOR} minor units per major unit`,
    );
  }
  const fractionalMinor = fractionalDigits.slice(0, 2).padEnd(2, "0");
  const priceMinor = BigInt(match[1]!) * BigInt(TWSE_MINOR_UNITS_PER_MAJOR)
    + BigInt(fractionalMinor || "0");
  if (priceMinor <= 0n) {
    throw new TypeError(`CSV line ${lineNumber} column close must be greater than zero`);
  }
  return priceMinor.toString();
}

function twseDailyCloseTimestamp(date: string, lineNumber: number): number {
  const timestamp = Date.parse(`${date}T${TWSE_CLOSE_EVENT_TIME}`);
  if (!Number.isSafeInteger(timestamp)) {
    throw new TypeError(`CSV line ${lineNumber} date cannot be represented as a daily-close timestamp`);
  }
  return timestamp;
}

function headerIndexes(
  headers: readonly string[],
  requiredHeaders: readonly string[] = REQUIRED_HEADERS,
): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header === "" || header.trim() !== header) {
      throw new TypeError("CSV headers must be non-empty and have no surrounding whitespace");
    }
    if (indexes.has(header)) throw new TypeError(`CSV header ${header} is duplicated`);
    indexes.set(header, index);
  });
  for (const header of requiredHeaders) {
    if (!indexes.has(header)) throw new TypeError(`CSV is missing required header ${header}`);
  }
  return indexes;
}

export function parseHistoricalCsv(
  contents: string,
  symbol: string,
  sourceLabel: string,
  sourceProfile?: HistoricalSourceProfile,
): ParsedHistoricalCsv {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol)) {
    throw new TypeError("--symbol must be 1-32 letters, digits, dots, underscores, or hyphens");
  }
  if (sourceLabel.trim() === "") throw new TypeError("input path must be non-empty");

  const [header, ...dataRecords] = csvRecords(contents);
  if (!header) throw new TypeError("CSV input is missing its header row");
  const indexes = headerIndexes(
    header.fields,
    sourceProfile === TWSE_SOURCE_PROFILE_ARGUMENT ? TWSE_REQUIRED_HEADERS : REQUIRED_HEADERS,
  );
  const selected: {
    readonly date: string;
    readonly timestamp: number;
    readonly currencyCode: string;
    readonly minorUnit: string;
    readonly priceMinor: string;
    readonly eventId: string;
  }[] = [];
  const sourceRows: ParsedHistoricalCsv["sourceRows"][number][] = [];
  let lastSelectedTimestamp: number | null = null;
  let selectedCurrencyCode: string | null = null;
  let selectedMinorUnit: string | null = null;

  for (const record of dataRecords) {
    if (record.fields.length !== header.fields.length) {
      throw new TypeError(`CSV line ${record.lineNumber} has ${record.fields.length} fields; expected ${header.fields.length}`);
    }
    const cell = (name: string): string => {
      const index = indexes.get(name);
      if (index === undefined) throw new Error(`required CSV header ${name} was not indexed`);
      return strictCell(record.fields[index]!, record.lineNumber, name);
    };

    if (sourceProfile === TWSE_SOURCE_PROFILE_ARGUMENT) {
      const rowSymbol = validateSymbol(cell("symbol"), record.lineNumber);
      if (rowSymbol !== symbol) continue;
      const { date } = parseDate(cell("date"), record.lineNumber);
      const timestamp = twseDailyCloseTimestamp(date, record.lineNumber);
      const priceMinor = twseCloseToPriceMinor(cell("close"), record.lineNumber);
      if (lastSelectedTimestamp !== null && timestamp <= lastSelectedTimestamp) {
        throw new TypeError(`CSV line ${record.lineNumber} is duplicate or out of chronological order for ${symbol}`);
      }
      selectedCurrencyCode = TWSE_CURRENCY_CODE;
      selectedMinorUnit = TWSE_MINOR_UNIT;
      lastSelectedTimestamp = timestamp;
      selected.push(Object.freeze({
        date,
        timestamp,
        currencyCode: TWSE_CURRENCY_CODE,
        minorUnit: TWSE_MINOR_UNIT,
        priceMinor,
        eventId: `historical-${symbol}-${date}`,
      }));
      sourceRows.push(Object.freeze({
        date,
        valuesByColumn: Object.freeze(Object.fromEntries(
          header.fields.map((name, index) => [name, record.fields[index]!]),
        )),
      }));
      continue;
    }

    const { date, timestamp } = parseDate(cell("date"), record.lineNumber);
    const rowSymbol = validateSymbol(cell("symbol"), record.lineNumber);
    const currencyCode = validateCurrencyCode(cell("currencyCode"), record.lineNumber);
    const minorUnit = validateMinorUnit(cell("minorUnit"), record.lineNumber);
    const priceMinor = validatePriceMinor(cell("priceMinor"), record.lineNumber);

    if (rowSymbol !== symbol) continue;
    if (lastSelectedTimestamp !== null && timestamp <= lastSelectedTimestamp) {
      throw new TypeError(`CSV line ${record.lineNumber} is duplicate or out of chronological order for ${symbol}`);
    }
    if (selectedCurrencyCode !== null && currencyCode !== selectedCurrencyCode) {
      throw new TypeError(`CSV line ${record.lineNumber} changes currencyCode for ${symbol}`);
    }
    if (selectedMinorUnit !== null && minorUnit !== selectedMinorUnit) {
      throw new TypeError(`CSV line ${record.lineNumber} changes minorUnit for ${symbol}`);
    }

    selectedCurrencyCode = currencyCode;
    selectedMinorUnit = minorUnit;
    lastSelectedTimestamp = timestamp;
    selected.push(Object.freeze({
      date,
      timestamp,
      currencyCode,
      minorUnit,
      priceMinor,
      eventId: `historical-${symbol}-${date}`,
    }));
    sourceRows.push(Object.freeze({
      date,
      valuesByColumn: Object.freeze(Object.fromEntries(
        header.fields.map((name, index) => [name, record.fields[index]!]),
      )),
    }));
  }

  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last || selectedCurrencyCode === null || selectedMinorUnit === null) {
    throw new TypeError(`CSV contains no rows for requested symbol ${symbol}`);
  }

  const settings = PAPER_TRADING_DEMO_SETTINGS;
  const session = parsePaperSession({
    schemaVersion: 1,
    dataKind: "HISTORICAL",
    sourceLabel,
    asset: { symbol, currencyCode: selectedCurrencyCode, minorUnit: selectedMinorUnit },
    simulation: {
      initialCashMinor: settings.initialCashMinor.toString(),
      risk: {
        maxPositionQuantity: settings.risk.maxPositionQuantity,
        maxExposureMinor: settings.risk.maxExposureMinor.toString(),
        maxMarketAgeMs: settings.risk.maxMarketAgeMs,
      },
      terms: settings.terms,
      strategy: {
        entryAtOrBelowMinor: settings.strategy.entryAtOrBelowMinor.toString(),
        exitAtOrAboveMinor: settings.strategy.exitAtOrAboveMinor.toString(),
        targetQuantity: settings.strategy.targetQuantity,
      },
    },
    events: selected.map(({ eventId, timestamp, priceMinor }) => ({ eventId, timestamp, symbol, priceMinor })),
  });

  return Object.freeze({
    session,
    symbol,
    rowCount: selected.length,
    startDate: first.date,
    endDate: last.date,
    sourceRows: Object.freeze(sourceRows),
    ...(sourceProfile === TWSE_SOURCE_PROFILE_ARGUMENT
      ? {
          sourceProfile: TWSE_SOURCE_PROFILE,
          minorUnitsPerMajor: TWSE_MINOR_UNITS_PER_MAJOR,
          sourcePriceColumn: "close" as const,
        }
      : {}),
  });
}

export async function runHistoricalCsvFile(
  inputPath: string,
  symbol: string,
  sourceProfile?: HistoricalSourceProfile,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(inputPath);
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`input file is not valid UTF-8 CSV: ${detail}`);
  }

  const parsed = parseHistoricalCsv(contents, symbol, inputPath, sourceProfile);
  const result = runPaperSession(parsed.session, inputSha256);
  const tradingStatistics = result["tradingStatistics"] as Record<string, unknown>;
  const accountSummary = result["accountSummary"] as Record<string, unknown>;
  return Object.freeze({
    ...result,
    SIMULATION_ONLY: true,
    inputPath: resolve(inputPath),
    inputSha256,
    symbol: parsed.symbol,
    ...(parsed.sourceProfile === undefined
      ? {}
      : {
          sourceProfile: parsed.sourceProfile,
          currencyCode: parsed.session.asset.currencyCode,
          minorUnitsPerMajor: parsed.minorUnitsPerMajor,
          sourcePriceColumn: parsed.sourcePriceColumn,
          exactConversionRule: "close decimal multiplied by 100 must be an exact positive integer; no rounding",
        }),
    acceptedRowCount: parsed.rowCount,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    completedTradeCount: tradingStatistics["completeTradeCount"],
    winCount: tradingStatistics["wins"],
    lossCount: tradingStatistics["losses"],
    breakevenCount: tradingStatistics["breakevens"],
    netWinRate: tradingStatistics["netWinRate"],
    averageWinningTradeNetPnl: tradingStatistics["averageWinPnlMinor"],
    averageLosingTradeNetPnl: tradingStatistics["averageLossPnlMinor"],
    averageCompletedTradeNetPnl: tradingStatistics["averageCompleteTradeNetPnlMinor"],
    fees: accountSummary["feesPaidMinor"],
    realizedPnl: accountSummary["realizedPnlMinor"],
    unrealizedPnl: accountSummary["unrealizedPnlMinor"],
    cash: accountSummary["cashMinor"],
    equity: accountSummary["equityMinor"],
    position: accountSummary["positionQuantity"],
    accountReconciliationStatus: result["accountReconciliation"],
  });
}

function helpText(): string {
  return [
    "Usage: npm run --silent paper:baseline -- --input-csv <prices.csv> --symbol <symbol>",
    "       npm run --silent paper:baseline -- --input-csv <ohlcv.csv> --symbol <symbol> --source-profile twse-daily-ohlcv-close-v1",
    "",
    "Generic CSV columns: date,symbol,currencyCode,minorUnit,priceMinor",
    "  date: valid YYYY-MM-DD calendar date (interpreted at 00:00 UTC)",
    "  currencyCode: explicit uppercase code; minorUnit: explicit positive decimal, e.g. 0.01",
    "  priceMinor: positive integer in that minor unit; no scaling or currency inference is performed",
    "TWSE daily-close profile columns: date,symbol,close; currency is the owner-specified TWD scale of 100 minor units per major unit.",
    "  close is parsed as decimal text exactly; daily close events use 13:30 Asia/Taipei and only close enters the strategy.",
    "Extra columns are ignored, including future outcomes or research labels.",
    "Rows for the selected symbol must be strictly chronological; the runner never sorts or fills gaps.",
    "CSV supports quoted fields on one physical line, LF/CRLF endings, and no multiline fields.",
    "The adapter uses the existing fixed price-band strategy, demo risk/fees/slippage, and next-event fill model.",
    "Results are SIMULATION_ONLY; the supplied path is a declaration, not independent source verification.",
  ].join("\n");
}

function parseCliArguments(args: readonly string[]): {
  readonly help: boolean;
  readonly inputPath?: string;
  readonly symbol?: string;
  readonly sourceProfile?: HistoricalSourceProfile;
} {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  let inputPath: string | undefined;
  let symbol: string | undefined;
  let sourceProfile: HistoricalSourceProfile | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (
      (option !== "--input-csv" && option !== "--symbol" && option !== "--source-profile")
      || value === undefined
      || value === ""
    ) {
      throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for the supported format");
    }
    if (option === "--input-csv") {
      if (inputPath !== undefined) throw new TypeError("--input-csv may be specified only once");
      inputPath = value;
    } else if (option === "--symbol") {
      if (symbol !== undefined) throw new TypeError("--symbol may be specified only once");
      symbol = value;
    } else {
      if (sourceProfile !== undefined) throw new TypeError("--source-profile may be specified only once");
      if (value !== TWSE_SOURCE_PROFILE_ARGUMENT) {
        throw new TypeError(`unsupported --source-profile ${value}`);
      }
      sourceProfile = value;
    }
    index += 1;
  }
  if (inputPath === undefined || symbol === undefined) {
    throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for the supported format");
  }
  return {
    help: false,
    inputPath,
    symbol,
    ...(sourceProfile === undefined ? {} : { sourceProfile }),
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runHistoricalCsvFile(options.inputPath!, options.symbol!, options.sourceProfile);
  stdout.write(`${JSON.stringify(result, jsonReplacer)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown historical baseline error";
    stderr.write(`paper:baseline: ${message}\n`);
    process.exitCode = 1;
  });
}
