import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
