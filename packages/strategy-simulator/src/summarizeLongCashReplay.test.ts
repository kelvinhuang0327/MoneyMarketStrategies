import { describe, expect, it } from "vitest";

import {
  simulateLongCashReplay,
  summarizeLongCashReplay,
  type LongCashReplayResult,
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
        realizedForwardReturn: 0.1,
      },
      {
        entryDate: "2026-01-18",
        exitDate: "2026-01-25",
        probabilityUp: 0.9,
        realizedForwardReturn: -0.2,
      },
    ],
  });
}

function replayFromPositions(
  rows: readonly { position: "LONG" | "CASH"; netReturn: number }[],
) {
  return simulateLongCashReplay({
    symbol: "TEST",
    validationThreshold: 0.5,
    roundTripCostBps: 0,
    initialCapital: 100,
    rows: rows.map((row, index) => {
      const month = String(7 + Math.floor(index / 3)).padStart(2, "0");
      const day = (index % 3) * 8 + 2;
      return {
        entryDate: `2026-${month}-${String(day).padStart(2, "0")}`,
        exitDate: `2026-${month}-${String(day + 7).padStart(2, "0")}`,
        probabilityUp: row.position === "LONG" ? 1 : 0,
        realizedForwardReturn: row.netReturn,
      };
    }),
  });
}

describe("summarizeLongCashReplay", () => {
  it("summarizes observation, position, outcome, and existing return metrics", () => {
    const replay = replayFixture();

    expect(summarizeLongCashReplay(replay)).toEqual({
      symbol: "TEST",
      configuredThreshold: 0.5,
      observations: 3,
      longObservations: 2,
      cashObservations: 1,
      winningLongObservations: 1,
      losingLongObservations: 1,
      longHitRate: 0.5,
      strategyProfitFactor: 1,
      strategyMaxDrawdownDuration: 2,
      benchmarkMaxDrawdownDuration: 1,
      strategyTotalReturn: replay.strategy.totalReturn,
      benchmarkTotalReturn: replay.benchmark.totalReturn,
      excessReturn: replay.excessReturn,
      strategyUlcerIndex: 11.54700538,
      benchmarkUlcerIndex: 11.54700538,
    });
    expect(replay.strategy.maximumDrawdown).toBe(0.2);
    expect(replay.benchmark.maximumDrawdown).toBe(0.2);
  });

  it("handles all-cash replay without dividing by zero", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 1,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-02-02",
          exitDate: "2026-02-09",
          probabilityUp: 0.2,
          realizedForwardReturn: 0.25,
        },
        {
          entryDate: "2026-02-10",
          exitDate: "2026-02-17",
          probabilityUp: 0.4,
          realizedForwardReturn: -0.1,
        },
      ],
    });

    const summary = summarizeLongCashReplay(replay);

    expect(summary.longObservations).toBe(0);
    expect(summary.cashObservations).toBe(2);
    expect(summary.winningLongObservations).toBe(0);
    expect(summary.losingLongObservations).toBe(0);
    expect(summary.longHitRate).toBe(0);
    expect(summary.strategyProfitFactor).toBe(0);
    expect(summary.strategyMaxDrawdownDuration).toBe(2);
    expect(summary.benchmarkMaxDrawdownDuration).toBe(1);
    expect(summary.strategyTotalReturn).toBe(replay.strategy.totalReturn);
    expect(summary.strategyUlcerIndex).toBe(0);
    expect(summary.benchmarkUlcerIndex).toBe(7.07106781);
  });

  it("handles an empty replay record set", () => {
    const replay = replayFixture();
    const emptyReplay = {
      ...replay,
      windows: Object.freeze([]),
      strategy: {
        ...replay.strategy,
        longWindowCount: 0,
        cashWindowCount: 0,
        winningLongTradeCount: 0,
        losingLongTradeCount: 0,
        totalReturn: 0,
      },
    } as LongCashReplayResult;

    expect(summarizeLongCashReplay(emptyReplay)).toMatchObject({
      observations: 0,
      longObservations: 0,
      cashObservations: 0,
      winningLongObservations: 0,
      losingLongObservations: 0,
      longHitRate: 0,
      strategyProfitFactor: 0,
      strategyMaxDrawdownDuration: 0,
      benchmarkMaxDrawdownDuration: 0,
      strategyTotalReturn: 0,
      strategyUlcerIndex: 0,
      benchmarkUlcerIndex: 0,
    });
  });

  it("matches the legacy percentage-point RMS for a drawdown, recovery, and new high", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-03-02",
          exitDate: "2026-03-09",
          probabilityUp: 1,
          realizedForwardReturn: 0.2,
        },
        {
          entryDate: "2026-03-10",
          exitDate: "2026-03-17",
          probabilityUp: 1,
          realizedForwardReturn: -0.25,
        },
        {
          entryDate: "2026-03-18",
          exitDate: "2026-03-25",
          probabilityUp: 1,
          realizedForwardReturn: 1 / 3,
        },
        {
          entryDate: "2026-03-26",
          exitDate: "2026-04-02",
          probabilityUp: 1,
          realizedForwardReturn: 1 / 3,
        },
      ],
    });

    expect(replay.windows.map((window) => window.strategyCapital)).toEqual([
      120,
      90,
      120,
      160,
    ]);
    // Legacy observes realized points only: sqrt((0² + 25² + 0² + 0²) / 4) = 12.5.
    // Initial capital is the starting peak, not a fifth zero-drawdown observation.
    const summary = summarizeLongCashReplay(replay);
    expect(summary.strategyUlcerIndex).toBe(12.5);
    expect(summary.benchmarkUlcerIndex).toBe(12.5);
  });

  it("calculates the benchmark path independently from a flat all-cash strategy", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 1,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-05-02",
          exitDate: "2026-05-09",
          probabilityUp: 0.2,
          realizedForwardReturn: 0.2,
        },
        {
          entryDate: "2026-05-10",
          exitDate: "2026-05-17",
          probabilityUp: 0.4,
          realizedForwardReturn: -0.2,
        },
      ],
    });

    const summary = summarizeLongCashReplay(replay);
    expect(replay.windows.map((window) => window.strategyCapital)).toEqual([100, 100]);
    expect(replay.windows.map((window) => window.benchmarkCapital)).toEqual([120, 96]);
    expect(summary.strategyMaxDrawdownDuration).toBe(2);
    expect(summary.benchmarkMaxDrawdownDuration).toBe(1);
    expect(summary.strategyUlcerIndex).toBe(0);
    expect(summary.benchmarkUlcerIndex).toBe(14.14213562);
  });

  it("returns zero for a flat benchmark path", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.5,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-06-02",
          exitDate: "2026-06-09",
          probabilityUp: 0.8,
          realizedForwardReturn: 0,
        },
        {
          entryDate: "2026-06-10",
          exitDate: "2026-06-17",
          probabilityUp: 0.2,
          realizedForwardReturn: 0,
        },
      ],
    });

    const summary = summarizeLongCashReplay(replay);
    expect(summary.strategyProfitFactor).toBe(0);
    expect(summary.strategyUlcerIndex).toBe(0);
    expect(summary.benchmarkUlcerIndex).toBe(0);
  });

  it("uses replay-owned positions and remains deterministic", () => {
    const replay = replayFixture();
    const metadataOnlyThresholdChange = Object.freeze({
      ...replay,
      validationThreshold: 0.99,
    });

    expect(summarizeLongCashReplay(metadataOnlyThresholdChange)).toEqual({
      ...summarizeLongCashReplay(replay),
      configuredThreshold: 0.99,
    });
    expect(summarizeLongCashReplay(replay)).toEqual(summarizeLongCashReplay(replay));
    expect(Object.isFrozen(summarizeLongCashReplay(replay))).toBe(true);
  });

  it("matches legacy duration for a drawdown, recovery, and new high", () => {
    const replay = replayFromPositions([
      { position: "LONG", netReturn: 0.2 },
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: 0.1 },
      { position: "LONG", netReturn: 0.2 },
    ]);

    expect(replay.windows.map((window) => window.strategyCapital)).toEqual([
      120,
      108,
      97.2,
      106.92,
      128.304,
    ]);
    expect(summarizeLongCashReplay(replay).strategyMaxDrawdownDuration).toBe(3);
  });

  it("calculates strategy and benchmark duration independently", () => {
    const replay = replayFromPositions([
      { position: "LONG", netReturn: 0.2 },
      { position: "CASH", netReturn: -0.05 },
      { position: "LONG", netReturn: -0.2 },
      { position: "CASH", netReturn: 0.5 },
      { position: "LONG", netReturn: 0.3 },
    ]);
    const summary = summarizeLongCashReplay(replay);

    expect(replay.windows.map((window) => window.strategyCapital)).toEqual([
      120,
      120,
      96,
      96,
      124.8,
    ]);
    expect(replay.windows.map((window) => window.benchmarkCapital)).toEqual([
      120,
      114,
      91.2,
      136.8,
      177.84,
    ]);
    expect(summary.strategyMaxDrawdownDuration).toBe(3);
    expect(summary.benchmarkMaxDrawdownDuration).toBe(2);
  });

  it("returns zero for immediate new highs", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.1 },
      { position: "LONG", netReturn: 0.2 },
    ]));

    expect(summary.strategyMaxDrawdownDuration).toBe(0);
    expect(summary.benchmarkMaxDrawdownDuration).toBe(0);
  });

  it("counts flat-at-peak observations using legacy semantics", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "CASH", netReturn: 0 },
      { position: "CASH", netReturn: 0 },
    ]));

    // Legacy resets only on a strictly greater high; equal capital increments duration.
    expect(summary.strategyMaxDrawdownDuration).toBe(2);
    expect(summary.benchmarkMaxDrawdownDuration).toBe(2);
  });

  it("does not count initial capital and keeps the longest trailing episode", () => {
    const singleObservation = summarizeLongCashReplay(replayFromPositions([
      { position: "CASH", netReturn: 0 },
    ]));
    const multipleEpisodes = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.2 },
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: 0.3 },
      { position: "LONG", netReturn: -0.05 },
      { position: "LONG", netReturn: -0.05 },
      { position: "LONG", netReturn: -0.05 },
    ]));

    expect(singleObservation.strategyMaxDrawdownDuration).toBe(1);
    expect(singleObservation.benchmarkMaxDrawdownDuration).toBe(1);
    expect(multipleEpisodes.strategyMaxDrawdownDuration).toBe(3);
    expect(multipleEpisodes.benchmarkMaxDrawdownDuration).toBe(3);
  });

  it("aggregates multiple winning LONG returns", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.1 },
      { position: "LONG", netReturn: 0.2 },
      { position: "LONG", netReturn: -0.1 },
    ]));

    expect(summary.strategyProfitFactor).toBe(3);
  });

  it("aggregates multiple losing LONG returns", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.2 },
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: -0.2 },
    ]));

    expect(summary.strategyProfitFactor).toBe(0.66666667);
  });

  it("excludes CASH returns from the strategy Profit Factor", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.1 },
      { position: "CASH", netReturn: 0.5 },
      { position: "LONG", netReturn: -0.05 },
      { position: "CASH", netReturn: -0.5 },
    ]));

    expect(summary.strategyProfitFactor).toBe(2);
  });

  it("preserves legacy zero-loss and zero-win behavior", () => {
    const allWins = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.1 },
      { position: "LONG", netReturn: 0.2 },
    ]));
    const allLosses = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: -0.1 },
      { position: "LONG", netReturn: -0.2 },
    ]));

    expect(allWins.strategyProfitFactor).toBe(Infinity);
    expect(allLosses.strategyProfitFactor).toBe(0);
  });

  it("ignores zero-return LONG observations in payoff aggregation", () => {
    const summary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0.2 },
      { position: "LONG", netReturn: 0 },
      { position: "LONG", netReturn: -0.1 },
    ]));
    const allZeroSummary = summarizeLongCashReplay(replayFromPositions([
      { position: "LONG", netReturn: 0 },
      { position: "LONG", netReturn: 0 },
    ]));

    expect(summary.strategyProfitFactor).toBe(2);
    expect(allZeroSummary.strategyProfitFactor).toBe(0);
  });
});
