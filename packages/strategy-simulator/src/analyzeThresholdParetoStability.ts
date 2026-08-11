import { analyzeThresholdParetoFrontier } from "./analyzeThresholdParetoFrontier.js";
import type {
  ThresholdParameterSensitivityFoldResult,
} from "./types.js";

const SCHEMA_VERSION = "MMS_VALIDATION_THRESHOLD_PARETO_STABILITY_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const DECIMAL_PLACES = 8;

export type ThresholdParetoStabilityFoldInput = Pick<
  ThresholdParameterSensitivityFoldResult,
  "candidateThresholdResults"
>;

export type ThresholdParetoStabilityInput =
  | readonly ThresholdParetoStabilityFoldInput[]
  | { readonly foldResults: readonly ThresholdParetoStabilityFoldInput[] };

export interface ThresholdParetoStabilityThreshold {
  readonly threshold: number;
  readonly eligibleFoldCount: number;
  readonly frontierFoldCount: number;
  readonly dominatedFoldCount: number;
  readonly frontierRate: number;
  readonly hasFullCoverage: boolean;
}

export interface ThresholdParetoStabilityResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly totalFoldCount: number;
  readonly thresholdCount: number;
  readonly stableFrontierThresholds: readonly number[];
  readonly neverFrontierThresholds: readonly number[];
  readonly mixedThresholds: readonly number[];
  readonly partialCoverageThresholds: readonly number[];
  readonly thresholds: readonly ThresholdParetoStabilityThreshold[];
}

interface FoldMembership {
  readonly observedThresholds: ReadonlySet<number>;
  readonly frontierThresholds: ReadonlySet<number>;
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveFolds(
  input: ThresholdParetoStabilityInput,
): readonly ThresholdParetoStabilityFoldInput[] {
  return isFoldArray(input) ? input : input.foldResults;
}

function isFoldArray(
  input: ThresholdParetoStabilityInput,
): input is readonly ThresholdParetoStabilityFoldInput[] {
  return Array.isArray(input);
}

function buildFoldMembership(
  fold: ThresholdParetoStabilityFoldInput,
): FoldMembership {
  const frontier = analyzeThresholdParetoFrontier(fold);
  return {
    observedThresholds: new Set(
      fold.candidateThresholdResults.map(({ threshold }) => threshold),
    ),
    frontierThresholds: new Set(
      frontier.frontierCandidates.map(({ threshold }) => threshold),
    ),
  };
}

export function analyzeThresholdParetoStability(
  input: ThresholdParetoStabilityInput,
): ThresholdParetoStabilityResult {
  const folds = resolveFolds(input);
  const foldMembership = folds.map(buildFoldMembership);
  const thresholds = [...new Set(
    folds.flatMap(({ candidateThresholdResults }) => (
      candidateThresholdResults.map(({ threshold }) => threshold)
    )),
  )].sort((left, right) => left - right);

  const thresholdResults = thresholds.map((threshold) => {
    let eligibleFoldCount = 0;
    let frontierFoldCount = 0;
    foldMembership.forEach(({ observedThresholds, frontierThresholds }) => {
      if (!observedThresholds.has(threshold)) return;
      eligibleFoldCount += 1;
      if (frontierThresholds.has(threshold)) frontierFoldCount += 1;
    });
    const dominatedFoldCount = eligibleFoldCount - frontierFoldCount;
    const hasFullCoverage = eligibleFoldCount === folds.length;

    return Object.freeze({
      threshold,
      eligibleFoldCount,
      frontierFoldCount,
      dominatedFoldCount,
      frontierRate: round(frontierFoldCount / eligibleFoldCount),
      hasFullCoverage,
    });
  });

  const stableFrontierThresholds = thresholdResults
    .filter(({ hasFullCoverage, frontierFoldCount }) => (
      hasFullCoverage && frontierFoldCount === folds.length
    ))
    .map(({ threshold }) => threshold);
  const neverFrontierThresholds = thresholdResults
    .filter(({ hasFullCoverage, frontierFoldCount }) => (
      hasFullCoverage && frontierFoldCount === 0
    ))
    .map(({ threshold }) => threshold);
  const mixedThresholds = thresholdResults
    .filter(({ hasFullCoverage, frontierFoldCount, dominatedFoldCount }) => (
      hasFullCoverage && frontierFoldCount > 0 && dominatedFoldCount > 0
    ))
    .map(({ threshold }) => threshold);
  const partialCoverageThresholds = thresholdResults
    .filter(({ hasFullCoverage }) => !hasFullCoverage)
    .map(({ threshold }) => threshold);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    totalFoldCount: folds.length,
    thresholdCount: thresholdResults.length,
    stableFrontierThresholds: Object.freeze(stableFrontierThresholds),
    neverFrontierThresholds: Object.freeze(neverFrontierThresholds),
    mixedThresholds: Object.freeze(mixedThresholds),
    partialCoverageThresholds: Object.freeze(partialCoverageThresholds),
    thresholds: Object.freeze(thresholdResults),
  });
}
