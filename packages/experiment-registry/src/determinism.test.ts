import { canonicalStringify, hashValue, runResearchEvidenceKernel } from "@mms/research-kernel";
import type { DatasetVersion, ExperimentRegistryState, MarketDataRow } from "@mms/contracts";
import { describe, expect, it } from "vitest";

import {
  attachRunEvidence,
  createExperiment,
  createExperimentRegistry,
  exportCanonicalLedger,
  hashStrategyVersion,
  recordPromotionReview,
  registerStrategyVersion,
  transitionExperiment,
} from "./experimentRegistry.js";

const FIXTURE_DATASET_VERSION: DatasetVersion = {
  datasetId: "synthetic-cycle",
  version: "v1",
  source: "test-owned/in-memory",
};

const STRATEGY_ID = "mean-reversion";
const STRATEGY_VERSION = "1.0.0";

function fixtureMarketRows(count = 120): MarketDataRow[] {
  const rows: MarketDataRow[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
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

function runFixtureSequence(): ExperimentRegistryState {
  const { evidence, promotionDecision } = runResearchEvidenceKernel({
    datasetVersion: FIXTURE_DATASET_VERSION,
    marketRows: fixtureMarketRows(),
    logisticRegression: { iterations: 600, learningRate: 0.08, l2: 0.01 },
  });

  let state = registerStrategyVersion(createExperimentRegistry(), {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    description: "Diagnostic mean-reversion baseline",
    parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    logicalTime: "t0",
  });
  state = createExperiment(state, {
    experimentId: "exp-determinism",
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    hypothesis: "Reverting to the 20-day mean predicts next-day direction.",
    requiredData: FIXTURE_DATASET_VERSION,
    successCriteria: ["final-test accuracy exceeds its majority baseline"],
    logicalTime: "t1",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-determinism",
    toStatus: "READY",
    reason: "ready",
    logicalTime: "t2",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-determinism",
    toStatus: "RUNNING",
    reason: "start",
    logicalTime: "t3",
  });
  state = attachRunEvidence(state, {
    experimentId: "exp-determinism",
    evidenceRunId: "run-1",
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    datasetVersion: FIXTURE_DATASET_VERSION,
    evidence,
    promotionDecision,
    requestedEvidenceLevel: "VERIFIED",
    logicalTime: "t4",
  });
  state = recordPromotionReview(state, {
    experimentId: "exp-determinism",
    evidenceRunId: "run-1",
    outcome: "ACCEPTED_FOR_RESEARCH_VALIDATION",
    isDiagnosticResearchReviewOnly: true,
    reviewer: "research-lead",
    notes: "Diagnostic research review only; meets V1 promotion gates.",
    logicalTime: "t5",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-determinism",
    toStatus: "VALIDATED",
    reason: "all V1 diagnostic gates satisfied",
    logicalTime: "t6",
  });
  return state;
}

describe("deterministic reproduction", () => {
  it("produces a byte-identical canonical ledger export across two independent runs", () => {
    const stateA = runFixtureSequence();
    const stateB = runFixtureSequence();

    const ledgerA = exportCanonicalLedger(stateA);
    const ledgerB = exportCanonicalLedger(stateB);

    expect(canonicalStringify(ledgerA)).toBe(canonicalStringify(ledgerB));
    expect(hashValue(ledgerA)).toBe(hashValue(ledgerB));
    expect(ledgerA.map((event) => event.eventHash)).toEqual(ledgerB.map((event) => event.eventHash));
  });

  it("produces identical strategy-version and evidence hashes across two independent runs", () => {
    const stateA = runFixtureSequence();
    const stateB = runFixtureSequence();

    const strategyA = stateA.strategyVersions[0];
    const strategyB = stateB.strategyVersions[0];
    if (strategyA === undefined || strategyB === undefined) {
      throw new Error("fixture strategy version is missing");
    }
    expect(hashStrategyVersion(strategyA.definition)).toBe(hashStrategyVersion(strategyB.definition));
    expect(strategyA.strategyDefinitionHash).toBe(strategyB.strategyDefinitionHash);

    const experimentA = stateA.experiments[0];
    const experimentB = stateB.experiments[0];
    if (experimentA === undefined || experimentB === undefined) {
      throw new Error("fixture experiment is missing");
    }
    expect(experimentA.status).toBe("VALIDATED");
    expect(experimentA.evidenceAttachments[0]?.evidenceHash).toBe(
      experimentB.evidenceAttachments[0]?.evidenceHash,
    );
    expect(experimentA.evidenceAttachments[0]?.promotionDecisionHash).toBe(
      experimentB.evidenceAttachments[0]?.promotionDecisionHash,
    );
    expect(canonicalStringify(experimentA)).toBe(canonicalStringify(experimentB));
  });

  it("running the same sequence three times in a row never drifts", () => {
    const runs = [runFixtureSequence(), runFixtureSequence(), runFixtureSequence()];
    const canonicalExports = runs.map((state) => canonicalStringify(exportCanonicalLedger(state)));
    expect(new Set(canonicalExports).size).toBe(1);
  });
});
