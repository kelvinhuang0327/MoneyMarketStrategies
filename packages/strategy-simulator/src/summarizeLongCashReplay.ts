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
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
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
  });
}
