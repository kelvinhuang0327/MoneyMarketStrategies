import type {
  LongCashReplayPolicy,
  LongCashReplayResult,
} from "./types.js";

const SCHEMA_VERSION = "MMS_LONG_CASH_BENCHMARK_COMPARISON_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

export type LongCashBenchmarkVerdict =
  | "OUTPERFORMS_BENCHMARK"
  | "MIXED_RELATIVE_PERFORMANCE"
  | "UNDERPERFORMS_BENCHMARK";

export interface LongCashBenchmarkComparison {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly symbol: string;
  readonly strategyPolicy: LongCashReplayPolicy;
  readonly benchmarkPolicy: LongCashReplayPolicy;
  readonly observationCount: number;
  readonly strategyTotalReturn: number;
  readonly benchmarkTotalReturn: number;
  readonly excessReturn: number;
  readonly strategyMaximumDrawdown: number;
  readonly benchmarkMaximumDrawdown: number;
  /** Positive means the strategy used less peak-to-trough drawdown. */
  readonly drawdownAdvantage: number;
  readonly strategyOutperformedWindowCount: number;
  readonly benchmarkOutperformedWindowCount: number;
  readonly tiedWindowCount: number;
  readonly strategyOutperformanceRate: number;
  readonly verdict: LongCashBenchmarkVerdict;
  readonly caveats: readonly string[];
}

function round(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveVerdict(
  excessReturn: number,
  drawdownAdvantage: number,
): LongCashBenchmarkVerdict {
  if (excessReturn > 0 && drawdownAdvantage >= 0) return "OUTPERFORMS_BENCHMARK";
  if (excessReturn < 0 && drawdownAdvantage <= 0) return "UNDERPERFORMS_BENCHMARK";
  return "MIXED_RELATIVE_PERFORMANCE";
}

/**
 * Compares a completed historical replay with its cost-matched always-long
 * benchmark. Realized outcomes are read only after replay decisions have been
 * made, so this diagnostic cannot affect threshold selection or positions.
 */
export function compareLongCashReplayWithBenchmark(
  replay: LongCashReplayResult,
): LongCashBenchmarkComparison {
  let strategyOutperformedWindowCount = 0;
  let benchmarkOutperformedWindowCount = 0;
  let tiedWindowCount = 0;

  for (const window of replay.windows) {
    if (window.strategyNetReturn > window.benchmarkNetReturn) {
      strategyOutperformedWindowCount += 1;
    } else if (window.strategyNetReturn < window.benchmarkNetReturn) {
      benchmarkOutperformedWindowCount += 1;
    } else {
      tiedWindowCount += 1;
    }
  }

  const observationCount = replay.windows.length;
  const strategyTotalReturn = replay.strategy.totalReturn;
  const benchmarkTotalReturn = replay.benchmark.totalReturn;
  const excessReturn = round(strategyTotalReturn - benchmarkTotalReturn);
  const strategyMaximumDrawdown = replay.strategy.maximumDrawdown;
  const benchmarkMaximumDrawdown = replay.benchmark.maximumDrawdown;
  const drawdownAdvantage = round(benchmarkMaximumDrawdown - strategyMaximumDrawdown);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: replay.symbol,
    strategyPolicy: replay.strategy.policy,
    benchmarkPolicy: replay.benchmark.policy,
    observationCount,
    strategyTotalReturn,
    benchmarkTotalReturn,
    excessReturn,
    strategyMaximumDrawdown,
    benchmarkMaximumDrawdown,
    drawdownAdvantage,
    strategyOutperformedWindowCount,
    benchmarkOutperformedWindowCount,
    tiedWindowCount,
    strategyOutperformanceRate: observationCount === 0
      ? 0
      : round(strategyOutperformedWindowCount / observationCount),
    verdict: resolveVerdict(excessReturn, drawdownAdvantage),
    caveats: Object.freeze([
      "The benchmark is the cost-matched always-long replay path.",
      "Window comparisons use realized outcomes after historical position decisions and do not alter replay behavior.",
      "Research-only diagnostic output; it does not provide investment advice or order execution.",
    ]),
  });
}
