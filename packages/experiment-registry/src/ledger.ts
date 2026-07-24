import { hashValue } from "@mms/research-kernel";
import {
  GENESIS_PREVIOUS_EVENT_HASH,
  type ExperimentLedger,
  type ExperimentLedgerEvent,
  type ExperimentLedgerEventType,
  type LedgerIntegrityFinding,
  type LedgerIntegrityResult,
} from "@mms/contracts";

import { deepFreezeClone } from "./types.js";

export function hashLedgerEvent(
  fields: Pick<
    ExperimentLedgerEvent,
    "sequence" | "identity" | "eventType" | "payload" | "logicalTime" | "previousEventHash"
  >,
): string {
  return hashValue({
    sequence: fields.sequence,
    identity: fields.identity,
    eventType: fields.eventType,
    payload: fields.payload,
    logicalTime: fields.logicalTime,
    previousEventHash: fields.previousEventHash,
  });
}

export function appendLedgerEvent(
  ledger: ExperimentLedger,
  next: {
    readonly identity: string;
    readonly eventType: ExperimentLedgerEventType;
    readonly payload: unknown;
    readonly logicalTime: string;
  },
): { readonly ledger: ExperimentLedger; readonly event: ExperimentLedgerEvent } {
  const previousEvent = ledger[ledger.length - 1];
  const sequence = ledger.length;
  const previousEventHash = previousEvent === undefined
    ? GENESIS_PREVIOUS_EVENT_HASH
    : previousEvent.eventHash;
  // Deep-clone-and-freeze so a caller's later mutation of a payload object it
  // still holds a reference to (e.g. a `blocker`) can never reach the ledger.
  const payload = deepFreezeClone(next.payload);
  const eventHash = hashLedgerEvent({
    sequence,
    identity: next.identity,
    eventType: next.eventType,
    payload,
    logicalTime: next.logicalTime,
    previousEventHash,
  });
  const event: ExperimentLedgerEvent = Object.freeze({
    sequence,
    identity: next.identity,
    eventType: next.eventType,
    payload,
    logicalTime: next.logicalTime,
    previousEventHash,
    eventHash,
  });
  return { ledger: Object.freeze([...ledger, event]), event };
}

function finding(code: string, message: string, sequence: number | null): LedgerIntegrityFinding {
  return { code, message, sequence };
}

export function verifyLedgerIntegrity(ledger: ExperimentLedger): LedgerIntegrityResult {
  const findings: LedgerIntegrityFinding[] = [];
  let expectedPreviousHash = GENESIS_PREVIOUS_EVENT_HASH;
  let verifiedEventCount = 0;

  for (const [index, event] of ledger.entries()) {
    if (event.sequence !== index) {
      findings.push(
        finding(
          "SEQUENCE_MISMATCH",
          `event at ledger position ${index} declares sequence ${event.sequence}; expected ${index} (gap, duplication, or reordering)`,
          event.sequence,
        ),
      );
    }

    if (event.previousEventHash !== expectedPreviousHash) {
      findings.push(
        finding(
          "PREVIOUS_HASH_MISMATCH",
          `event at ledger position ${index} declares previousEventHash "${event.previousEventHash}"; expected "${expectedPreviousHash}" (deletion, insertion, reordering, or previous-hash mutation)`,
          event.sequence,
        ),
      );
    }

    if (index > 0 && event.previousEventHash === GENESIS_PREVIOUS_EVENT_HASH) {
      findings.push(
        finding(
          "NON_GENESIS_SENTINEL_USE",
          `event at ledger position ${index} uses the genesis sentinel as previousEventHash but is not the first event`,
          event.sequence,
        ),
      );
    }

    const recomputedEventHash = hashLedgerEvent({
      sequence: event.sequence,
      identity: event.identity,
      eventType: event.eventType,
      payload: event.payload,
      logicalTime: event.logicalTime,
      previousEventHash: event.previousEventHash,
    });
    if (recomputedEventHash !== event.eventHash) {
      findings.push(
        finding(
          "EVENT_HASH_MISMATCH",
          `event at ledger position ${index} declares eventHash "${event.eventHash}"; recomputed "${recomputedEventHash}" (payload, sequence, logicalTime, identity, eventType, or eventHash mutation)`,
          event.sequence,
        ),
      );
    } else {
      verifiedEventCount += 1;
    }

    expectedPreviousHash = event.eventHash;
  }

  return Object.freeze({
    valid: findings.length === 0,
    findings: Object.freeze(findings),
    verifiedEventCount,
  });
}
