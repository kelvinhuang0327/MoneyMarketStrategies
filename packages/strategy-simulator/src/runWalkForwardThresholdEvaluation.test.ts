import { canonicalStringify, hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  LongCashReplayError,
  runWalkForwardThresholdEvaluation,
  type WalkForwardThresholdEvaluationInput,
} from "./index.js";

function acceptanceInput(): WalkForwardThresholdEvaluationInput {
  return {
    symbol: "TEST",
    roundTripCostBps: 0,
    initialCapital: 100,
    folds: [
      {
        foldId: "A",
        candidateThresholds: [0.5, 0.7],
        calibrationRows: [
          {
            entryDate: "2026-01-02",
            exitDate: "2026-01-09",
            probabilityUp: 0.9,
            realizedForwardReturn: 0.2,
          },
          {
            entryDate: "2026-01-10",
            exitDate: "2026-01-17",
            probabilityUp: 0.6,
            realizedForwardReturn: -0.1,
          },
          {
            entryDate: "2026-01-18",
            exitDate: "2026-01-25",
            probabilityUp: 0.4,
            realizedForwardReturn: 0.05,
          },
        ],
        validationRows: [{
          entryDate: "2026-01-26",
          exitDate: "2026-02-02",
          probabilityUp: 0.8,
          realizedForwardReturn: 0.1,
        }],
      },
      {
        foldId: "B",
        candidateThresholds: [0.5, 0.7],
        calibrationRows: [
          {
            entryDate: "2026-02-03",
            exitDate: "2026-02-10",
            probabilityUp: 0.6,
            realizedForwardReturn: 0.2,
          },
          {
            entryDate: "2026-02-11",
            exitDate: "2026-02-18",
            probabilityUp: 0.4,
            realizedForwardReturn: -0.1,
          },
        ],
        validationRows: [{
          entryDate: "2026-02-19",
          exitDate: "2026-02-26",
          probabilityUp: 0.6,
          realizedForwardReturn: -0.2,
        }],
      },
    ],
  };
}

function withSecondValidationWindow(
  entryDate: string,
  exitDate: string,
): WalkForwardThresholdEvaluationInput {
  const source = acceptanceInput();
  return {
    ...source,
    folds: [
      source.folds[0]!,
      {
        ...source.folds[1]!,
        calibrationRows: source.folds[0]!.calibrationRows,
        validationRows: [{
          entryDate,
          exitDate,
          probabilityUp: 0.8,
          realizedForwardReturn: 0.1,
        }],
      },
    ],
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value as Record<string, unknown>).forEach(expectDeeplyFrozen);
}

describe("runWalkForwardThresholdEvaluation", () => {
  it("passes the required two-fold acceptance fixture", () => {
    const result = runWalkForwardThresholdEvaluation(acceptanceInput());

    expect(result.orderedFoldIds).toEqual(["A", "B"]);
    expect(result.foldResults.map(({ selectedThreshold }) => selectedThreshold)).toEqual([0.7, 0.5]);
    expect(result.aggregateStrategyEquityCurve.map(({ capital }) => capital)).toEqual([100, 110, 88]);
    expect(result.aggregateBenchmarkEquityCurve.map(({ capital }) => capital)).toEqual([100, 110, 88]);
    expect(result.thresholdFrequencies).toEqual([
      { threshold: 0.5, count: 1 },
      { threshold: 0.7, count: 1 },
    ]);
    expect(result.cumulativeAggregateStrategyReturn).toBe(-0.12);
    expect(result.cumulativeAggregateBenchmarkReturn).toBe(-0.12);
    expect(result.aggregateExcessReturn).toBe(0);
    expect(result.aggregateMaximumStrategyDrawdown).toBe(0.2);
  });

  it("makes caller fold permutations byte-identical", () => {
    const ascending = acceptanceInput();
    const descending = { ...acceptanceInput(), folds: [...acceptanceInput().folds].reverse() };

    expect(JSON.stringify(runWalkForwardThresholdEvaluation(descending))).toBe(
      JSON.stringify(runWalkForwardThresholdEvaluation(ascending)),
    );
  });

  it("retains each fold selected threshold and complete calibration and validation evidence", () => {
    const result = runWalkForwardThresholdEvaluation(acceptanceInput());

    expect(result.foldResults[0]!.selectedThreshold).toBe(0.7);
    expect(result.foldResults[0]!.calibrationResult.calibrationResults).toHaveLength(2);
    expect(result.foldResults[0]!.calibrationResult.selectedCalibrationResult.windows).toHaveLength(3);
    expect(result.foldResults[0]!.calibrationResult.validationResult.windows).toHaveLength(1);
    expect(result.foldResults[1]!.selectedThreshold).toBe(0.5);
    expect(result.foldResults[1]!.calibrationResult.calibrationResults.map(
      ({ eligible }) => eligible,
    )).toEqual([true, false]);
    expect(result.foldResults[1]!.calibrationResult.validationResult.windows).toHaveLength(1);
  });

  it("compounds aggregate curves from validation returns only", () => {
    const result = runWalkForwardThresholdEvaluation(acceptanceInput());

    expect(result.foldResults.map(
      ({ calibrationResult }) => calibrationResult.validationResult.strategy.totalReturn,
    )).toEqual([0.1, -0.2]);
    expect(result.aggregateStrategyEquityCurve).toEqual([
      { foldId: null, capital: 100 },
      { foldId: "A", capital: 110 },
      { foldId: "B", capital: 88 },
    ]);
  });

  it("does not let calibration returns enter aggregate equity", () => {
    const result = runWalkForwardThresholdEvaluation(acceptanceInput());

    expect(result.foldResults.map(
      ({ calibrationResult }) => calibrationResult.selectedCalibrationResult.strategy.totalReturn,
    )).toEqual([0.2, 0.2]);
    expect(result.aggregateStrategyEquityCurve.map(({ capital }) => capital)).toEqual([100, 110, 88]);
  });

  it("sorts threshold frequency records numerically", () => {
    const source = acceptanceInput();
    const result = runWalkForwardThresholdEvaluation({
      ...source,
      folds: [...source.folds].reverse(),
    });

    expect(result.thresholdFrequencies).toEqual([
      { threshold: 0.5, count: 1 },
      { threshold: 0.7, count: 1 },
    ]);
  });

  it("never lets later validation data affect either selected threshold", () => {
    const baseline = acceptanceInput();
    const changed = acceptanceInput();
    const changedSecondFold = {
      ...changed.folds[1]!,
      validationRows: [{
        entryDate: "2026-02-19",
        exitDate: "2026-02-26",
        probabilityUp: 0.1,
        realizedForwardReturn: 0.5,
      }],
    };
    const changedResult = runWalkForwardThresholdEvaluation({
      ...changed,
      folds: [changed.folds[0]!, changedSecondFold],
    });

    expect(runWalkForwardThresholdEvaluation(baseline).foldResults.map(
      ({ selectedThreshold }) => selectedThreshold,
    )).toEqual([0.7, 0.5]);
    expect(changedResult.foldResults.map(({ selectedThreshold }) => selectedThreshold)).toEqual([
      0.7,
      0.5,
    ]);
  });

  it("produces identical and independently recomputable hashes", () => {
    const first = runWalkForwardThresholdEvaluation(acceptanceInput());
    const second = runWalkForwardThresholdEvaluation(acceptanceInput());
    const { normalizedResultSha256, ...withoutSelfHash } = first;

    expect(first.normalizedResultSha256).toBe(second.normalizedResultSha256);
    expect(first.foldResultsSha256).toBe(hashValue(first.foldResults));
    expect(first.aggregateStrategyCurveSha256).toBe(hashValue(first.aggregateStrategyEquityCurve));
    expect(first.aggregateBenchmarkCurveSha256).toBe(hashValue(first.aggregateBenchmarkEquityCurve));
    expect(normalizedResultSha256).toBe(hashValue(withoutSelfHash));
  });

  it("deeply freezes the complete result graph", () => {
    expectDeeplyFrozen(runWalkForwardThresholdEvaluation(acceptanceInput()));
  });

  it("does not mutate, freeze, or retain caller-owned input", () => {
    const source = acceptanceInput();
    const input = {
      symbol: source.symbol,
      roundTripCostBps: source.roundTripCostBps,
      initialCapital: source.initialCapital,
      folds: source.folds.map((fold) => ({
        foldId: fold.foldId,
        candidateThresholds: [...fold.candidateThresholds],
        calibrationRows: fold.calibrationRows.map((row) => ({ ...row })),
        validationRows: fold.validationRows.map((row) => ({ ...row })),
      })),
    };
    const before = canonicalStringify(input);
    const result = runWalkForwardThresholdEvaluation(input);

    expect(canonicalStringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.folds)).toBe(false);
    expect(Object.isFrozen(input.folds[0]!.candidateThresholds)).toBe(false);
    input.folds[0]!.candidateThresholds[0] = 0.1;
    input.folds[0]!.validationRows[0]!.realizedForwardReturn = -0.5;
    expect(result.foldResults[0]!.calibrationResult.candidateThresholds).toEqual([0.5, 0.7]);
    expect(result.foldResults[0]!.calibrationResult.validationResult.strategy.totalReturn).toBe(0.1);
  });

  it("fails closed for empty folds", () => {
    expect(() => runWalkForwardThresholdEvaluation({
      ...acceptanceInput(),
      folds: [],
    })).toThrow(/folds must contain at least one fold/);
  });

  it("fails closed for blank or duplicate normalized fold IDs", () => {
    const source = acceptanceInput();

    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{ ...source.folds[0]!, foldId: " " }],
    })).toThrow(/foldId must not be blank/);
    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [
        { ...source.folds[0]!, foldId: "same" },
        { ...source.folds[1]!, foldId: " same " },
      ],
    })).toThrow(/duplicate foldId same/);
  });

  it("fails closed for touching cross-fold validation windows", () => {
    expect(() => runWalkForwardThresholdEvaluation(
      withSecondValidationWindow("2026-02-02", "2026-02-09"),
    )).toThrow(/strictly non-overlapping/);
  });

  it("fails closed for overlapping cross-fold validation windows", () => {
    expect(() => runWalkForwardThresholdEvaluation(
      withSecondValidationWindow("2026-02-01", "2026-02-08"),
    )).toThrow(/strictly non-overlapping/);
  });

  it("fails closed through the existing calibrator for invalid calibration rows", () => {
    const source = acceptanceInput();

    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{ ...source.folds[0]!, calibrationRows: [] }],
    })).toThrow(LongCashReplayError);
    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{ ...source.folds[0]!, calibrationRows: [] }],
    })).toThrow(/calibrationRows/);
  });

  it("fails closed through the existing calibrator for invalid validation rows", () => {
    const source = acceptanceInput();

    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{ ...source.folds[0]!, validationRows: [] }],
    })).toThrow(LongCashReplayError);
    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{ ...source.folds[0]!, validationRows: [] }],
    })).toThrow(/validationRows/);
  });

  it("fails closed through the existing calibrator for an all-cash fold", () => {
    const source = acceptanceInput();

    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{
        ...source.folds[1]!,
        candidateThresholds: [0.7],
      }],
    })).toThrow(/only all-cash/);
  });

  it("fails when a fold calibration reaches its validation start", () => {
    const source = acceptanceInput();
    const secondFold = source.folds[1]!;

    expect(() => runWalkForwardThresholdEvaluation({
      ...source,
      folds: [{
        ...secondFold,
        calibrationRows: [
          secondFold.calibrationRows[0]!,
          {
            ...secondFold.calibrationRows[1]!,
            exitDate: secondFold.validationRows[0]!.entryDate,
          },
        ],
      }],
    })).toThrow(/strictly after/);
  });
});
