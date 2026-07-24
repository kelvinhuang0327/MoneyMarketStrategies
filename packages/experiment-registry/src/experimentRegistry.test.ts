import { decidePromotion, hashValue, runResearchEvidenceKernel } from "@mms/research-kernel";
import type { DatasetVersion, MarketDataRow, PromotionDecision } from "@mms/contracts";
import { describe, expect, it } from "vitest";

import {
  attachRunEvidence,
  createExperiment,
  createExperimentRegistry,
  exportCanonicalLedger,
  getExperimentSnapshot,
  hashStrategyVersion,
  rebuildExperimentSnapshot,
  recordPromotionReview,
  registerStrategyVersion,
  transitionExperiment,
  verifyLedgerIntegrity,
} from "./experimentRegistry.js";
import { ExperimentRegistryError } from "./types.js";

const FIXTURE_DATASET_VERSION: DatasetVersion = {
  datasetId: "synthetic-cycle",
  version: "v1",
  source: "test-owned/in-memory",
};

const OTHER_DATASET_VERSION: DatasetVersion = {
  datasetId: "other-dataset",
  version: "v1",
  source: "test-owned/in-memory",
};

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

function buildVerifiedEvidence() {
  return runResearchEvidenceKernel({
    datasetVersion: FIXTURE_DATASET_VERSION,
    marketRows: fixtureMarketRows(),
    logisticRegression: { iterations: 600, learningRate: 0.08, l2: 0.01 },
  });
}

function buildBlockedDataQualityEvidence() {
  const rows = fixtureMarketRows();
  const row = rows[70];
  if (row === undefined) throw new Error("fixture row is missing");
  rows[70] = { ...row, open: row.open * 2, high: row.high * 2, low: row.low * 2, close: row.close * 2 };
  return runResearchEvidenceKernel({
    datasetVersion: FIXTURE_DATASET_VERSION,
    marketRows: rows,
    logisticRegression: { iterations: 600, learningRate: 0.08, l2: 0.01 },
  });
}

const STRATEGY_ID = "mean-reversion";
const STRATEGY_VERSION = "1.0.0";

function registerFixtureStrategy(
  state: ReturnType<typeof createExperimentRegistry>,
  overrides: Partial<Parameters<typeof registerStrategyVersion>[1]> = {},
) {
  return registerStrategyVersion(state, {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    description: "Diagnostic mean-reversion baseline",
    parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    logicalTime: "t0",
    ...overrides,
  });
}

function createFixtureExperiment(
  state: ReturnType<typeof createExperimentRegistry>,
  experimentId: string,
  overrides: Partial<Parameters<typeof createExperiment>[1]> = {},
) {
  return createExperiment(state, {
    experimentId,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    hypothesis: "Reverting to the 20-day mean predicts next-day direction.",
    requiredData: FIXTURE_DATASET_VERSION,
    successCriteria: ["final-test accuracy exceeds its majority baseline"],
    logicalTime: "t1",
    ...overrides,
  });
}

function baseRegistry() {
  return registerFixtureStrategy(createExperimentRegistry());
}

function promoteThroughValidated(
  state: ReturnType<typeof createExperimentRegistry>,
  experimentId: string,
) {
  const { evidence, promotionDecision } = buildVerifiedEvidence();
  let next = attachRunEvidence(state, {
    experimentId,
    evidenceRunId: "run-1",
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    datasetVersion: FIXTURE_DATASET_VERSION,
    evidence,
    promotionDecision,
    requestedEvidenceLevel: "VERIFIED",
    logicalTime: "t-evidence",
  });
  next = recordPromotionReview(next, {
    experimentId,
    evidenceRunId: "run-1",
    outcome: "ACCEPTED_FOR_RESEARCH_VALIDATION",
    isDiagnosticResearchReviewOnly: true,
    reviewer: "research-lead",
    notes: "Diagnostic research review only; meets V1 promotion gates.",
    logicalTime: "t-review",
  });
  next = transitionExperiment(next, {
    experimentId,
    toStatus: "VALIDATED",
    reason: "all V1 diagnostic gates satisfied",
    logicalTime: "t-validated",
  });
  return next;
}

describe("hashStrategyVersion", () => {
  it("is stable for the same strategy version definition", () => {
    const definition = {
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      description: "Diagnostic mean-reversion baseline",
      parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    };
    expect(hashStrategyVersion(definition)).toBe(hashStrategyVersion({ ...definition }));
    expect(hashStrategyVersion(definition)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("registerStrategyVersion", () => {
  it("registers an immutable strategy version", () => {
    const state = baseRegistry();
    const registered = state.strategyVersions[0];
    expect(registered).toBeDefined();
    expect(registered?.strategyId).toBe(STRATEGY_ID);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered?.definition)).toBe(true);
    expect(() => {
      (registered as { strategyVersion: string }).strategyVersion = "9.9.9";
    }).toThrow();
  });

  it("is idempotent when the same strategy version is registered again with an identical definition", () => {
    const state = baseRegistry();
    const again = registerFixtureStrategy(state);
    expect(again.ledger.length).toBe(state.ledger.length);
    expect(again.strategyVersions.length).toBe(1);
  });

  it("rejects a duplicate strategy version registered with a different payload", () => {
    const state = baseRegistry();
    expect(() =>
      registerFixtureStrategy(state, { description: "A materially different strategy definition" }),
    ).toThrow(ExperimentRegistryError);
  });
});

describe("createExperiment", () => {
  it("creates an experiment with the explicit definition fields, starting IDEA/UNVERIFIED", () => {
    const state = createFixtureExperiment(baseRegistry(), "exp-create");
    const snapshot = getExperimentSnapshot(state, "exp-create");
    expect(snapshot.status).toBe("IDEA");
    expect(snapshot.evidenceLevel).toBe("UNVERIFIED");
    expect(snapshot.hypothesis).toBe("Reverting to the 20-day mean predicts next-day direction.");
    expect(snapshot.requiredData).toEqual(FIXTURE_DATASET_VERSION);
    expect(snapshot.successCriteria).toEqual(["final-test accuracy exceeds its majority baseline"]);
    expect(snapshot.blockers).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects an experiment referencing an unregistered strategy version", () => {
    expect(() =>
      createExperiment(createExperimentRegistry(), {
        experimentId: "exp-orphan",
        strategyId: "unknown-strategy",
        strategyVersion: "1.0.0",
        hypothesis: "n/a",
        requiredData: FIXTURE_DATASET_VERSION,
        successCriteria: [],
        logicalTime: "t1",
      }),
    ).toThrow(ExperimentRegistryError);
  });
});

describe("transitionExperiment - every allowed transition", () => {
  it("walks every one of the sixteen allowed transition edges without error", () => {
    const registered = baseRegistry();

    // exp-a: IDEA->READY->RUNNING->PARTIAL->RUNNING->BLOCKED->READY(resolved)->DEFERRED
    let stateA = createFixtureExperiment(registered, "exp-a");
    stateA = transitionExperiment(stateA, { experimentId: "exp-a", toStatus: "READY", reason: "ready", logicalTime: "a1" });
    stateA = transitionExperiment(stateA, { experimentId: "exp-a", toStatus: "RUNNING", reason: "start", logicalTime: "a2" });
    stateA = transitionExperiment(stateA, { experimentId: "exp-a", toStatus: "PARTIAL", reason: "partial results", logicalTime: "a3" });
    stateA = transitionExperiment(stateA, { experimentId: "exp-a", toStatus: "RUNNING", reason: "resume", logicalTime: "a4" });
    stateA = transitionExperiment(stateA, {
      experimentId: "exp-a",
      toStatus: "BLOCKED",
      reason: "missing data feed",
      logicalTime: "a5",
      blocker: { code: "DATA_FEED_DOWN", message: "upstream feed unavailable" },
    });
    stateA = transitionExperiment(stateA, {
      experimentId: "exp-a",
      toStatus: "READY",
      reason: "feed restored",
      logicalTime: "a6",
      blockerResolutionEvidence: "Upstream feed confirmed restored and backfilled 2026-01-02.",
    });
    stateA = transitionExperiment(stateA, { experimentId: "exp-a", toStatus: "DEFERRED", reason: "deprioritized", logicalTime: "a7" });
    const snapshotA = getExperimentSnapshot(stateA, "exp-a");
    expect(snapshotA.status).toBe("DEFERRED");
    expect(snapshotA.blockers).toHaveLength(1);
    expect(snapshotA.blockers[0]?.resolvedAtSequence).not.toBeNull();
    expect(snapshotA.blockers[0]?.resolutionEvidence).toBe(
      "Upstream feed confirmed restored and backfilled 2026-01-02.",
    );

    // exp-b: IDEA->READY->RUNNING->REJECTED
    let stateB = createFixtureExperiment(registered, "exp-b");
    stateB = transitionExperiment(stateB, { experimentId: "exp-b", toStatus: "READY", reason: "ready", logicalTime: "b1" });
    stateB = transitionExperiment(stateB, { experimentId: "exp-b", toStatus: "RUNNING", reason: "start", logicalTime: "b2" });
    stateB = transitionExperiment(stateB, { experimentId: "exp-b", toStatus: "REJECTED", reason: "hypothesis disproven", logicalTime: "b3" });
    expect(getExperimentSnapshot(stateB, "exp-b").status).toBe("REJECTED");

    // exp-c: IDEA->READY->RUNNING->PARTIAL->BLOCKED->REJECTED
    let stateC = createFixtureExperiment(registered, "exp-c");
    stateC = transitionExperiment(stateC, { experimentId: "exp-c", toStatus: "READY", reason: "ready", logicalTime: "c1" });
    stateC = transitionExperiment(stateC, { experimentId: "exp-c", toStatus: "RUNNING", reason: "start", logicalTime: "c2" });
    stateC = transitionExperiment(stateC, { experimentId: "exp-c", toStatus: "PARTIAL", reason: "partial results", logicalTime: "c3" });
    stateC = transitionExperiment(stateC, {
      experimentId: "exp-c",
      toStatus: "BLOCKED",
      reason: "dataset retracted",
      logicalTime: "c4",
      blocker: { code: "DATASET_RETRACTED", message: "vendor retracted the dataset" },
    });
    stateC = transitionExperiment(stateC, { experimentId: "exp-c", toStatus: "REJECTED", reason: "cannot recover dataset", logicalTime: "c5" });
    expect(getExperimentSnapshot(stateC, "exp-c").status).toBe("REJECTED");

    // exp-d: IDEA->READY->RUNNING->PARTIAL->DEFERRED
    let stateD = createFixtureExperiment(registered, "exp-d");
    stateD = transitionExperiment(stateD, { experimentId: "exp-d", toStatus: "READY", reason: "ready", logicalTime: "d1" });
    stateD = transitionExperiment(stateD, { experimentId: "exp-d", toStatus: "RUNNING", reason: "start", logicalTime: "d2" });
    stateD = transitionExperiment(stateD, { experimentId: "exp-d", toStatus: "PARTIAL", reason: "partial results", logicalTime: "d3" });
    stateD = transitionExperiment(stateD, { experimentId: "exp-d", toStatus: "DEFERRED", reason: "deprioritized", logicalTime: "d4" });
    expect(getExperimentSnapshot(stateD, "exp-d").status).toBe("DEFERRED");

    // exp-e: IDEA->READY->RUNNING->PARTIAL->REJECTED
    let stateE = createFixtureExperiment(registered, "exp-e");
    stateE = transitionExperiment(stateE, { experimentId: "exp-e", toStatus: "READY", reason: "ready", logicalTime: "e1" });
    stateE = transitionExperiment(stateE, { experimentId: "exp-e", toStatus: "RUNNING", reason: "start", logicalTime: "e2" });
    stateE = transitionExperiment(stateE, { experimentId: "exp-e", toStatus: "PARTIAL", reason: "partial results", logicalTime: "e3" });
    stateE = transitionExperiment(stateE, { experimentId: "exp-e", toStatus: "REJECTED", reason: "hypothesis disproven", logicalTime: "e4" });
    expect(getExperimentSnapshot(stateE, "exp-e").status).toBe("REJECTED");

    // exp-f: IDEA->READY->REJECTED
    let stateF = createFixtureExperiment(registered, "exp-f");
    stateF = transitionExperiment(stateF, { experimentId: "exp-f", toStatus: "READY", reason: "ready", logicalTime: "f1" });
    stateF = transitionExperiment(stateF, { experimentId: "exp-f", toStatus: "REJECTED", reason: "deprioritized before start", logicalTime: "f2" });
    expect(getExperimentSnapshot(stateF, "exp-f").status).toBe("REJECTED");

    // exp-g: IDEA->READY->RUNNING->DEFERRED
    let stateG = createFixtureExperiment(registered, "exp-g");
    stateG = transitionExperiment(stateG, { experimentId: "exp-g", toStatus: "READY", reason: "ready", logicalTime: "g1" });
    stateG = transitionExperiment(stateG, { experimentId: "exp-g", toStatus: "RUNNING", reason: "start", logicalTime: "g2" });
    stateG = transitionExperiment(stateG, { experimentId: "exp-g", toStatus: "DEFERRED", reason: "deprioritized", logicalTime: "g3" });
    expect(getExperimentSnapshot(stateG, "exp-g").status).toBe("DEFERRED");

    // exp-h: IDEA->READY->RUNNING->VALIDATED
    let stateH = createFixtureExperiment(registered, "exp-h");
    stateH = transitionExperiment(stateH, { experimentId: "exp-h", toStatus: "READY", reason: "ready", logicalTime: "h1" });
    stateH = transitionExperiment(stateH, { experimentId: "exp-h", toStatus: "RUNNING", reason: "start", logicalTime: "h2" });
    stateH = promoteThroughValidated(stateH, "exp-h");
    expect(getExperimentSnapshot(stateH, "exp-h").status).toBe("VALIDATED");

    // exp-i: IDEA->READY->RUNNING->PARTIAL->VALIDATED
    let stateI = createFixtureExperiment(registered, "exp-i");
    stateI = transitionExperiment(stateI, { experimentId: "exp-i", toStatus: "READY", reason: "ready", logicalTime: "i1" });
    stateI = transitionExperiment(stateI, { experimentId: "exp-i", toStatus: "RUNNING", reason: "start", logicalTime: "i2" });
    stateI = transitionExperiment(stateI, { experimentId: "exp-i", toStatus: "PARTIAL", reason: "partial results", logicalTime: "i3" });
    stateI = promoteThroughValidated(stateI, "exp-i");
    expect(getExperimentSnapshot(stateI, "exp-i").status).toBe("VALIDATED");
  });
});

describe("transitionExperiment - negative coverage", () => {
  it("rejects an invalid transition (IDEA -> RUNNING)", () => {
    const state = createFixtureExperiment(baseRegistry(), "exp-invalid");
    expect(() =>
      transitionExperiment(state, { experimentId: "exp-invalid", toStatus: "RUNNING", reason: "skip ready", logicalTime: "x1" }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects any transition out of a terminal status", () => {
    let state = createFixtureExperiment(baseRegistry(), "exp-terminal");
    state = transitionExperiment(state, { experimentId: "exp-terminal", toStatus: "READY", reason: "ready", logicalTime: "t1" });
    state = transitionExperiment(state, { experimentId: "exp-terminal", toStatus: "REJECTED", reason: "disproven", logicalTime: "t2" });
    expect(() =>
      transitionExperiment(state, { experimentId: "exp-terminal", toStatus: "READY", reason: "reopen", logicalTime: "t3" }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects BLOCKED -> READY without explicit non-empty blocker-resolution evidence", () => {
    let state = createFixtureExperiment(baseRegistry(), "exp-blocked");
    state = transitionExperiment(state, { experimentId: "exp-blocked", toStatus: "READY", reason: "ready", logicalTime: "bk1" });
    state = transitionExperiment(state, { experimentId: "exp-blocked", toStatus: "RUNNING", reason: "start", logicalTime: "bk2" });
    state = transitionExperiment(state, {
      experimentId: "exp-blocked",
      toStatus: "BLOCKED",
      reason: "missing data",
      logicalTime: "bk3",
      blocker: { code: "MISSING_DATA", message: "upstream data missing" },
    });
    expect(() =>
      transitionExperiment(state, { experimentId: "exp-blocked", toStatus: "READY", reason: "resume without evidence", logicalTime: "bk4" }),
    ).toThrow(ExperimentRegistryError);
    expect(() =>
      transitionExperiment(state, {
        experimentId: "exp-blocked",
        toStatus: "READY",
        reason: "resume with blank evidence",
        logicalTime: "bk4b",
        blockerResolutionEvidence: "   ",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects VALIDATED before every gate is satisfied, then accepts it once they are", () => {
    let state = createFixtureExperiment(baseRegistry(), "exp-gates");
    state = transitionExperiment(state, { experimentId: "exp-gates", toStatus: "READY", reason: "ready", logicalTime: "v1" });
    state = transitionExperiment(state, { experimentId: "exp-gates", toStatus: "RUNNING", reason: "start", logicalTime: "v2" });

    expect(() =>
      transitionExperiment(state, { experimentId: "exp-gates", toStatus: "VALIDATED", reason: "premature", logicalTime: "v3" }),
    ).toThrow(ExperimentRegistryError);

    const { evidence, promotionDecision } = buildVerifiedEvidence();
    state = attachRunEvidence(state, {
      experimentId: "exp-gates",
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence,
      promotionDecision,
      requestedEvidenceLevel: "VERIFIED",
      logicalTime: "v4",
    });

    expect(() =>
      transitionExperiment(state, { experimentId: "exp-gates", toStatus: "VALIDATED", reason: "still missing review", logicalTime: "v5" }),
    ).toThrow(ExperimentRegistryError);

    state = recordPromotionReview(state, {
      experimentId: "exp-gates",
      evidenceRunId: "run-1",
      outcome: "ACCEPTED_FOR_RESEARCH_VALIDATION",
      isDiagnosticResearchReviewOnly: true,
      reviewer: "research-lead",
      notes: "Diagnostic research review only.",
      logicalTime: "v6",
    });

    state = transitionExperiment(state, { experimentId: "exp-gates", toStatus: "VALIDATED", reason: "all gates satisfied", logicalTime: "v7" });
    expect(getExperimentSnapshot(state, "exp-gates").status).toBe("VALIDATED");
  });
});

describe("attachRunEvidence", () => {
  function readyRunningExperiment(experimentId: string, requiredData: DatasetVersion = FIXTURE_DATASET_VERSION) {
    let state = createFixtureExperiment(baseRegistry(), experimentId, { requiredData });
    state = transitionExperiment(state, { experimentId, toStatus: "READY", reason: "ready", logicalTime: "r1" });
    state = transitionExperiment(state, { experimentId, toStatus: "RUNNING", reason: "start", logicalTime: "r2" });
    return state;
  }

  it("attaches matching evidence, storing verified hashes and a deterministic re-derived promotion decision", () => {
    const experimentId = "exp-attach";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();

    const attached = attachRunEvidence(state, {
      experimentId,
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence,
      promotionDecision,
      requestedEvidenceLevel: "VERIFIED",
      logicalTime: "attach-1",
    });

    const snapshot = getExperimentSnapshot(attached, experimentId);
    expect(snapshot.evidenceAttachments).toHaveLength(1);
    const stored = snapshot.evidenceAttachments[0];
    expect(stored?.evidenceLevel).toBe("VERIFIED");
    expect(stored?.evidenceHash).toBe(evidence.normalizedEvidenceSha256);
    expect(stored?.promotionDecisionHash).toBe(hashValue(decidePromotion(evidence)));
    expect(snapshot.evidenceLevel).toBe("VERIFIED");

    // idempotent re-attachment with the identical payload is a no-op
    const reattached = attachRunEvidence(attached, {
      experimentId,
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence,
      promotionDecision,
      requestedEvidenceLevel: "VERIFIED",
      logicalTime: "attach-1-again",
    });
    expect(reattached.ledger.length).toBe(attached.ledger.length);
    expect(getExperimentSnapshot(reattached, experimentId).evidenceAttachments).toHaveLength(1);
  });

  it("rejects a strategy linkage mismatch", () => {
    const experimentId = "exp-strategy-mismatch";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: "a-different-strategy",
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "sm1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects a dataset linkage mismatch against the experiment definition", () => {
    const experimentId = "exp-dataset-mismatch";
    const state = readyRunningExperiment(experimentId, OTHER_DATASET_VERSION);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "dm1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects an evidence hash mismatch", () => {
    const experimentId = "exp-evidence-hash-mismatch";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    const tamperedEvidence = { ...evidence, normalizedEvidenceSha256: "0".repeat(64) };
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence: tamperedEvidence,
        promotionDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "eh1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects a promotion decision that does not match a fresh re-derivation", () => {
    const experimentId = "exp-promotion-mismatch";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    const forgedDecision: PromotionDecision = { ...promotionDecision, reasons: ["forged reason"] };
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision: forgedDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "pm1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects a promotion decision asserting automaticPromotion true", () => {
    const experimentId = "exp-auto-promotion";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    const forgedDecision = { ...promotionDecision, automaticPromotion: true } as unknown as PromotionDecision;
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision: forgedDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "ap1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects a promotion decision asserting manualApprovalRequired false", () => {
    const experimentId = "exp-manual-approval";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    const forgedDecision = { ...promotionDecision, manualApprovalRequired: false } as unknown as PromotionDecision;
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision: forgedDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "mr1",
      }),
    ).toThrow(ExperimentRegistryError);
  });

  it("rejects elevating data-quality-blocked evidence to VERIFIED", () => {
    const experimentId = "exp-data-quality-blocked";
    const state = readyRunningExperiment(experimentId);
    const { evidence, promotionDecision } = buildBlockedDataQualityEvidence();
    expect(promotionDecision.status).toBe("BLOCKED_DATA_QUALITY");
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence,
        promotionDecision,
        requestedEvidenceLevel: "VERIFIED",
        logicalTime: "dq1",
      }),
    ).toThrow(ExperimentRegistryError);

    // NEEDS_DATA remains attachable for the same blocked evidence
    const attached = attachRunEvidence(state, {
      experimentId,
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence,
      promotionDecision,
      requestedEvidenceLevel: "NEEDS_DATA",
      logicalTime: "dq2",
    });
    expect(getExperimentSnapshot(attached, experimentId).evidenceAttachments[0]?.evidenceLevel).toBe("NEEDS_DATA");
  });

  it("rejects re-attaching the same evidenceRunId with a different payload", () => {
    const experimentId = "exp-duplicate-identity";
    let state = readyRunningExperiment(experimentId);
    const verified = buildVerifiedEvidence();
    state = attachRunEvidence(state, {
      experimentId,
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence: verified.evidence,
      promotionDecision: verified.promotionDecision,
      requestedEvidenceLevel: "VERIFIED",
      logicalTime: "dup1",
    });

    const blocked = buildBlockedDataQualityEvidence();
    expect(() =>
      attachRunEvidence(state, {
        experimentId,
        evidenceRunId: "run-1",
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        datasetVersion: FIXTURE_DATASET_VERSION,
        evidence: blocked.evidence,
        promotionDecision: blocked.promotionDecision,
        requestedEvidenceLevel: "NEEDS_DATA",
        logicalTime: "dup2",
      }),
    ).toThrow(ExperimentRegistryError);
  });
});

describe("recordPromotionReview", () => {
  it("records a diagnostic-only research review referencing the attached evidence", () => {
    const experimentId = "exp-review";
    let state = createFixtureExperiment(baseRegistry(), experimentId);
    state = transitionExperiment(state, { experimentId, toStatus: "READY", reason: "ready", logicalTime: "rv1" });
    state = transitionExperiment(state, { experimentId, toStatus: "RUNNING", reason: "start", logicalTime: "rv2" });
    const { evidence, promotionDecision } = buildVerifiedEvidence();
    state = attachRunEvidence(state, {
      experimentId,
      evidenceRunId: "run-1",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      datasetVersion: FIXTURE_DATASET_VERSION,
      evidence,
      promotionDecision,
      requestedEvidenceLevel: "VERIFIED",
      logicalTime: "rv3",
    });
    state = recordPromotionReview(state, {
      experimentId,
      evidenceRunId: "run-1",
      outcome: "ACCEPTED_FOR_RESEARCH_VALIDATION",
      isDiagnosticResearchReviewOnly: true,
      reviewer: "research-lead",
      notes: "Diagnostic research review only; not a production promotion.",
      logicalTime: "rv4",
    });
    const review = getExperimentSnapshot(state, experimentId).promotionReviews[0];
    expect(review?.outcome).toBe("ACCEPTED_FOR_RESEARCH_VALIDATION");
    expect(review?.isDiagnosticResearchReviewOnly).toBe(true);
    expect(review?.evidenceHash).toBe(evidence.normalizedEvidenceSha256);
  });

  it("rejects recording a promotion review against an experiment in a terminal status", () => {
    const experimentId = "exp-review-terminal";
    let state = createFixtureExperiment(baseRegistry(), experimentId);
    state = transitionExperiment(state, { experimentId, toStatus: "READY", reason: "ready", logicalTime: "rt1" });
    state = transitionExperiment(state, { experimentId, toStatus: "REJECTED", reason: "disproven", logicalTime: "rt2" });
    expect(() =>
      recordPromotionReview(state, {
        experimentId,
        evidenceRunId: "run-1",
        outcome: "ACCEPTED_FOR_RESEARCH_VALIDATION",
        isDiagnosticResearchReviewOnly: true,
        reviewer: "research-lead",
        notes: "attempted after terminal status",
        logicalTime: "rt3",
      }),
    ).toThrow(ExperimentRegistryError);
  });
});

describe("exportCanonicalLedger and rebuildExperimentSnapshot", () => {
  it("exports a canonical ledger and rebuilds an identical snapshot purely from it", () => {
    const experimentId = "exp-rebuild";
    let state = createFixtureExperiment(baseRegistry(), experimentId);
    state = transitionExperiment(state, { experimentId, toStatus: "READY", reason: "ready", logicalTime: "rb1" });
    state = transitionExperiment(state, { experimentId, toStatus: "RUNNING", reason: "start", logicalTime: "rb2" });
    state = promoteThroughValidated(state, experimentId);

    const ledger = exportCanonicalLedger(state);
    expect(ledger).toBe(state.ledger);

    const live = getExperimentSnapshot(state, experimentId);
    const rebuilt = rebuildExperimentSnapshot(ledger, experimentId);
    expect(rebuilt).toEqual(live);
  });
});

describe("input immutability", () => {
  it("does not let a caller's later mutation of their input reach stored state", () => {
    const mutableParameters: Record<string, string | number | boolean> = { lookbackDays: 20 };
    let state = registerStrategyVersion(createExperimentRegistry(), {
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      description: "Diagnostic mean-reversion baseline",
      parameters: mutableParameters,
      logicalTime: "im1",
    });
    mutableParameters.lookbackDays = 999;
    expect(state.strategyVersions[0]?.definition.parameters.lookbackDays).toBe(20);

    const mutableRequiredData: DatasetVersion = { ...FIXTURE_DATASET_VERSION };
    state = createExperiment(state, {
      experimentId: "exp-immutable",
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      hypothesis: "n/a",
      requiredData: mutableRequiredData,
      successCriteria: [],
      logicalTime: "im2",
    });
    mutableRequiredData.datasetId = "tampered-after-the-fact";
    expect(getExperimentSnapshot(state, "exp-immutable").requiredData.datasetId).toBe(
      FIXTURE_DATASET_VERSION.datasetId,
    );
  });

  it("does not let a caller's later mutation of a blocker object reach the stored ledger event", () => {
    const experimentId = "exp-immutable-blocker";
    let state = createFixtureExperiment(baseRegistry(), experimentId);
    state = transitionExperiment(state, { experimentId, toStatus: "READY", reason: "ready", logicalTime: "ib1" });
    state = transitionExperiment(state, { experimentId, toStatus: "RUNNING", reason: "start", logicalTime: "ib2" });

    const mutableBlocker = { code: "DATA_FEED_DOWN", message: "upstream feed unavailable" };
    state = transitionExperiment(state, {
      experimentId,
      toStatus: "BLOCKED",
      reason: "missing data feed",
      logicalTime: "ib3",
      blocker: mutableBlocker,
    });
    mutableBlocker.code = "TAMPERED";
    mutableBlocker.message = "tampered after the fact";

    const snapshot = getExperimentSnapshot(state, experimentId);
    expect(snapshot.blockers[0]?.code).toBe("DATA_FEED_DOWN");
    expect(snapshot.blockers[0]?.message).toBe("upstream feed unavailable");

    const ledgerEvent = exportCanonicalLedger(state).at(-1);
    expect(Object.isFrozen(ledgerEvent?.payload)).toBe(true);
    expect(verifyLedgerIntegrity(exportCanonicalLedger(state)).valid).toBe(true);
  });
});
