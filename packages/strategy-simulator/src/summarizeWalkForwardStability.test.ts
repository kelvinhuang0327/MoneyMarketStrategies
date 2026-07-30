import { canonicalStringify, hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  runWalkForwardThresholdEvaluation,
  summarizeWalkForwardStability,
} from "./index.js";

interface FoldSpec {
  readonly foldId: string;
  readonly selectedThreshold?: number;
  readonly strategyReturn?: number;
  readonly benchmarkReturn?: number;
  readonly excessReturn?: number;
  readonly maximumDrawdown?: number;
  readonly activeLongCount?: number;
  readonly cashCount?: number;
  readonly calibrationStrategyReturn?: number;
}

function seedEvaluation() {
  return runWalkForwardThresholdEvaluation({
    symbol: "TEST",
    roundTripCostBps: 0,
    initialCapital: 100,
    folds: [{
      foldId: "seed",
      candidateThresholds: [0.5],
      calibrationRows: [{
        entryDate: "2026-01-01",
        exitDate: "2026-01-02",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.1,
      }],
      validationRows: [{
        entryDate: "2026-01-03",
        exitDate: "2026-01-04",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.1,
      }],
    }],
  });
}

function makeEvaluationResult(
  specs: readonly FoldSpec[],
  aggregate = {
    strategyReturn: 0.42,
    benchmarkReturn: 0.18,
    excessReturn: 0.24,
    maximumDrawdown: 0.17,
  },
) {
  const seed = seedEvaluation();
  const seedFold = seed.foldResults[0]!;
  const foldResults = specs.map((spec, index) => {
    const selectedThreshold = spec.selectedThreshold ?? 0.5;
    const strategyReturn = spec.strategyReturn ?? 0;
    const benchmarkReturn = spec.benchmarkReturn ?? 0;
    const excessReturn = spec.excessReturn ?? strategyReturn - benchmarkReturn;
    const selectedCalibrationResult = {
      ...seedFold.calibrationResult.selectedCalibrationResult,
      strategy: {
        ...seedFold.calibrationResult.selectedCalibrationResult.strategy,
        totalReturn: spec.calibrationStrategyReturn
          ?? seedFold.calibrationResult.selectedCalibrationResult.strategy.totalReturn,
      },
    };
    const validationResult = {
      ...seedFold.calibrationResult.validationResult,
      validationThreshold: selectedThreshold,
      strategy: {
        ...seedFold.calibrationResult.validationResult.strategy,
        totalReturn: strategyReturn,
        maximumDrawdown: spec.maximumDrawdown ?? 0,
        longWindowCount: spec.activeLongCount ?? 1,
        cashWindowCount: spec.cashCount ?? 0,
      },
      benchmark: {
        ...seedFold.calibrationResult.validationResult.benchmark,
        totalReturn: benchmarkReturn,
      },
      excessReturn,
    };
    return {
      ...seedFold,
      foldId: spec.foldId,
      validationStartDate: `2026-02-${String(index * 2 + 1).padStart(2, "0")}`,
      validationEndDate: `2026-02-${String(index * 2 + 2).padStart(2, "0")}`,
      selectedThreshold,
      calibrationResult: {
        ...seedFold.calibrationResult,
        selectedThreshold,
        selectedCalibrationResult,
        validationResult,
      },
    };
  });
  return {
    ...seed,
    foldCount: specs.length,
    orderedFoldIds: specs.map(({ foldId }) => foldId),
    foldResults,
    cumulativeAggregateStrategyReturn: aggregate.strategyReturn,
    cumulativeAggregateBenchmarkReturn: aggregate.benchmarkReturn,
    aggregateExcessReturn: aggregate.excessReturn,
    aggregateMaximumStrategyDrawdown: aggregate.maximumDrawdown,
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value as Record<string, unknown>).forEach(expectDeeplyFrozen);
}

describe("summarizeWalkForwardStability", () => {
  it("calculates all three-fold means from validation evidence", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      {
        foldId: "A",
        selectedThreshold: 0.7,
        strategyReturn: 0.3,
        benchmarkReturn: 0.1,
        maximumDrawdown: 0.1,
        activeLongCount: 2,
        cashCount: 1,
      },
      {
        foldId: "B",
        selectedThreshold: 0.5,
        strategyReturn: -0.1,
        benchmarkReturn: 0.2,
        maximumDrawdown: 0.2,
        activeLongCount: 1,
        cashCount: 2,
      },
      {
        foldId: "C",
        selectedThreshold: 0.7,
        strategyReturn: 0.2,
        benchmarkReturn: -0.1,
        maximumDrawdown: 0.05,
        activeLongCount: 3,
        cashCount: 0,
      },
    ]));

    expect(result.meanValidationStrategyReturn).toBe((0.3 - 0.1 + 0.2) / 3);
    expect(result.meanValidationBenchmarkReturn).toBe((0.1 + 0.2 - 0.1) / 3);
    expect(result.meanValidationExcessReturn).toBe((0.2 - 0.3 + 0.3) / 3);
    expect(result.foldDiagnostics).toEqual([
      {
        foldId: "A",
        validationStartDate: "2026-02-01",
        validationEndDate: "2026-02-02",
        selectedThreshold: 0.7,
        validationStrategyReturn: 0.3,
        validationBenchmarkReturn: 0.1,
        validationExcessReturn: 0.19999999999999998,
        validationMaximumDrawdown: 0.1,
        validationActiveLongCount: 2,
        validationCashCount: 1,
      },
      expect.objectContaining({ foldId: "B" }),
      expect.objectContaining({ foldId: "C" }),
    ]);
  });

  it("calculates odd-count medians", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", strategyReturn: 0.3, benchmarkReturn: 0.4, excessReturn: -0.1 },
      { foldId: "B", strategyReturn: -0.2, benchmarkReturn: -0.2, excessReturn: 0 },
      { foldId: "C", strategyReturn: 0.1, benchmarkReturn: 0, excessReturn: 0.1 },
    ]));

    expect(result.medianValidationStrategyReturn).toBe(0.1);
    expect(result.medianValidationBenchmarkReturn).toBe(0);
    expect(result.medianValidationExcessReturn).toBe(0);
  });

  it("calculates even-count medians", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", strategyReturn: -0.2, benchmarkReturn: -0.4, excessReturn: 0.2 },
      { foldId: "B", strategyReturn: 0.1, benchmarkReturn: 0.2, excessReturn: -0.1 },
      { foldId: "C", strategyReturn: 0.3, benchmarkReturn: 0.4, excessReturn: -0.1 },
      { foldId: "D", strategyReturn: 0.8, benchmarkReturn: 0.6, excessReturn: 0.2 },
    ]));

    expect(result.medianValidationStrategyReturn).toBe(0.2);
    expect(result.medianValidationBenchmarkReturn).toBe((0.2 + 0.4) / 2);
    expect(result.medianValidationExcessReturn).toBe(0.05);
  });

  it("uses exact positive and nonnegative boundaries", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", strategyReturn: -0.1, benchmarkReturn: 0, excessReturn: -0.1 },
      { foldId: "B", strategyReturn: 0, benchmarkReturn: 0, excessReturn: 0 },
      { foldId: "C", strategyReturn: 0.1, benchmarkReturn: 0, excessReturn: 0.1 },
    ]));

    expect(result.positiveStrategyReturnFoldCount).toBe(1);
    expect(result.positiveExcessReturnFoldCount).toBe(1);
    expect(result.nonNegativeExcessReturnFoldCount).toBe(2);
  });

  it("uses the lower foldId for a best-fold tie", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "Z", excessReturn: 0.4 },
      { foldId: "A", excessReturn: 0.4 },
      { foldId: "M", excessReturn: -0.1 },
    ]));

    expect(result.bestFoldByExcessReturn.foldId).toBe("A");
  });

  it("uses the lower foldId for a worst-fold tie", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "Z", excessReturn: -0.4 },
      { foldId: "A", excessReturn: -0.4 },
      { foldId: "M", excessReturn: 0.1 },
    ]));

    expect(result.worstFoldByExcessReturn.foldId).toBe("A");
  });

  it("finds the maximum validation drawdown across folds", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", maximumDrawdown: 0.13 },
      { foldId: "B", maximumDrawdown: 0.31 },
      { foldId: "C", maximumDrawdown: 0.22 },
    ]));

    expect(result.maximumValidationDrawdownAcrossFolds).toBe(0.31);
  });

  it("sorts selected-threshold frequencies numerically", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", selectedThreshold: 0.9 },
      { foldId: "B", selectedThreshold: 0.1 },
      { foldId: "C", selectedThreshold: 0.5 },
      { foldId: "D", selectedThreshold: 0.1 },
    ]));

    expect(result.selectedThresholdFrequencies).toEqual([
      { threshold: 0.1, count: 2 },
      { threshold: 0.5, count: 1 },
      { threshold: 0.9, count: 1 },
    ]);
    expect(result.uniqueSelectedThresholdCount).toBe(3);
  });

  it("uses the lower threshold for a dominant-threshold tie", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", selectedThreshold: 0.7 },
      { foldId: "B", selectedThreshold: 0.3 },
    ]));

    expect(result.dominantSelectedThreshold).toBe(0.3);
    expect(result.dominantSelectedThresholdFrequency).toBe(1);
  });

  it("calculates the dominant-threshold ratio", () => {
    const result = summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", selectedThreshold: 0.4 },
      { foldId: "B", selectedThreshold: 0.4 },
      { foldId: "C", selectedThreshold: 0.4 },
      { foldId: "D", selectedThreshold: 0.8 },
    ]));

    expect(result.dominantSelectedThresholdRatio).toBe(3 / 4);
  });

  it("copies all aggregate metrics exactly", () => {
    const aggregate = {
      strategyReturn: 0.123456789012345,
      benchmarkReturn: -0.234567890123456,
      excessReturn: 0.358024679135801,
      maximumDrawdown: 0.456789012345678,
    };
    const result = summarizeWalkForwardStability(
      makeEvaluationResult([{ foldId: "A" }], aggregate),
    );

    expect(result.aggregateStrategyReturn).toBe(aggregate.strategyReturn);
    expect(result.aggregateBenchmarkReturn).toBe(aggregate.benchmarkReturn);
    expect(result.aggregateExcessReturn).toBe(aggregate.excessReturn);
    expect(result.aggregateMaximumDrawdown).toBe(aggregate.maximumDrawdown);
  });

  it("does not let calibration-return changes affect diagnostics", () => {
    const baseline = makeEvaluationResult([
      { foldId: "A", strategyReturn: 0.2, benchmarkReturn: 0.1 },
      { foldId: "B", strategyReturn: -0.1, benchmarkReturn: 0.05 },
    ]);
    const changed = makeEvaluationResult([
      {
        foldId: "A",
        strategyReturn: 0.2,
        benchmarkReturn: 0.1,
        calibrationStrategyReturn: -0.9,
      },
      {
        foldId: "B",
        strategyReturn: -0.1,
        benchmarkReturn: 0.05,
        calibrationStrategyReturn: 9,
      },
    ]);

    expect(canonicalStringify(summarizeWalkForwardStability(changed))).toBe(
      canonicalStringify(summarizeWalkForwardStability(baseline)),
    );
  });

  it("produces byte-identical output and independently recomputable hashes", () => {
    const input = makeEvaluationResult([
      { foldId: "A", selectedThreshold: 0.4, strategyReturn: 0.1 },
      { foldId: "B", selectedThreshold: 0.6, strategyReturn: -0.2 },
    ]);
    const first = summarizeWalkForwardStability(input);
    const second = summarizeWalkForwardStability(input);
    const { normalizedResultSha256, ...withoutSelfHash } = first;

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.foldDiagnosticsSha256).toBe(hashValue(first.foldDiagnostics));
    expect(first.selectedThresholdFrequenciesSha256).toBe(
      hashValue(first.selectedThresholdFrequencies),
    );
    expect(normalizedResultSha256).toBe(hashValue(withoutSelfHash));
  });

  it("deep-freezes the complete returned graph", () => {
    expectDeeplyFrozen(summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A" },
      { foldId: "B" },
    ])));
  });

  it("leaves caller input unchanged and unfrozen", () => {
    const input = makeEvaluationResult([{ foldId: "A", strategyReturn: 0.2 }]);
    const before = canonicalStringify(input);

    summarizeWalkForwardStability(input);

    expect(canonicalStringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.foldResults)).toBe(false);
    expect(Object.isFrozen(input.foldResults[0])).toBe(false);
  });

  it("does not retain caller-owned values after return", () => {
    const input = makeEvaluationResult([{ foldId: "A", strategyReturn: 0.2 }]);
    const result = summarizeWalkForwardStability(input);

    input.foldResults[0]!.calibrationResult.validationResult.strategy.totalReturn = 99;
    input.foldResults[0]!.selectedThreshold = 0.9;
    input.orderedFoldIds[0] = "changed";

    expect(result.foldDiagnostics[0]!.validationStrategyReturn).toBe(0.2);
    expect(result.foldDiagnostics[0]!.selectedThreshold).toBe(0.5);
    expect(result.foldDiagnostics[0]!.foldId).toBe("A");
  });

  it("fails closed for zero-fold and structurally inconsistent input", () => {
    const zeroFold = makeEvaluationResult([]);
    const mismatchedOrder = makeEvaluationResult([{ foldId: "A" }]);
    mismatchedOrder.orderedFoldIds[0] = "B";

    expect(() => summarizeWalkForwardStability(zeroFold)).toThrow(
      /foldCount must be a positive integer/,
    );
    expect(() => summarizeWalkForwardStability(mismatchedOrder)).toThrow(
      /orderedFoldIds/,
    );
  });

  it("fails closed for duplicate fold IDs", () => {
    expect(() => summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "same" },
      { foldId: "same" },
    ]))).toThrow(/duplicate foldId same/);
  });

  it("fails closed for non-finite validation metrics", () => {
    expect(() => summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", strategyReturn: Number.NaN },
    ]))).toThrow(/validation strategy return must be finite/);
    expect(() => summarizeWalkForwardStability(makeEvaluationResult([
      { foldId: "A", maximumDrawdown: Number.POSITIVE_INFINITY },
    ]))).toThrow(/validation maximum drawdown must be finite/);
  });

  it("fails closed when the declared fold count does not match", () => {
    const input = makeEvaluationResult([{ foldId: "A" }]);
    input.foldCount = 2;

    expect(() => summarizeWalkForwardStability(input)).toThrow(
      /foldCount must match foldResults and orderedFoldIds/,
    );
  });
});
