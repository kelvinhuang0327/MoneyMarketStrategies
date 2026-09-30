import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PAPER_TRADING_DEMO_SETTINGS } from "./fixture.js";
import { parsePaperSession, runPaperSession } from "./sessionRunner.js";

const REQUIRED_HEADERS = ["date", "symbol", "currencyCode", "minorUnit", "priceMinor"] as const;

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

function headerIndexes(headers: readonly string[]): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header === "" || header.trim() !== header) {
      throw new TypeError("CSV headers must be non-empty and have no surrounding whitespace");
    }
    if (indexes.has(header)) throw new TypeError(`CSV header ${header} is duplicated`);
    indexes.set(header, index);
  });
  for (const header of REQUIRED_HEADERS) {
    if (!indexes.has(header)) throw new TypeError(`CSV is missing required header ${header}`);
  }
  return indexes;
}

export function parseHistoricalCsv(
  contents: string,
  symbol: string,
  sourceLabel: string,
): ParsedHistoricalCsv {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol)) {
    throw new TypeError("--symbol must be 1-32 letters, digits, dots, underscores, or hyphens");
  }
  if (sourceLabel.trim() === "") throw new TypeError("input path must be non-empty");

  const [header, ...dataRecords] = csvRecords(contents);
  if (!header) throw new TypeError("CSV input is missing its header row");
  const indexes = headerIndexes(header.fields);
  const selected: {
    readonly date: string;
    readonly timestamp: number;
    readonly currencyCode: string;
    readonly minorUnit: string;
    readonly priceMinor: string;
    readonly eventId: string;
  }[] = [];
  let lastSelectedTimestamp: number | null = null;
  let selectedCurrencyCode: string | null = null;
  let selectedMinorUnit: string | null = null;

  for (const record of dataRecords) {
    if (record.fields.length !== header.fields.length) {
      throw new TypeError(`CSV line ${record.lineNumber} has ${record.fields.length} fields; expected ${header.fields.length}`);
    }
    const cell = (name: (typeof REQUIRED_HEADERS)[number]): string => {
      const index = indexes.get(name);
      if (index === undefined) throw new Error(`required CSV header ${name} was not indexed`);
      return strictCell(record.fields[index]!, record.lineNumber, name);
    };

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
  });
}

export async function runHistoricalCsvFile(inputPath: string, symbol: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(inputPath);
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`input file is not valid UTF-8 CSV: ${detail}`);
  }

  const parsed = parseHistoricalCsv(contents, symbol, inputPath);
  const result = runPaperSession(parsed.session, inputSha256);
  const tradingStatistics = result["tradingStatistics"] as Record<string, unknown>;
  const accountSummary = result["accountSummary"] as Record<string, unknown>;
  return Object.freeze({
    ...result,
    SIMULATION_ONLY: true,
    inputPath: resolve(inputPath),
    inputSha256,
    symbol: parsed.symbol,
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
    "",
    "Required CSV columns: date,symbol,currencyCode,minorUnit,priceMinor",
    "  date: valid YYYY-MM-DD calendar date (interpreted at 00:00 UTC)",
    "  currencyCode: explicit uppercase code; minorUnit: explicit positive decimal, e.g. 0.01",
    "  priceMinor: positive integer in that minor unit; no scaling or currency inference is performed",
    "Extra columns are ignored, including future outcomes or research labels.",
    "Rows for the selected symbol must be strictly chronological; the runner never sorts or fills gaps.",
    "CSV supports quoted fields on one physical line, LF/CRLF endings, and no multiline fields.",
    "The adapter uses the existing fixed price-band strategy, demo risk/fees/slippage, and next-event fill model.",
    "Results are SIMULATION_ONLY; the supplied path is a declaration, not independent source verification.",
  ].join("\n");
}

function parseCliArguments(args: readonly string[]): { readonly help: boolean; readonly inputPath?: string; readonly symbol?: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  let inputPath: string | undefined;
  let symbol: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if ((option !== "--input-csv" && option !== "--symbol") || value === undefined || value === "") {
      throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for the supported format");
    }
    if (option === "--input-csv") {
      if (inputPath !== undefined) throw new TypeError("--input-csv may be specified only once");
      inputPath = value;
    } else {
      if (symbol !== undefined) throw new TypeError("--symbol may be specified only once");
      symbol = value;
    }
    index += 1;
  }
  if (inputPath === undefined || symbol === undefined) {
    throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for the supported format");
  }
  return { help: false, inputPath, symbol };
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
  const result = await runHistoricalCsvFile(options.inputPath!, options.symbol!);
  stdout.write(`${JSON.stringify(result, jsonReplacer)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown historical baseline error";
    stderr.write(`paper:baseline: ${message}\n`);
    process.exitCode = 1;
  });
}
