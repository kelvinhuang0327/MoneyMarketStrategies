import { canonicalStringify, hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  LongCashReplayError,
  simulateLongCashReplay,
  type LongCashReplayInput,
} from "./index.js";

function fixtureAInput(): LongCashReplayInput {
  return {
    symbol: "TEST",
    validationThreshold: 0.5,
    roundTripCostBps: 2_500,
    initialCapital: 100,
    rows: [
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 0.5,
        realizedForwardReturn: 1,
      },
      {
        entryDate: "2026-01-05",
        exitDate: "2026-01-12",
        probabilityUp: 1,
        realizedForwardReturn: 10,
      },
      {
        entryDate: "2026-01-10",
        exitDate: "2026-01-17",
        probabilityUp: 0.25,
        realizedForwardReturn: -0.5,
      },
    ],
  };
}

describe("simulateLongCashReplay", () => {
  it("matches required Fixture A with a shared strictly-later schedule", () => {
    const result = simulateLongCashReplay(fixtureAInput());

    expect(result.selectedSchedule).toEqual([
      { entryDate: "2026-01-02", exitDate: "2026-01-09" },
      { entryDate: "2026-01-10", exitDate: "2026-01-17" },
    ]);
    expect(result.windows.map((window) => window.sourceRowIndex)).toEqual([0, 1]);
    expect(result.windows.map((window) => window.strategyPosition)).toEqual(["LONG", "CASH"]);
    expect(result.replayWindowCount).toBe(2);
    expect(result.skippedOverlapCount).toBe(1);
    expect(result.windows.map((window) => window.strategyCapital)).toEqual([150, 150]);
    expect(result.windows.map((window) => window.benchmarkCapital)).toEqual([150, 56.25]);
    expect(result.strategy).toEqual({
      policy: "VALIDATION_THRESHOLD_LONG_CASH",
      initialCapital: 100,
      finalCapital: 150,
      totalReturn: 0.5,
      maximumDrawdown: 0,
      longWindowCount: 1,
      cashWindowCount: 1,
      roundTripCount: 1,
      totalTransactionCost: 50,
      winningLongTradeCount: 1,
      losingLongTradeCount: 0,
      averageActiveLongNetReturn: 0.5,
    });
    expect(result.benchmark).toEqual({
      policy: "ALWAYS_LONG_BENCHMARK",
      initialCapital: 100,
      finalCapital: 56.25,
      totalReturn: -0.4375,
      maximumDrawdown: 0.625,
      longWindowCount: 2,
      cashWindowCount: 0,
      roundTripCount: 2,
      totalTransactionCost: 68.75,
      winningLongTradeCount: 1,
      losingLongTradeCount: 1,
      averageActiveLongNetReturn: -0.0625,
    });
    expect(result.excessReturn).toBe(0.9375);
  });

  it("includes initial capital when calculating Fixture B drawdown", () => {
    const result = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-01-02",
          exitDate: "2026-01-09",
          probabilityUp: 1,
          realizedForwardReturn: 0.25,
        },
        {
          entryDate: "2026-01-10",
          exitDate: "2026-01-17",
          probabilityUp: 1,
          realizedForwardReturn: -0.5,
        },
      ],
    });

    expect(result.windows.map((window) => window.strategyCapital)).toEqual([125, 62.5]);
    expect(result.strategy.maximumDrawdown).toBe(0.5);
  });

  it("matches Fixture C when every selected strategy window is CASH", () => {
    const result = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0.9,
      roundTripCostBps: 25,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-01-02",
          exitDate: "2026-01-09",
          probabilityUp: 0.1,
          realizedForwardReturn: 0.25,
        },
        {
          entryDate: "2026-01-10",
          exitDate: "2026-01-17",
          probabilityUp: 0.2,
          realizedForwardReturn: -0.5,
        },
      ],
    });

    expect(result.strategy).toMatchObject({
      finalCapital: 100,
      totalReturn: 0,
      maximumDrawdown: 0,
      longWindowCount: 0,
      cashWindowCount: 2,
      totalTransactionCost: 0,
      winningLongTradeCount: 0,
      losingLongTradeCount: 0,
      averageActiveLongNetReturn: 0,
    });
  });

  it("accepts 10000 bps and permits zero capital with drawdown one", () => {
    const result = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 10_000,
      initialCapital: 100,
      rows: [{
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 1,
        realizedForwardReturn: 0,
      }],
    });

    expect(result.windows[0]).toMatchObject({
      strategyPosition: "LONG",
      strategyGrossReturn: 0,
      strategyNetReturn: -1,
      benchmarkGrossReturn: 0,
      benchmarkNetReturn: -1,
      strategyCapital: 0,
      benchmarkCapital: 0,
    });
    expect(result.strategy).toMatchObject({
      finalCapital: 0,
      totalReturn: -1,
      maximumDrawdown: 1,
      totalTransactionCost: 100,
    });
    expect(result.benchmark).toMatchObject({
      finalCapital: 0,
      totalReturn: -1,
      maximumDrawdown: 1,
      totalTransactionCost: 100,
    });
    expect(result.excessReturn).toBe(0);
  });

  it("normalizes unordered rows and produces byte-identical results for permutations", () => {
    const input = fixtureAInput();
    const rows = input.rows;
    const permutations = [
      [rows[0]!, rows[1]!, rows[2]!],
      [rows[2]!, rows[0]!, rows[1]!],
      [rows[1]!, rows[2]!, rows[0]!],
    ];
    const results = permutations.map((permutedRows) => simulateLongCashReplay({
      ...input,
      rows: permutedRows,
    }));

    expect(new Set(results.map(canonicalStringify)).size).toBe(1);
    expect(results.map((result) => result.inputSha256)).toEqual([
      results[0]!.inputSha256,
      results[0]!.inputSha256,
      results[0]!.inputSha256,
    ]);
    expect(results.map((result) => result.replayWindowsSha256)).toEqual([
      results[0]!.replayWindowsSha256,
      results[0]!.replayWindowsSha256,
      results[0]!.replayWindowsSha256,
    ]);
  });

  it("treats entry equality as overlap and accepts only strictly later rows", () => {
    const result = simulateLongCashReplay({
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [
        {
          entryDate: "2026-01-04",
          exitDate: "2026-01-06",
          probabilityUp: 1,
          realizedForwardReturn: 0,
        },
        {
          entryDate: "2026-01-03",
          exitDate: "2026-01-05",
          probabilityUp: 1,
          realizedForwardReturn: 0,
        },
        {
          entryDate: "2026-01-01",
          exitDate: "2026-01-03",
          probabilityUp: 1,
          realizedForwardReturn: 0,
        },
      ],
    });

    expect(result.selectedSchedule).toEqual([
      { entryDate: "2026-01-01", exitDate: "2026-01-03" },
      { entryDate: "2026-01-04", exitDate: "2026-01-06" },
    ]);
    expect(result.replayWindowCount).toBe(2);
    expect(result.skippedOverlapCount).toBe(1);
  });

  it("hashes exactly the date-only schedule independently of replay values", () => {
    const baselineInput = fixtureAInput();
    const baseline = simulateLongCashReplay(baselineInput);
    const changedReplay = simulateLongCashReplay({
      ...baselineInput,
      validationThreshold: 0.95,
      roundTripCostBps: 100,
      initialCapital: 500,
      rows: baselineInput.rows.map((row, index) => ({
        ...row,
        probabilityUp: index === 0 ? 0.1 : 0.9,
        realizedForwardReturn: index === 1 ? 0.25 : -0.25,
      })),
    });
    const changedDates = simulateLongCashReplay({
      ...baselineInput,
      rows: baselineInput.rows.map((row, index) => index === 2
        ? { ...row, entryDate: "2026-01-11", exitDate: "2026-01-18" }
        : row),
    });

    expect(baseline.selectedScheduleSha256).toBe(hashValue(baseline.selectedSchedule));
    expect(Object.keys(baseline.selectedSchedule[0]!).sort()).toEqual([
      "entryDate",
      "exitDate",
    ]);
    expect(changedReplay.selectedSchedule).toEqual(baseline.selectedSchedule);
    expect(changedReplay.selectedScheduleSha256).toBe(baseline.selectedScheduleSha256);
    expect(changedReplay.replayWindowsSha256).not.toBe(baseline.replayWindowsSha256);
    expect(changedReplay.normalizedResultSha256).not.toBe(baseline.normalizedResultSha256);
    expect(changedDates.selectedScheduleSha256).not.toBe(baseline.selectedScheduleSha256);
  });

  it("validates signal and return values even on rows skipped by the schedule", () => {
    const input = fixtureAInput();
    const invalidProbability = {
      ...input,
      rows: input.rows.map((row, index) => index === 1
        ? { ...row, probabilityUp: Number.NaN }
        : row),
    };
    const invalidReturn = {
      ...input,
      rows: input.rows.map((row, index) => index === 1
        ? { ...row, realizedForwardReturn: -1 }
        : row),
    };

    expect(() => simulateLongCashReplay(invalidProbability)).toThrow(
      /probabilityUp must be finite/,
    );
    expect(() => simulateLongCashReplay(invalidReturn)).toThrow(
      /realizedForwardReturn must be greater than -1/,
    );
  });

  it("uses the normalized input for hashing and trims the public symbol", () => {
    const input = fixtureAInput();
    const result = simulateLongCashReplay({
      ...input,
      symbol: "  TEST  ",
      rows: [input.rows[2]!, input.rows[1]!, input.rows[0]!],
    });

    expect(result.symbol).toBe("TEST");
    expect(result.inputSha256).toBe(hashValue({
      schemaVersion: "MMS_LONG_CASH_REPLAY_V1",
      symbol: "TEST",
      validationThreshold: input.validationThreshold,
      roundTripCostBps: input.roundTripCostBps,
      initialCapital: input.initialCapital,
      rows: input.rows,
    }));
  });

  it("is byte-deterministic, canonically hashed, deeply frozen, and diagnostic-only", () => {
    const first = simulateLongCashReplay(fixtureAInput());
    const second = simulateLongCashReplay(fixtureAInput());
    const { normalizedResultSha256, ...normalized } = first;

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(normalizedResultSha256).toBe(hashValue(normalized));
    expect(first.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.selectedScheduleSha256).toBe(hashValue(first.selectedSchedule));
    expect(first.replayWindowsSha256).toBe(hashValue(first.windows));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.selectedSchedule)).toBe(true);
    expect(first.selectedSchedule.every((window) => Object.isFrozen(window))).toBe(true);
    expect(Object.isFrozen(first.windows)).toBe(true);
    expect(first.windows.every((window) => Object.isFrozen(window))).toBe(true);
    expect(Object.isFrozen(first.strategy)).toBe(true);
    expect(Object.isFrozen(first.benchmark)).toBe(true);
    expect(Object.isFrozen(first.guardrails)).toBe(true);
    expect(first.guardrails).toEqual({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
    });
  });

  it("does not mutate, freeze, or retain caller-owned row objects", () => {
    const callerRow = {
      entryDate: "2026-01-02",
      exitDate: "2026-01-09",
      probabilityUp: 1,
      realizedForwardReturn: 0.25,
    };
    const input: LongCashReplayInput = {
      symbol: "TEST",
      validationThreshold: 0,
      roundTripCostBps: 0,
      initialCapital: 100,
      rows: [callerRow],
    };
    const before = canonicalStringify(input);
    const result = simulateLongCashReplay(input);

    expect(canonicalStringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.rows)).toBe(false);
    expect(Object.isFrozen(callerRow)).toBe(false);
    callerRow.probabilityUp = 0;
    callerRow.realizedForwardReturn = -0.5;
    expect(result.windows[0]).toMatchObject({
      probabilityUp: 1,
      realizedForwardReturn: 0.25,
    });
  });

  it("accepts deeply frozen immutable-compatible input", () => {
    const input = fixtureAInput();
    const rows = Object.freeze(input.rows.map((row) => Object.freeze({ ...row })));
    const frozenInput = Object.freeze({ ...input, rows });
    const before = canonicalStringify(frozenInput);

    simulateLongCashReplay(frozenInput);

    expect(canonicalStringify(frozenInput)).toBe(before);
  });

  it("rejects duplicate entry dates after deterministic sorting", () => {
    const input = fixtureAInput();

    expect(() => simulateLongCashReplay({
      ...input,
      rows: [
        input.rows[2]!,
        input.rows[0]!,
        { ...input.rows[1]!, entryDate: input.rows[0]!.entryDate },
      ],
    })).toThrow(/duplicate entryDate 2026-01-02/);
  });

  it.each([
    [{ ...fixtureAInput(), symbol: " " }, /symbol must not be blank/],
    [{
      ...fixtureAInput(),
      validationThreshold: Number.NaN,
    }, /validationThreshold must be finite/],
    [{ ...fixtureAInput(), validationThreshold: 1.01 }, /within \[0, 1\]/],
    [{ ...fixtureAInput(), roundTripCostBps: -1 }, /within \[0, 10000\]/],
    [{
      ...fixtureAInput(),
      roundTripCostBps: Number.POSITIVE_INFINITY,
    }, /roundTripCostBps must be finite/],
    [{ ...fixtureAInput(), roundTripCostBps: 10_000.0000001 }, /within \[0, 10000\]/],
    [{ ...fixtureAInput(), initialCapital: 0 }, /greater than zero/],
    [{ ...fixtureAInput(), rows: [] }, /at least one prediction/],
    [{
      ...fixtureAInput(),
      rows: [{ ...fixtureAInput().rows[0]!, entryDate: "2026-2-01" }],
    }, /canonical YYYY-MM-DD/],
    [{
      ...fixtureAInput(),
      rows: [{ ...fixtureAInput().rows[0]!, entryDate: "2026-02-30" }],
    }, /real canonical date/],
    [{
      ...fixtureAInput(),
      rows: [{ ...fixtureAInput().rows[0]!, exitDate: "2026-01-01" }],
    }, /exit after it enters/],
    [{
      ...fixtureAInput(),
      rows: [{ ...fixtureAInput().rows[0]!, probabilityUp: -0.01 }],
    }, /probabilityUp must be within/],
    [{
      ...fixtureAInput(),
      rows: [{ ...fixtureAInput().rows[0]!, realizedForwardReturn: -1 }],
    }, /realizedForwardReturn must be greater than -1/],
  ] as const)("fails closed on invalid input", (input, expected) => {
    expect(() => simulateLongCashReplay(input)).toThrow(LongCashReplayError);
    expect(() => simulateLongCashReplay(input)).toThrow(expected);
  });
});
