import { hashValue } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  evaluateWalkForwardStabilityGate,
  TW_STABILITY_RESEARCH_POLICY_V1,
} from "./evaluateWalkForwardStabilityGate.js";
import { LongCashReplayError, type WalkForwardStabilityDiagnostics } from "./types.js";

function makeDiagnostics(overrides: Partial<WalkForwardStabilityDiagnostics> = {}): WalkForwardStabilityDiagnostics {
  const base = {
    schemaVersion: "MMS_WALK_FORWARD_STABILITY_DIAGNOSTICS_V1" as const,
    researchMode: "diagnostic-only" as const,
    foldCount: 3,
    foldDiagnostics: [],
    positiveStrategyReturnFoldCount: 2,
    positiveExcessReturnFoldCount: 2,
    nonNegativeExcessReturnFoldCount: 2,
    meanValidationStrategyReturn: 0.05,
    medianValidationStrategyReturn: 0.04,
    meanValidationBenchmarkReturn: 0.02,
    medianValidationBenchmarkReturn: 0.01,
    meanValidationExcessReturn: 0.03,
    medianValidationExcessReturn: 0.03,
    bestFoldByExcessReturn: {
      foldId: "fold-1",
      validationStartDate: "2024-01-01",
      validationEndDate: "2024-06-30",
      selectedThreshold: 0.6,
      validationStrategyReturn: 0.08,
      validationBenchmarkReturn: 0.02,
      validationExcessReturn: 0.06,
      validationMaximumDrawdown: 0.1,
      validationActiveLongCount: 5,
      validationCashCount: 2,
    },
    worstFoldByExcessReturn: {
      foldId: "fold-3",
      validationStartDate: "2025-01-01",
      validationEndDate: "2025-06-30",
      selectedThreshold: 0.6,
      validationStrategyReturn: -0.01,
      validationBenchmarkReturn: 0.01,
      validationExcessReturn: -0.02,
      validationMaximumDrawdown: 0.15,
      validationActiveLongCount: 3,
      validationCashCount: 4,
    },
    maximumValidationDrawdownAcrossFolds: 0.15,
    selectedThresholdFrequencies: [{ threshold: 0.6, count: 2 }, { threshold: 0.65, count: 1 }],
    uniqueSelectedThresholdCount: 2,
    dominantSelectedThreshold: 0.6,
    dominantSelectedThresholdFrequency: 2,
    dominantSelectedThresholdRatio: 0.6666666666666666,
    aggregateStrategyReturn: 0.12,
    aggregateBenchmarkReturn: 0.04,
    aggregateExcessReturn: 0.08,
    aggregateMaximumDrawdown: 0.15,
    foldDiagnosticsSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    selectedThresholdFrequenciesSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
  const normalizedResultSha256 = hashValue(base);
  return { ...base, normalizedResultSha256 };
}

describe("evaluateWalkForwardStabilityGate", () => {
  it("all pass: passes when all criteria satisfy the policy", () => {
    const diagnostics = makeDiagnostics();
    const result = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics,
    });

    expect(result.overallPass).toBe(true);
    expect(result.criteria).toHaveLength(6);
    expect(result.criteria.every((c) => c.pass)).toBe(true);
  });

  it("each individual criterion failure", () => {
    // 1. MINIMUM_FOLD_COUNT failure
    const failFoldCount = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ foldCount: 2, positiveExcessReturnFoldCount: 2 }),
    });
    expect(failFoldCount.overallPass).toBe(false);
    expect(failFoldCount.criteria[0]!.criterionId).toBe("MINIMUM_FOLD_COUNT");
    expect(failFoldCount.criteria[0]!.pass).toBe(false);

    // 2. MINIMUM_POSITIVE_EXCESS_RETURN_FOLD_RATIO failure
    const failRatio = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ foldCount: 3, positiveExcessReturnFoldCount: 1 }),
    });
    expect(failRatio.overallPass).toBe(false);
    expect(failRatio.criteria[1]!.criterionId).toBe("MINIMUM_POSITIVE_EXCESS_RETURN_FOLD_RATIO");
    expect(failRatio.criteria[1]!.pass).toBe(false);

    // 3. MINIMUM_MEDIAN_VALIDATION_EXCESS_RETURN failure
    const failMedian = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ medianValidationExcessReturn: -0.01 }),
    });
    expect(failMedian.overallPass).toBe(false);
    expect(failMedian.criteria[2]!.criterionId).toBe("MINIMUM_MEDIAN_VALIDATION_EXCESS_RETURN");
    expect(failMedian.criteria[2]!.pass).toBe(false);

    // 4. MINIMUM_AGGREGATE_EXCESS_RETURN failure
    const failAggExcess = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ aggregateExcessReturn: -0.005 }),
    });
    expect(failAggExcess.overallPass).toBe(false);
    expect(failAggExcess.criteria[3]!.criterionId).toBe("MINIMUM_AGGREGATE_EXCESS_RETURN");
    expect(failAggExcess.criteria[3]!.pass).toBe(false);

    // 5. MAXIMUM_AGGREGATE_DRAWDOWN failure
    const failDrawdown = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ aggregateMaximumDrawdown: 0.40 }),
    });
    expect(failDrawdown.overallPass).toBe(false);
    expect(failDrawdown.criteria[4]!.criterionId).toBe("MAXIMUM_AGGREGATE_DRAWDOWN");
    expect(failDrawdown.criteria[4]!.pass).toBe(false);

    // 6. MAXIMUM_DOMINANT_THRESHOLD_RATIO failure
    const failDominantRatio = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics({ dominantSelectedThresholdRatio: 0.80 }),
    });
    expect(failDominantRatio.overallPass).toBe(false);
    expect(failDominantRatio.criteria[5]!.criterionId).toBe("MAXIMUM_DOMINANT_THRESHOLD_RATIO");
    expect(failDominantRatio.criteria[5]!.pass).toBe(false);
  });

  it("equality boundaries: passes when observed values equal thresholds exactly", () => {
    const boundaryDiagnostics = makeDiagnostics({
      foldCount: 3,
      positiveExcessReturnFoldCount: 2, // 2/3 = 0.6666666666666666
      medianValidationExcessReturn: 0,
      aggregateExcessReturn: 0,
      aggregateMaximumDrawdown: 0.35,
      dominantSelectedThresholdRatio: 0.67,
    });

    const result = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: boundaryDiagnostics,
    });

    expect(result.overallPass).toBe(true);
    expect(result.criteria.every((c) => c.pass)).toBe(true);
  });

  it("malformed policies: rejects invalid or incomplete policy objects", () => {
    const diagnostics = makeDiagnostics();

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: null as unknown as typeof TW_STABILITY_RESEARCH_POLICY_V1,
        diagnostics,
      })).toThrow(LongCashReplayError);

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: { ...TW_STABILITY_RESEARCH_POLICY_V1, minimumFoldCount: 0 },
        diagnostics,
      })).toThrow(/minimumFoldCount must be a positive integer/);

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: { ...TW_STABILITY_RESEARCH_POLICY_V1, minimumPositiveExcessReturnFoldRatio: 1.5 },
        diagnostics,
      })).toThrow(/minimumPositiveExcessReturnFoldRatio/);

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: { ...TW_STABILITY_RESEARCH_POLICY_V1, maximumAggregateDrawdown: -0.1 },
        diagnostics,
      })).toThrow(/maximumAggregateDrawdown/);
  });

  it("malformed diagnostics: rejects invalid or incomplete diagnostics objects", () => {
    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        diagnostics: null as unknown as WalkForwardStabilityDiagnostics,
      })).toThrow(LongCashReplayError);

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        diagnostics: makeDiagnostics({ foldCount: -1 }),
      })).toThrow(/diagnostics.foldCount must be a positive integer/);

    expect(() =>
      evaluateWalkForwardStabilityGate({
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        diagnostics: { ...makeDiagnostics(), normalizedResultSha256: "invalid-sha" },
      })).toThrow(/normalizedResultSha256/);
  });

  it("fixed order: criteria are returned in the exact declared contract order", () => {
    const result = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics(),
    });

    const expectedOrder = [
      "MINIMUM_FOLD_COUNT",
      "MINIMUM_POSITIVE_EXCESS_RETURN_FOLD_RATIO",
      "MINIMUM_MEDIAN_VALIDATION_EXCESS_RETURN",
      "MINIMUM_AGGREGATE_EXCESS_RETURN",
      "MAXIMUM_AGGREGATE_DRAWDOWN",
      "MAXIMUM_DOMINANT_THRESHOLD_RATIO",
    ];

    expect(result.criteria.map((c) => c.criterionId)).toEqual(expectedOrder);
  });

  it("policy key-order invariance: produces identical hashes regardless of policy key ordering", () => {
    const policyOrderA = {
      policyId: "TW_STABILITY_RESEARCH_POLICY_V1",
      policyVersion: "1.0.0",
      minimumFoldCount: 3,
      minimumPositiveExcessReturnFoldRatio: 0.6666666666666666,
      minimumMedianValidationExcessReturn: 0,
      minimumAggregateExcessReturn: 0,
      maximumAggregateDrawdown: 0.35,
      maximumDominantThresholdRatio: 0.67,
    };

    const policyOrderB = {
      maximumDominantThresholdRatio: 0.67,
      maximumAggregateDrawdown: 0.35,
      minimumAggregateExcessReturn: 0,
      minimumMedianValidationExcessReturn: 0,
      minimumPositiveExcessReturnFoldRatio: 0.6666666666666666,
      minimumFoldCount: 3,
      policyVersion: "1.0.0",
      policyId: "TW_STABILITY_RESEARCH_POLICY_V1",
    };

    const diagnostics = makeDiagnostics();

    const resultA = evaluateWalkForwardStabilityGate({ policy: policyOrderA, diagnostics });
    const resultB = evaluateWalkForwardStabilityGate({ policy: policyOrderB, diagnostics });

    expect(resultA.policySha256).toBe(resultB.policySha256);
    expect(resultA.normalizedResultSha256).toBe(resultB.normalizedResultSha256);
  });

  it("deterministic hashes: policySha256 and normalizedResultSha256 are valid 64-char hex strings", () => {
    const result = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics(),
    });

    expect(result.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.diagnosticsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.normalizedResultSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deep immutability: returns a deeply frozen result object", () => {
    const result = evaluateWalkForwardStabilityGate({
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      diagnostics: makeDiagnostics(),
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.criteria)).toBe(true);
    expect(Object.isFrozen(result.criteria[0])).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
  });

  it("caller input unchanged: input objects are not mutated or frozen in place", () => {
    const rawPolicy = {
      policyId: "TW_STABILITY_RESEARCH_POLICY_V1",
      policyVersion: "1.0.0",
      minimumFoldCount: 3,
      minimumPositiveExcessReturnFoldRatio: 0.6666666666666666,
      minimumMedianValidationExcessReturn: 0,
      minimumAggregateExcessReturn: 0,
      maximumAggregateDrawdown: 0.35,
      maximumDominantThresholdRatio: 0.67,
    };

    const rawDiagnostics = makeDiagnostics();
    // make diagnostics unfrozen
    const unfrozenDiagnostics = JSON.parse(JSON.stringify(rawDiagnostics));

    expect(Object.isFrozen(rawPolicy)).toBe(false);
    expect(Object.isFrozen(unfrozenDiagnostics)).toBe(false);

    evaluateWalkForwardStabilityGate({
      policy: rawPolicy,
      diagnostics: unfrozenDiagnostics,
    });

    expect(Object.isFrozen(rawPolicy)).toBe(false);
    expect(Object.isFrozen(unfrozenDiagnostics)).toBe(false);
  });
});
