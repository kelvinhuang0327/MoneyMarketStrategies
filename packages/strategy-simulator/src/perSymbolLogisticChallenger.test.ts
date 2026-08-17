import { describe, expect, it } from "vitest";

import {
  runResearchEvidenceKernel,
  type MarketDataRow,
} from "@mms/research-kernel";

import {
  buildPerSymbolLogisticChallengerEvaluation,
} from "./perSymbolLogisticChallenger.js";

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
      datasetId: "simulator-per-symbol-challenger-fixture",
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

describe("strategy-simulator per-symbol logistic challenger composition", () => {
  it("replays each frozen challenger threshold with the canonical cost-matched benchmark", () => {
    const kernel = run();
    if (kernel.perSymbolLogisticChallenger === undefined) {
      throw new Error("challenger evidence is missing");
    }
    if (kernel.finalTestEconomicEvidence === undefined) {
      throw new Error("incumbent economic evidence is missing");
    }
    const result = buildPerSymbolLogisticChallengerEvaluation({
      challenger: kernel.perSymbolLogisticChallenger,
      incumbentEvidence: kernel.evidence,
      incumbentFinalTestEconomicEvidence: kernel.finalTestEconomicEvidence,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 10,
      initialCapital: 100,
    });

    expect(result.symbols).toEqual(["ALPHA", "BETA"]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) =>
      group.challengerEconomic.transactionCostBps === 10
      && group.challengerEconomic.thresholdSelectionSource === "VALIDATION"
      && group.challengerEconomic.benchmarkPolicy === "ALWAYS_LONG_BENCHMARK"
      && group.challengerEconomic.strategyPolicy === "VALIDATION_THRESHOLD_LONG_CASH",
    )).toBe(true);
    expect(result.groups.every((group) =>
      group.incumbentVsChallenger.majorityBaselineAccuracy
        === group.challenger.majorityBaselineAccuracy,
    )).toBe(true);
    expect(result.promotionDecision).toBe("do_not_promote");
    expect(result.guardrails.supportsSymbolSelection).toBe(false);
    expect(result.normalizedResultSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not expose a combined or ranking score", () => {
    const kernel = run();
    if (kernel.perSymbolLogisticChallenger === undefined) {
      throw new Error("challenger evidence is missing");
    }
    if (kernel.finalTestEconomicEvidence === undefined) {
      throw new Error("incumbent economic evidence is missing");
    }
    const result = buildPerSymbolLogisticChallengerEvaluation({
      challenger: kernel.perSymbolLogisticChallenger,
      incumbentEvidence: kernel.evidence,
      incumbentFinalTestEconomicEvidence: kernel.finalTestEconomicEvidence,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 10,
      initialCapital: 100,
    });
    expect(result).not.toHaveProperty("combinedScore");
    expect(result).not.toHaveProperty("rankedSymbols");
    expect(result).not.toHaveProperty("selectedSymbol");
  });
});
