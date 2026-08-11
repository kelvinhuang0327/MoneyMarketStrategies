import { describe, expect, it } from "vitest";

import {
  compareLongCashReplayWithBenchmark,
  simulateLongCashReplay,
} from "./index.js";

function replayFixture() {
  return simulateLongCashReplay({
    symbol: "TEST",
    validationThreshold: 0.5,
    roundTripCostBps: 0,
    initialCapital: 100,
    rows: [
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 0.8,
        realizedForwardReturn: 0.2,
      },
      {
        entryDate: "2026-01-10",
        exitDate: "2026-01-17",
        probabilityUp: 0.2,
        realizedForwardReturn: -0.2,
      },
      {
        entryDate: "2026-01-18",
        exitDate: "2026-01-25",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.1,
      },
    ],
  });
}

describe("compareLongCashReplayWithBenchmark", () => {
  it("reports return, drawdown, and per-window benchmark advantage", () => {
    const comparison = compareLongCashReplayWithBenchmark(replayFixture());

    expect(comparison).toMatchObject({
      schemaVersion: "MMS_LONG_CASH_BENCHMARK_COMPARISON_V1",
      researchMode: "diagnostic-only",
      symbol: "TEST",
      strategyPolicy: "VALIDATION_THRESHOLD_LONG_CASH",
      benchmarkPolicy: "ALWAYS_LONG_BENCHMARK",
      observationCount: 3,
      strategyTotalReturn: 0.32,
      benchmarkTotalReturn: 0.056,
      excessReturn: 0.264,
      strategyMaximumDrawdown: 0,
      benchmarkMaximumDrawdown: 0.2,
      drawdownAdvantage: 0.2,
      strategyOutperformedWindowCount: 1,
      benchmarkOutperformedWindowCount: 0,
      tiedWindowCount: 2,
      strategyOutperformanceRate: 0.33333333,
      verdict: "OUTPERFORMS_BENCHMARK",
    });
    expect(comparison.caveats).toHaveLength(3);
    expect(Object.isFrozen(comparison)).toBe(true);
    expect(Object.isFrozen(comparison.caveats)).toBe(true);
  });

  it("classifies an equal path as mixed and remains deterministic", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 10,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-02-02",
          exitDate: "2026-02-09",
          probabilityUp: 0.4,
          realizedForwardReturn: 0.1,
        },
        {
          entryDate: "2026-02-10",
          exitDate: "2026-02-17",
          probabilityUp: 0.6,
          realizedForwardReturn: -0.05,
        },
      ],
    });

    const first = compareLongCashReplayWithBenchmark(replay);
    const second = compareLongCashReplayWithBenchmark(replay);

    expect(first).toEqual(second);
    expect(first.excessReturn).toBe(0);
    expect(first.drawdownAdvantage).toBe(0);
    expect(first.strategyOutperformedWindowCount).toBe(0);
    expect(first.benchmarkOutperformedWindowCount).toBe(0);
    expect(first.tiedWindowCount).toBe(2);
    expect(first.verdict).toBe("MIXED_RELATIVE_PERFORMANCE");
  });

  it("classifies a strategy that misses a gain as underperforming", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.5,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-03-02",
          exitDate: "2026-03-09",
          probabilityUp: 0.1,
          realizedForwardReturn: 0.2,
        },
        {
          entryDate: "2026-03-10",
          exitDate: "2026-03-17",
          probabilityUp: 1,
          realizedForwardReturn: -0.3,
        },
      ],
    });

    const comparison = compareLongCashReplayWithBenchmark(replay);

    expect(comparison.excessReturn).toBe(-0.14);
    expect(comparison.drawdownAdvantage).toBe(0);
    expect(comparison.verdict).toBe("UNDERPERFORMS_BENCHMARK");
    expect(comparison.strategyOutperformedWindowCount).toBe(0);
    expect(comparison.benchmarkOutperformedWindowCount).toBe(1);
    expect(comparison.tiedWindowCount).toBe(1);
  });
});
