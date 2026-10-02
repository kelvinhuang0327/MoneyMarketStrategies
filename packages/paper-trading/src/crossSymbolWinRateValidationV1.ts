import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  RollingMeanReversionV1Strategy,
  ROLLING_MEAN_REVERSION_V1,
} from "./strategy.js";
import { wilsonLowerBound95 } from "./winRateOptimizerV2.js";

export const CROSS_SYMBOL_VALIDATION_SYMBOLS = Object.freeze(["0056", "2317", "2330", "2454"] as const);
export const CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH = "packages/paper-trading/win-rate-strategy-family-v1.json" as const;
export const CROSS_SYMBOL_VALIDATION_DATA_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv" as const;
export const CROSS_SYMBOL_VALIDATION_OUTPUT_PATH = "packages/paper-trading/cross-symbol-win-rate-validation-v1.json" as const;
export const CROSS_SYMBOL_VALIDATION_INPUT_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7" as const;
export const CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID = "lookback-20-entry-0.04-take-0.04-hold-10" as const;
export const CROSS_SYMBOL_VALIDATION_FUTURE_UNSEEN_AFTER = "2026-09-29" as const;

const SOURCE_PROFILE = "twse-daily-ohlcv-close-v1" as const;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIN_COMPLETED_TRADES_FOR_EVIDENCE = 12;
const MIN_SYMBOLS_WITH_TRADES_FOR_EVIDENCE = 3;

export interface FrozenCrossSymbolChallenger {
  readonly id: typeof CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID;
  readonly strategyFamily: typeof ROLLING_MEAN_REVERSION_V1;
  readonly parameters: Readonly<{
    lookback: number;
    entryDiscount: number;
    takeProfit: number;
    maxHoldBars: number;
  }>;
}

export interface CrossSymbolOutcomeDiagnostic {
  readonly symbol: string;
  readonly WIN: number;
  readonly LOSS: number;
  readonly BREAKEVEN: number;
  readonly diagnosticNetPnl: string;
  readonly diagnosticFees: string;
}

export interface CrossSymbolSymbolResult extends CrossSymbolOutcomeDiagnostic {
  readonly completedTradeCount: number;
  readonly rawNetWinRate: number | null;
  readonly WilsonLowerBound95: number | null;
}

export interface CrossSymbolValidationResult {
  readonly schemaVersion: 1;
  readonly strategyFamily: typeof ROLLING_MEAN_REVERSION_V1;
  readonly frozenChallengerId: typeof CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID;
  readonly parameters: FrozenCrossSymbolChallenger["parameters"];
  readonly inputSha256: string;
  readonly validationSymbols: typeof CROSS_SYMBOL_VALIDATION_SYMBOLS;
  readonly perSymbol: readonly CrossSymbolSymbolResult[];
  readonly aggregate: {
    readonly completedTradeCount: number;
    readonly WIN: number;
    readonly LOSS: number;
    readonly BREAKEVEN: number;
    readonly rawNetWinRate: number | null;
    readonly WilsonLowerBound95: number | null;
  };
  readonly coverage: {
    readonly symbolsWithTrades: readonly string[];
    readonly symbolsWithoutTrades: readonly string[];
  };
  readonly validationStatus: "EVIDENCE_OBSERVED" | "INSUFFICIENT_CROSS_SYMBOL_TRADES";
  readonly futureTemporalEvaluation: {
    readonly status: "AWAITING_UNSEEN_DATA";
    readonly unseenAfter: typeof CROSS_SYMBOL_VALIDATION_FUTURE_UNSEEN_AFTER;
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function parameterSnapshot(value: unknown, label: string): FrozenCrossSymbolChallenger["parameters"] {
  const raw = asRecord(value, label);
  const lookback = safeInteger(raw["lookback"], `${label}.lookback`, 1);
  const entryDiscount = raw["entryDiscount"];
  const takeProfit = raw["takeProfit"];
  if (
    typeof entryDiscount !== "number"
    || !Number.isFinite(entryDiscount)
    || entryDiscount <= 0
    || entryDiscount >= 1
    || Number(entryDiscount.toFixed(2)) !== entryDiscount
  ) {
    throw new TypeError(`${label}.entryDiscount must be a positive percentage with at most two decimal places`);
  }
  if (
    typeof takeProfit !== "number"
    || !Number.isFinite(takeProfit)
    || takeProfit <= 0
    || takeProfit >= 1
    || Number(takeProfit.toFixed(2)) !== takeProfit
  ) {
    throw new TypeError(`${label}.takeProfit must be a positive percentage with at most two decimal places`);
  }
  const maxHoldBars = safeInteger(raw["maxHoldBars"], `${label}.maxHoldBars`, 1);
  return Object.freeze({ lookback, entryDiscount, takeProfit, maxHoldBars });
}

function sameParameters(
  left: FrozenCrossSymbolChallenger["parameters"],
  right: FrozenCrossSymbolChallenger["parameters"],
): boolean {
  return left.lookback === right.lookback
    && left.entryDiscount === right.entryDiscount
    && left.takeProfit === right.takeProfit
    && left.maxHoldBars === right.maxHoldBars;
}

function derivedCandidateId(parameters: FrozenCrossSymbolChallenger["parameters"]): string {
  return `lookback-${parameters.lookback}-entry-${parameters.entryDiscount.toFixed(2)}-take-${parameters.takeProfit.toFixed(2)}-hold-${parameters.maxHoldBars}`;
}

export function loadFrozenCrossSymbolChallenger(value: unknown): FrozenCrossSymbolChallenger {
  const artifact = asRecord(value, "frozen strategy-family artifact");
  const selected = asRecord(artifact["selectedFutureChallenger"], "selectedFutureChallenger");
  if (
    artifact["schemaVersion"] !== 1
    || artifact["strategyFamily"] !== ROLLING_MEAN_REVERSION_V1
    || artifact["selectionStatus"] !== "SELECTED_FUTURE_CHALLENGER"
    || artifact["FROZEN_CHALLENGER_ID"] !== CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID
    || selected["id"] !== CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID
    || selected["strategyFamily"] !== ROLLING_MEAN_REVERSION_V1
  ) {
    throw new TypeError("checked-in strategy-family artifact does not identify the frozen ROLLING_MEAN_REVERSION_V1 challenger");
  }

  const parameters = parameterSnapshot(artifact["FROZEN_PARAMETERS"], "FROZEN_PARAMETERS");
  const selectedParameters = parameterSnapshot(selected["parameters"], "selectedFutureChallenger.parameters");
  if (!sameParameters(parameters, selectedParameters) || derivedCandidateId(parameters) !== CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID) {
    throw new TypeError("frozen challenger parameters do not match its checked-in identity");
  }
  return Object.freeze({
    id: CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID,
    strategyFamily: ROLLING_MEAN_REVERSION_V1,
    parameters,
  });
}

export function createFrozenMeanReversionStrategy(challenger: FrozenCrossSymbolChallenger): RollingMeanReversionV1Strategy {
  return new RollingMeanReversionV1Strategy({
    lookback: challenger.parameters.lookback,
    entryDiscountBps: Math.round(challenger.parameters.entryDiscount * 10_000),
    takeProfitBps: Math.round(challenger.parameters.takeProfit * 10_000),
    maxHoldBars: challenger.parameters.maxHoldBars,
  });
}

function validateInputHash(inputSha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("inputSha256 must be a lowercase SHA-256 digest");
}

function safeCount(value: unknown, label: string): number {
  return safeInteger(value, label);
}

function integerMinor(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer minor-unit amount`);
}

function formatTwdMinor(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const major = magnitude / 100n;
  const minor = (magnitude % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${major.toString()}.${minor}`;
}

function evaluateOneSymbol(
  challenger: FrozenCrossSymbolChallenger,
  symbol: typeof CROSS_SYMBOL_VALIDATION_SYMBOLS[number],
  csvContents: string,
  inputSha256: string,
): CrossSymbolOutcomeDiagnostic {
  const parsed = parseHistoricalCsv(csvContents, symbol, CROSS_SYMBOL_VALIDATION_DATA_PATH, SOURCE_PROFILE);
  const result = runPaperSession(parsed.session, inputSha256, undefined, createFrozenMeanReversionStrategy(challenger));
  const statistics = asRecord(result["tradingStatistics"], "paper session tradingStatistics");
  const account = asRecord(result["accountSummary"], "paper session accountSummary");
  const completedTrades = statistics["completedTrades"];
  if (!Array.isArray(completedTrades)) throw new TypeError("paper session completedTrades must be an array");
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "completeTradeCount");
  const wins = safeCount(statistics["wins"], "wins");
  const losses = safeCount(statistics["losses"], "losses");
  const breakevens = safeCount(statistics["breakevens"], "breakevens");
  if (completedTradeCount !== completedTrades.length || completedTradeCount !== wins + losses + breakevens) {
    throw new Error(`paper session completed-trade outcomes do not reconcile for ${symbol}`);
  }
  const completedNetPnlMinor = completedTrades.reduce((sum: bigint, rawTrade: unknown, index: number) => {
    const trade = asRecord(rawTrade, `completedTrades[${index}]`);
    return sum + integerMinor(trade["netPnlMinor"], `completedTrades[${index}].netPnlMinor`);
  }, 0n);

  return Object.freeze({
    symbol,
    WIN: wins,
    LOSS: losses,
    BREAKEVEN: breakevens,
    diagnosticNetPnl: formatTwdMinor(completedNetPnlMinor),
    diagnosticFees: formatTwdMinor(integerMinor(account["feesPaidMinor"], "accountSummary.feesPaidMinor")),
  });
}

function validateDiagnostic(value: CrossSymbolOutcomeDiagnostic, expectedSymbol: string): void {
  if (value.symbol !== expectedSymbol) throw new TypeError("cross-symbol outcome diagnostics must remain in the predeclared policy order");
  const wins = safeCount(value.WIN, `${expectedSymbol}.WIN`);
  const losses = safeCount(value.LOSS, `${expectedSymbol}.LOSS`);
  const breakevens = safeCount(value.BREAKEVEN, `${expectedSymbol}.BREAKEVEN`);
  if (!Number.isSafeInteger(wins + losses + breakevens)) throw new RangeError("completed trade count exceeds the safe integer range");
  if (!/^-?(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(value.diagnosticNetPnl)) {
    throw new TypeError(`${expectedSymbol}.diagnosticNetPnl must be an exact two-decimal TWD amount`);
  }
  if (!/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(value.diagnosticFees)) {
    throw new TypeError(`${expectedSymbol}.diagnosticFees must be a non-negative exact two-decimal TWD amount`);
  }
}

export function buildCrossSymbolValidationResult(
  challenger: FrozenCrossSymbolChallenger,
  inputSha256: string,
  outcomes: readonly CrossSymbolOutcomeDiagnostic[],
): CrossSymbolValidationResult {
  validateInputHash(inputSha256);
  if (outcomes.length !== CROSS_SYMBOL_VALIDATION_SYMBOLS.length) {
    throw new TypeError("cross-symbol validation requires every predeclared symbol exactly once");
  }
  const perSymbol = Object.freeze(outcomes.map((outcome, index) => {
    const expectedSymbol = CROSS_SYMBOL_VALIDATION_SYMBOLS[index]!;
    validateDiagnostic(outcome, expectedSymbol);
    const completedTradeCount = outcome.WIN + outcome.LOSS + outcome.BREAKEVEN;
    return Object.freeze({
      ...outcome,
      completedTradeCount,
      rawNetWinRate: completedTradeCount === 0 ? null : outcome.WIN / completedTradeCount,
      WilsonLowerBound95: wilsonLowerBound95(outcome.WIN, completedTradeCount),
    });
  }));
  const aggregateCompletedTradeCount = perSymbol.reduce((sum, row) => sum + row.completedTradeCount, 0);
  const aggregateWins = perSymbol.reduce((sum, row) => sum + row.WIN, 0);
  const aggregateLosses = perSymbol.reduce((sum, row) => sum + row.LOSS, 0);
  const aggregateBreakevens = perSymbol.reduce((sum, row) => sum + row.BREAKEVEN, 0);
  const symbolsWithTrades = Object.freeze(perSymbol.filter(({ completedTradeCount }) => completedTradeCount > 0).map(({ symbol }) => symbol));
  const symbolsWithoutTrades = Object.freeze(perSymbol.filter(({ completedTradeCount }) => completedTradeCount === 0).map(({ symbol }) => symbol));

  return Object.freeze({
    schemaVersion: 1,
    strategyFamily: challenger.strategyFamily,
    frozenChallengerId: challenger.id,
    parameters: challenger.parameters,
    inputSha256,
    validationSymbols: CROSS_SYMBOL_VALIDATION_SYMBOLS,
    perSymbol,
    aggregate: Object.freeze({
      completedTradeCount: aggregateCompletedTradeCount,
      WIN: aggregateWins,
      LOSS: aggregateLosses,
      BREAKEVEN: aggregateBreakevens,
      rawNetWinRate: aggregateCompletedTradeCount === 0 ? null : aggregateWins / aggregateCompletedTradeCount,
      WilsonLowerBound95: wilsonLowerBound95(aggregateWins, aggregateCompletedTradeCount),
    }),
    coverage: Object.freeze({ symbolsWithTrades, symbolsWithoutTrades }),
    validationStatus: aggregateCompletedTradeCount >= MIN_COMPLETED_TRADES_FOR_EVIDENCE
      && symbolsWithTrades.length >= MIN_SYMBOLS_WITH_TRADES_FOR_EVIDENCE
      ? "EVIDENCE_OBSERVED"
      : "INSUFFICIENT_CROSS_SYMBOL_TRADES",
    futureTemporalEvaluation: Object.freeze({
      status: "AWAITING_UNSEEN_DATA",
      unseenAfter: CROSS_SYMBOL_VALIDATION_FUTURE_UNSEEN_AFTER,
    }),
  });
}

export function evaluateCrossSymbolValidationCsv(
  authorityValue: unknown,
  csvContents: string,
  inputSha256: string,
): CrossSymbolValidationResult {
  const challenger = loadFrozenCrossSymbolChallenger(authorityValue);
  validateInputHash(inputSha256);
  const outcomes = CROSS_SYMBOL_VALIDATION_SYMBOLS.map((symbol) => evaluateOneSymbol(
    challenger,
    symbol,
    csvContents,
    inputSha256,
  ));
  return buildCrossSymbolValidationResult(challenger, inputSha256, outcomes);
}

export function serializeCrossSymbolValidationResult(result: CrossSymbolValidationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function readCrossSymbolValidationMarketCsv(projectRoot = PROJECT_ROOT): Promise<{
  readonly inputSha256: string;
  readonly contents: string;
}> {
  const bytes = await readFile(resolve(projectRoot, CROSS_SYMBOL_VALIDATION_DATA_PATH));
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  if (inputSha256 !== CROSS_SYMBOL_VALIDATION_INPUT_SHA256) {
    throw new Error(`P194 input SHA-256 mismatch: expected ${CROSS_SYMBOL_VALIDATION_INPUT_SHA256}, received ${inputSha256}`);
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`P194 input is not valid UTF-8 CSV: ${detail}`);
  }
  return Object.freeze({ inputSha256, contents });
}

export function assertNoCrossSymbolCliOverrides(args: readonly string[]): void {
  if (args.length !== 0) throw new TypeError("cross-symbol validation accepts no CLI arguments");
}

export async function runCrossSymbolWinRateValidation(projectRoot = PROJECT_ROOT): Promise<CrossSymbolValidationResult> {
  const [authorityBytes, market] = await Promise.all([
    readFile(resolve(projectRoot, CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH)),
    readCrossSymbolValidationMarketCsv(projectRoot),
  ]);
  let authority: unknown;
  try {
    authority = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authorityBytes)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`frozen strategy-family artifact is not valid UTF-8 JSON: ${detail}`);
  }
  const result = evaluateCrossSymbolValidationCsv(authority, market.contents, market.inputSha256);
  await writeFile(resolve(projectRoot, CROSS_SYMBOL_VALIDATION_OUTPUT_PATH), serializeCrossSymbolValidationResult(result), "utf8");
  return result;
}

async function main(): Promise<void> {
  assertNoCrossSymbolCliOverrides(process.argv.slice(2));
  const result = await runCrossSymbolWinRateValidation();
  stdout.write(serializeCrossSymbolValidationResult(result));
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
