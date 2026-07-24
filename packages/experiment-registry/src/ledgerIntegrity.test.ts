import type { DatasetVersion, ExperimentLedger, ExperimentLedgerEvent } from "@mms/contracts";
import { describe, expect, it } from "vitest";

import {
  createExperiment,
  createExperimentRegistry,
  exportCanonicalLedger,
  registerStrategyVersion,
  transitionExperiment,
  verifyLedgerIntegrity,
} from "./experimentRegistry.js";

const FIXTURE_DATASET_VERSION: DatasetVersion = {
  datasetId: "synthetic-cycle",
  version: "v1",
  source: "test-owned/in-memory",
};

const STRATEGY_ID = "mean-reversion";
const STRATEGY_VERSION = "1.0.0";

function buildGenuineLedger(): ExperimentLedger {
  let state = registerStrategyVersion(createExperimentRegistry(), {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    description: "Diagnostic mean-reversion baseline",
    parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    logicalTime: "t0",
  });
  state = createExperiment(state, {
    experimentId: "exp-ledger",
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    hypothesis: "Reverting to the 20-day mean predicts next-day direction.",
    requiredData: FIXTURE_DATASET_VERSION,
    successCriteria: ["final-test accuracy exceeds its majority baseline"],
    logicalTime: "t1",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-ledger",
    toStatus: "READY",
    reason: "ready",
    logicalTime: "t2",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-ledger",
    toStatus: "RUNNING",
    reason: "start",
    logicalTime: "t3",
  });
  state = transitionExperiment(state, {
    experimentId: "exp-ledger",
    toStatus: "PARTIAL",
    reason: "partial results",
    logicalTime: "t4",
  });
  return exportCanonicalLedger(state);
}

function withReplacedEvent(
  ledger: ExperimentLedger,
  index: number,
  patch: Partial<ExperimentLedgerEvent>,
): ExperimentLedger {
  const target = ledger[index];
  if (target === undefined) throw new Error("fixture ledger index is missing");
  const copy = ledger.slice();
  copy[index] = { ...target, ...patch };
  return copy;
}

describe("verifyLedgerIntegrity", () => {
  it("accepts a genuine, untampered ledger with no findings", () => {
    const ledger = buildGenuineLedger();
    const result = verifyLedgerIntegrity(ledger);
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.verifiedEventCount).toBe(ledger.length);
    expect(ledger.length).toBeGreaterThanOrEqual(5);
  });

  it("detects payload mutation", () => {
    const ledger = buildGenuineLedger();
    const target = ledger[2];
    if (target === undefined) throw new Error("fixture ledger index is missing");
    const tampered = withReplacedEvent(ledger, 2, {
      payload: { ...(target.payload as Record<string, unknown>), reason: "tampered reason" },
    });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "EVENT_HASH_MISMATCH")).toBe(true);
  });

  it("detects sequence mutation", () => {
    const ledger = buildGenuineLedger();
    const tampered = withReplacedEvent(ledger, 2, { sequence: 99 });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "SEQUENCE_MISMATCH")).toBe(true);
  });

  it("detects a sequence gap from event deletion", () => {
    const ledger = buildGenuineLedger();
    const withoutMiddleEvent = ledger.filter((_, index) => index !== 2);
    const result = verifyLedgerIntegrity(withoutMiddleEvent);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.code === "SEQUENCE_MISMATCH" || finding.code === "PREVIOUS_HASH_MISMATCH",
      ),
    ).toBe(true);
  });

  it("detects event insertion", () => {
    const ledger = buildGenuineLedger();
    const foreignEvent = ledger[0];
    if (foreignEvent === undefined) throw new Error("fixture ledger index is missing");
    const withInsertedEvent = [
      ...ledger.slice(0, 2),
      { ...foreignEvent, sequence: 2 },
      ...ledger.slice(2),
    ];
    const result = verifyLedgerIntegrity(withInsertedEvent);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.code === "SEQUENCE_MISMATCH" || finding.code === "PREVIOUS_HASH_MISMATCH",
      ),
    ).toBe(true);
  });

  it("detects event duplication", () => {
    const ledger = buildGenuineLedger();
    const duplicated = [...ledger.slice(0, 3), ledger[2], ...ledger.slice(3)] as ExperimentLedger;
    const result = verifyLedgerIntegrity(duplicated);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.code === "SEQUENCE_MISMATCH" || finding.code === "PREVIOUS_HASH_MISMATCH",
      ),
    ).toBe(true);
  });

  it("detects event reordering", () => {
    const ledger = buildGenuineLedger();
    const reordered = ledger.slice();
    const eventAtTwo = reordered[2];
    const eventAtThree = reordered[3];
    if (eventAtTwo === undefined || eventAtThree === undefined) {
      throw new Error("fixture ledger index is missing");
    }
    reordered[2] = eventAtThree;
    reordered[3] = eventAtTwo;
    const result = verifyLedgerIntegrity(reordered);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.code === "SEQUENCE_MISMATCH" || finding.code === "PREVIOUS_HASH_MISMATCH",
      ),
    ).toBe(true);
  });

  it("detects logical-time mutation", () => {
    const ledger = buildGenuineLedger();
    const tampered = withReplacedEvent(ledger, 1, { logicalTime: "tampered-time" });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "EVENT_HASH_MISMATCH")).toBe(true);
  });

  it("detects previous-hash mutation", () => {
    const ledger = buildGenuineLedger();
    const tampered = withReplacedEvent(ledger, 2, { previousEventHash: "f".repeat(64) });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "PREVIOUS_HASH_MISMATCH")).toBe(true);
  });

  it("detects event-hash mutation", () => {
    const ledger = buildGenuineLedger();
    const tampered = withReplacedEvent(ledger, 1, { eventHash: "0".repeat(64) });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "EVENT_HASH_MISMATCH")).toBe(true);
  });

  it("detects an incorrect event identity", () => {
    const ledger = buildGenuineLedger();
    const tampered = withReplacedEvent(ledger, 1, { identity: "a-different-experiment" });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "EVENT_HASH_MISMATCH")).toBe(true);
  });

  it("detects invalid genesis sentinel use on a non-first event", () => {
    const ledger = buildGenuineLedger();
    const genesisEvent = ledger[0];
    if (genesisEvent === undefined) throw new Error("fixture ledger index is missing");
    const tampered = withReplacedEvent(ledger, 1, { previousEventHash: genesisEvent.previousEventHash });
    const result = verifyLedgerIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === "NON_GENESIS_SENTINEL_USE")).toBe(true);
  });
});
