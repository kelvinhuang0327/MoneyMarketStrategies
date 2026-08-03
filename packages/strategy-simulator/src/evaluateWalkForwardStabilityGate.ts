import { hashValue } from "@mms/research-kernel";

import {
  LongCashReplayError,
  type EvaluateWalkForwardStabilityGateInput,
  type WalkForwardStabilityDiagnostics,
  type WalkForwardStabilityGateCriterionResult,
  type WalkForwardStabilityGateEvaluationResult,
  type WalkForwardStabilityGatePolicy,
} from "./types.js";

const SCHEMA_VERSION = "MMS_WALK_FORWARD_STABILITY_GATE_EVALUATION_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

export const TW_STABILITY_RESEARCH_POLICY_V1: WalkForwardStabilityGatePolicy = Object.freeze({
  policyId: "TW_STABILITY_RESEARCH_POLICY_V1",
  policyVersion: "1.0.0",
  minimumFoldCount: 3,
  minimumPositiveExcessReturnFoldRatio: 0.6666666666666666,
  minimumMedianValidationExcessReturn: 0,
  minimumAggregateExcessReturn: 0,
  maximumAggregateDrawdown: 0.35,
  maximumDominantThresholdRatio: 0.67,
});

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function validatePolicy(policy: unknown): WalkForwardStabilityGatePolicy {
  if (typeof policy !== "object" || policy === null) {
    fail("policy must be a non-null object");
  }
  const p = policy as Partial<WalkForwardStabilityGatePolicy>;
  if (typeof p.policyId !== "string" || p.policyId.trim() === "") {
    fail("policyId must be a non-empty string");
  }
  if (typeof p.policyVersion !== "string" || p.policyVersion.trim() === "") {
    fail("policyVersion must be a non-empty string");
  }
  if (p.minimumFoldCount === undefined || !Number.isInteger(p.minimumFoldCount) || p.minimumFoldCount <= 0) {
    fail("minimumFoldCount must be a positive integer");
  }
  if (
    p.minimumPositiveExcessReturnFoldRatio === undefined
    || typeof p.minimumPositiveExcessReturnFoldRatio !== "number"
    || !Number.isFinite(p.minimumPositiveExcessReturnFoldRatio)
    || p.minimumPositiveExcessReturnFoldRatio < 0
    || p.minimumPositiveExcessReturnFoldRatio > 1
  ) {
    fail("minimumPositiveExcessReturnFoldRatio must be a finite number between 0 and 1");
  }
  if (
    p.minimumMedianValidationExcessReturn === undefined
    || typeof p.minimumMedianValidationExcessReturn !== "number"
    || !Number.isFinite(p.minimumMedianValidationExcessReturn)
  ) {
    fail("minimumMedianValidationExcessReturn must be a finite number");
  }
  if (
    p.minimumAggregateExcessReturn === undefined
    || typeof p.minimumAggregateExcessReturn !== "number"
    || !Number.isFinite(p.minimumAggregateExcessReturn)
  ) {
    fail("minimumAggregateExcessReturn must be a finite number");
  }
  if (
    p.maximumAggregateDrawdown === undefined
    || typeof p.maximumAggregateDrawdown !== "number"
    || !Number.isFinite(p.maximumAggregateDrawdown)
    || p.maximumAggregateDrawdown < 0
    || p.maximumAggregateDrawdown > 1
  ) {
    fail("maximumAggregateDrawdown must be a finite number between 0 and 1");
  }
  if (
    p.maximumDominantThresholdRatio === undefined
    || typeof p.maximumDominantThresholdRatio !== "number"
    || !Number.isFinite(p.maximumDominantThresholdRatio)
    || p.maximumDominantThresholdRatio < 0
    || p.maximumDominantThresholdRatio > 1
  ) {
    fail("maximumDominantThresholdRatio must be a finite number between 0 and 1");
  }
  return {
    policyId: p.policyId,
    policyVersion: p.policyVersion,
    minimumFoldCount: p.minimumFoldCount,
    minimumPositiveExcessReturnFoldRatio: p.minimumPositiveExcessReturnFoldRatio,
    minimumMedianValidationExcessReturn: p.minimumMedianValidationExcessReturn,
    minimumAggregateExcessReturn: p.minimumAggregateExcessReturn,
    maximumAggregateDrawdown: p.maximumAggregateDrawdown,
    maximumDominantThresholdRatio: p.maximumDominantThresholdRatio,
  };
}

function validateDiagnostics(diagnostics: unknown): WalkForwardStabilityDiagnostics {
  if (typeof diagnostics !== "object" || diagnostics === null) {
    fail("diagnostics must be a non-null object");
  }
  const d = diagnostics as Partial<WalkForwardStabilityDiagnostics>;
  if (d.foldCount === undefined || !Number.isInteger(d.foldCount) || d.foldCount <= 0) {
    fail("diagnostics.foldCount must be a positive integer");
  }
  if (
    d.positiveExcessReturnFoldCount === undefined
    || !Number.isInteger(d.positiveExcessReturnFoldCount)
    || d.positiveExcessReturnFoldCount < 0
    || d.positiveExcessReturnFoldCount > d.foldCount
  ) {
    fail("diagnostics.positiveExcessReturnFoldCount must be a non-negative integer <= foldCount");
  }
  if (
    d.medianValidationExcessReturn === undefined
    || typeof d.medianValidationExcessReturn !== "number"
    || !Number.isFinite(d.medianValidationExcessReturn)
  ) {
    fail("diagnostics.medianValidationExcessReturn must be a finite number");
  }
  if (
    d.aggregateExcessReturn === undefined
    || typeof d.aggregateExcessReturn !== "number"
    || !Number.isFinite(d.aggregateExcessReturn)
  ) {
    fail("diagnostics.aggregateExcessReturn must be a finite number");
  }
  if (
    d.aggregateMaximumDrawdown === undefined
    || typeof d.aggregateMaximumDrawdown !== "number"
    || !Number.isFinite(d.aggregateMaximumDrawdown)
  ) {
    fail("diagnostics.aggregateMaximumDrawdown must be a finite number");
  }
  if (
    d.dominantSelectedThresholdRatio === undefined
    || typeof d.dominantSelectedThresholdRatio !== "number"
    || !Number.isFinite(d.dominantSelectedThresholdRatio)
  ) {
    fail("diagnostics.dominantSelectedThresholdRatio must be a finite number");
  }
  if (
    d.normalizedResultSha256 === undefined
    || typeof d.normalizedResultSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(d.normalizedResultSha256)
  ) {
    fail("diagnostics.normalizedResultSha256 must be a 64-character hex string");
  }
  return diagnostics as WalkForwardStabilityDiagnostics;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function evaluateWalkForwardStabilityGate(
  input: EvaluateWalkForwardStabilityGateInput,
): WalkForwardStabilityGateEvaluationResult {
  if (typeof input !== "object" || input === null) {
    fail("input must be a non-null object");
  }
  const policy = validatePolicy(input.policy);
  const diagnostics = validateDiagnostics(input.diagnostics);

  const positiveExcessReturnFoldRatio = diagnostics.positiveExcessReturnFoldCount / diagnostics.foldCount;

  const criteria: readonly WalkForwardStabilityGateCriterionResult[] = Object.freeze([
    Object.freeze({
      criterionId: "MINIMUM_FOLD_COUNT" as const,
      pass: diagnostics.foldCount >= policy.minimumFoldCount,
      observedValue: diagnostics.foldCount,
      thresholdValue: policy.minimumFoldCount,
      comparator: ">=" as const,
    }),
    Object.freeze({
      criterionId: "MINIMUM_POSITIVE_EXCESS_RETURN_FOLD_RATIO" as const,
      pass: positiveExcessReturnFoldRatio >= policy.minimumPositiveExcessReturnFoldRatio,
      observedValue: positiveExcessReturnFoldRatio,
      thresholdValue: policy.minimumPositiveExcessReturnFoldRatio,
      comparator: ">=" as const,
    }),
    Object.freeze({
      criterionId: "MINIMUM_MEDIAN_VALIDATION_EXCESS_RETURN" as const,
      pass: diagnostics.medianValidationExcessReturn >= policy.minimumMedianValidationExcessReturn,
      observedValue: diagnostics.medianValidationExcessReturn,
      thresholdValue: policy.minimumMedianValidationExcessReturn,
      comparator: ">=" as const,
    }),
    Object.freeze({
      criterionId: "MINIMUM_AGGREGATE_EXCESS_RETURN" as const,
      pass: diagnostics.aggregateExcessReturn >= policy.minimumAggregateExcessReturn,
      observedValue: diagnostics.aggregateExcessReturn,
      thresholdValue: policy.minimumAggregateExcessReturn,
      comparator: ">=" as const,
    }),
    Object.freeze({
      criterionId: "MAXIMUM_AGGREGATE_DRAWDOWN" as const,
      pass: diagnostics.aggregateMaximumDrawdown <= policy.maximumAggregateDrawdown,
      observedValue: diagnostics.aggregateMaximumDrawdown,
      thresholdValue: policy.maximumAggregateDrawdown,
      comparator: "<=" as const,
    }),
    Object.freeze({
      criterionId: "MAXIMUM_DOMINANT_THRESHOLD_RATIO" as const,
      pass: diagnostics.dominantSelectedThresholdRatio <= policy.maximumDominantThresholdRatio,
      observedValue: diagnostics.dominantSelectedThresholdRatio,
      thresholdValue: policy.maximumDominantThresholdRatio,
      comparator: "<=" as const,
    }),
  ]);

  const overallPass = criteria.every((c) => c.pass);
  const policySha256 = hashValue(policy);
  const diagnosticsSha256 = diagnostics.normalizedResultSha256;

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policySha256,
    diagnosticsSha256,
    overallPass,
    criteria,
    policy,
  };

  const normalizedResultSha256 = hashValue(normalized);

  return deepFreeze({
    ...normalized,
    normalizedResultSha256,
  });
}
