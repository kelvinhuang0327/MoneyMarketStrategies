import {
  LongCashReplayError,
  type ThresholdParameterSensitivityCandidateResult,
  type ThresholdParameterSensitivityFoldResult,
} from "./types.js";

const SCHEMA_VERSION = "MMS_VALIDATION_THRESHOLD_PARETO_FRONTIER_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

export type ThresholdParetoDimensionDirection = "MAXIMIZE" | "MINIMIZE";

export interface ThresholdParetoDimension {
  readonly field: "validationExcessReturn" | "validationMaximumDrawdown";
  readonly direction: ThresholdParetoDimensionDirection;
  readonly source: string;
}

export interface ThresholdParetoFrontierCandidate {
  readonly threshold: number;
}

export interface ThresholdParetoFrontierDominatedCandidate {
  readonly threshold: number;
  readonly dominatedByThresholds: readonly number[];
}

export type ThresholdParetoFrontierInput =
  | readonly ThresholdParameterSensitivityCandidateResult[]
  | Pick<ThresholdParameterSensitivityFoldResult, "candidateThresholdResults">;

export interface ThresholdParetoFrontierResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly dimensions: readonly ThresholdParetoDimension[];
  readonly candidateCount: number;
  readonly frontierCount: number;
  readonly frontierCandidates: readonly ThresholdParetoFrontierCandidate[];
  readonly dominatedCandidates: readonly ThresholdParetoFrontierDominatedCandidate[];
}

const PARETO_DIMENSIONS: readonly ThresholdParetoDimension[] = Object.freeze([
  Object.freeze({
    field: "validationExcessReturn",
    direction: "MAXIMIZE",
    source: "ThresholdParameterSensitivityCandidateResult.validationExcessReturn",
  }),
  Object.freeze({
    field: "validationMaximumDrawdown",
    direction: "MINIMIZE",
    source: "ThresholdParameterSensitivityCandidateResult.validationMaximumDrawdown",
  }),
]);

type ComparableCandidate = ThresholdParameterSensitivityCandidateResult;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function resolveCandidates(
  input: ThresholdParetoFrontierInput,
): readonly ComparableCandidate[] {
  if (Array.isArray(input)) return input as readonly ComparableCandidate[];
  const foldInput = input as Pick<ThresholdParameterSensitivityFoldResult, "candidateThresholdResults">;
  return foldInput.candidateThresholdResults;
}

function validateAndOrderCandidates(
  input: ThresholdParetoFrontierInput,
): readonly ComparableCandidate[] {
  const candidates = resolveCandidates(input);
  if (candidates.length < 2) {
    fail("threshold Pareto analysis requires at least two candidates");
  }

  const thresholds = new Set<number>();
  candidates.forEach((candidate, index) => {
    if (!Number.isFinite(candidate.threshold)) {
      fail(`candidate ${index} threshold must be finite`);
    }
    if (thresholds.has(candidate.threshold)) {
      fail(`candidate thresholds contain duplicate threshold ${candidate.threshold}`);
    }
    thresholds.add(candidate.threshold);

    PARETO_DIMENSIONS.forEach(({ field }) => {
      if (!Number.isFinite(candidate[field])) {
        fail(`${field} must be finite for threshold ${candidate.threshold}`);
      }
    });
  });

  return Object.freeze([...candidates].sort((left, right) => left.threshold - right.threshold));
}

function strictlyBetter(
  left: ComparableCandidate,
  right: ComparableCandidate,
  dimension: ThresholdParetoDimension,
): boolean {
  const leftValue = left[dimension.field];
  const rightValue = right[dimension.field];
  return dimension.direction === "MAXIMIZE"
    ? leftValue > rightValue
    : leftValue < rightValue;
}

function atLeastAsGood(
  left: ComparableCandidate,
  right: ComparableCandidate,
  dimension: ThresholdParetoDimension,
): boolean {
  const leftValue = left[dimension.field];
  const rightValue = right[dimension.field];
  return dimension.direction === "MAXIMIZE"
    ? leftValue >= rightValue
    : leftValue <= rightValue;
}

function dominates(left: ComparableCandidate, right: ComparableCandidate): boolean {
  let hasStrictImprovement = false;
  for (const dimension of PARETO_DIMENSIONS) {
    if (!atLeastAsGood(left, right, dimension)) return false;
    if (strictlyBetter(left, right, dimension)) hasStrictImprovement = true;
  }
  return hasStrictImprovement;
}

export function analyzeThresholdParetoFrontier(
  input: ThresholdParetoFrontierInput,
): ThresholdParetoFrontierResult {
  const candidates = validateAndOrderCandidates(input);
  const dominatedBy = new Map<number, readonly number[]>();

  candidates.forEach((candidate) => {
    const dominators = candidates
      .filter((other) => other.threshold !== candidate.threshold && dominates(other, candidate))
      .map(({ threshold }) => threshold);
    if (dominators.length > 0) {
      dominatedBy.set(candidate.threshold, Object.freeze(dominators));
    }
  });

  const frontierCandidates = Object.freeze(
    candidates
      .filter(({ threshold }) => !dominatedBy.has(threshold))
      .map(({ threshold }) => Object.freeze({ threshold })),
  );
  const dominatedCandidates = Object.freeze(
    candidates
      .filter(({ threshold }) => dominatedBy.has(threshold))
      .map(({ threshold }) => Object.freeze({
        threshold,
        dominatedByThresholds: dominatedBy.get(threshold)!,
      })),
  );

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    dimensions: PARETO_DIMENSIONS,
    candidateCount: candidates.length,
    frontierCount: frontierCandidates.length,
    frontierCandidates,
    dominatedCandidates,
  });
}
