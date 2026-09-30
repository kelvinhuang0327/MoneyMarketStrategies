import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import { ROLLING_ZSCORE_MEAN_REVERSION_V1, RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import { WIN_RATE_OBJECTIVE, wilsonLowerBound95 } from "./winRateOptimizerV2.js";
import type { MarketEvent } from "./types.js";

export const ZSCORE_WIN_RATE_SYMBOLS = Object.freeze(["0050", "0056", "2317", "2330", "2454"] as const);
export const ZSCORE_HISTORICAL_CUTOFF = "2026-08-11" as const;
export const ZSCORE_HISTORICAL_INPUT_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7" as const;
export const ZSCORE_SELECTION_ARTIFACT_PATH = "packages/paper-trading/zscore-win-rate-strategy-v1.json" as const;
export const ZSCORE_HISTORICAL_INPUT_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv" as const;

const SOURCE_PROFILE = "twse-daily-ohlcv-close-v1" as const;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LOOKBACK_GRID = Object.freeze([20, 40] as const);
const ENTRY_Z_GRID = Object.freeze([0.75, 1.00, 1.25] as const);
const EXIT_Z_GRID = Object.freeze([-0.25, 0.00] as const);
const MAX_HOLD_BARS_GRID = Object.freeze([10, 20] as const);

export interface ZScoreParameters {
  readonly lookback: number;
  readonly entryZ: number;
  readonly exitZ: number;
  readonly maxHoldBars: number;
}

export interface ZScoreCandidate {
  readonly candidateId: string;
  readonly parameters: ZScoreParameters;
}

export interface ZScoreRollingOriginFold {
  readonly id: string;
  readonly trainingEndIndex: number;
  readonly validationStartIndex: number;
  readonly validationEndIndex: number;
}

export interface ZScoreMetrics {
  readonly completedTradeCount: number;
  readonly WIN: number;
  readonly LOSS: number;
  readonly BREAKEVEN: number;
  readonly rawNetWinRate: number | null;
  readonly WilsonLowerBound95: number | null;
  readonly netPnl: string;
  readonly fees: string;
}

export interface ZScoreSymbolDiagnostics extends ZScoreMetrics {
  readonly symbol: string;
}

export interface ZScoreCandidateDiagnostics {
  readonly candidateId: string;
  readonly parameters: ZScoreParameters;
  readonly perSymbol: readonly ZScoreSymbolDiagnostics[];
  readonly aggregate: ZScoreMetrics;
  readonly eligible: boolean;
  readonly parameterDistanceFromGridCenter: number;
}

export interface ZScoreFoldOutcome {
  readonly foldId: string;
  readonly completedTradeCount: number;
  readonly WIN: number;
  readonly LOSS: number;
  readonly BREAKEVEN: number;
  readonly netPnlMinor: bigint;
  readonly feesMinor: bigint;
}

function formatZ(value: number): string {
  const fixed = value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.startsWith("-") ? `neg${fixed.slice(1).replace(".", "p")}` : fixed.replace(".", "p");
}

export function buildZScoreCandidateGrid(): readonly ZScoreCandidate[] {
  const candidates: ZScoreCandidate[] = [];
  for (const lookback of LOOKBACK_GRID) {
    for (const entryZ of ENTRY_Z_GRID) {
      for (const exitZ of EXIT_Z_GRID) {
        for (const maxHoldBars of MAX_HOLD_BARS_GRID) {
          const parameters = Object.freeze({ lookback, entryZ, exitZ, maxHoldBars });
          const candidateId = `lookback-${lookback}-entryz-${formatZ(entryZ)}-exitz-${formatZ(exitZ)}-hold-${maxHoldBars}`;
          candidates.push(Object.freeze({ candidateId, parameters }));
        }
      }
    }
  }
  return Object.freeze(candidates);
}

export function buildZScoreRollingOriginFolds(rowCount: number): readonly ZScoreRollingOriginFold[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 4) {
    throw new RangeError("at least four chronological rows are required for three rolling-origin folds");
  }
  const boundaries = [Math.floor(rowCount / 4), Math.floor(rowCount / 2), Math.floor((rowCount * 3) / 4), rowCount];
  if (boundaries.some((boundary, index) => index > 0 && boundary <= boundaries[index - 1]!)) {
    throw new RangeError("row count cannot produce three non-empty chronological validation slices");
  }
  return Object.freeze([0, 1, 2].map((index) => Object.freeze({
    id: `fold-${index + 1}`,
    trainingEndIndex: boundaries[index]!,
    validationStartIndex: boundaries[index]!,
    validationEndIndex: boundaries[index + 1]!,
  })));
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

function integerMinor(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an exact integer in minor units`);
}

export function isZScoreCandidateEligible(
  perSymbolCompletedTradeCounts: readonly number[],
  aggregateCompletedTradeCount: number,
  pooledWilsonLowerBound95: number | null,
): boolean {
  return perSymbolCompletedTradeCounts.length === ZSCORE_WIN_RATE_SYMBOLS.length
    && perSymbolCompletedTradeCounts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && perSymbolCompletedTradeCounts.filter((count) => count >= 2).length >= 4
    && Number.isSafeInteger(aggregateCompletedTradeCount)
    && aggregateCompletedTradeCount >= 20
    && perSymbolCompletedTradeCounts.reduce((sum, count) => sum + count, 0) === aggregateCompletedTradeCount
    && pooledWilsonLowerBound95 !== null;
}

function ordinalDistance(value: number, axis: readonly number[]): number {
  const index = axis.indexOf(value);
  if (index < 0) throw new TypeError("candidate parameters must belong to the fixed grid");
  return Math.abs(2 * index - (axis.length - 1));
}

export function zScoreParameterDistanceFromGridCenter(parameters: ZScoreParameters): number {
  return ordinalDistance(parameters.lookback, LOOKBACK_GRID)
    + ordinalDistance(parameters.entryZ, ENTRY_Z_GRID)
    + ordinalDistance(parameters.exitZ, EXIT_Z_GRID)
    + ordinalDistance(parameters.maxHoldBars, MAX_HOLD_BARS_GRID);
}

export function rankZScoreCandidates(
  candidates: readonly ZScoreCandidateDiagnostics[],
): readonly ZScoreCandidateDiagnostics[] {
  return Object.freeze(candidates.filter((candidate) => (
    candidate.eligible
    && candidate.aggregate.WilsonLowerBound95 !== null
    && candidate.aggregate.rawNetWinRate !== null
  )).slice().sort((left, right) => {
    const leftWilson = left.aggregate.WilsonLowerBound95!;
    const rightWilson = right.aggregate.WilsonLowerBound95!;
    if (leftWilson !== rightWilson) return leftWilson > rightWilson ? -1 : 1;
    const leftRawRate = left.aggregate.rawNetWinRate!;
    const rightRawRate = right.aggregate.rawNetWinRate!;
    if (leftRawRate !== rightRawRate) return leftRawRate > rightRawRate ? -1 : 1;
    const leftDistance = zScoreParameterDistanceFromGridCenter(left.parameters);
    const rightDistance = zScoreParameterDistanceFromGridCenter(right.parameters);
    if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1;
    if (left.candidateId === right.candidateId) return 0;
    return left.candidateId < right.candidateId ? -1 : 1;
  }));
}

function metricsFromCounts(input: {
  readonly completedTradeCount: number;
  readonly WIN: number;
  readonly LOSS: number;
  readonly BREAKEVEN: number;
  readonly netPnlMinor: bigint;
  readonly feesMinor: bigint;
}): ZScoreMetrics {
  const { completedTradeCount, WIN, LOSS, BREAKEVEN, netPnlMinor, feesMinor } = input;
  if (completedTradeCount !== WIN + LOSS + BREAKEVEN) throw new Error("completed-trade outcomes do not reconcile");
  return Object.freeze({
    completedTradeCount,
    WIN,
    LOSS,
    BREAKEVEN,
    rawNetWinRate: completedTradeCount === 0 ? null : WIN / completedTradeCount,
    WilsonLowerBound95: wilsonLowerBound95(WIN, completedTradeCount),
    netPnl: formatTwdMinor(netPnlMinor),
    fees: formatTwdMinor(feesMinor),
  });
}

export function formatTwdMinor(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const major = magnitude / 100n;
  const minor = (magnitude % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${major.toString()}.${minor}`;
}

export function evaluateZScoreFold(
  parsed: ParsedHistoricalCsv,
  fold: ZScoreRollingOriginFold,
  parameters: ZScoreParameters,
  inputSha256: string,
): ZScoreFoldOutcome {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("inputSha256 must be a lowercase SHA-256 digest");
  const events = parsed.session.events;
  if (
    parsed.rowCount !== events.length
    || fold.trainingEndIndex !== fold.validationStartIndex
    || fold.validationStartIndex < 1
    || fold.validationEndIndex > events.length
    || fold.validationStartIndex >= fold.validationEndIndex
  ) {
    throw new TypeError("rolling-origin fold boundaries are invalid for this symbol's history");
  }
  const firstValidationEvent = events[fold.validationStartIndex];
  if (!firstValidationEvent) throw new TypeError("validation fold has no first event");
  const strategy = new RollingZScoreMeanReversionV1Strategy({
    ...parameters,
    activeFromTimestamp: firstValidationEvent.timestamp,
  });
  const foldSession = Object.freeze({
    ...parsed.session,
    events: Object.freeze(events.slice(0, fold.validationEndIndex)),
  });
  const result = runPaperSession(foldSession, inputSha256, undefined, strategy);
  const statistics = asRecord(result["tradingStatistics"], "paper session tradingStatistics");
  const account = asRecord(result["accountSummary"], "paper session accountSummary");
  const completedTrades = statistics["completedTrades"];
  if (!Array.isArray(completedTrades)) throw new TypeError("paper session completedTrades must be an array");
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "completeTradeCount");
  const WIN = safeCount(statistics["wins"], "wins");
  const LOSS = safeCount(statistics["losses"], "losses");
  const BREAKEVEN = safeCount(statistics["breakevens"], "breakevens");
  if (completedTradeCount !== completedTrades.length || completedTradeCount !== WIN + LOSS + BREAKEVEN) {
    throw new Error("paper session completed-trade outcomes do not reconcile");
  }
  const netPnlMinor = completedTrades.reduce((sum: bigint, rawTrade: unknown, index: number) => {
    const trade = asRecord(rawTrade, `completedTrades[${index}]`);
    return sum + integerMinor(trade["netPnlMinor"], `completedTrades[${index}].netPnlMinor`);
  }, 0n);
  return Object.freeze({
    foldId: fold.id,
    completedTradeCount,
    WIN,
    LOSS,
    BREAKEVEN,
    netPnlMinor,
    feesMinor: integerMinor(account["feesPaidMinor"], "accountSummary.feesPaidMinor"),
  });
}

function combineFoldOutcomes(outcomes: readonly ZScoreFoldOutcome[]): Omit<ZScoreMetrics, "rawNetWinRate" | "WilsonLowerBound95" | "netPnl" | "fees"> & {
  readonly netPnlMinor: bigint;
  readonly feesMinor: bigint;
} {
  return Object.freeze({
    completedTradeCount: outcomes.reduce((sum, row) => sum + row.completedTradeCount, 0),
    WIN: outcomes.reduce((sum, row) => sum + row.WIN, 0),
    LOSS: outcomes.reduce((sum, row) => sum + row.LOSS, 0),
    BREAKEVEN: outcomes.reduce((sum, row) => sum + row.BREAKEVEN, 0),
    netPnlMinor: outcomes.reduce((sum, row) => sum + row.netPnlMinor, 0n),
    feesMinor: outcomes.reduce((sum, row) => sum + row.feesMinor, 0n),
  });
}

function dateOf(event: MarketEvent | undefined): string | null {
  return event === undefined ? null : new Date(event.timestamp).toISOString().slice(0, 10);
}

function foldPolicyForSymbols(parsedBySymbol: ReadonlyMap<string, ParsedHistoricalCsv>): Record<string, unknown> {
  const perSymbolBoundaries = ZSCORE_WIN_RATE_SYMBOLS.map((symbol) => {
    const parsed = parsedBySymbol.get(symbol);
    if (!parsed) throw new Error(`missing historical input for ${symbol}`);
    const folds = buildZScoreRollingOriginFolds(parsed.rowCount);
    return Object.freeze({
      symbol,
      rowCount: parsed.rowCount,
      folds: Object.freeze(folds.map((fold) => Object.freeze({
        id: fold.id,
        training: Object.freeze({
          startRowInclusive: 1,
          endRowExclusive: fold.trainingEndIndex + 1,
          startDate: dateOf(parsed.session.events[0]),
          endDate: dateOf(parsed.session.events[fold.trainingEndIndex - 1]),
          rowCount: fold.trainingEndIndex,
        }),
        validation: Object.freeze({
          startRowInclusive: fold.validationStartIndex + 1,
          endRowExclusive: fold.validationEndIndex + 1,
          startDate: dateOf(parsed.session.events[fold.validationStartIndex]),
          endDate: dateOf(parsed.session.events[fold.validationEndIndex - 1]),
          rowCount: fold.validationEndIndex - fold.validationStartIndex,
        }),
      }))),
    });
  });
  return Object.freeze({
    policy: "ROLLING_ORIGIN_3_EQUAL_ROW_FOLDS_PER_SYMBOL",
    foldCountPerSymbol: 3,
    boundaryIndicesZeroBased: "floor(n/4), floor(n/2), floor(3n/4), n; each validation slice is evaluated only after its training prefix",
    perSymbolBoundaries: Object.freeze(perSymbolBoundaries),
  });
}

export function evaluateZScoreCandidate(
  parsedBySymbol: ReadonlyMap<string, ParsedHistoricalCsv>,
  candidate: ZScoreCandidate,
  inputSha256: string,
): ZScoreCandidateDiagnostics {
  const perSymbol = ZSCORE_WIN_RATE_SYMBOLS.map((symbol) => {
    const parsed = parsedBySymbol.get(symbol);
    if (!parsed) throw new Error(`missing historical input for ${symbol}`);
    const folds = buildZScoreRollingOriginFolds(parsed.rowCount);
    const outcomes = folds.map((fold) => evaluateZScoreFold(parsed, fold, candidate.parameters, inputSha256));
    const counts = combineFoldOutcomes(outcomes);
    return Object.freeze({ symbol, ...metricsFromCounts(counts) });
  });
  const aggregateCounts = {
    completedTradeCount: perSymbol.reduce((sum, row) => sum + row.completedTradeCount, 0),
    WIN: perSymbol.reduce((sum, row) => sum + row.WIN, 0),
    LOSS: perSymbol.reduce((sum, row) => sum + row.LOSS, 0),
    BREAKEVEN: perSymbol.reduce((sum, row) => sum + row.BREAKEVEN, 0),
    netPnlMinor: perSymbol.reduce((sum, row) => sum + BigInt(row.netPnl.replace(".", "")), 0n),
    feesMinor: perSymbol.reduce((sum, row) => sum + BigInt(row.fees.replace(".", "")), 0n),
  };
  const aggregate = metricsFromCounts(aggregateCounts);
  const eligible = isZScoreCandidateEligible(
    perSymbol.map(({ completedTradeCount }) => completedTradeCount),
    aggregate.completedTradeCount,
    aggregate.WilsonLowerBound95,
  );
  return Object.freeze({
    candidateId: candidate.candidateId,
    parameters: candidate.parameters,
    perSymbol: Object.freeze(perSymbol),
    aggregate,
    eligible,
    parameterDistanceFromGridCenter: zScoreParameterDistanceFromGridCenter(candidate.parameters),
  });
}

export function selectZScoreWinRateCandidate(
  parsedBySymbol: ReadonlyMap<string, ParsedHistoricalCsv>,
  historicalInputSha256: string,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(historicalInputSha256)) throw new TypeError("historicalInputSha256 must be a lowercase SHA-256 digest");
  for (const symbol of ZSCORE_WIN_RATE_SYMBOLS) {
    const parsed = parsedBySymbol.get(symbol);
    if (!parsed || parsed.symbol !== symbol || parsed.endDate > ZSCORE_HISTORICAL_CUTOFF) {
      throw new TypeError(`historical development input for ${symbol} is missing or crosses the cutoff`);
    }
  }
  const grid = buildZScoreCandidateGrid();
  if (grid.length !== 24) throw new Error("the frozen z-score candidate grid must contain exactly 24 candidates");
  const candidateDiagnostics = Object.freeze(grid.map((candidate) => (
    evaluateZScoreCandidate(parsedBySymbol, candidate, historicalInputSha256)
  )));
  const selected = rankZScoreCandidates(candidateDiagnostics)[0] ?? null;
  const foldPolicy = foldPolicyForSymbols(parsedBySymbol);
  return Object.freeze({
    schemaVersion: 1,
    strategyFamily: ROLLING_ZSCORE_MEAN_REVERSION_V1,
    objective: WIN_RATE_OBJECTIVE,
    historicalInputSha256,
    historicalDataEnd: ZSCORE_HISTORICAL_CUTOFF,
    candidateGrid: Object.freeze({
      lookback: LOOKBACK_GRID,
      entryZ: ENTRY_Z_GRID,
      exitZ: EXIT_Z_GRID,
      maxHoldBars: MAX_HOLD_BARS_GRID,
      candidateCount: grid.length,
    }),
    foldPolicy,
    selectionRanking: Object.freeze([
      "highest pooled validation WilsonLowerBound95",
      "higher pooled validation rawNetWinRate",
      "smallest summed ordinal distance from the center of the four fixed grid axes",
      "lexicographically smallest candidate id",
    ]),
    eligibilityPolicy: Object.freeze({
      minimumSymbolsWithAtLeastTwoCompletedValidationTrades: 4,
      requiredSymbolCount: ZSCORE_WIN_RATE_SYMBOLS.length,
      minimumAggregateCompletedValidationTrades: 20,
      requiresNonNullPooledWilsonLowerBound95: true,
    }),
    candidateDiagnostics,
    selectionStatus: selected === null ? "NO_ELIGIBLE_CANDIDATE" : "SELECTED_FUTURE_CANDIDATE",
    selectedFutureCandidate: selected === null
      ? null
      : Object.freeze({
          id: selected.candidateId,
          strategyFamily: ROLLING_ZSCORE_MEAN_REVERSION_V1,
          parameters: selected.parameters,
          aggregateCompletedTradeCount: selected.aggregate.completedTradeCount,
          aggregateW: selected.aggregate.WIN,
          aggregateL: selected.aggregate.LOSS,
          aggregateBE: selected.aggregate.BREAKEVEN,
          rawNetWinRate: selected.aggregate.rawNetWinRate,
          WilsonLowerBound95: selected.aggregate.WilsonLowerBound95,
        }),
    freshEvaluationPolicy: Object.freeze({
      symbols: Object.freeze(["0056", "2317", "2330", "2454"]),
      historicalCutoff: ZSCORE_HISTORICAL_CUTOFF,
      dataSource: "TWSE STOCK_DAY monthly report API",
      dataFetchAllowedOnlyAfterFreezeCommit: true,
      evidencePurpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION",
      legacyReferenceCandidateId: "lookback-20-entry-0.04-take-0.04-hold-10",
      minimumSymbolsWithCompletedTradePerStrategy: 3,
      minimumAggregateCompletedTradesPerStrategy: 12,
      improvementRule: "new challenger aggregate WilsonLowerBound95 must be strictly greater than legacy reference",
    }),
  });
}

export function serializeZScoreSelectionArtifact(artifact: Record<string, unknown>): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`historical P194 is not valid UTF-8 CSV: ${detail}`);
  }
}

export async function loadZScoreHistoricalDevelopment(): Promise<{
  readonly inputSha256: string;
  readonly parsedBySymbol: ReadonlyMap<string, ParsedHistoricalCsv>;
}> {
  const bytes = await readFile(resolve(PROJECT_ROOT, ZSCORE_HISTORICAL_INPUT_PATH));
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  if (inputSha256 !== ZSCORE_HISTORICAL_INPUT_SHA256) {
    throw new TypeError("P194 historical SHA-256 does not match the pinned selection input");
  }
  const contents = decodeCsv(bytes);
  const parsedBySymbol = new Map<string, ParsedHistoricalCsv>();
  for (const symbol of ZSCORE_WIN_RATE_SYMBOLS) {
    const parsed = parseHistoricalCsv(contents, symbol, ZSCORE_HISTORICAL_INPUT_PATH, SOURCE_PROFILE);
    if (parsed.endDate !== ZSCORE_HISTORICAL_CUTOFF) {
      throw new TypeError(`P194 data end for ${symbol} is ${parsed.endDate}; expected ${ZSCORE_HISTORICAL_CUTOFF}`);
    }
    parsedBySymbol.set(symbol, parsed);
  }
  return Object.freeze({ inputSha256, parsedBySymbol });
}

export async function runZScoreWinRateSelection(): Promise<Record<string, unknown>> {
  const { inputSha256, parsedBySymbol } = await loadZScoreHistoricalDevelopment();
  const artifact = selectZScoreWinRateCandidate(parsedBySymbol, inputSha256);
  await writeFile(resolve(PROJECT_ROOT, ZSCORE_SELECTION_ARTIFACT_PATH), serializeZScoreSelectionArtifact(artifact), "utf8");
  return artifact;
}

export function assertNoZScoreSelectionCliOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("z-score selector accepts no data, candidate-grid, or tuning overrides");
}

async function main(args: readonly string[]): Promise<void> {
  assertNoZScoreSelectionCliOverrides(args);
  const artifact = await runZScoreWinRateSelection();
  const selected = artifact["selectedFutureCandidate"];
  stdout.write(`${JSON.stringify({ artifactPath: ZSCORE_SELECTION_ARTIFACT_PATH, selectionStatus: artifact["selectionStatus"], selectedFutureCandidate: selected })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown z-score selection error";
    stderr.write(`paper:select-zscore-win-rate: ${message}\n`);
    process.exitCode = 1;
  });
}
