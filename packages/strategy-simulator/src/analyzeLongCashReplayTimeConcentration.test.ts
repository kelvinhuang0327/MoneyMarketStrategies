import { describe, expect, it } from "vitest";

import {
  analyzeLongCashReplayTimeConcentration,
  simulateLongCashReplay,
} from "./index.js";

function replayFixture() {
  return simulateLongCashReplay({
    symbol: "TEST",
    validationThreshold: 0.6,
    roundTripCostBps: 100,
    initialCapital: 100,
    rows: [
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 0.8,
        realizedForwardReturn: 0.1,
      },
      {
        entryDate: "2026-01-10",
        exitDate: "2026-01-17",
        probabilityUp: 0.7,
        realizedForwardReturn: -0.02,
      },
      {
        entryDate: "2026-02-02",
        exitDate: "2026-02-09",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.2,
      },
      {
        entryDate: "2026-02-10",
        exitDate: "2026-02-17",
        probabilityUp: 0.8,
        realizedForwardReturn: 0.04,
      },
      {
        entryDate: "2026-03-02",
        exitDate: "2026-03-09",
        probabilityUp: 0.9,
        realizedForwardReturn: -0.1,
      },
      {
        entryDate: "2026-03-10",
        exitDate: "2026-03-17",
        probabilityUp: 0.2,
        realizedForwardReturn: 0.9,
      },
    ],
  });
}

describe("analyzeLongCashReplayTimeConcentration", () => {
  it("groups completed LONG windows into hand-computed calendar-month cohorts", () => {
    const replay = replayFixture();
    const analysis = analyzeLongCashReplayTimeConcentration(replay);

    expect(analysis).toMatchObject({
      schemaVersion: "MMS_LONG_CASH_REPLAY_TIME_CONCENTRATION_V1",
      researchMode: "diagnostic-only",
      status: "candidate",
      symbol: "TEST",
      validationThreshold: 0.6,
      longWindowCount: 5,
      cohortCount: 3,
      dominantCohortKey: "2026-02",
      dominantTradeShare: 0.4,
      isTimeConcentrated: false,
      reason: "Grouped completed LONG replay windows by entry calendar month for approximate time attribution.",
    });
    expect(analysis.rows).toEqual([
      {
        cohortKey: "2026-02",
        entryDateRange: "2026-02-02 -> 2026-02-10",
        exitDateRange: "2026-02-09 -> 2026-02-17",
        entryDates: ["2026-02-02", "2026-02-10"],
        exitDates: ["2026-02-09", "2026-02-17"],
        tradeCount: 2,
        tradeShare: 0.4,
        winCount: 2,
        hitRate: 1,
        averageProbabilityUp: 0.85,
        averageForwardReturnGross: 0.12,
        averageNetReturnAfterCost: 0.1088,
        cumulativeNetContributionApprox: 0.04352,
        bestTradeForwardReturn: 0.2,
        worstTradeForwardReturn: 0.04,
      },
      {
        cohortKey: "2026-01",
        entryDateRange: "2026-01-02 -> 2026-01-10",
        exitDateRange: "2026-01-09 -> 2026-01-17",
        entryDates: ["2026-01-02", "2026-01-10"],
        exitDates: ["2026-01-09", "2026-01-17"],
        tradeCount: 2,
        tradeShare: 0.4,
        winCount: 1,
        hitRate: 0.5,
        averageProbabilityUp: 0.75,
        averageForwardReturnGross: 0.04,
        averageNetReturnAfterCost: 0.0296,
        cumulativeNetContributionApprox: 0.01184,
        bestTradeForwardReturn: 0.1,
        worstTradeForwardReturn: -0.02,
      },
      {
        cohortKey: "2026-03",
        entryDateRange: "2026-03-02",
        exitDateRange: "2026-03-09",
        entryDates: ["2026-03-02"],
        exitDates: ["2026-03-09"],
        tradeCount: 1,
        tradeShare: 0.2,
        winCount: 0,
        hitRate: 0,
        averageProbabilityUp: 0.9,
        averageForwardReturnGross: -0.1,
        averageNetReturnAfterCost: -0.109,
        cumulativeNetContributionApprox: -0.0218,
        bestTradeForwardReturn: -0.1,
        worstTradeForwardReturn: -0.1,
      },
    ]);
    expect(analysis.caveats).toContain(
      "Small sample: selected LONG window count is below 10; concentration can dominate sample results.",
    );
  });

  it("returns a no-candidate result when replay selects only CASH", () => {
    const replay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.9,
      roundTripCostBps: 100,
      initialCapital: 100,
      rows: [{
        entryDate: "2026-04-02",
        exitDate: "2026-04-09",
        probabilityUp: 0.2,
        realizedForwardReturn: 0.5,
      }],
    });

    expect(analyzeLongCashReplayTimeConcentration(replay)).toMatchObject({
      status: "no_candidate",
      longWindowCount: 0,
      cohortCount: 0,
      dominantCohortKey: null,
      dominantTradeShare: null,
      isTimeConcentrated: false,
      rows: [],
    });
  });

  it("flags a small, single-month sample and ignores outcomes of CASH windows", () => {
    const replay = replayFixture();
    const changedCashOutcome = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.6,
      roundTripCostBps: 100,
      initialCapital: 100,
      rows: [
        ...replay.windows
          .filter((window) => window.strategyPosition === "LONG")
          .map((window) => ({
            entryDate: window.entryDate,
            exitDate: window.exitDate,
            probabilityUp: window.probabilityUp,
            realizedForwardReturn: window.realizedForwardReturn,
          })),
        {
          entryDate: "2026-03-10",
          exitDate: "2026-03-17",
          probabilityUp: 0.2,
          realizedForwardReturn: -0.9,
        },
      ],
    });
    const singleMonthReplay = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.6,
      roundTripCostBps: 100,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-05-02",
          exitDate: "2026-05-09",
          probabilityUp: 0.8,
          realizedForwardReturn: 0.1,
        },
      ],
    });

    expect(analyzeLongCashReplayTimeConcentration(changedCashOutcome))
      .toEqual(analyzeLongCashReplayTimeConcentration(replay));
    const singleMonthAnalysis = analyzeLongCashReplayTimeConcentration(singleMonthReplay);
    expect(singleMonthAnalysis).toMatchObject({
      cohortCount: 1,
      dominantCohortKey: "2026-05",
      dominantTradeShare: 1,
      isTimeConcentrated: true,
    });
    expect(Object.isFrozen(singleMonthAnalysis)).toBe(true);
    expect(Object.isFrozen(singleMonthAnalysis.rows)).toBe(true);
    expect(Object.isFrozen(singleMonthAnalysis.rows[0])).toBe(true);
  });

  it("is deterministic for repeated execution", () => {
    const replay = replayFixture();
    expect(analyzeLongCashReplayTimeConcentration(replay))
      .toEqual(analyzeLongCashReplayTimeConcentration(replay));
  });
});
