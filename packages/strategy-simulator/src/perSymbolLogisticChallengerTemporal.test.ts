import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  type RawTwStrategyResearchRow,
} from "@mms/research-kernel";

import {
  runPerSymbolLogisticChallengerTemporalConfirmation,
} from "./index.js";

function fixtureRows(count = 520): RawTwStrategyResearchRow[] {
  const start = Date.UTC(2024, 0, 1);
  return ["0056", "CONTROL"].flatMap((symbol, symbolIndex) =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const cycle = Math.sin((index + symbolIndex * 3) * Math.PI / 10);
      const close = 100 + cycle * 7 + index * (symbolIndex === 0 ? 0.05 : -0.02);
      return {
        symbol,
        date,
        open: close - 0.2,
        high: close + 0.8,
        low: close - 0.8,
        close,
        volume: 1000 + (index % 13) * 23 + symbolIndex * 5,
        source: "test-owned/in-memory",
        fetched_at_utc: "2026-08-12T00:00:00.000Z",
      };
    }),
  );
}

function run() {
  return runPerSymbolLogisticChallengerTemporalConfirmation({
    rawRows: fixtureRows(),
    cutoffDates: ["2024-08-31", "2024-12-31", "2025-04-30", "2025-08-31"],
    source: {
      path: "test-owned/in-memory.csv",
      sha256: "a".repeat(64),
    },
    datasetVersion: {
      datasetId: "per-symbol-logistic-challenger-temporal-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    reviewDate: "2026-08-12",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    roundTripCostBps: 10,
    initialCapital: 1_000,
  });
}

describe("0056 per-symbol logistic challenger temporal confirmation", () => {
  it("replays every cutoff with as-of isolation and the frozen challenger contract", () => {
    const result = run();

    expect(result.symbol).toBe("0056");
    expect(result.cutoffRuns).toHaveLength(4);
    for (const cutoffRun of result.cutoffRuns) {
      const candidate = cutoffRun.challenger;
      const economic = cutoffRun.challengerEconomic;
      expect(cutoffRun.asOf <= cutoffRun.cutoff).toBe(true);
      expect(candidate.fit.fitPartition).toBe("TRAINING");
      expect(candidate.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(candidate.thresholdSelection.fixedThresholdGrid)
        .toContain(candidate.thresholdSelection.selectedThreshold);
      expect(candidate.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(candidate.finalTestMetrics.sampleCount).toBe(candidate.finalTestRows);
      expect(candidate.finalTestEconomicEvidence.rows.every((row) => row.targetDate <= cutoffRun.asOf))
        .toBe(true);
      expect(cutoffRun.finalTestEndDate <= cutoffRun.asOf).toBe(true);
      expect(economic.transactionCostBps).toBe(10);
      expect(economic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(economic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(cutoffRun.pooledIncumbentEconomic).not.toBeNull();
      expect(cutoffRun.pooledIncumbent.finalTestRows).toBe(candidate.finalTestRows);
      expect(cutoffRun.normalizedResultSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.promotionDecision).toBe("do_not_promote");
    expect(result.guardrails.supportsSymbolSelection).toBe(false);
    expect(result.temporalSummary.positiveExcessCutoffCount
      + result.temporalSummary.nonPositiveExcessCutoffCount)
      .toBe(result.temporalSummary.temporalCutoffCount);
  }, 20_000);

  it("is deterministic and does not synthesize a robustness score", () => {
    const first = run();
    const second = run();

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(second).not.toHaveProperty("robustnessScore");
    expect(second).not.toHaveProperty("combinedScore");
    expect(second).not.toHaveProperty("selectedSymbol");
  }, 30_000);
});
