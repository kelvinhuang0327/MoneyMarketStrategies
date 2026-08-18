import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildCurrentUnresolvedSignal,
  buildPredictionRetrainingResultV1FromFreshResearch,
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

test("derives a current signal from the latest feature row without future labels", () => {
  const rawRows = [];
  for (let index = 0; index < 120; index += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    const close = 100 + Math.sin(index / 7) * 4 + index * 0.05;
    rawRows.push({
      symbol: "0050",
      date,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000 + index,
      source: "test-owned/in-memory",
    });
  }

  const first = buildCurrentUnresolvedSignal(rawRows, 0.6);
  const second = buildCurrentUnresolvedSignal(rawRows, 0.6);

  assert.deepEqual(second, first);
  assert.equal(first.signalAsOfFeatureDate, "2024-04-29");
  assert.equal(first.signalAsOfTargetDate, "2024-05-06");
  assert.equal(first.predictionHorizonRows, 5);
  assert.equal(first.position, first.probabilityUp >= 0.6 ? "LONG" : "CASH");
  assert.equal(Number.isFinite(first.probabilityUp), true);
});

test("adapts one fresh research output into a deterministic Contract V1 result", () => {
  const rawRows = [];
  for (let index = 0; index < 120; index += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    const close = 100 + Math.sin(index / 7) * 4 + index * 0.05;
    rawRows.push({
      symbol: "0050",
      date,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000 + index,
      source: "test-owned/in-memory",
    });
  }

  const replay = simulateLongCashReplay({
    symbol: "0050",
    validationThreshold: 0.5,
    roundTripCostBps: 10,
    initialCapital: 100,
    rows: [
      {
        entryDate: "2024-04-01",
        exitDate: "2024-04-08",
        probabilityUp: 0.7,
        realizedForwardReturn: 0.02,
      },
      {
        entryDate: "2024-04-09",
        exitDate: "2024-04-16",
        probabilityUp: 0.4,
        realizedForwardReturn: -0.01,
      },
    ],
  });
  const scenario = (symbol, probabilityUp, position) => ({
    symbol,
    latestSignal: {
      signalAsOfFeatureDate: "2024-04-20",
      signalAsOfTargetDate: "2024-04-29",
      probabilityUp,
      operativeThreshold: 0.6,
      position,
    },
    currentSignal: {
      signalAsOfFeatureDate: "2024-04-29",
      signalAsOfTargetDate: "2024-05-06",
      probabilityUp: probabilityUp + 0.01,
      operativeThreshold: 0.6,
      position,
      predictionHorizonRows: 5,
    },
    walkForward: {
      normalizedResultSha256: "b".repeat(64),
      foldResults: [{ calibrationResult: { validationResult: replay } }],
    },
  });
  const output = {
    schemaVersion: "MMS_TW_STRATEGY_RESEARCH_RUNNER_V1",
    repositories: { legacyRepo: { ref: "test-ref" } },
    source: {
      path: "test.csv",
      sha256: "a".repeat(64),
      dateRange: { max: "2024-04-29" },
    },
    scenarios: {
      "2330_RAW_CONTROL": scenario("2330", 0.58, "LONG"),
      "0050_RAW": scenario("0050", 0.48, "CASH"),
      "0050_SOURCE_QUALIFIED_ADJUSTED": scenario("0050", 0.62, "LONG"),
    },
    limitations: [],
  };

  const first = buildPredictionRetrainingResultV1FromFreshResearch({
    output,
    rawRows,
    generatedAt: "2026-08-12T00:00:00.000Z",
  });
  const second = buildPredictionRetrainingResultV1FromFreshResearch({
    output,
    rawRows,
    generatedAt: "2026-08-12T00:00:00.000Z",
  });

  assert.deepEqual(second, first);
  assert.equal(first.latestPredictions.availability, "available");
  assert.equal(first.latestPredictions.value.length, 3);
  assert.deepEqual(first.latestPredictions.value.map(({ scenario, position }) => ({ scenario, position })), [
    { scenario: "0050_RAW", position: "CASH" },
    { scenario: "0050_SOURCE_QUALIFIED_ADJUSTED", position: "LONG" },
    { scenario: "2330_RAW_CONTROL", position: "LONG" },
  ]);
  assert.deepEqual(first.latestPredictions.value.map(({ scenario, operativeThreshold }) => ({
    scenario,
    operativeThreshold,
  })), [
    { scenario: "0050_RAW", operativeThreshold: { availability: "available", value: 0.6 } },
    { scenario: "0050_SOURCE_QUALIFIED_ADJUSTED", operativeThreshold: { availability: "available", value: 0.6 } },
    { scenario: "2330_RAW_CONTROL", operativeThreshold: { availability: "available", value: 0.6 } },
  ]);
  assert.equal(first.currentUnresolvedPredictions.availability, "available");
  assert.deepEqual(first.currentUnresolvedPredictions.value.map(({ scenario, resolutionStatus, predictionRole }) => ({
    scenario,
    resolutionStatus,
    predictionRole,
  })), [
    { scenario: "0050_RAW", resolutionStatus: "unresolved", predictionRole: "current_unresolved" },
    { scenario: "0050_SOURCE_QUALIFIED_ADJUSTED", resolutionStatus: "unresolved", predictionRole: "current_unresolved" },
    { scenario: "2330_RAW_CONTROL", resolutionStatus: "unresolved", predictionRole: "current_unresolved" },
  ]);
  assert.equal(first.currentUnresolvedPredictions.value.every(({ predictionHorizon, targetDate, actualDirection, realizedReturn }) =>
    predictionHorizon.availability === "available"
    && predictionHorizon.value.rows === 5
    && targetDate.availability === "available"
    && actualDirection.availability === "unavailable"
    && realizedReturn.availability === "unavailable"), true);
  assert.deepEqual(first.currentPredictionUnavailable, []);
  assert.equal(first.finalTestMetrics.availability, "available");
  assert.equal(first.finalTestReliability.availability, "available");
  assert.equal(
    first.finalTestReliability.value.groups.reduce(
      (total, group) => total + group.finalTestRowCount,
      0,
    ),
    first.finalTestMetrics.value.sampleCount,
  );
  assert.equal(first.finalTestEconomicEdge.availability, "available");
  assert.equal(first.finalTestEconomicEdge.value.evaluationPartition, "FINAL_TEST");
  assert.equal(
    first.finalTestEconomicEdge.value.groups.reduce(
      (total, group) => total + group.finalTestRows,
      0,
    ),
    first.finalTestMetrics.value.sampleCount,
  );
  assert.deepEqual(
    first.finalTestEconomicEdge.value.groups.map(({ symbol }) => symbol),
    ["0050"],
  );
  assert.equal(first.finalTestEconomicEdge.value.transactionCostBps, 10);
  assert.equal(Number.isFinite(first.finalTestEconomicEdge.value.groups[0].excessReturn), true);
  assert.deepEqual(
    first.finalTestReliability.value.groups.map(({ groupDimension, symbol }) => ({
      groupDimension,
      symbol,
    })),
    [
      { groupDimension: "symbol", symbol: "0050" },
    ],
  );
  assert.equal(first.simulation.availability, "available");
  assert.equal(first.simulation.value.scenario, "0050_SOURCE_QUALIFIED_ADJUSTED");
});

test("runs market regime challenger via CLI and produces valid JSON artifact", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-market-regime-test-"));
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/runTwStrategyResearchStudy.mjs",
        "--market-regime-challenger",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: "/Users/kelvin/VibeCoding-WorkSpace/MoneyMarketStrategies",
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    assert.equal(stdout.includes("CONTROL_REPRODUCTION=PASS"), true);
    assert.equal(stdout.includes("PROMOTION_DECISION=do_not_promote"), true);
    assert.equal(stdout.includes("MARKET_REGIME_CHALLENGER_CONCLUSION=NOT_SUPPORTED"), true);

    const artifactPath = path.join(
      tempDir,
      "mms_0056_market_regime_context_challenger_temporal_v1.json",
    );
    const json = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(json.schemaVersion, "MMS_0056_MARKET_REGIME_CONTEXT_CHALLENGER_TEMPORAL_V1");
    assert.equal(json.symbol, "0056");
    assert.equal(json.cutoffRuns.length, 4);
    assert.equal(json.controlReproduction.status, "PASS");
    assert.equal(json.marketRegimeChallengerConclusion, "NOT_SUPPORTED");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
