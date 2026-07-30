import { hashValue } from "@mms/research-kernel";

import {
  LongCashReplayError,
  type LongCashReplayInput,
  type LongCashReplayPathSummary,
  type LongCashReplayPolicy,
  type LongCashReplayResult,
  type LongCashReplayRow,
  type LongCashReplayWindow,
} from "./types.js";

const SCHEMA_VERSION = "MMS_LONG_CASH_REPLAY_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const DECIMAL_PLACES = 8;
const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) fail(`${name} must be finite`);
}

function assertCanonicalDate(name: string, value: string): void {
  const match = CANONICAL_DATE.exec(value);
  if (match === null) fail(`${name} must use canonical YYYY-MM-DD format`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (normalized !== value) fail(`${name} must be a real canonical date`);
}

function validateRows(rows: readonly LongCashReplayRow[]): void {
  if (rows.length === 0) fail("rows must contain at least one prediction");
  let priorEntryDate: string | undefined;
  let priorExitDate: string | undefined;
  rows.forEach((row, index) => {
    const prefix = `rows[${index}]`;
    assertCanonicalDate(`${prefix}.entryDate`, row.entryDate);
    assertCanonicalDate(`${prefix}.exitDate`, row.exitDate);
    if (row.entryDate >= row.exitDate) {
      fail(`${prefix} must exit after it enters`);
    }
    if (priorEntryDate !== undefined && row.entryDate <= priorEntryDate) {
      fail(`${prefix} entryDate must be strictly later than the prior entryDate`);
    }
    if (priorExitDate !== undefined && row.exitDate <= priorExitDate) {
      fail(`${prefix} exitDate must be strictly later than the prior exitDate`);
    }
    assertFinite(`${prefix}.probabilityUp`, row.probabilityUp);
    if (row.probabilityUp < 0 || row.probabilityUp > 1) {
      fail(`${prefix}.probabilityUp must be within [0, 1]`);
    }
    assertFinite(`${prefix}.realizedForwardReturn`, row.realizedForwardReturn);
    if (row.realizedForwardReturn <= -1) {
      fail(`${prefix}.realizedForwardReturn must be greater than -1`);
    }
    priorEntryDate = row.entryDate;
    priorExitDate = row.exitDate;
  });
}

function validateInput(input: LongCashReplayInput): void {
  if (input.symbol.trim().length === 0) fail("symbol must not be blank");
  assertFinite("validationThreshold", input.validationThreshold);
  if (input.validationThreshold < 0 || input.validationThreshold > 1) {
    fail("validationThreshold must be within [0, 1]");
  }
  assertFinite("roundTripCostBps", input.roundTripCostBps);
  if (input.roundTripCostBps < 0 || input.roundTripCostBps >= 10_000) {
    fail("roundTripCostBps must be within [0, 10000)");
  }
  assertFinite("initialCapital", input.initialCapital);
  if (input.initialCapital <= 0) fail("initialCapital must be greater than zero");
  validateRows(input.rows);
}

function selectNonOverlappingRows(
  rows: readonly LongCashReplayRow[],
): readonly { readonly row: LongCashReplayRow; readonly sourceRowIndex: number }[] {
  const selected: { readonly row: LongCashReplayRow; readonly sourceRowIndex: number }[] = [];
  let previousExitDate: string | undefined;
  rows.forEach((row, sourceRowIndex) => {
    if (previousExitDate !== undefined && row.entryDate < previousExitDate) return;
    selected.push(Object.freeze({ row, sourceRowIndex }));
    previousExitDate = row.exitDate;
  });
  return Object.freeze(selected);
}

function maximumDrawdown(initialCapital: number, capitals: readonly number[]): number {
  let peak = initialCapital;
  let maximum = 0;
  for (const capital of capitals) {
    peak = Math.max(peak, capital);
    maximum = Math.max(maximum, (peak - capital) / peak);
  }
  return round(maximum);
}

function buildSummary(
  policy: LongCashReplayPolicy,
  initialCapital: number,
  finalCapital: number,
  capitals: readonly number[],
  longWindowCount: number,
  cashWindowCount: number,
  totalTransactionCost: number,
): LongCashReplayPathSummary {
  return Object.freeze({
    policy,
    initialCapital,
    finalCapital,
    totalReturn: round(finalCapital / initialCapital - 1),
    maximumDrawdown: maximumDrawdown(initialCapital, capitals),
    longWindowCount,
    cashWindowCount,
    roundTripCount: longWindowCount,
    totalTransactionCost: round(totalTransactionCost),
  });
}

export function simulateLongCashReplay(input: LongCashReplayInput): LongCashReplayResult {
  validateInput(input);
  const selected = selectNonOverlappingRows(input.rows);
  const costRate = input.roundTripCostBps / 10_000;
  let strategyCapital = input.initialCapital;
  let benchmarkCapital = input.initialCapital;
  let strategyTransactionCost = 0;
  let benchmarkTransactionCost = 0;
  let strategyLongWindowCount = 0;
  const windows: LongCashReplayWindow[] = [];

  for (const { row, sourceRowIndex } of selected) {
    const strategyPosition = row.probabilityUp >= input.validationThreshold ? "LONG" : "CASH";
    const strategyGrossReturn = strategyPosition === "LONG" ? row.realizedForwardReturn : 0;
    const strategyNetReturn = strategyPosition === "LONG"
      ? round(strategyGrossReturn - costRate)
      : 0;
    const benchmarkGrossReturn = row.realizedForwardReturn;
    const benchmarkNetReturn = round(benchmarkGrossReturn - costRate);
    if (strategyNetReturn <= -1 || benchmarkNetReturn <= -1) {
      fail(`row ${sourceRowIndex} loses all capital after round-trip costs`);
    }

    if (strategyPosition === "LONG") {
      strategyLongWindowCount += 1;
      strategyTransactionCost += strategyCapital * costRate;
    }
    benchmarkTransactionCost += benchmarkCapital * costRate;
    strategyCapital = round(strategyCapital * (1 + strategyNetReturn));
    benchmarkCapital = round(benchmarkCapital * (1 + benchmarkNetReturn));
    windows.push(Object.freeze({
      sourceRowIndex,
      entryDate: row.entryDate,
      exitDate: row.exitDate,
      probabilityUp: row.probabilityUp,
      realizedForwardReturn: row.realizedForwardReturn,
      strategyPosition,
      strategyGrossReturn,
      strategyNetReturn,
      benchmarkGrossReturn,
      benchmarkNetReturn,
      strategyCapital,
      benchmarkCapital,
    }));
  }

  const frozenWindows = Object.freeze(windows);
  const strategy = buildSummary(
    "VALIDATION_THRESHOLD_LONG_CASH",
    input.initialCapital,
    strategyCapital,
    frozenWindows.map((window) => window.strategyCapital),
    strategyLongWindowCount,
    frozenWindows.length - strategyLongWindowCount,
    strategyTransactionCost,
  );
  const benchmark = buildSummary(
    "ALWAYS_LONG_BENCHMARK",
    input.initialCapital,
    benchmarkCapital,
    frozenWindows.map((window) => window.benchmarkCapital),
    frozenWindows.length,
    0,
    benchmarkTransactionCost,
  );
  const guardrails = Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
  } as const);
  const normalized = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: input.symbol,
    validationThreshold: input.validationThreshold,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    inputRowCount: input.rows.length,
    replayWindowCount: frozenWindows.length,
    skippedOverlapCount: input.rows.length - frozenWindows.length,
    inputSha256: hashValue({
      schemaVersion: SCHEMA_VERSION,
      symbol: input.symbol,
      validationThreshold: input.validationThreshold,
      roundTripCostBps: input.roundTripCostBps,
      initialCapital: input.initialCapital,
      rows: input.rows,
    }),
    replayWindowsSha256: hashValue(frozenWindows),
    windows: frozenWindows,
    strategy,
    benchmark,
    guardrails,
  });
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
