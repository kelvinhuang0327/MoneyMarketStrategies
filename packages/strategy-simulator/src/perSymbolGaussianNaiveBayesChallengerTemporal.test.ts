import { describe, expect, it } from "vitest";

import {
  RESEARCH_FEATURE_NAMES,
  VALIDATION_THRESHOLD_GRID,
  canonicalStringify,
  type RawTwStrategyResearchRow,
} from "@mms/research-kernel";

import { runPerSymbolGaussianNaiveBayesChallengerTemporal } from "./index.js";

function fixtureRows(count = 520, closeDrift = 0): RawTwStrategyResearchRow[] {
  const start = Date.UTC(2024, 0, 1);
  return ["0056", "CONTROL"].flatMap((symbol, symbolIndex) =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const cycle = Math.sin((index + symbolIndex * 3) * Math.PI / 10);
      const lateDrift = date > "2025-04-30" ? closeDrift : 0;
      const close = 100 + cycle * 7 + index * (symbolIndex === 0 ? 0.05 : -0.02) + lateDrift;
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

function run(rows: readonly RawTwStrategyResearchRow[] = fixtureRows()) {
  return runPerSymbolGaussianNaiveBayesChallengerTemporal({
    rawRows: rows,
    cutoffDates: ["2024-08-31", "2024-12-31", "2025-04-30", "2025-08-31"],
    source: {
      path: "test-owned/in-memory.csv",
      sha256: "c".repeat(64),
    },
    datasetVersion: {
      datasetId: "gaussian-naive-bayes-challenger-temporal-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    reviewDate: "2026-08-12",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    roundTripCostBps: 10,
    initialCapital: 1_000,
  });
}

describe("0056 gaussian naive bayes challenger temporal confirmation", () => {
  it("replays every cutoff independently with training-only GNB and no added feature", () => {
    const result = run();

    expect(result.symbol).toBe("0056");
    expect(result.cutoffRuns).toHaveLength(4);
    expect(result.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(result.featureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(result.featureNames).not.toContain("breakout_20d_high");
    expect(result.featureNames).not.toContain("intraday_range_pct");
    expect(result.promotionDecision).toBe("do_not_promote");
    expect(result.temporalSummary.cutoffCount).toBe(4);
    expect(result.varianceFloor).toBe(result.cutoffRuns[0]?.gnbMetrics.varianceFloor);

    for (const cutoffRun of result.cutoffRuns) {
      expect(cutoffRun.asOf <= cutoffRun.cutoff).toBe(true);
      expect(cutoffRun.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
      expect(cutoffRun.control.fit.fitPartition).toBe("TRAINING");
      expect(cutoffRun.control.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(cutoffRun.control.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(cutoffRun.controlEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.controlEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(cutoffRun.controlEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(cutoffRun.control.fit).not.toHaveProperty("classBalancing");
      expect(cutoffRun.balancedLogistic.fit.classBalancing?.sourcePartition).toBe("TRAINING");
      expect(cutoffRun.gnb.fit.fitPartition).toBe("TRAINING");
      expect(cutoffRun.gnb.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(cutoffRun.gnb.thresholdSelection.fixedThresholdGrid).toEqual([...VALIDATION_THRESHOLD_GRID]);
      expect(cutoffRun.gnb.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(cutoffRun.gnb.trainingRowsSha256).toBe(cutoffRun.control.trainingRowsSha256);
      expect(cutoffRun.gnb.fit.scalerStateSha256).toBe(cutoffRun.control.fit.scalerStateSha256);
      expect(cutoffRun.gnbMetrics.trainingUpRows + cutoffRun.gnbMetrics.trainingDownRows)
        .toBe(cutoffRun.gnbMetrics.trainingRows);
      expect(cutoffRun.gnbMetrics.classPriorUp)
        .toBe(cutoffRun.gnbMetrics.trainingUpRows / cutoffRun.gnbMetrics.trainingRows);
      expect(cutoffRun.gnbMetrics.varianceFloor).toBe(result.varianceFloor);
      expect(cutoffRun.gnbEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.deltasVsControl).toMatchObject({
        accuracyDelta: expect.any(Number),
        balancedAccuracyDelta: expect.any(Number),
        logLossDelta: expect.any(Number),
        brierDelta: expect.any(Number),
        predictedUpRateDelta: expect.any(Number),
        excessReturnDelta: expect.any(Number),
        maxDrawdownDelta: expect.any(Number),
      });
      expect(cutoffRun.deltasVsBalanced).toMatchObject({
        accuracyDelta: expect.any(Number),
        balancedAccuracyDelta: expect.any(Number),
        excessReturnDelta: expect.any(Number),
      });
    }
    expect(result.controlReproduction.status).toBe("NOT_APPLICABLE");
    expect(result.temporalSummary).toMatchObject({
      directionalWinsVsControl: expect.any(Number),
      economicWinsVsControl: expect.any(Number),
      bothWinsVsControl: expect.any(Number),
      directionalWinsVsBalanced: expect.any(Number),
      economicWinsVsBalanced: expect.any(Number),
      bothWinsVsBalanced: expect.any(Number),
      medianAccuracyDeltaVsControl: expect.any(Number),
      medianBalancedAccuracyDeltaVsControl: expect.any(Number),
      medianExcessDeltaVsControl: expect.any(Number),
      latestExcessDeltaVsControl: expect.any(Number),
    });
  }, 45_000);

  it("keeps cutoff refits independent of later-window prices", () => {
    const baseline = run();
    const mutated = run(fixtureRows(520, 25));
    const firstBaseline = baseline.cutoffRuns[0];
    const firstMutated = mutated.cutoffRuns[0];
    const lastBaseline = baseline.cutoffRuns.at(-1);
    const lastMutated = mutated.cutoffRuns.at(-1);
    if (
      firstBaseline === undefined
      || firstMutated === undefined
      || lastBaseline === undefined
      || lastMutated === undefined
    ) {
      throw new Error("expected four cutoff runs");
    }

    expect(firstMutated.normalizedResultSha256).toBe(firstBaseline.normalizedResultSha256);
    expect(firstMutated.control.fit.modelStateSha256)
      .toBe(firstBaseline.control.fit.modelStateSha256);
    expect(firstMutated.gnb.fit.modelStateSha256)
      .toBe(firstBaseline.gnb.fit.modelStateSha256);
    expect(lastMutated.normalizedResultSha256).not.toBe(lastBaseline.normalizedResultSha256);
  }, 60_000);

  it("is deterministic and does not synthesize a score or promotion", () => {
    const first = run();
    const second = run();

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(second.promotionDecision).toBe("do_not_promote");
    expect(second).not.toHaveProperty("robustnessScore");
    expect(second).not.toHaveProperty("combinedScore");
    expect(second).not.toHaveProperty("selectedSymbol");
    expect(second.guardrails.supportsAutomaticPromotion).toBe(false);
  }, 60_000);
});
