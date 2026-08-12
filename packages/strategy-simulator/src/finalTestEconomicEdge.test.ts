import {
  canonicalStringify,
  type FinalTestEconomicEvidence,
} from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  buildFinalTestPerSymbolEconomicEdge,
} from "./index.js";

function evidence(): FinalTestEconomicEvidence {
  return {
    evaluationPartition: "FINAL_TEST",
    finalTestRowsSha256: "a".repeat(64),
    finalTestScoredRowsSha256: "b".repeat(64),
    frozenThreshold: 0.5,
    finalTestRowCount: 6,
    rows: [
      {
        symbol: "BETA",
        featureDate: "2025-01-01",
        targetDate: "2025-01-06",
        target: 1,
        forwardReturn: 0.02,
        probabilityUp: 0.8,
        prediction: 1,
      },
      {
        symbol: "ALPHA",
        featureDate: "2025-01-01",
        targetDate: "2025-01-06",
        target: 1,
        forwardReturn: 0.01,
        probabilityUp: 0.7,
        prediction: 1,
      },
      {
        symbol: "BETA",
        featureDate: "2025-01-07",
        targetDate: "2025-01-13",
        target: 0,
        forwardReturn: -0.01,
        probabilityUp: 0.6,
        prediction: 1,
      },
      {
        symbol: "ALPHA",
        featureDate: "2025-01-07",
        targetDate: "2025-01-13",
        target: 0,
        forwardReturn: -0.02,
        probabilityUp: 0.6,
        prediction: 1,
      },
      {
        symbol: "BETA",
        featureDate: "2025-01-14",
        targetDate: "2025-01-20",
        target: 1,
        forwardReturn: 0.03,
        probabilityUp: 0.9,
        prediction: 1,
      },
      {
        symbol: "ALPHA",
        featureDate: "2025-01-14",
        targetDate: "2025-01-20",
        target: 1,
        forwardReturn: 0.015,
        probabilityUp: 0.75,
        prediction: 1,
      },
    ],
  };
}

describe("buildFinalTestPerSymbolEconomicEdge", () => {
  it("replays each symbol with the canonical cost-matched benchmark", () => {
    const result = buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: evidence(),
      roundTripCostBps: 10,
      initialCapital: 100,
    });

    expect(result.groups.map(({ symbol }) => symbol)).toEqual(["ALPHA", "BETA"]);
    expect(result.groups.map(({ finalTestRows }) => finalTestRows)).toEqual([3, 3]);
    expect(result.groups.every(({ strategyNetReturn, benchmarkNetReturn, excessReturn }) =>
      strategyNetReturn === benchmarkNetReturn && excessReturn === 0)).toBe(true);
    expect(result.groups.map(({ transactionCostBps, tradeCount, replayWindowCount, skippedOverlapCount }) => ({
      transactionCostBps,
      tradeCount,
      replayWindowCount,
      skippedOverlapCount,
    }))).toEqual([
      { transactionCostBps: 10, tradeCount: 3, replayWindowCount: 3, skippedOverlapCount: 0 },
      { transactionCostBps: 10, tradeCount: 3, replayWindowCount: 3, skippedOverlapCount: 0 },
    ]);
    expect(result.groups[0]).toMatchObject({
      evaluationStartDate: "2025-01-01",
      evaluationEndDate: "2025-01-20",
      strategyPolicy: "VALIDATION_THRESHOLD_LONG_CASH",
      benchmarkPolicy: "ALWAYS_LONG_BENCHMARK",
    });
    expect(result.guardrails).toEqual({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    });
  });

  it("is deterministic, preserves source evidence, and does not reuse current rows", () => {
    const source = evidence();
    const before = canonicalStringify(source);
    const first = buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: source,
      roundTripCostBps: 10,
      initialCapital: 100,
    });
    const second = buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: source,
      roundTripCostBps: 10,
      initialCapital: 100,
    });

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(first.normalizedResultSha256).toBeDefined();
    expect(canonicalStringify(source)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.groups)).toBe(true);
    expect(Object.isFrozen(first.groups[0])).toBe(true);
    expect(first.groups.every(({ warnings }) => warnings.some((warning) => warning.includes("Exposure")))).toBe(true);
  });

  it("fails closed when a frozen prediction or partition boundary is inconsistent", () => {
    const source = evidence();
    expect(() => buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: {
        ...source,
        evaluationPartition: "VALIDATION" as unknown as "FINAL_TEST",
      },
      roundTripCostBps: 10,
      initialCapital: 100,
    })).toThrow(/requires FINAL_TEST/);
    expect(() => buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: {
        ...source,
        rows: source.rows.map((row, index) => index === 0
          ? { ...row, prediction: 0 }
          : row),
      },
      roundTripCostBps: 10,
      initialCapital: 100,
    })).toThrow(/does not match the frozen threshold/);
  });
});
