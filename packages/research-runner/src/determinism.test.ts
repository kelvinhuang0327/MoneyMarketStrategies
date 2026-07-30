import type {
  DatasetVersion,
  ExperimentRegistryState,
  MarketDataRow,
} from "@mms/contracts";
import {
  createExperiment,
  createExperimentRegistry,
  registerStrategyVersion,
  transitionExperiment,
} from "@mms/experiment-registry";
import { canonicalStringify } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import type { RunResearchExperimentInput } from "./researchExperimentRunner.js";
import { runResearchStudy } from "./researchStudyRunner.js";

const DATASET_VERSION: DatasetVersion = Object.freeze({
  datasetId: "deterministic-study",
  version: "v1",
  source: "test-owned/in-memory",
});

function fixtureMarketRows(count = 120): MarketDataRow[] {
  const rows: MarketDataRow[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const cycle = Math.sin((index * Math.PI) / 9);
    const close = 100 + cycle * 12 + index * 0.03;
    rows.push({
      symbol: "SYNTH",
      date,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000 + (index % 13) * 17,
      source: "test-owned/in-memory",
    });
  }
  return rows;
}

function studyRegistry(experimentIds: readonly string[]): ExperimentRegistryState {
  let state = createExperimentRegistry();
  state = registerStrategyVersion(state, {
    strategyId: "deterministic-strategy",
    strategyVersion: "1.0.0",
    description: "Deterministic study fixture",
    parameters: { lookbackDays: 20 },
    logicalTime: "strategy-registered",
  });
  for (const experimentId of experimentIds) {
    state = createExperiment(state, {
      experimentId,
      strategyId: "deterministic-strategy",
      strategyVersion: "1.0.0",
      hypothesis: "The same study input yields the same public output.",
      requiredData: DATASET_VERSION,
      successCriteria: ["byte-identical canonical output"],
      logicalTime: `experiment-created-${experimentId}`,
    });
    state = transitionExperiment(state, {
      experimentId,
      toStatus: "READY",
      reason: "ready for deterministic research",
      logicalTime: `experiment-ready-${experimentId}`,
    });
  }
  return state;
}

function runnerInput(
  experimentId: string,
  marketRows: readonly MarketDataRow[],
): RunResearchExperimentInput {
  return {
    experimentId,
    evidenceRunId: `run-${experimentId}`,
    marketRows,
    logisticRegression: {
      iterations: 600,
      learningRate: 0.08,
      l2: 0.01,
    },
    startedAtLogicalTime: `run-started-${experimentId}`,
    evidenceAttachedAtLogicalTime: `evidence-attached-${experimentId}`,
  };
}

describe("research study determinism", () => {
  it("returns byte-identical public output for identical input", () => {
    const experimentIds = ["deterministic-two", "deterministic-one"];
    const marketRows = fixtureMarketRows();
    const input = {
      initialState: studyRegistry(experimentIds),
      runs: experimentIds.map((experimentId) =>
        runnerInput(experimentId, marketRows),
      ),
    };

    const first = runResearchStudy(input);
    const second = runResearchStudy(input);

    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
  });
});
