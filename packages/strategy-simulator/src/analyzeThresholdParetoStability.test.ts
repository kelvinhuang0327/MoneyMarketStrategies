import { canonicalStringify } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  analyzeThresholdParetoStability,
  type ThresholdParetoStabilityFoldInput,
  type ThresholdParetoStabilityInput,
} from "./index.js";

type CandidateValues = {
  readonly threshold: number;
  readonly validationExcessReturn: number;
  readonly validationMaximumDrawdown: number;
};

function candidate(values: CandidateValues) {
  return {
    threshold: values.threshold,
    isSelectedThreshold: values.threshold === 0.5,
    validationStrategyReturn: values.validationExcessReturn,
    validationBenchmarkReturn: 0,
    validationExcessReturn: values.validationExcessReturn,
    validationMaximumDrawdown: values.validationMaximumDrawdown,
    returnDeltaVersusSelectedThreshold: 0,
    excessReturnDeltaVersusSelectedThreshold: 0,
    degradationVersusSelectedThreshold: 0,
    excessReturnDegradationVersusSelectedThreshold: 0,
  } as const;
}

function fold(values: readonly CandidateValues[]): ThresholdParetoStabilityFoldInput {
  return {
    candidateThresholdResults: values.map(candidate),
  };
}

function input(folds: readonly ThresholdParetoStabilityFoldInput[]): ThresholdParetoStabilityInput {
  return { foldResults: folds };
}

describe("analyzeThresholdParetoStability", () => {
  it("identifies a threshold that remains on the frontier across every fold", () => {
    const result = analyzeThresholdParetoStability(input([
      fold([
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.2 },
      ]),
      fold([
        { threshold: 0.5, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
        { threshold: 0.7, validationExcessReturn: 0.05, validationMaximumDrawdown: 0.3 },
      ]),
    ]));

    expect(result.stableFrontierThresholds).toEqual([0.5]);
    expect(result.neverFrontierThresholds).toEqual([0.7]);
    expect(result.mixedThresholds).toEqual([]);
    expect(result.thresholds).toEqual([
      {
        threshold: 0.5,
        eligibleFoldCount: 2,
        frontierFoldCount: 2,
        dominatedFoldCount: 0,
        frontierRate: 1,
        hasFullCoverage: true,
      },
      {
        threshold: 0.7,
        eligibleFoldCount: 2,
        frontierFoldCount: 0,
        dominatedFoldCount: 2,
        frontierRate: 0,
        hasFullCoverage: true,
      },
    ]);
  });

  it("reports fold-dependent frontier membership as mixed rather than stable", () => {
    const result = analyzeThresholdParetoStability([
      fold([
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
      ]),
      fold([
        { threshold: 0.5, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
        { threshold: 0.7, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
      ]),
    ]);

    expect(result.mixedThresholds).toEqual([0.5, 0.7]);
    expect(result.stableFrontierThresholds).toEqual([]);
    expect(result.thresholds.map(({ frontierFoldCount, dominatedFoldCount, frontierRate }) => ({
      frontierFoldCount,
      dominatedFoldCount,
      frontierRate,
    }))).toEqual([
      { frontierFoldCount: 1, dominatedFoldCount: 1, frontierRate: 0.5 },
      { frontierFoldCount: 1, dominatedFoldCount: 1, frontierRate: 0.5 },
    ]);
  });

  it("classifies a fully covered never-frontier candidate deterministically", () => {
    const result = analyzeThresholdParetoStability([
      fold([
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
      ]),
      fold([
        { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.05, validationMaximumDrawdown: 0.4 },
      ]),
    ]);

    expect(result.neverFrontierThresholds).toEqual([0.7]);
    expect(result.thresholds.find(({ threshold }) => threshold === 0.7)).toMatchObject({
      eligibleFoldCount: 2,
      frontierFoldCount: 0,
      dominatedFoldCount: 2,
      hasFullCoverage: true,
    });
  });

  it("represents missing threshold observations as partial coverage", () => {
    const result = analyzeThresholdParetoStability([
      fold([
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
      ]),
      fold([
        { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.1 },
        { threshold: 0.9, validationExcessReturn: 0.05, validationMaximumDrawdown: 0.4 },
      ]),
    ]);

    expect(result.partialCoverageThresholds).toEqual([0.7, 0.9]);
    expect(result.stableFrontierThresholds).toEqual([0.5]);
    expect(result.thresholds.filter(({ threshold }) => threshold !== 0.5)).toEqual([
      {
        threshold: 0.7,
        eligibleFoldCount: 1,
        frontierFoldCount: 0,
        dominatedFoldCount: 1,
        frontierRate: 0,
        hasFullCoverage: false,
      },
      {
        threshold: 0.9,
        eligibleFoldCount: 1,
        frontierFoldCount: 0,
        dominatedFoldCount: 1,
        frontierRate: 0,
        hasFullCoverage: false,
      },
    ]);
  });

  it("preserves V13 exact ties as frontier membership in every fold", () => {
    const result = analyzeThresholdParetoStability([
      fold([
        { threshold: 0.4, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
        { threshold: 0.6, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
      ]),
      fold([
        { threshold: 0.4, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.3 },
        { threshold: 0.6, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.3 },
      ]),
    ]);

    expect(result.stableFrontierThresholds).toEqual([0.4, 0.6]);
    expect(result.thresholds.every(({ dominatedFoldCount }) => dominatedFoldCount === 0)).toBe(true);
  });

  it("returns a deterministic empty result", () => {
    expect(analyzeThresholdParetoStability([])).toEqual({
      schemaVersion: "MMS_VALIDATION_THRESHOLD_PARETO_STABILITY_V1",
      researchMode: "diagnostic-only",
      totalFoldCount: 0,
      thresholdCount: 0,
      stableFrontierThresholds: [],
      neverFrontierThresholds: [],
      mixedThresholds: [],
      partialCoverageThresholds: [],
      thresholds: [],
    });
  });

  it("preserves one-fold evidence without implying additional robustness", () => {
    const result = analyzeThresholdParetoStability([
      fold([
        { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
      ]),
    ]);

    expect(result.totalFoldCount).toBe(1);
    expect(result.thresholds.map(({ eligibleFoldCount, frontierFoldCount, hasFullCoverage }) => ({
      eligibleFoldCount,
      frontierFoldCount,
      hasFullCoverage,
    }))).toEqual([
      { eligibleFoldCount: 1, frontierFoldCount: 1, hasFullCoverage: true },
      { eligibleFoldCount: 1, frontierFoldCount: 0, hasFullCoverage: true },
    ]);
  });

  it("uses stable ascending ordering and does not mutate fold inputs", () => {
    const source = [
      fold([
        { threshold: 0.9, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.7, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.2 },
      ]),
      fold([
        { threshold: 0.7, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.2 },
        { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
        { threshold: 0.9, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
      ]),
    ];
    const before = canonicalStringify(source);

    const first = analyzeThresholdParetoStability(source);
    const second = analyzeThresholdParetoStability([...source].reverse());

    expect(first).toEqual(second);
    expect(canonicalStringify(source)).toBe(before);
    expect(first.thresholds.map(({ threshold }) => threshold)).toEqual([0.5, 0.7, 0.9]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.thresholds)).toBe(true);
    expect(Object.isFrozen(first.thresholds[0])).toBe(true);
  });

  it("uses validation fields only and exposes no selection or composite score", () => {
    const withFinalTestFields = [
      {
        ...fold([
          { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.1 },
          { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
        ]),
        finalTestExcessReturn: -100,
        finalTestMaximumDrawdown: 100,
      },
    ];

    const result = analyzeThresholdParetoStability(withFinalTestFields);

    expect(result.stableFrontierThresholds).toEqual([0.5]);
    expect(result).not.toHaveProperty("bestThreshold");
    expect(result).not.toHaveProperty("selectedThreshold");
    expect(result).not.toHaveProperty("weightedScore");
    expect(JSON.stringify(result)).not.toContain("finalTest");
  });
});
