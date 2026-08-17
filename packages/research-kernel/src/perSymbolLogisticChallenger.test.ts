import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  runResearchEvidenceKernel,
  type MarketDataRow,
} from "./index.js";

function fixtureRows(count = 150): MarketDataRow[] {
  const start = Date.UTC(2024, 0, 1);
  return ["ALPHA", "BETA"].flatMap((symbol, symbolIndex) =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const cycle = Math.sin((index + symbolIndex * 2) * Math.PI / 8);
      const drift = symbolIndex === 0 ? index * 0.04 : -index * 0.02;
      const close = 100 + cycle * 8 + drift;
      return {
        symbol,
        date,
        open: close - 0.2,
        high: close + 0.8,
        low: close - 0.8,
        close,
        volume: 1000 + (index % 11) * 17 + symbolIndex * 3,
        source: "test-owned/in-memory",
      };
    }),
  );
}

function run() {
  return runResearchEvidenceKernel({
    datasetVersion: {
      datasetId: "per-symbol-challenger-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    marketRows: fixtureRows(),
    logisticRegression: {
      iterations: 400,
      learningRate: 0.08,
      l2: 0.01,
    },
  });
}

describe("per-symbol logistic challenger", () => {
  it("fits independent models and preserves pooled chronological partitions", () => {
    const result = run();
    const challenger = result.perSymbolLogisticChallenger;
    if (challenger === undefined) throw new Error("challenger evidence is missing");

    expect(challenger.symbols).toEqual(["ALPHA", "BETA"]);
    expect(challenger.groups).toHaveLength(2);
    for (const group of challenger.groups) {
      expect(group.trainingRows).toBeGreaterThan(0);
      expect(group.validationRows).toBeGreaterThan(0);
      expect(group.finalTestRows).toBeGreaterThan(0);
      expect(group.trainValidationPurgeRows).toBeGreaterThan(0);
      expect(group.validationFinalPurgeRows).toBeGreaterThan(0);
      expect(group.fit.fitPartition).toBe("TRAINING");
      expect(group.fit.trainingRowsSha256).toBe(group.trainingRowsSha256);
      expect(group.fit.scalerFitRowCount).toBe(group.trainingRows);
      expect(group.fit.modelFitRowCount).toBe(group.trainingRows);
      expect(group.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(group.thresholdSelection.validationRowsSha256).toBe(group.validationRowsSha256);
      expect(group.thresholdSelection.validationRowsSha256)
        .not.toBe(group.finalTestRowsSha256);
      expect(group.thresholdSelection.selectedThreshold)
        .toBe(group.finalTest.frozenThreshold);
      expect(group.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(group.finalTest.evaluatorExecutionCount).toBe(1);
      expect(group.finalTestEconomicEvidence.rows).toHaveLength(group.finalTestRows);
      expect(group.finalTestMetrics.sampleCount).toBe(group.finalTestRows);
    }
    expect(new Set(challenger.groups.map((group) => group.fit.modelStateSha256)).size)
      .toBeGreaterThan(1);
    expect(result.promotionDecision.automaticPromotion).toBe(false);
  });

  it("is deterministic and does not alter the pooled incumbent evidence", () => {
    const first = run();
    const second = run();
    expect(canonicalStringify(second.perSymbolLogisticChallenger))
      .toBe(canonicalStringify(first.perSymbolLogisticChallenger));
    expect(second.evidence.normalizedEvidenceSha256)
      .toBe(first.evidence.normalizedEvidenceSha256);
    expect(second.evidence.finalTest.metrics)
      .toEqual(first.evidence.finalTest.metrics);
  });
});
