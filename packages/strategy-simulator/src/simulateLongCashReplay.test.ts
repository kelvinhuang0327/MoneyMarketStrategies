import { canonicalStringify, hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  LongCashReplayError,
  simulateLongCashReplay,
  type LongCashReplayInput,
} from "./index.js";

function fixtureInput(): LongCashReplayInput {
  return {
    symbol: "FIXED",
    validationThreshold: 0.6,
    roundTripCostBps: 10,
    initialCapital: 1_000,
    rows: [
      {
        entryDate: "2026-01-01",
        exitDate: "2026-01-03",
        probabilityUp: 0.7,
        realizedForwardReturn: 0.1,
      },
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-04",
        probabilityUp: 0.99,
        realizedForwardReturn: 0.5,
      },
      {
        entryDate: "2026-01-03",
        exitDate: "2026-01-05",
        probabilityUp: 0.4,
        realizedForwardReturn: -0.05,
      },
      {
        entryDate: "2026-01-04",
        exitDate: "2026-01-06",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.4,
      },
      {
        entryDate: "2026-01-05",
        exitDate: "2026-01-07",
        probabilityUp: 0.6,
        realizedForwardReturn: 0.02,
      },
    ],
  };
}

describe("simulateLongCashReplay", () => {
  it("uses one non-overlapping schedule for the strategy and fair benchmark", () => {
    const result = simulateLongCashReplay(fixtureInput());

    expect(result.windows.map((window) => window.sourceRowIndex)).toEqual([0, 2, 4]);
    expect(result.windows.map((window) => window.strategyPosition)).toEqual([
      "LONG",
      "CASH",
      "LONG",
    ]);
    expect(result.replayWindowCount).toBe(3);
    expect(result.skippedOverlapCount).toBe(2);
    expect(result.strategy).toEqual({
      policy: "VALIDATION_THRESHOLD_LONG_CASH",
      initialCapital: 1_000,
      finalCapital: 1119.881,
      totalReturn: 0.119881,
      maximumDrawdown: 0,
      longWindowCount: 2,
      cashWindowCount: 1,
      roundTripCount: 2,
      totalTransactionCost: 2.099,
    });
    expect(result.benchmark).toEqual({
      policy: "ALWAYS_LONG_BENCHMARK",
      initialCapital: 1_000,
      finalCapital: 1062.767069,
      totalReturn: 0.06276707,
      maximumDrawdown: 0.051,
      longWindowCount: 3,
      cashWindowCount: 0,
      roundTripCount: 3,
      totalTransactionCost: 3.141951,
    });
  });

  it("treats the frozen threshold as inclusive and charges costs only while long", () => {
    const result = simulateLongCashReplay({
      ...fixtureInput(),
      rows: [fixtureInput().rows[4]!],
    });

    expect(result.windows[0]).toMatchObject({
      strategyPosition: "LONG",
      strategyGrossReturn: 0.02,
      strategyNetReturn: 0.019,
      benchmarkNetReturn: 0.019,
      strategyCapital: 1019,
      benchmarkCapital: 1019,
    });
    expect(result.strategy.totalTransactionCost).toBe(1);
    expect(result.benchmark.totalTransactionCost).toBe(1);
  });

  it("is byte-deterministic, canonically hashed, immutable, and diagnostic-only", () => {
    const first = simulateLongCashReplay(fixtureInput());
    const second = simulateLongCashReplay(fixtureInput());
    const { normalizedResultSha256, ...normalized } = first;

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(normalizedResultSha256).toBe(hashValue(normalized));
    expect(first.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.replayWindowsSha256).toBe(hashValue(first.windows));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.windows)).toBe(true);
    expect(first.windows.every((window) => Object.isFrozen(window))).toBe(true);
    expect(first.guardrails).toEqual({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
    });
  });

  it("accepts deeply frozen immutable-compatible input without mutating it", () => {
    const input = fixtureInput();
    const rows = Object.freeze(input.rows.map((row) => Object.freeze({ ...row })));
    const frozenInput = Object.freeze({ ...input, rows });
    const before = canonicalStringify(frozenInput);

    simulateLongCashReplay(frozenInput);

    expect(canonicalStringify(frozenInput)).toBe(before);
  });

  it.each([
    [{ ...fixtureInput(), symbol: " " }, /symbol must not be blank/],
    [{ ...fixtureInput(), validationThreshold: Number.NaN }, /validationThreshold must be finite/],
    [{ ...fixtureInput(), validationThreshold: 1.01 }, /within \[0, 1\]/],
    [{ ...fixtureInput(), roundTripCostBps: -1 }, /within \[0, 10000\)/],
    [{ ...fixtureInput(), roundTripCostBps: 10_000 }, /within \[0, 10000\)/],
    [{ ...fixtureInput(), initialCapital: 0 }, /greater than zero/],
    [{ ...fixtureInput(), rows: [] }, /at least one prediction/],
    [{
      ...fixtureInput(),
      rows: [{ ...fixtureInput().rows[0]!, entryDate: "2026-02-30" }],
    }, /real canonical date/],
    [{
      ...fixtureInput(),
      rows: [{ ...fixtureInput().rows[0]!, exitDate: "2026-01-01" }],
    }, /exit after it enters/],
    [{
      ...fixtureInput(),
      rows: [fixtureInput().rows[1]!, fixtureInput().rows[0]!],
    }, /entryDate must be strictly later/],
    [{
      ...fixtureInput(),
      rows: [
        fixtureInput().rows[0]!,
        { ...fixtureInput().rows[1]!, exitDate: "2026-01-03" },
      ],
    }, /exitDate must be strictly later/],
    [{
      ...fixtureInput(),
      rows: [{ ...fixtureInput().rows[0]!, probabilityUp: -0.01 }],
    }, /probabilityUp must be within/],
    [{
      ...fixtureInput(),
      rows: [{ ...fixtureInput().rows[0]!, realizedForwardReturn: -1 }],
    }, /realizedForwardReturn must be greater than -1/],
  ] as const)("fails closed on invalid input", (input, expected) => {
    expect(() => simulateLongCashReplay(input)).toThrow(LongCashReplayError);
    expect(() => simulateLongCashReplay(input)).toThrow(expected);
  });

  it("fails closed rather than producing non-positive capital after costs", () => {
    expect(() => simulateLongCashReplay({
      ...fixtureInput(),
      roundTripCostBps: 100,
      rows: [{
        entryDate: "2026-01-01",
        exitDate: "2026-01-02",
        probabilityUp: 0.9,
        realizedForwardReturn: -0.995,
      }],
    })).toThrow(/loses all capital after round-trip costs/);
  });
});
