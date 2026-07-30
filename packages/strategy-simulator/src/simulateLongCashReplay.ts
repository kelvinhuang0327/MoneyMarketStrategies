import { hashValue } from "@mms/research-kernel";

import {
  LongCashReplayError,
  type LongCashReplayInput,
  type LongCashReplayPathSummary,
  type LongCashReplayPolicy,
  type LongCashReplayResult,
  type LongCashReplayRow,
  type LongCashReplayWindow,
  type SelectedScheduleWindow,
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
  if (value.length !== 10 || match === null) {
    fail(`${name} must use canonical YYYY-MM-DD format`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const reconstructed = new Date(0);
  reconstructed.setUTCFullYear(year, month - 1, day);
  reconstructed.setUTCHours(0, 0, 0, 0);
  if (
    reconstructed.getUTCFullYear() !== year
    || reconstructed.getUTCMonth() !== month - 1
    || reconstructed.getUTCDate() !== day
  ) {
    fail(`${name} must be a real canonical date`);
  }
}

function compareRows(left: LongCashReplayRow, right: LongCashReplayRow): number {
  if (left.entryDate < right.entryDate) return -1;
  if (left.entryDate > right.entryDate) return 1;
  if (left.exitDate < right.exitDate) return -1;
  if (left.exitDate > right.exitDate) return 1;
  return 0;
}

function normalizeInput(input: LongCashReplayInput): Readonly<{
  symbol: string;
  validationThreshold: number;
  roundTripCostBps: number;
  initialCapital: number;
  rows: readonly LongCashReplayRow[];
}> {
  const symbol = input.symbol.trim();
  if (symbol.length === 0) fail("symbol must not be blank");
  assertFinite("validationThreshold", input.validationThreshold);
  if (input.validationThreshold < 0 || input.validationThreshold > 1) {
    fail("validationThreshold must be within [0, 1]");
  }
  assertFinite("roundTripCostBps", input.roundTripCostBps);
  if (input.roundTripCostBps < 0 || input.roundTripCostBps > 10_000) {
    fail("roundTripCostBps must be within [0, 10000]");
  }
  assertFinite("initialCapital", input.initialCapital);
  if (input.initialCapital <= 0) fail("initialCapital must be greater than zero");
  if (input.rows.length === 0) fail("rows must contain at least one prediction");

  const rows = input.rows.map((row, index) => {
    const prefix = `rows[${index}]`;
    assertCanonicalDate(`${prefix}.entryDate`, row.entryDate);
    assertCanonicalDate(`${prefix}.exitDate`, row.exitDate);
    if (row.entryDate >= row.exitDate) {
      fail(`${prefix} must exit after it enters`);
    }
    return Object.freeze({
      entryDate: row.entryDate,
      exitDate: row.exitDate,
      probabilityUp: row.probabilityUp,
      realizedForwardReturn: row.realizedForwardReturn,
    });
  });
  rows.sort(compareRows);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.entryDate === rows[index - 1]!.entryDate) {
      fail(`rows contain duplicate entryDate ${rows[index]!.entryDate}`);
    }
  }

  return Object.freeze({
    symbol,
    validationThreshold: input.validationThreshold,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    rows: Object.freeze(rows),
  });
}

function validateRowValues(rows: readonly LongCashReplayRow[]): void {
  rows.forEach((row, index) => {
    const prefix = `rows[${index}]`;
    assertFinite(`${prefix}.probabilityUp`, row.probabilityUp);
    if (row.probabilityUp < 0 || row.probabilityUp > 1) {
      fail(`${prefix}.probabilityUp must be within [0, 1]`);
    }
    assertFinite(`${prefix}.realizedForwardReturn`, row.realizedForwardReturn);
    if (row.realizedForwardReturn <= -1) {
      fail(`${prefix}.realizedForwardReturn must be greater than -1`);
    }
  });
}

function selectNonOverlappingRows(
  rows: readonly LongCashReplayRow[],
): readonly LongCashReplayRow[] {
  const selected: LongCashReplayRow[] = [];
  let previousExitDate: string | undefined;
  rows.forEach((row) => {
    if (previousExitDate !== undefined && row.entryDate <= previousExitDate) return;
    selected.push(row);
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
  longWindowNetReturns: readonly number[],
): LongCashReplayPathSummary {
  const winningLongTradeCount = longWindowNetReturns.filter((value) => value > 0).length;
  const losingLongTradeCount = longWindowNetReturns.filter((value) => value < 0).length;
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
    winningLongTradeCount,
    losingLongTradeCount,
    averageActiveLongNetReturn: longWindowNetReturns.length === 0
      ? 0
      : round(longWindowNetReturns.reduce((sum, value) => sum + value, 0)
        / longWindowNetReturns.length),
  });
}

export function simulateLongCashReplay(input: LongCashReplayInput): LongCashReplayResult {
  const normalizedInput = normalizeInput(input);
  const selected = selectNonOverlappingRows(normalizedInput.rows);
  validateRowValues(normalizedInput.rows);
  const selectedSchedule: readonly SelectedScheduleWindow[] = Object.freeze(
    selected.map((row) => Object.freeze({
      entryDate: row.entryDate,
      exitDate: row.exitDate,
    })),
  );
  const selectedScheduleSha256 = hashValue(selectedSchedule);
  const costRate = normalizedInput.roundTripCostBps / 10_000;
  let strategyCapital = normalizedInput.initialCapital;
  let benchmarkCapital = normalizedInput.initialCapital;
  let strategyTransactionCost = 0;
  let benchmarkTransactionCost = 0;
  let strategyLongWindowCount = 0;
  const strategyLongWindowNetReturns: number[] = [];
  const benchmarkLongWindowNetReturns: number[] = [];
  const windows: LongCashReplayWindow[] = [];

  selected.forEach((row, selectedScheduleIndex) => {
    const strategyPosition = row.probabilityUp >= normalizedInput.validationThreshold
      ? "LONG"
      : "CASH";
    const strategyGrossReturn = strategyPosition === "LONG" ? row.realizedForwardReturn : 0;
    const strategyGrossFactor = 1 + strategyGrossReturn;
    const strategyCostRate = strategyPosition === "LONG" ? costRate : 0;
    const strategyNetFactor = strategyGrossFactor * (1 - strategyCostRate);
    const strategyNetReturn = strategyPosition === "LONG"
      ? round(strategyNetFactor - 1)
      : 0;
    const benchmarkGrossReturn = row.realizedForwardReturn;
    const benchmarkGrossFactor = 1 + benchmarkGrossReturn;
    const benchmarkNetFactor = benchmarkGrossFactor * (1 - costRate);
    const benchmarkNetReturn = round(benchmarkNetFactor - 1);
    if (strategyNetFactor < 0 || benchmarkNetFactor < 0) {
      fail(`row ${selectedScheduleIndex} produces negative capital after round-trip costs`);
    }

    if (strategyPosition === "LONG") {
      strategyLongWindowCount += 1;
      strategyLongWindowNetReturns.push(strategyNetReturn);
      strategyTransactionCost += strategyCapital * strategyGrossFactor * costRate;
    }
    benchmarkLongWindowNetReturns.push(benchmarkNetReturn);
    benchmarkTransactionCost += benchmarkCapital * benchmarkGrossFactor * costRate;
    strategyCapital = round(strategyCapital * strategyNetFactor);
    benchmarkCapital = round(benchmarkCapital * benchmarkNetFactor);
    windows.push(Object.freeze({
      sourceRowIndex: selectedScheduleIndex,
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
  });

  const frozenWindows = Object.freeze(windows);
  const strategy = buildSummary(
    "VALIDATION_THRESHOLD_LONG_CASH",
    normalizedInput.initialCapital,
    strategyCapital,
    frozenWindows.map((window) => window.strategyCapital),
    strategyLongWindowCount,
    frozenWindows.length - strategyLongWindowCount,
    strategyTransactionCost,
    strategyLongWindowNetReturns,
  );
  const benchmark = buildSummary(
    "ALWAYS_LONG_BENCHMARK",
    normalizedInput.initialCapital,
    benchmarkCapital,
    frozenWindows.map((window) => window.benchmarkCapital),
    frozenWindows.length,
    0,
    benchmarkTransactionCost,
    benchmarkLongWindowNetReturns,
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
    symbol: normalizedInput.symbol,
    validationThreshold: normalizedInput.validationThreshold,
    roundTripCostBps: normalizedInput.roundTripCostBps,
    initialCapital: normalizedInput.initialCapital,
    inputRowCount: normalizedInput.rows.length,
    replayWindowCount: frozenWindows.length,
    skippedOverlapCount: normalizedInput.rows.length - frozenWindows.length,
    inputSha256: hashValue({
      schemaVersion: SCHEMA_VERSION,
      symbol: normalizedInput.symbol,
      validationThreshold: normalizedInput.validationThreshold,
      roundTripCostBps: normalizedInput.roundTripCostBps,
      initialCapital: normalizedInput.initialCapital,
      rows: normalizedInput.rows,
    }),
    selectedSchedule,
    selectedScheduleSha256,
    replayWindowsSha256: hashValue(frozenWindows),
    windows: frozenWindows,
    strategy,
    benchmark,
    excessReturn: round(strategy.totalReturn - benchmark.totalReturn),
    guardrails,
  });
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}
