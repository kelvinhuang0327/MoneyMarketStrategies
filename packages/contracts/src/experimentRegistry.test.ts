import { describe, expect, it } from "vitest";

import {
  EVIDENCE_LEVELS,
  EXPERIMENT_LEDGER_EVENT_TYPES,
  EXPERIMENT_STATUSES,
  GENESIS_PREVIOUS_EVENT_HASH,
  PROMOTION_REVIEW_OUTCOMES,
} from "./experimentRegistry.js";

describe("experiment registry contracts", () => {
  it("fixes the exact V1 experiment status set", () => {
    expect(EXPERIMENT_STATUSES).toEqual([
      "IDEA",
      "READY",
      "RUNNING",
      "BLOCKED",
      "PARTIAL",
      "VALIDATED",
      "REJECTED",
      "DEFERRED",
    ]);
  });

  it("fixes the exact V1 evidence level set", () => {
    expect(EVIDENCE_LEVELS).toEqual(["VERIFIED", "INFERRED", "NEEDS_DATA", "UNVERIFIED"]);
  });

  it("fixes the exact V1 promotion review outcome set", () => {
    expect(PROMOTION_REVIEW_OUTCOMES).toEqual([
      "ACCEPTED_FOR_RESEARCH_VALIDATION",
      "NEEDS_MORE_DATA",
      "REJECTED",
    ]);
  });

  it("fixes the exact V1 ledger event type set", () => {
    expect(EXPERIMENT_LEDGER_EVENT_TYPES).toEqual([
      "STRATEGY_VERSION_REGISTERED",
      "EXPERIMENT_CREATED",
      "STATUS_TRANSITIONED",
      "RUN_EVIDENCE_ATTACHED",
      "PROMOTION_REVIEW_RECORDED",
    ]);
  });

  it("uses a 64-character all-zero genesis sentinel matching SHA-256 hex-digest length", () => {
    expect(GENESIS_PREVIOUS_EVENT_HASH).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(GENESIS_PREVIOUS_EVENT_HASH).toHaveLength(64);
    expect(GENESIS_PREVIOUS_EVENT_HASH).toMatch(/^0+$/);
  });
});
