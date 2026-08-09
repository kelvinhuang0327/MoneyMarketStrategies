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
      strategyTotalReturn: replay.strategy.totalReturn,
      benchmarkTotalReturn: replay.benchmark.totalReturn,
      excessReturn: replay.excessReturn,
    });
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
    expect(summary.strategyTotalReturn).toBe(replay.strategy.totalReturn);
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
      strategyTotalReturn: 0,
    });
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
});
