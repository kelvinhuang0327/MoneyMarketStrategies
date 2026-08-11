import { canonicalStringify } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  analyzeThresholdParetoFrontier,
  type ThresholdParetoFrontierInput,
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

function input(values: readonly CandidateValues[]): ThresholdParetoFrontierInput {
  return values.map(candidate);
}

describe("analyzeThresholdParetoFrontier", () => {
  it("identifies a clear validation reward/risk dominance", () => {
    const result = analyzeThresholdParetoFrontier(input([
      { threshold: 0.7, validationExcessReturn: 0.12, validationMaximumDrawdown: 0.1 },
      { threshold: 0.5, validationExcessReturn: 0.08, validationMaximumDrawdown: 0.2 },
    ]));

    expect(result.frontierCandidates).toEqual([{ threshold: 0.7 }]);
    expect(result.dominatedCandidates).toEqual([{
      threshold: 0.5,
      dominatedByThresholds: [0.7],
    }]);
  });

  it("keeps risk/return trade-offs on the frontier", () => {
    const result = analyzeThresholdParetoFrontier(input([
      { threshold: 0.3, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.3 },
      { threshold: 0.8, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.1 },
    ]));

    expect(result.frontierCandidates).toEqual([{ threshold: 0.3 }, { threshold: 0.8 }]);
    expect(result.dominatedCandidates).toEqual([]);
  });

  it("preserves exact ties as separate frontier candidates", () => {
    const result = analyzeThresholdParetoFrontier(input([
      { threshold: 0.4, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
      { threshold: 0.6, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
    ]));

    expect(result.frontierCandidates).toEqual([{ threshold: 0.4 }, { threshold: 0.6 }]);
    expect(result.dominatedCandidates).toEqual([]);
  });

  it("reports every dominator rather than only a direct neighbor", () => {
    const result = analyzeThresholdParetoFrontier(input([
      { threshold: 0.3, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
      { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.2 },
      { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
    ]));

    expect(result.frontierCandidates).toEqual([{ threshold: 0.3 }]);
    expect(result.dominatedCandidates).toEqual([
      { threshold: 0.5, dominatedByThresholds: [0.3] },
      { threshold: 0.7, dominatedByThresholds: [0.3, 0.5] },
    ]);
  });

  it("uses stable threshold ordering and does not mutate candidates", () => {
    const source = input([
      { threshold: 0.9, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.3 },
      { threshold: 0.5, validationExcessReturn: 0.3, validationMaximumDrawdown: 0.1 },
      { threshold: 0.7, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.2 },
    ]);
    const before = canonicalStringify(source);

    const first = analyzeThresholdParetoFrontier(source);
    const second = analyzeThresholdParetoFrontier([...source].reverse());

    expect(first).toEqual(second);
    expect(canonicalStringify(source)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.frontierCandidates)).toBe(true);
    expect(Object.isFrozen(first.dominatedCandidates)).toBe(true);
  });

  it("uses validation fields only and exposes no weighted score or selection", () => {
    const withFinalTestFields = input([
      { threshold: 0.5, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.1 },
      { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
    ]).map((item, index) => ({
      ...item,
      finalTestExcessReturn: index === 0 ? -100 : 100,
      finalTestMaximumDrawdown: index === 0 ? 100 : 0,
    }));

    const result = analyzeThresholdParetoFrontier(withFinalTestFields);

    expect(result.frontierCandidates).toEqual([{ threshold: 0.5 }]);
    expect(result).not.toHaveProperty("strategyScore");
    expect(result).not.toHaveProperty("selectedThreshold");
    expect(JSON.stringify(result)).not.toContain("finalTest");
  });

  it("fails closed for too few or non-comparable candidates", () => {
    expect(() => analyzeThresholdParetoFrontier(input([
      { threshold: 0.5, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
    ]))).toThrow(/at least two candidates/);
    expect(() => analyzeThresholdParetoFrontier(input([
      { threshold: 0.5, validationExcessReturn: Number.NaN, validationMaximumDrawdown: 0.2 },
      { threshold: 0.7, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.1 },
    ]))).toThrow(/validationExcessReturn must be finite/);
  });

  it("records the existing validation dimensions", () => {
    const result = analyzeThresholdParetoFrontier(input([
      { threshold: 0.5, validationExcessReturn: 0.1, validationMaximumDrawdown: 0.2 },
      { threshold: 0.7, validationExcessReturn: 0.2, validationMaximumDrawdown: 0.3 },
    ]));

    expect(result.dimensions).toEqual([
      {
        field: "validationExcessReturn",
        direction: "MAXIMIZE",
        source: "ThresholdParameterSensitivityCandidateResult.validationExcessReturn",
      },
      {
        field: "validationMaximumDrawdown",
        direction: "MINIMIZE",
        source: "ThresholdParameterSensitivityCandidateResult.validationMaximumDrawdown",
      },
    ]);
    expect(result.candidateCount).toBe(2);
    expect(result.frontierCount).toBe(2);
  });
});
