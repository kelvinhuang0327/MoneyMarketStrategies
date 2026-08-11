import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildValidationThresholdParetoResearchOutput,
  formatProfitFactorForResearchMarkdown,
  serializeResearchOutputForJson,
} from "./runTwStrategyResearchStudy.mjs";
import {
  simulateLongCashReplay,
  summarizeLongCashReplay,
} from "@mms/strategy-simulator";

function replaySummary(strategyProfitFactor) {
  return {
    foldId: "fold-1",
    configuredThreshold: 0.5,
    strategyProfitFactor,
    strategyUlcerIndex: 1.25,
    benchmarkUlcerIndex: 2.5,
    strategyMaxDrawdownDuration: 3,
    benchmarkMaxDrawdownDuration: 4,
  };
}

function scenario(strategyProfitFactor) {
  return {
    validationReplaySummaries: [replaySummary(strategyProfitFactor)],
  };
}

function sensitivityCandidate({
  threshold,
  validationExcessReturn,
  validationMaximumDrawdown,
  isSelectedThreshold = false,
  finalTestExcessReturn = 0,
}) {
  return {
    threshold,
    isSelectedThreshold,
    validationStrategyReturn: validationExcessReturn,
    validationBenchmarkReturn: 0,
    validationExcessReturn,
    validationMaximumDrawdown,
    returnDeltaVersusSelectedThreshold: 0,
    excessReturnDeltaVersusSelectedThreshold: 0,
    degradationVersusSelectedThreshold: 0,
    excessReturnDegradationVersusSelectedThreshold: 0,
    finalTestExcessReturn,
    finalTestMaximumDrawdown: 0,
  };
}

function thresholdSensitivity(foldResults) {
  return { foldResults };
}

function paretoSensitivityFixture() {
  return thresholdSensitivity([
    {
      foldId: "fold-1",
      selectedThreshold: 0.7,
      candidateThresholdResults: [
        sensitivityCandidate({
          threshold: 0.5,
          validationExcessReturn: 0.3,
          validationMaximumDrawdown: 0.1,
          finalTestExcessReturn: 999,
        }),
        sensitivityCandidate({
          threshold: 0.7,
          validationExcessReturn: 0.2,
          validationMaximumDrawdown: 0.2,
          isSelectedThreshold: true,
          finalTestExcessReturn: -999,
        }),
      ],
    },
    {
      foldId: "fold-2",
      selectedThreshold: 0.5,
      candidateThresholdResults: [
        sensitivityCandidate({
          threshold: 0.5,
          validationExcessReturn: 0.1,
          validationMaximumDrawdown: 0.2,
          isSelectedThreshold: true,
        }),
        sensitivityCandidate({
          threshold: 0.9,
          validationExcessReturn: 0.05,
          validationMaximumDrawdown: 0.3,
        }),
      ],
    },
  ]);
}

test("exposes per-fold V13 frontiers and aggregate V14 stability without changing selection", () => {
  const source = paretoSensitivityFixture();
  const selectedThresholdsBefore = source.foldResults.map(({ selectedThreshold }) => selectedThreshold);
  const output = buildValidationThresholdParetoResearchOutput(source);

  assert.deepEqual(
    output.validationThresholdParetoFrontier.map(({ foldId }) => foldId),
    ["fold-1", "fold-2"],
  );
  assert.deepEqual(output.validationThresholdParetoFrontier[0], {
    foldId: "fold-1",
    candidateThresholds: [0.5, 0.7],
    schemaVersion: "MMS_VALIDATION_THRESHOLD_PARETO_FRONTIER_V1",
    researchMode: "diagnostic-only",
    dimensions: [
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
    ],
    candidateCount: 2,
    frontierCount: 1,
    frontierCandidates: [{ threshold: 0.5 }],
    dominatedCandidates: [{ threshold: 0.7, dominatedByThresholds: [0.5] }],
  });

  assert.deepEqual(output.validationThresholdParetoStability.stableFrontierThresholds, [0.5]);
  assert.deepEqual(output.validationThresholdParetoStability.neverFrontierThresholds, []);
  assert.deepEqual(output.validationThresholdParetoStability.mixedThresholds, []);
  assert.deepEqual(output.validationThresholdParetoStability.partialCoverageThresholds, [0.7, 0.9]);
  assert.deepEqual(output.validationThresholdParetoStability.thresholds, [
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

  assert.deepEqual(
    source.foldResults.map(({ selectedThreshold }) => selectedThreshold),
    selectedThresholdsBefore,
  );
  assert.equal(Object.hasOwn(output, "bestThreshold"), false);
  assert.equal(Object.hasOwn(output, "recommendedThreshold"), false);
});

test("keeps Pareto output validation-only, deterministic, and JSON-compatible", () => {
  const source = paretoSensitivityFixture();
  const first = buildValidationThresholdParetoResearchOutput(source);
  const second = buildValidationThresholdParetoResearchOutput(source);
  const finalTestChanged = JSON.parse(JSON.stringify(source));
  finalTestChanged.foldResults[0].candidateThresholdResults[0].finalTestExcessReturn = -123456;
  finalTestChanged.foldResults[0].candidateThresholdResults[0].finalTestMaximumDrawdown = 123456;
  const finalTestChangedOutput = buildValidationThresholdParetoResearchOutput(finalTestChanged);

  assert.deepEqual(second, first);
  assert.deepEqual(finalTestChangedOutput, first);

  const serialized = serializeResearchOutputForJson({
    scenarios: {
      TEST: {
        ...first,
        validationReplaySummaries: [],
      },
    },
  });
  const parsed = JSON.parse(JSON.stringify(serialized));
  assert.deepEqual(parsed.scenarios.TEST.validationThresholdParetoFrontier, first.validationThresholdParetoFrontier);
  assert.deepEqual(parsed.scenarios.TEST.validationThresholdParetoStability, first.validationThresholdParetoStability);
  assert.equal(JSON.stringify(parsed).includes("finalTest"), false);
});

test("serializes positive Infinity without mutating the source summary", () => {
  const replay = simulateLongCashReplay({
    symbol: "TEST",
    validationThreshold: 0.5,
    roundTripCostBps: 0,
    initialCapital: 100,
    rows: [
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 1,
        realizedForwardReturn: 0.1,
      },
      {
        entryDate: "2026-01-10",
        exitDate: "2026-01-17",
        probabilityUp: 1,
        realizedForwardReturn: 0.2,
      },
    ],
  });
  const sourceSummary = summarizeLongCashReplay(replay);
  const sourceSummaryBeforeSerialization = { ...sourceSummary };
  const source = {
    scenarios: {
      TEST: { validationReplaySummaries: [sourceSummary] },
    },
  };

  const serialized = serializeResearchOutputForJson(source);
  const json = JSON.parse(JSON.stringify(serialized));
  const outputSummary = json.scenarios.TEST.validationReplaySummaries[0];

  assert.equal(sourceSummary.strategyProfitFactor, Infinity);
  assert.deepEqual(sourceSummary, sourceSummaryBeforeSerialization);
  assert.equal(outputSummary.strategyProfitFactor, "Infinity");
  assert.notEqual(outputSummary.strategyProfitFactor, null);
  assert.equal(typeof outputSummary.strategyProfitFactor, "string");
  assert.equal(outputSummary.strategyUlcerIndex, sourceSummary.strategyUlcerIndex);
  assert.equal(outputSummary.benchmarkUlcerIndex, sourceSummary.benchmarkUlcerIndex);
  assert.equal(outputSummary.strategyMaxDrawdownDuration, sourceSummary.strategyMaxDrawdownDuration);
  assert.equal(outputSummary.benchmarkMaxDrawdownDuration, sourceSummary.benchmarkMaxDrawdownDuration);
});

test("keeps finite Profit Factor numeric across all research output shapes", () => {
  const finiteSummary = replaySummary(2.5);
  const mainOutput = { scenarios: { TEST: scenario(finiteSummary.strategyProfitFactor) } };
  const temporalOutput = {
    cutoffRuns: [{ scenarios: { TEST: scenario(finiteSummary.strategyProfitFactor) } }],
  };
  const sensitivityOutput = {
    temporalStudiesByCost: {
      "10": temporalOutput,
    },
  };

  for (const output of [mainOutput, temporalOutput, sensitivityOutput]) {
    const serialized = serializeResearchOutputForJson(output);
    const json = JSON.parse(JSON.stringify(serialized));
    const outputSummary = output.scenarios
      ? json.scenarios.TEST.validationReplaySummaries[0]
      : output.cutoffRuns
        ? json.cutoffRuns[0].scenarios.TEST.validationReplaySummaries[0]
        : json.temporalStudiesByCost["10"].cutoffRuns[0].scenarios.TEST.validationReplaySummaries[0];

    assert.equal(outputSummary.strategyProfitFactor, 2.5);
    assert.equal(typeof outputSummary.strategyProfitFactor, "number");
  }
});

test("rejects unsupported non-finite Profit Factor values", () => {
  for (const value of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => serializeResearchOutputForJson({ scenarios: { TEST: scenario(value) } }),
      /STOP_MMS_REPLAY_DIAGNOSTICS_UNEXPECTED_NONFINITE_VALUE/,
    );
  }
});

test("renders the authorized Markdown Profit Factor representation", () => {
  assert.equal(formatProfitFactorForResearchMarkdown(2.5), "2.5");
  assert.equal(formatProfitFactorForResearchMarkdown(Infinity), "Infinity");
});
