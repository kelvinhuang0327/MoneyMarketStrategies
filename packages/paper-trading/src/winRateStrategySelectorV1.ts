import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  RollingMeanReversionV1Strategy,
  ROLLING_MEAN_REVERSION_V1,
  ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY,
} from "./strategy.js";
import { WIN_RATE_OBJECTIVE, wilsonLowerBound95 } from "./winRateOptimizerV2.js";
import type { MarketEvent } from "./types.js";

export const ROLLING_MEAN_REVERSION_V1_SELECTION_POLICY = "wilson-rolling-mean-reversion-v1" as const;
export const ROLLING_MEAN_REVERSION_V1_UNSEEN_AFTER = "2026-09-29" as const;
export const ROLLING_MEAN_REVERSION_V1_ARTIFACT_PATH = "packages/paper-trading/win-rate-strategy-family-v1.json" as const;

const BASIS_POINTS = 10_000;
const SYMBOL = "0050";
const HISTORICAL_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv";
const OBSERVED_FORWARD_PATH = "data/market/forward/0050-forward-v1/0050_forward.csv";
const HISTORICAL_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7";
const OBSERVED_FORWARD_SHA256 = "9e66a3fd594c0614ac1641b7a50e9d926014eaa4839347b524e25d52567b0aaf";
const HISTORICAL_RANGE = Object.freeze({ start: "2020-01-02", end: "2026-08-11", rowCount: 1_599 });
const OBSERVED_FORWARD_RANGE = Object.freeze({ start: "2026-08-12", end: ROLLING_MEAN_REVERSION_V1_UNSEEN_AFTER, rowCount: 33 });
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const LOOKBACK_GRID = Object.freeze([10, 20, 40] as const);
const ENTRY_DISCOUNT_GRID = Object.freeze([0.02, 0.04] as const);
const TAKE_PROFIT_GRID = Object.freeze([0.02, 0.04] as const);
const MAX_HOLD_BARS_GRID = Object.freeze([10, 20] as const);

export interface RollingMeanReversionParameters {
  readonly lookback: number;
  readonly entryDiscount: number;
  readonly takeProfit: number;
  readonly maxHoldBars: number;
}

export interface RollingMeanReversionCandidate {
  readonly candidateId: string;
  readonly parameters: RollingMeanReversionParameters;
  readonly entryDiscountBps: number;
  readonly takeProfitBps: number;
}

export interface RollingOriginFold {
  readonly id: string;
  readonly trainingStartIndex: 0;
  readonly trainingEndIndex: number;
  readonly validationStartIndex: number;
  readonly validationEndIndex: number;
}

export interface DevelopmentMarketRow {
  readonly date: string;
  readonly event: MarketEvent;
  readonly valuesByColumn: Readonly<Record<string, string>>;
}

export interface WinRateStrategyInputHashes {
  readonly historicalSha256: string;
  readonly observedForwardSha256: string;
}

export interface RollingMeanReversionCandidateDiagnostics {
  readonly candidateId: string;
  readonly parameters: RollingMeanReversionParameters;
  readonly perFoldCompletedTradeCount: readonly {
    readonly foldId: string;
    readonly completedTradeCount: number;
  }[];
  readonly aggregateCompletedTradeCount: number;
  readonly WIN: number;
  readonly LOSS: number;
  readonly BREAKEVEN: number;
  readonly rawNetWinRate: number | null;
  readonly WilsonLowerBound95: number | null;
  readonly eligible: boolean;
  readonly parameterDistanceFromGridCenter: number;
  readonly totalNetPnlMinor: string;
  readonly averageCompletedTradePnlMinor: {
    readonly numeratorMinor: string;
    readonly denominator: number;
  } | null;
  readonly feesMinor: string;
}

export interface RollingMeanReversionFoldOutcome {
  readonly foldId: string;
  readonly completedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly netPnlMinor: bigint;
  readonly feesMinor: bigint;
}

const CANDIDATE_GRID: readonly RollingMeanReversionCandidate[] = Object.freeze(
  LOOKBACK_GRID.flatMap((lookback) => ENTRY_DISCOUNT_GRID.flatMap((entryDiscount) => (
    TAKE_PROFIT_GRID.flatMap((takeProfit) => MAX_HOLD_BARS_GRID.map((maxHoldBars) => {
      const parameters = Object.freeze({ lookback, entryDiscount, takeProfit, maxHoldBars });
      return Object.freeze({
        candidateId: `lookback-${lookback}-entry-${entryDiscount.toFixed(2)}-take-${takeProfit.toFixed(2)}-hold-${maxHoldBars}`,
        parameters,
        entryDiscountBps: Math.round(entryDiscount * BASIS_POINTS),
        takeProfitBps: Math.round(takeProfit * BASIS_POINTS),
      });
    }))
  ))),
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCsv(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`${label} is not valid UTF-8 CSV: ${detail}`);
  }
}

function rowsFromParsed(parsed: ParsedHistoricalCsv): readonly DevelopmentMarketRow[] {
  if (parsed.sourceRows.length !== parsed.session.events.length) {
    throw new Error("parsed source rows do not match the event count");
  }
  return Object.freeze(parsed.session.events.map((event, index) => {
    const sourceRow = parsed.sourceRows[index]!;
    if (sourceRow.date !== event.eventId.slice(-10)) {
      throw new Error("parsed source row date does not match its market event identity");
    }
    return Object.freeze({ date: sourceRow.date, event, valuesByColumn: sourceRow.valuesByColumn });
  }));
}

function assertChronologicalRows(rows: readonly DevelopmentMarketRow[], label: string): void {
  let priorTimestamp: number | null = null;
  let priorDate: string | null = null;
  for (const row of rows) {
    if (priorTimestamp !== null && row.event.timestamp <= priorTimestamp) {
      throw new TypeError(`${label} rows are duplicate or out of chronological order`);
    }
    if (priorDate !== null && row.date <= priorDate) {
      throw new TypeError(`${label} dates are duplicate or out of chronological order`);
    }
    priorTimestamp = row.event.timestamp;
    priorDate = row.date;
  }
}

function normalizeNumericCell(value: string, column: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TypeError(`cannot verify duplicate market rows because ${column} is not a decimal value`);
  const integer = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction === "" ? integer : `${integer}.${fraction}`;
}

function marketValueSignature(row: DevelopmentMarketRow): string {
  const columns = ["symbol", "date", "open", "high", "low", "close", "volume"] as const;
  return columns.map((column) => {
    const value = row.valuesByColumn[column];
    if (value === undefined) {
      throw new TypeError(`cannot verify duplicate market rows because ${column} is missing`);
    }
    return column === "symbol" || column === "date"
      ? `${column}=${value}`
      : `${column}=${normalizeNumericCell(value, column)}`;
  }).join("\u001f");
}

export function mergeChronologicalDevelopmentRows(
  historicalRows: readonly DevelopmentMarketRow[],
  observedForwardRows: readonly DevelopmentMarketRow[],
): readonly DevelopmentMarketRow[] {
  assertChronologicalRows(historicalRows, "historical input");
  assertChronologicalRows(observedForwardRows, "observed-forward input");

  const merged: DevelopmentMarketRow[] = [];
  let historicalIndex = 0;
  let forwardIndex = 0;
  while (historicalIndex < historicalRows.length && forwardIndex < observedForwardRows.length) {
    const historicalRow = historicalRows[historicalIndex]!;
    const forwardRow = observedForwardRows[forwardIndex]!;
    if (historicalRow.event.symbol !== forwardRow.event.symbol) {
      throw new TypeError("development inputs contain different symbols");
    }
    if (historicalRow.event.timestamp < forwardRow.event.timestamp) {
      merged.push(historicalRow);
      historicalIndex += 1;
    } else if (historicalRow.event.timestamp > forwardRow.event.timestamp) {
      merged.push(forwardRow);
      forwardIndex += 1;
    } else {
      if (
        historicalRow.date !== forwardRow.date
        || historicalRow.event.symbol !== forwardRow.event.symbol
        || historicalRow.event.priceMinor !== forwardRow.event.priceMinor
        || marketValueSignature(historicalRow) !== marketValueSignature(forwardRow)
      ) {
        throw new TypeError(`historical and observed-forward market rows conflict on ${historicalRow.date}`);
      }
      merged.push(historicalRow);
      historicalIndex += 1;
      forwardIndex += 1;
    }
  }
  merged.push(...historicalRows.slice(historicalIndex), ...observedForwardRows.slice(forwardIndex));
  assertChronologicalRows(merged, "merged development input");
  return Object.freeze(merged);
}

export function mergeParsedHistoricalCsv(
  historical: ParsedHistoricalCsv,
  observedForward: ParsedHistoricalCsv,
): ParsedHistoricalCsv {
  if (
    historical.symbol !== observedForward.symbol
    || historical.session.asset.currencyCode !== observedForward.session.asset.currencyCode
    || historical.session.asset.minorUnit !== observedForward.session.asset.minorUnit
  ) {
    throw new TypeError("historical and observed-forward input identities do not match");
  }
  const mergedRows = mergeChronologicalDevelopmentRows(rowsFromParsed(historical), rowsFromParsed(observedForward));
  const first = mergedRows[0];
  const last = mergedRows.at(-1);
  if (!first || !last) throw new TypeError("development inputs contain no market rows");
  const events = Object.freeze(mergedRows.map(({ event }) => event));
  const session = Object.freeze({ ...historical.session, events });
  return Object.freeze({
    ...historical,
    session,
    rowCount: mergedRows.length,
    startDate: first.date,
    endDate: last.date,
    sourceRows: Object.freeze(mergedRows.map(({ date, valuesByColumn }) => Object.freeze({ date, valuesByColumn }))),
  });
}

export function buildRollingMeanReversionCandidateGrid(): readonly RollingMeanReversionCandidate[] {
  return CANDIDATE_GRID;
}

export function buildRollingOriginFolds(rowCount: number): readonly RollingOriginFold[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 4) {
    throw new RangeError("at least four chronological rows are required for three rolling-origin folds");
  }
  const boundaries = [
    Math.floor(rowCount / 4),
    Math.floor(rowCount / 2),
    Math.floor((rowCount * 3) / 4),
    rowCount,
  ];
  if (boundaries.some((boundary, index) => index > 0 && boundary <= boundaries[index - 1]!)) {
    throw new RangeError("row count cannot produce three non-empty rolling-origin validation folds");
  }
  return Object.freeze([0, 1, 2].map((index) => {
    const validationStartIndex = boundaries[index]!;
    return Object.freeze({
      id: `fold-${index + 1}`,
      trainingStartIndex: 0 as const,
      trainingEndIndex: validationStartIndex,
      validationStartIndex,
      validationEndIndex: boundaries[index + 1]!,
    });
  }));
}

function record(value: unknown, label: string): Record<string, unknown> {
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

function integerMinor(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an exact integer in minor units`);
}

export function evaluateRollingMeanReversionFold(
  parsed: ParsedHistoricalCsv,
  fold: RollingOriginFold,
  candidate: RollingMeanReversionCandidate,
  evaluationInputSha256: string,
): RollingMeanReversionFoldOutcome {
  if (!/^[a-f0-9]{64}$/.test(evaluationInputSha256)) {
    throw new TypeError("evaluationInputSha256 must be a lowercase SHA-256 digest");
  }
  const events = parsed.session.events;
  if (
    parsed.rowCount !== events.length
    || fold.trainingEndIndex !== fold.validationStartIndex
    || fold.validationStartIndex < 1
    || fold.validationEndIndex > events.length
    || fold.validationStartIndex >= fold.validationEndIndex
  ) {
    throw new TypeError("rolling-origin fold boundaries are invalid for the development stream");
  }
  const firstValidationEvent = events[fold.validationStartIndex];
  if (!firstValidationEvent) throw new TypeError("validation fold has no first event");
  const strategy = new RollingMeanReversionV1Strategy({
    lookback: candidate.parameters.lookback,
    entryDiscountBps: candidate.entryDiscountBps,
    takeProfitBps: candidate.takeProfitBps,
    maxHoldBars: candidate.parameters.maxHoldBars,
    activeFromTimestamp: firstValidationEvent.timestamp,
  });
  const foldSession = Object.freeze({
    ...parsed.session,
    events: Object.freeze(events.slice(0, fold.validationEndIndex)),
  });
  const result = runPaperSession(foldSession, evaluationInputSha256, undefined, strategy);
  const statistics = record(result["tradingStatistics"], "paper session tradingStatistics");
  const account = record(result["accountSummary"], "paper session accountSummary");
  const completedTrades = statistics["completedTrades"];
  if (!Array.isArray(completedTrades)) throw new TypeError("paper session completedTrades must be an array");
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "completeTradeCount");
  const wins = safeCount(statistics["wins"], "wins");
  const losses = safeCount(statistics["losses"], "losses");
  const breakevens = safeCount(statistics["breakevens"], "breakevens");
  if (completedTradeCount !== completedTrades.length || completedTradeCount !== wins + losses + breakevens) {
    throw new Error("paper session completed-trade outcomes do not reconcile");
  }
  const netPnlMinor = completedTrades.reduce((sum: bigint, rawTrade: unknown, index: number) => {
    const trade = record(rawTrade, `completedTrades[${index}]`);
    return sum + integerMinor(trade["netPnlMinor"], `completedTrades[${index}].netPnlMinor`);
  }, 0n);
  return Object.freeze({
    foldId: fold.id,
    completedTradeCount,
    wins,
    losses,
    breakevens,
    netPnlMinor,
    feesMinor: integerMinor(account["feesPaidMinor"], "accountSummary.feesPaidMinor"),
  });
}

export function isRollingMeanReversionCandidateEligible(
  perFoldCompletedTradeCount: readonly number[],
  aggregateCompletedTradeCount: number,
): boolean {
  return perFoldCompletedTradeCount.length === 3
    && perFoldCompletedTradeCount.every((count) => Number.isSafeInteger(count) && count >= 1)
    && Number.isSafeInteger(aggregateCompletedTradeCount)
    && aggregateCompletedTradeCount >= 6
    && perFoldCompletedTradeCount.reduce((sum, count) => sum + count, 0) === aggregateCompletedTradeCount;
}

function gridAxisDistance(value: number, axis: readonly number[]): number {
  const index = axis.indexOf(value);
  if (index < 0) throw new TypeError("candidate parameters must belong to the fixed grid");
  return Math.abs(2 * index - (axis.length - 1));
}

function parameterDistanceFromGridCenter(parameters: RollingMeanReversionParameters): number {
  return gridAxisDistance(parameters.lookback, LOOKBACK_GRID)
    + gridAxisDistance(parameters.entryDiscount, ENTRY_DISCOUNT_GRID)
    + gridAxisDistance(parameters.takeProfit, TAKE_PROFIT_GRID)
    + gridAxisDistance(parameters.maxHoldBars, MAX_HOLD_BARS_GRID);
}

export function rankRollingMeanReversionCandidates(
  candidates: readonly RollingMeanReversionCandidateDiagnostics[],
): readonly RollingMeanReversionCandidateDiagnostics[] {
  return Object.freeze(candidates.filter((candidate) => (
    candidate.eligible
    && candidate.WilsonLowerBound95 !== null
    && candidate.rawNetWinRate !== null
  )).slice().sort((left, right) => {
    const leftWilson = left.WilsonLowerBound95!;
    const rightWilson = right.WilsonLowerBound95!;
    if (leftWilson !== rightWilson) return leftWilson > rightWilson ? -1 : 1;
    const leftRawRate = left.rawNetWinRate!;
    const rightRawRate = right.rawNetWinRate!;
    if (leftRawRate !== rightRawRate) return leftRawRate > rightRawRate ? -1 : 1;
    const leftDistance = parameterDistanceFromGridCenter(left.parameters);
    const rightDistance = parameterDistanceFromGridCenter(right.parameters);
    if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1;
    if (left.candidateId === right.candidateId) return 0;
    return left.candidateId < right.candidateId ? -1 : 1;
  }));
}

function evaluateCandidate(
  parsed: ParsedHistoricalCsv,
  candidate: RollingMeanReversionCandidate,
  folds: readonly RollingOriginFold[],
  evaluationInputSha256: string,
): RollingMeanReversionCandidateDiagnostics {
  const foldOutcomes = folds.map((fold) => evaluateRollingMeanReversionFold(
    parsed,
    fold,
    candidate,
    evaluationInputSha256,
  ));
  const aggregateCompletedTradeCount = foldOutcomes.reduce((sum, fold) => sum + fold.completedTradeCount, 0);
  const wins = foldOutcomes.reduce((sum, fold) => sum + fold.wins, 0);
  const losses = foldOutcomes.reduce((sum, fold) => sum + fold.losses, 0);
  const breakevens = foldOutcomes.reduce((sum, fold) => sum + fold.breakevens, 0);
  const totalNetPnlMinor = foldOutcomes.reduce((sum, fold) => sum + fold.netPnlMinor, 0n);
  const feesMinor = foldOutcomes.reduce((sum, fold) => sum + fold.feesMinor, 0n);
  const perFoldCompletedTradeCount = Object.freeze(foldOutcomes.map((fold) => Object.freeze({
    foldId: fold.foldId,
    completedTradeCount: fold.completedTradeCount,
  })));
  const foldCounts = perFoldCompletedTradeCount.map(({ completedTradeCount }) => completedTradeCount);
  const eligible = isRollingMeanReversionCandidateEligible(foldCounts, aggregateCompletedTradeCount);
  return Object.freeze({
    candidateId: candidate.candidateId,
    parameters: candidate.parameters,
    perFoldCompletedTradeCount,
    aggregateCompletedTradeCount,
    WIN: wins,
    LOSS: losses,
    BREAKEVEN: breakevens,
    rawNetWinRate: aggregateCompletedTradeCount === 0 ? null : wins / aggregateCompletedTradeCount,
    WilsonLowerBound95: wilsonLowerBound95(wins, aggregateCompletedTradeCount),
    eligible,
    parameterDistanceFromGridCenter: parameterDistanceFromGridCenter(candidate.parameters),
    totalNetPnlMinor: totalNetPnlMinor.toString(),
    averageCompletedTradePnlMinor: aggregateCompletedTradeCount === 0
      ? null
      : Object.freeze({ numeratorMinor: totalNetPnlMinor.toString(), denominator: aggregateCompletedTradeCount }),
    feesMinor: feesMinor.toString(),
  });
}

function foldDateReports(
  folds: readonly RollingOriginFold[],
  events: readonly MarketEvent[],
): readonly Record<string, unknown>[] {
  return Object.freeze(folds.map((fold) => {
    const trainingStart = events[fold.trainingStartIndex];
    const trainingEnd = events[fold.trainingEndIndex - 1];
    const validationStart = events[fold.validationStartIndex];
    const validationEnd = events[fold.validationEndIndex - 1];
    if (!trainingStart || !trainingEnd || !validationStart || !validationEnd) {
      throw new Error(`fold ${fold.id} has an empty training or validation range`);
    }
    return Object.freeze({
      id: fold.id,
      training: Object.freeze({
        startDate: new Date(trainingStart.timestamp).toISOString().slice(0, 10),
        endDate: new Date(trainingEnd.timestamp).toISOString().slice(0, 10),
        rowCount: fold.trainingEndIndex - fold.trainingStartIndex,
      }),
      validation: Object.freeze({
        startDate: new Date(validationStart.timestamp).toISOString().slice(0, 10),
        endDate: new Date(validationEnd.timestamp).toISOString().slice(0, 10),
        rowCount: fold.validationEndIndex - fold.validationStartIndex,
      }),
    });
  }));
}

export function selectRollingMeanReversionV1(
  parsed: ParsedHistoricalCsv,
  inputHashes: WinRateStrategyInputHashes,
): Record<string, unknown> {
  if (parsed.rowCount !== parsed.session.events.length || parsed.rowCount < 4) {
    throw new Error("development row count does not match the chronological event stream");
  }
  if (!/^[a-f0-9]{64}$/.test(inputHashes.historicalSha256) || !/^[a-f0-9]{64}$/.test(inputHashes.observedForwardSha256)) {
    throw new TypeError("selection input hashes must be lowercase SHA-256 digests");
  }

  const folds = buildRollingOriginFolds(parsed.rowCount);
  const fixedGrid = buildRollingMeanReversionCandidateGrid();
  const evaluationInputSha256 = createHash("sha256")
    .update(inputHashes.historicalSha256)
    .update("\u0000")
    .update(inputHashes.observedForwardSha256)
    .digest("hex");
  const candidates = Object.freeze(fixedGrid.map((candidate) => evaluateCandidate(
    parsed,
    candidate,
    folds,
    evaluationInputSha256,
  )));
  const ranked = rankRollingMeanReversionCandidates(candidates);
  const selected = ranked[0] ?? null;
  const selectionStatus = selected === null ? "NO_ELIGIBLE_CANDIDATE" : "SELECTED_FUTURE_CHALLENGER";
  const futureEvaluation = Object.freeze({
    status: "AWAITING_UNSEEN_DATA",
    unseenAfter: ROLLING_MEAN_REVERSION_V1_UNSEEN_AFTER,
  });
  const selectedFutureChallenger = selected === null ? null : Object.freeze({
    id: selected.candidateId,
    strategyFamily: ROLLING_MEAN_REVERSION_V1,
    parameters: selected.parameters,
    aggregateCompletedTradeCount: selected.aggregateCompletedTradeCount,
    WIN: selected.WIN,
    LOSS: selected.LOSS,
    BREAKEVEN: selected.BREAKEVEN,
    rawNetWinRate: selected.rawNetWinRate,
    WilsonLowerBound95: selected.WilsonLowerBound95,
  });

  return Object.freeze({
    schemaVersion: 1,
    strategyFamily: ROLLING_MEAN_REVERSION_V1,
    legacyStrategyStatus: "LEGACY_EXECUTION_TEST_REFERENCE",
    objective: WIN_RATE_OBJECTIVE,
    developmentDataEnd: parsed.endDate,
    developmentData: Object.freeze({
      symbol: parsed.symbol,
      rowCount: parsed.rowCount,
      dateRange: Object.freeze({ start: parsed.startDate, end: parsed.endDate }),
    }),
    inputHashes: Object.freeze({
      historicalSha256: inputHashes.historicalSha256,
      observedForwardSha256: inputHashes.observedForwardSha256,
    }),
    foldPolicy: Object.freeze({
      version: "rolling-origin-expanding-history-three-fold-v1",
      foldCount: folds.length,
      folds: foldDateReports(folds, parsed.session.events),
    }),
    candidateGrid: Object.freeze({
      lookback: LOOKBACK_GRID,
      entryDiscount: ENTRY_DISCOUNT_GRID,
      takeProfit: TAKE_PROFIT_GRID,
      maxHoldBars: MAX_HOLD_BARS_GRID,
      candidateCount: fixedGrid.length,
      fixedTargetQuantity: ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY,
    }),
    candidates,
    selectionStatus,
    selectedFutureChallenger,
    ...(selected === null ? {} : {
      FROZEN_CHALLENGER_ID: selected.candidateId,
      FROZEN_PARAMETERS: selected.parameters,
      FROZEN_SELECTION_DATA_END: parsed.endDate,
      FROZEN_SELECTION_INPUT_HASHES: Object.freeze({
        historicalSha256: inputHashes.historicalSha256,
        observedForwardSha256: inputHashes.observedForwardSha256,
      }),
      FROZEN_SELECTION_POLICY: ROLLING_MEAN_REVERSION_V1_SELECTION_POLICY,
    }),
    FUTURE_PROMOTION_STATUS: "AWAITING_UNSEEN_DATA",
    futureEvaluation,
    freshDataWinRateImprovement: "NOT_EVALUATED",
  });
}

function assertExpectedRange(
  parsed: ParsedHistoricalCsv,
  expected: { readonly start: string; readonly end: string; readonly rowCount: number },
  label: string,
): void {
  if (parsed.startDate !== expected.start || parsed.endDate !== expected.end || parsed.rowCount !== expected.rowCount) {
    throw new Error(`${label} does not match the packet-pinned date range and row count`);
  }
}

export async function loadProjectDevelopmentData(projectRoot = PROJECT_ROOT): Promise<{
  readonly parsed: ParsedHistoricalCsv;
  readonly inputHashes: WinRateStrategyInputHashes;
}> {
  const [historicalBytes, observedForwardBytes] = await Promise.all([
    readFile(resolve(projectRoot, HISTORICAL_PATH)),
    readFile(resolve(projectRoot, OBSERVED_FORWARD_PATH)),
  ]);
  const historicalSha256 = sha256(historicalBytes);
  const observedForwardSha256 = sha256(observedForwardBytes);
  if (historicalSha256 !== HISTORICAL_SHA256 || observedForwardSha256 !== OBSERVED_FORWARD_SHA256) {
    throw new Error("project-local market inputs do not match the packet-pinned SHA-256 identities");
  }
  const historical = parseHistoricalCsv(
    decodeCsv(historicalBytes, "historical input"),
    SYMBOL,
    HISTORICAL_PATH,
    "twse-daily-ohlcv-close-v1",
  );
  const observedForward = parseHistoricalCsv(
    decodeCsv(observedForwardBytes, "observed-forward input"),
    SYMBOL,
    OBSERVED_FORWARD_PATH,
    "twse-daily-ohlcv-close-v1",
  );
  assertExpectedRange(historical, HISTORICAL_RANGE, "historical input");
  assertExpectedRange(observedForward, OBSERVED_FORWARD_RANGE, "observed-forward input");
  const parsed = mergeParsedHistoricalCsv(historical, observedForward);
  if (
    parsed.rowCount !== HISTORICAL_RANGE.rowCount + OBSERVED_FORWARD_RANGE.rowCount
    || parsed.startDate !== HISTORICAL_RANGE.start
    || parsed.endDate !== ROLLING_MEAN_REVERSION_V1_UNSEEN_AFTER
    || parsed.session.events.some((event) => new Date(event.timestamp).toISOString().slice(0, 10) > ROLLING_MEAN_REVERSION_V1_UNSEEN_AFTER)
  ) {
    throw new Error("merged development stream does not stop exactly at the observed-data cutoff");
  }
  return Object.freeze({
    parsed,
    inputHashes: Object.freeze({ historicalSha256, observedForwardSha256 }),
  });
}

export async function runWinRateStrategySelectorV1(projectRoot = PROJECT_ROOT): Promise<Record<string, unknown>> {
  if (process.argv.length > 2) throw new TypeError("this bounded selector accepts no command-line tuning arguments");
  const { parsed, inputHashes } = await loadProjectDevelopmentData(projectRoot);
  const result = selectRollingMeanReversionV1(parsed, inputHashes);
  const outputPath = resolve(projectRoot, ROLLING_MEAN_REVERSION_V1_ARTIFACT_PATH);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runWinRateStrategySelectorV1()
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown selector error";
      stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
