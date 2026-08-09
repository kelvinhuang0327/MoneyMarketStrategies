import { canonicalStringify, hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  runThresholdParameterSensitivity,
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
        candidateThresholds: [0.9, 0.5, 0.7],
        calibrationRows: [
          {
            entryDate: "2026-01-02",
            exitDate: "2026-01-03",
            probabilityUp: 0.6,
            realizedForwardReturn: -0.2,
          },
          {
            entryDate: "2026-01-04",
            exitDate: "2026-01-05",
            probabilityUp: 0.8,
            realizedForwardReturn: 0.5,
          },
        ],
        validationRows: [
          {
            entryDate: "2026-03-01",
            exitDate: "2026-03-02",
            probabilityUp: 0.6,
            realizedForwardReturn: -0.2,
          },
          {
            entryDate: "2026-03-03",
            exitDate: "2026-03-04",
            probabilityUp: 0.75,
            realizedForwardReturn: 0.5,
          },
          {
            entryDate: "2026-03-05",
            exitDate: "2026-03-06",
            probabilityUp: 0.95,
            realizedForwardReturn: -0.2,
          },
        ],
      },
      {
        foldId: "B",
        candidateThresholds: [0.9, 0.5, 0.7],
        calibrationRows: [
          {
            entryDate: "2026-04-01",
            exitDate: "2026-04-02",
            probabilityUp: 0.6,
            realizedForwardReturn: 0.2,
          },
          {
            entryDate: "2026-04-03",
            exitDate: "2026-04-04",
            probabilityUp: 0.8,
            realizedForwardReturn: -0.1,
          },
        ],
        validationRows: [
          {
            entryDate: "2026-06-01",
            exitDate: "2026-06-02",
            probabilityUp: 0.4,
            realizedForwardReturn: -0.1,
          },
          {
            entryDate: "2026-06-03",
            exitDate: "2026-06-04",
            probabilityUp: 0.6,
            realizedForwardReturn: 0.2,
          },
          {
            entryDate: "2026-06-05",
            exitDate: "2026-06-06",
            probabilityUp: 0.85,
            realizedForwardReturn: -0.05,
          },
        ],
      },
    ],
  };
}

function noSignFlipInput(): WalkForwardThresholdEvaluationInput {
  const source = acceptanceInput();
  return {
    ...source,
    folds: [{ ...source.folds[0]!, candidateThresholds: [0.7, 0.5] }],
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value as Record<string, unknown>).forEach(expectDeeplyFrozen);
}

describe("runThresholdParameterSensitivity", () => {
  it("keeps calibration-selected thresholds unchanged and exposes diagnostic guardrails", () => {
    const result = runThresholdParameterSensitivity(acceptanceInput());

    expect(result.schemaVersion).toBe("MMS_THRESHOLD_PARAMETER_SENSITIVITY_V1");
    expect(result.foldResults.map(({ selectedThreshold }) => selectedThreshold)).toEqual([0.7, 0.5]);
    expect(result.guardrails).toEqual({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      validationOutcomesAffectThresholdSelection: false,
      candidateThresholdsAreDiagnosticsOnly: true,
    });
  });

  it("does not let validation returns or probabilities affect selection", () => {
    const source = acceptanceInput();
    const changed: WalkForwardThresholdEvaluationInput = {
      ...source,
      folds: source.folds.map((fold) => ({
        ...fold,
        validationRows: fold.validationRows.map((row) => ({
          ...row,
          probabilityUp: 0.99,
          realizedForwardReturn: -0.9,
        })),
      })),
    };

    expect(
      runThresholdParameterSensitivity(changed).foldResults.map(({ selectedThreshold }) => selectedThreshold),
    ).toEqual([0.7, 0.5]);
  });

  it("is deterministic for repeated runs and caller fold/candidate permutations", () => {
    const source = acceptanceInput();
    const permuted: WalkForwardThresholdEvaluationInput = {
      ...source,
      folds: [...source.folds].reverse().map((fold) => ({
        ...fold,
        candidateThresholds: [...fold.candidateThresholds].reverse(),
      })),
    };

    const first = runThresholdParameterSensitivity(source);
    const second = runThresholdParameterSensitivity(permuted);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.normalizedResultSha256).toBe(second.normalizedResultSha256);
  });

  it("calculates candidate deltas against the selected replay in the same fold", () => {
    const fold = runThresholdParameterSensitivity(acceptanceInput()).foldResults[0]!;
    const selected = fold.candidateThresholdResults.find(({ isSelectedThreshold }) => isSelectedThreshold)!;
    const highThreshold = fold.candidateThresholdResults.find(({ threshold }) => threshold === 0.9)!;

    expect(selected.threshold).toBe(0.7);
    expect(selected.returnDeltaVersusSelectedThreshold).toBe(0);
    expect(selected.excessReturnDeltaVersusSelectedThreshold).toBe(0);
    expect(highThreshold.validationStrategyReturn).toBe(-0.2);
    expect(highThreshold.validationBenchmarkReturn).toBe(-0.04);
    expect(highThreshold.validationExcessReturn).toBe(-0.16);
    expect(highThreshold.returnDeltaVersusSelectedThreshold).toBe(-0.4);
    expect(highThreshold.excessReturnDeltaVersusSelectedThreshold).toBe(-0.4);
  });

  it("reports the maximum return and excess-return degradation", () => {
    const fold = runThresholdParameterSensitivity(acceptanceInput()).foldResults[0]!;

    expect(fold.selectedValidationStrategyReturn).toBe(0.2);
    expect(fold.selectedValidationExcessReturn).toBe(0.24);
    expect(fold.maximumValidationReturnDegradation).toBe(0.4);
    expect(fold.maximumValidationExcessReturnDegradation).toBe(0.4);
    expect(fold.candidateThresholdResults.find(({ threshold }) => threshold === 0.9)!
      .degradationVersusSelectedThreshold).toBe(0.4);
  });

  it("reports excess-return sign flips and their aggregate status", () => {
    const result = runThresholdParameterSensitivity(acceptanceInput());

    expect(result.foldResults.map(({ fragilityStatus }) => fragilityStatus)).toEqual([
      "EXCESS_RETURN_SIGN_FLIP",
      "EXCESS_RETURN_SIGN_FLIP",
    ]);
    expect(result.foldSignFlipCount).toBe(2);
    expect(result.aggregateFragilityStatus).toBe("ONE_OR_MORE_FOLD_SIGN_FLIPS");
    expect(result.foldResults[0]!.anyCandidateChangesValidationExcessReturnSign).toBe(true);
  });

  it("reports the stable descriptive status when no candidate changes sign", () => {
    const result = runThresholdParameterSensitivity(noSignFlipInput());

    expect(result.foldResults[0]!.fragilityStatus).toBe("NO_EXCESS_RETURN_SIGN_FLIP");
    expect(result.foldResults[0]!.anyCandidateChangesValidationExcessReturnSign).toBe(false);
    expect(result.aggregateFragilityStatus).toBe("NO_FOLD_SIGN_FLIP");
  });

  it("sorts candidate threshold results canonically", () => {
    const result = runThresholdParameterSensitivity(acceptanceInput());

    expect(result.candidateThresholds).toEqual([0.5, 0.7, 0.9]);
    expect(result.foldResults.every((fold) => (
      fold.candidateThresholdResults.map(({ threshold }) => threshold)
    ).every((threshold, index, thresholds) => index === 0 || thresholds[index - 1]! < threshold))).toBe(true);
  });

  it("does not mutate caller input and returns a deeply frozen result", () => {
    const input = acceptanceInput();
    const before = canonicalStringify(input);
    const result = runThresholdParameterSensitivity(input);

    expect(canonicalStringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.folds)).toBe(false);
    expectDeeplyFrozen(result);

    const { normalizedResultSha256, ...withoutSelfHash } = result;
    expect(result.foldResultsSha256).toBe(hashValue(result.foldResults));
    expect(normalizedResultSha256).toBe(hashValue(withoutSelfHash));
  });
});
