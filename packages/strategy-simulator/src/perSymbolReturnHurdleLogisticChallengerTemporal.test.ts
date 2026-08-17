import { describe, expect, it } from "vitest";

import {
  CANONICAL_ROUND_TRIP_COST_FRACTION,
  CANONICAL_TRANSACTION_COST_BPS,
  RESEARCH_FEATURE_NAMES,
  TARGET_CHALLENGER_RULE,
  TARGET_CONTROL_RULE,
  VALIDATION_THRESHOLD_GRID,
  buildHistoricalFeatureRows,
  buildReturnHurdleFeatureRows,
  canonicalStringify,
  deriveRoundTripCostFraction,
  splitChronologically,
  type RawTwStrategyResearchRow,
} from "@mms/research-kernel";

import {
  runPerSymbolReturnHurdleLogisticChallengerTemporal,
  type ReturnHurdleLogisticTemporalInput,
} from "./index.js";

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

function run(
  rows: readonly RawTwStrategyResearchRow[] = fixtureRows(),
  overrides: Partial<ReturnHurdleLogisticTemporalInput> = {},
) {
  return runPerSymbolReturnHurdleLogisticChallengerTemporal({
    rawRows: rows,
    cutoffDates: ["2024-08-31", "2024-12-31", "2025-04-30", "2025-08-31"],
    source: {
      path: "test-owned/in-memory.csv",
      sha256: "b".repeat(64),
    },
    datasetVersion: {
      datasetId: "return-hurdle-logistic-challenger-temporal-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    reviewDate: "2026-08-12",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    roundTripCostBps: 10,
    initialCapital: 1_000,
    ...overrides,
  });
}

describe("0056 cost-aware return-hurdle logistic challenger temporal runner", () => {
  // Requirement 1 & 2: Control target vs Challenger target frozen rules
  it("Requirement 1 & 2: control target = forwardReturn > 0 and challenger target = forwardReturn > 0.001", () => {
    const result = run();
    expect(result.targetControlRule).toBe(TARGET_CONTROL_RULE);
    expect(result.targetControlRule).toBe("forwardReturn > 0");
    expect(result.targetChallengerRule).toBe(TARGET_CHALLENGER_RULE);
    expect(result.targetChallengerRule).toBe("forwardReturn > canonicalRoundTripCostFraction");
    expect(result.canonicalRoundTripCostFraction).toBe(CANONICAL_ROUND_TRIP_COST_FRACTION);
    expect(result.canonicalRoundTripCostFraction).toBe(0.001);
    expect(result.roundTripCostBps).toBe(CANONICAL_TRANSACTION_COST_BPS);
  }, 30_000);

  // Requirement 3: Return below/equal/above hurdle is classified deterministically
  it("Requirement 3: returns below, equal to, and above hurdle are classified deterministically", () => {
    const hurdle = deriveRoundTripCostFraction(10);
    expect(hurdle).toBe(0.001);

    const testReturns = [-0.01, 0, 0.0005, 0.001, 0.001001, 0.002];
    const dummyRows = testReturns.map((forwardReturn, idx) => ({
      symbol: "0056",
      featureDate: `2025-01-0${idx + 1}`,
      targetDate: `2025-01-0${idx + 8}`,
      featureSourceStartDate: "2024-12-01",
      featureSourceEndDate: `2025-01-0${idx + 1}`,
      features: Object.freeze([0.01, 0.02, 0.01, 1.0, -0.02]),
      target: forwardReturn > 0 ? (1 as const) : (0 as const),
      forwardReturn,
    }));

    const hurdleLabeled = buildReturnHurdleFeatureRows(dummyRows, hurdle);
    expect(hurdleLabeled[0]?.target).toBe(0); // -0.01 <= 0.001
    expect(hurdleLabeled[1]?.target).toBe(0); // 0 <= 0.001
    expect(hurdleLabeled[2]?.target).toBe(0); // 0.0005 <= 0.001
    expect(hurdleLabeled[3]?.target).toBe(0); // 0.0010 == 0.001 (not strictly greater)
    expect(hurdleLabeled[4]?.target).toBe(1); // 0.001001 > 0.001
    expect(hurdleLabeled[5]?.target).toBe(1); // 0.002 > 0.001
  });

  // Requirement 4: Hurdle value does not depend on validation/final-test performance
  it("Requirement 4: hurdle value is frozen a priori and rejects non-canonical cost overrides", () => {
    expect(() => run(fixtureRows(), { roundTripCostBps: 20 })).toThrow(
      /STOP_MMS_0056_RETURN_HURDLE_COST_CONTRACT_AMBIGUOUS/,
    );
    expect(() => run(fixtureRows(), { roundTripCostBps: 0 })).toThrow(
      /STOP_MMS_0056_RETURN_HURDLE_COST_CONTRACT_AMBIGUOUS/,
    );
  });

  // Requirement 5: Later rows do not alter earlier cutoff labels
  it("Requirement 5: later rows do not alter earlier cutoff labels or feature representations", () => {
    const baseRows = fixtureRows(400);
    const extendedRows = fixtureRows(520, 5.0); // late drift after 2025-04-30
    const baseResult = run(baseRows);
    const extendedResult = run(extendedRows);

    // First two cutoffs (2024-08-31, 2024-12-31) must produce identical hashes and metrics
    expect(extendedResult.cutoffRuns[0]?.normalizedResultSha256)
      .toBe(baseResult.cutoffRuns[0]?.normalizedResultSha256);
    expect(extendedResult.cutoffRuns[1]?.normalizedResultSha256)
      .toBe(baseResult.cutoffRuns[1]?.normalizedResultSha256);
  }, 40_000);

  // Requirement 6: TRAINING label creation does not consume rows outside TRAINING
  it("Requirement 6: TRAINING labels are derived strictly within the training boundary", () => {
    const raw = fixtureRows();
    const marketRows = raw.map((r) => ({
      symbol: r.symbol,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      source: r.source,
    }));
    const featureRows = buildHistoricalFeatureRows(marketRows);
    const hurdleRows = buildReturnHurdleFeatureRows(featureRows, 0.001);
    const split = splitChronologically(hurdleRows);

    expect(split.training.rows.every((row) => row.targetDate <= split.trainEndDate)).toBe(true);
    expect(split.validation.rows.every((row) => row.featureDate > split.trainEndDate)).toBe(true);
  });

  // Requirement 7: Validation threshold selection remains validation-only
  it("Requirement 7: validation threshold selection is validation-only and from fixed candidate grid", () => {
    const result = run();
    for (const cutoffRun of result.cutoffRuns) {
      expect(cutoffRun.challenger.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(cutoffRun.challenger.thresholdSelection.fixedThresholdGrid).toEqual([...VALIDATION_THRESHOLD_GRID]);
      expect(VALIDATION_THRESHOLD_GRID).toContain(cutoffRun.challengerMetrics.selectedProbabilityThreshold);
    }
  }, 30_000);

  // Requirement 8: FINAL_TEST labels do not affect fitted scaler/model/threshold
  it("Requirement 8: FINAL_TEST rows and labels are evaluation-only with zero feedback into scaler/model/threshold", () => {
    const result = run();
    for (const cutoffRun of result.cutoffRuns) {
      expect(cutoffRun.challenger.fit.scalerFitRowCount).toBe(cutoffRun.challenger.trainingRows);
      expect(cutoffRun.challenger.trainingRows).toBe(cutoffRun.control.trainingRows);
      expect(cutoffRun.challenger.validationRows).toBe(cutoffRun.control.validationRows);
      expect(cutoffRun.challenger.finalTestRows).toBe(cutoffRun.control.finalTestRows);
    }
  }, 30_000);

  // Requirement 9: Control reproduction
  it("Requirement 9: control reproduction structure and guards are verified", () => {
    const result = run();
    expect(result.controlReproduction).toMatchObject({
      status: "NOT_APPLICABLE", // Fixture dates differ from canonical 2025/2026 dates
      expected: {
        positiveExcessCutoffs: 3,
        directionalBaselineWins: 2,
        medianExcessReturn: 0.04711292,
        latestExcessReturn: -0.01025134,
        threshold: 0.575,
      },
    });
  }, 30_000);

  // Requirement 10: Identical simulator semantics
  it("Requirement 10: identical simulator transaction costs and benchmark policies between control and challenger", () => {
    const result = run();
    for (const cutoffRun of result.cutoffRuns) {
      expect(cutoffRun.controlEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.challengerEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.controlEconomic.benchmarkNetReturn).toBe(cutoffRun.challengerEconomic.benchmarkNetReturn);
      expect(cutoffRun.economicComparison.commonBenchmarkNetReturn).toBe(cutoffRun.controlEconomic.benchmarkNetReturn);
      expect(cutoffRun.controlEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(cutoffRun.challengerEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(cutoffRun.controlEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(cutoffRun.challengerEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
    }
  }, 30_000);

  // Requirement 11: Deterministic four-cutoff challenger output
  it("Requirement 11: four-cutoff execution is strictly deterministic and preserves guardrails", () => {
    const first = run();
    const second = run();

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(first.symbol).toBe("0056");
    expect(first.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(first.featureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(first.promotionDecision).toBe("do_not_promote");
    expect(first.guardrails).toEqual({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    });
  }, 40_000);
});
