import type { LongCashReplayResult } from "./types.js";

const DECIMAL_PLACES = 8;

export interface LongCashReplaySummary {
  readonly symbol: string;
  readonly configuredThreshold: number;
  readonly observations: number;
  readonly longObservations: number;
  readonly cashObservations: number;
  readonly winningLongObservations: number;
  readonly losingLongObservations: number;
  readonly longHitRate: number;
  readonly strategyTotalReturn: number;
  readonly benchmarkTotalReturn: number;
  readonly excessReturn: number;
  readonly strategyUlcerIndex: number;
  readonly benchmarkUlcerIndex: number;
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function calculateUlcerIndex(
  initialCapital: number,
  capitals: readonly number[],
): number {
  let runningPeak = initialCapital;
  let squaredDrawdownTotal = 0;

  for (const capital of capitals) {
    if (capital > runningPeak) runningPeak = capital;
    const drawdownPercentage = ((runningPeak - capital) / runningPeak) * 100;
    squaredDrawdownTotal += drawdownPercentage ** 2;
  }

  return capitals.length === 0
    ? 0
    : round(Math.sqrt(squaredDrawdownTotal / capitals.length));
}

export function summarizeLongCashReplay(
  replay: LongCashReplayResult,
): LongCashReplaySummary {
  const longObservations = replay.strategy.longWindowCount;
  const winningLongObservations = replay.strategy.winningLongTradeCount;

  return Object.freeze({
    symbol: replay.symbol,
    configuredThreshold: replay.validationThreshold,
    observations: replay.windows.length,
    longObservations,
    cashObservations: replay.strategy.cashWindowCount,
    winningLongObservations,
    losingLongObservations: replay.strategy.losingLongTradeCount,
    longHitRate: longObservations === 0
      ? 0
      : round(winningLongObservations / longObservations),
    strategyTotalReturn: replay.strategy.totalReturn,
    benchmarkTotalReturn: replay.benchmark.totalReturn,
    excessReturn: replay.excessReturn,
    strategyUlcerIndex: calculateUlcerIndex(
      replay.initialCapital,
      replay.windows.map((window) => window.strategyCapital),
    ),
    benchmarkUlcerIndex: calculateUlcerIndex(
      replay.initialCapital,
      replay.windows.map((window) => window.benchmarkCapital),
    ),
  });
}
