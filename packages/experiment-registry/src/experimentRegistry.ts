import { decidePromotion, hashValue } from "@mms/research-kernel";
import type {
  EvidenceAttachment,
  EvidenceLevel,
  ExperimentLedger,
  ExperimentLedgerEvent,
  ExperimentRegistryState,
  ExperimentSnapshot,
  PromotionReviewRecord,
  RegisteredStrategyVersion,
  StrategyVersionDefinition,
} from "@mms/contracts";

import { buildEvidenceAttachment } from "./evidenceAttachment.js";
import { appendLedgerEvent } from "./ledger.js";
import {
  isTerminalStatus,
  isValidTransition,
  requiresBlockerResolution,
  requiresValidatedGates,
} from "./stateMachine.js";
import {
  deepFreezeClone,
  fail,
  type AttachRunEvidenceInput,
  type CreateExperimentInput,
  type ExperimentCreatedPayload,
  type RecordPromotionReviewInput,
  type RegisterStrategyVersionInput,
  type StatusTransitionedPayload,
  type TransitionExperimentInput,
} from "./types.js";

export { hashLedgerEvent, verifyLedgerIntegrity } from "./ledger.js";

const EVIDENCE_LEVEL_RANK: Readonly<Record<EvidenceLevel, number>> = Object.freeze({
  UNVERIFIED: 0,
  NEEDS_DATA: 1,
  INFERRED: 2,
  VERIFIED: 3,
});

function deriveEvidenceLevel(attachments: readonly EvidenceAttachment[]): EvidenceLevel {
  let best: EvidenceLevel = "UNVERIFIED";
  for (const attachment of attachments) {
    if (EVIDENCE_LEVEL_RANK[attachment.evidenceLevel] > EVIDENCE_LEVEL_RANK[best]) {
      best = attachment.evidenceLevel;
    }
  }
  return best;
}

export function applyExperimentEvent(
  snapshot: ExperimentSnapshot | undefined,
  event: ExperimentLedgerEvent,
): ExperimentSnapshot {
  switch (event.eventType) {
    case "EXPERIMENT_CREATED": {
      const payload = event.payload as ExperimentCreatedPayload;
      const created: ExperimentSnapshot = {
        experimentId: payload.experimentId,
        strategyId: payload.strategyId,
        strategyVersion: payload.strategyVersion,
        hypothesis: payload.hypothesis,
        requiredData: payload.requiredData,
        successCriteria: payload.successCriteria,
        status: "IDEA",
        evidenceLevel: "UNVERIFIED",
        blockers: Object.freeze([]),
        evidenceAttachments: Object.freeze([]),
        promotionReviews: Object.freeze([]),
        statusHistory: Object.freeze([
          { status: "IDEA", reason: "experiment created", sequence: event.sequence, logicalTime: event.logicalTime },
        ]),
        createdAtSequence: event.sequence,
        lastSequence: event.sequence,
      };
      return Object.freeze(created);
    }
    case "STATUS_TRANSITIONED": {
      if (snapshot === undefined) fail("STATUS_TRANSITIONED event applied before EXPERIMENT_CREATED");
      const payload = event.payload as StatusTransitionedPayload;
      let blockers = snapshot.blockers;
      if (payload.toStatus === "BLOCKED" && payload.blocker !== null) {
        const blocker = payload.blocker;
        blockers = Object.freeze([
          ...blockers,
          Object.freeze({
            code: blocker.code,
            message: blocker.message,
            raisedAtSequence: event.sequence,
            resolvedAtSequence: null,
            resolutionEvidence: null,
          }),
        ]);
      }
      if (payload.fromStatus === "BLOCKED" && payload.toStatus === "READY") {
        blockers = Object.freeze(
          blockers.map((blocker) =>
            blocker.resolvedAtSequence === null
              ? Object.freeze({
                  ...blocker,
                  resolvedAtSequence: event.sequence,
                  resolutionEvidence: payload.blockerResolutionEvidence,
                })
              : blocker,
          ),
        );
      }
      return Object.freeze({
        ...snapshot,
        status: payload.toStatus,
        blockers,
        statusHistory: Object.freeze([
          ...snapshot.statusHistory,
          Object.freeze({
            status: payload.toStatus,
            reason: payload.reason,
            sequence: event.sequence,
            logicalTime: event.logicalTime,
          }),
        ]),
        lastSequence: event.sequence,
      });
    }
    case "RUN_EVIDENCE_ATTACHED": {
      if (snapshot === undefined) fail("RUN_EVIDENCE_ATTACHED event applied before EXPERIMENT_CREATED");
      const attachment = event.payload as EvidenceAttachment;
      const evidenceAttachments = Object.freeze([...snapshot.evidenceAttachments, attachment]);
      return Object.freeze({
        ...snapshot,
        evidenceAttachments,
        evidenceLevel: deriveEvidenceLevel(evidenceAttachments),
        lastSequence: event.sequence,
      });
    }
    case "PROMOTION_REVIEW_RECORDED": {
      if (snapshot === undefined) fail("PROMOTION_REVIEW_RECORDED event applied before EXPERIMENT_CREATED");
      const review = event.payload as PromotionReviewRecord;
      return Object.freeze({
        ...snapshot,
        promotionReviews: Object.freeze([...snapshot.promotionReviews, review]),
        lastSequence: event.sequence,
      });
    }
    case "STRATEGY_VERSION_REGISTERED":
      return fail("STRATEGY_VERSION_REGISTERED is not an experiment-scoped ledger event");
  }
}

function requireSnapshot(state: ExperimentRegistryState, experimentId: string): ExperimentSnapshot {
  const snapshot = state.experiments.find((experiment) => experiment.experimentId === experimentId);
  if (snapshot === undefined) fail(`unknown experiment "${experimentId}"`);
  return snapshot;
}

function replaceExperiment(
  experiments: readonly ExperimentSnapshot[],
  updated: ExperimentSnapshot,
): readonly ExperimentSnapshot[] {
  return Object.freeze(
    experiments.map((experiment) => (experiment.experimentId === updated.experimentId ? updated : experiment)),
  );
}

function runValidatedGates(snapshot: ExperimentSnapshot): void {
  const unresolvedBlocker = snapshot.blockers.find((blocker) => blocker.resolvedAtSequence === null);
  if (unresolvedBlocker !== undefined) {
    fail(`cannot transition to VALIDATED: unresolved blocker "${unresolvedBlocker.code}" remains`);
  }

  const verifiedAttachments = snapshot.evidenceAttachments.filter(
    (attachment) => attachment.evidenceLevel === "VERIFIED",
  );
  if (verifiedAttachments.length === 0) {
    fail("cannot transition to VALIDATED: no evidence attachment at level VERIFIED exists");
  }

  const qualifies = verifiedAttachments.some((attachment) => {
    if (attachment.strategyId !== snapshot.strategyId || attachment.strategyVersion !== snapshot.strategyVersion) {
      return false;
    }
    if (hashValue(attachment.datasetVersion) !== hashValue(snapshot.requiredData)) return false;

    const { normalizedEvidenceSha256, ...withoutSelfHash } = attachment.evidence;
    if (hashValue(withoutSelfHash) !== normalizedEvidenceSha256) return false;
    if (attachment.evidenceHash !== normalizedEvidenceSha256) return false;

    if (attachment.promotionDecision.automaticPromotion !== false) return false;
    if (attachment.promotionDecision.manualApprovalRequired !== true) return false;
    if (attachment.promotionDecision.status !== "RESEARCH_CANDIDATE") return false;

    const rederived = decidePromotion(attachment.evidence);
    if (hashValue(rederived) !== attachment.promotionDecisionHash) return false;
    if (attachment.promotionDecisionHash !== hashValue(attachment.promotionDecision)) return false;

    const acceptedReview = snapshot.promotionReviews.find(
      (review) =>
        review.evidenceRunId === attachment.evidenceRunId
        && review.outcome === "ACCEPTED_FOR_RESEARCH_VALIDATION"
        && review.isDiagnosticResearchReviewOnly === true,
    );
    return acceptedReview !== undefined;
  });

  if (!qualifies) {
    fail(
      "cannot transition to VALIDATED: no VERIFIED evidence attachment satisfies every promotion gate together with a matching ACCEPTED_FOR_RESEARCH_VALIDATION diagnostic review",
    );
  }
}

export function createExperimentRegistry(): ExperimentRegistryState {
  return Object.freeze({
    strategyVersions: Object.freeze([]),
    experiments: Object.freeze([]),
    ledger: Object.freeze([]),
  });
}

export function hashStrategyVersion(definition: StrategyVersionDefinition): string {
  return hashValue(definition);
}

export function registerStrategyVersion(
  state: ExperimentRegistryState,
  input: RegisterStrategyVersionInput,
): ExperimentRegistryState {
  const definition: StrategyVersionDefinition = deepFreezeClone({
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    description: input.description,
    parameters: input.parameters,
  });
  const strategyDefinitionHash = hashStrategyVersion(definition);

  const existing = state.strategyVersions.find(
    (registered) =>
      registered.strategyId === input.strategyId && registered.strategyVersion === input.strategyVersion,
  );
  if (existing !== undefined) {
    if (existing.strategyDefinitionHash === strategyDefinitionHash) {
      return state;
    }
    fail(
      `strategy version "${input.strategyId}@${input.strategyVersion}" is already registered with a different definition`,
    );
  }

  const { ledger, event } = appendLedgerEvent(state.ledger, {
    identity: input.strategyId,
    eventType: "STRATEGY_VERSION_REGISTERED",
    payload: { strategyId: input.strategyId, strategyVersion: input.strategyVersion, strategyDefinitionHash, definition },
    logicalTime: input.logicalTime,
  });

  const registered: RegisteredStrategyVersion = Object.freeze({
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    strategyDefinitionHash,
    definition,
    sequence: event.sequence,
    logicalTime: input.logicalTime,
  });

  return Object.freeze({
    strategyVersions: Object.freeze([...state.strategyVersions, registered]),
    experiments: state.experiments,
    ledger,
  });
}

export function createExperiment(
  state: ExperimentRegistryState,
  input: CreateExperimentInput,
): ExperimentRegistryState {
  if (state.experiments.some((experiment) => experiment.experimentId === input.experimentId)) {
    fail(`experiment "${input.experimentId}" already exists`);
  }
  const strategy = state.strategyVersions.find(
    (registered) =>
      registered.strategyId === input.strategyId && registered.strategyVersion === input.strategyVersion,
  );
  if (strategy === undefined) {
    fail(`experiment references unregistered strategy version "${input.strategyId}@${input.strategyVersion}"`);
  }

  const payload: ExperimentCreatedPayload = {
    experimentId: input.experimentId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    hypothesis: input.hypothesis,
    requiredData: deepFreezeClone(input.requiredData),
    successCriteria: deepFreezeClone(input.successCriteria),
  };

  const { ledger, event } = appendLedgerEvent(state.ledger, {
    identity: input.experimentId,
    eventType: "EXPERIMENT_CREATED",
    payload,
    logicalTime: input.logicalTime,
  });

  const snapshot = applyExperimentEvent(undefined, event);

  return Object.freeze({
    strategyVersions: state.strategyVersions,
    experiments: Object.freeze([...state.experiments, snapshot]),
    ledger,
  });
}

export function transitionExperiment(
  state: ExperimentRegistryState,
  input: TransitionExperimentInput,
): ExperimentRegistryState {
  const snapshot = requireSnapshot(state, input.experimentId);

  if (isTerminalStatus(snapshot.status)) {
    fail(`experiment "${input.experimentId}" is in terminal status ${snapshot.status} and cannot transition`);
  }
  if (!isValidTransition(snapshot.status, input.toStatus)) {
    fail(`invalid transition ${snapshot.status} -> ${input.toStatus} for experiment "${input.experimentId}"`);
  }
  if (requiresBlockerResolution(snapshot.status, input.toStatus)) {
    const resolutionEvidence = input.blockerResolutionEvidence;
    if (resolutionEvidence === undefined || resolutionEvidence.trim().length === 0) {
      fail("BLOCKED -> READY requires explicit non-empty blocker-resolution evidence");
    }
  }
  if (input.toStatus === "BLOCKED" && input.blocker === undefined) {
    fail("transitioning to BLOCKED requires a blocker code and message");
  }
  if (requiresValidatedGates(snapshot.status, input.toStatus)) {
    runValidatedGates(snapshot);
  }

  const payload: StatusTransitionedPayload = {
    experimentId: input.experimentId,
    fromStatus: snapshot.status,
    toStatus: input.toStatus,
    reason: input.reason,
    blocker: input.blocker ?? null,
    blockerResolutionEvidence: input.blockerResolutionEvidence ?? null,
  };

  const { ledger, event } = appendLedgerEvent(state.ledger, {
    identity: input.experimentId,
    eventType: "STATUS_TRANSITIONED",
    payload,
    logicalTime: input.logicalTime,
  });

  const updatedSnapshot = applyExperimentEvent(snapshot, event);

  return Object.freeze({
    strategyVersions: state.strategyVersions,
    experiments: replaceExperiment(state.experiments, updatedSnapshot),
    ledger,
  });
}

export function attachRunEvidence(
  state: ExperimentRegistryState,
  input: AttachRunEvidenceInput,
): ExperimentRegistryState {
  const snapshot = requireSnapshot(state, input.experimentId);
  if (isTerminalStatus(snapshot.status)) {
    fail(`experiment "${input.experimentId}" is in terminal status ${snapshot.status}; evidence can no longer be attached`);
  }

  const existingAttachment = snapshot.evidenceAttachments.find(
    (attachment) => attachment.evidenceRunId === input.evidenceRunId,
  );

  const built = buildEvidenceAttachment({
    input,
    expectedStrategyId: snapshot.strategyId,
    expectedStrategyVersion: snapshot.strategyVersion,
    expectedDatasetVersion: snapshot.requiredData,
    sequence: state.ledger.length,
    existingAttachment,
  });

  if (built.isNoOpDuplicate) {
    return state;
  }

  const { ledger, event } = appendLedgerEvent(state.ledger, {
    identity: input.experimentId,
    eventType: "RUN_EVIDENCE_ATTACHED",
    payload: built.attachment,
    logicalTime: input.logicalTime,
  });

  const updatedSnapshot = applyExperimentEvent(snapshot, event);

  return Object.freeze({
    strategyVersions: state.strategyVersions,
    experiments: replaceExperiment(state.experiments, updatedSnapshot),
    ledger,
  });
}

export function recordPromotionReview(
  state: ExperimentRegistryState,
  input: RecordPromotionReviewInput,
): ExperimentRegistryState {
  const snapshot = requireSnapshot(state, input.experimentId);
  if (isTerminalStatus(snapshot.status)) {
    fail(`experiment "${input.experimentId}" is in terminal status ${snapshot.status}; promotion reviews can no longer be recorded`);
  }
  const attachment = snapshot.evidenceAttachments.find(
    (candidate) => candidate.evidenceRunId === input.evidenceRunId,
  );
  if (attachment === undefined) {
    fail(`promotion review references unknown evidenceRunId "${input.evidenceRunId}" for experiment "${input.experimentId}"`);
  }
  if (input.isDiagnosticResearchReviewOnly !== true) {
    fail("promotion review must explicitly state it is diagnostic research review only");
  }

  const payload: PromotionReviewRecord = Object.freeze({
    experimentId: input.experimentId,
    evidenceRunId: input.evidenceRunId,
    evidenceHash: attachment.evidenceHash,
    outcome: input.outcome,
    isDiagnosticResearchReviewOnly: true,
    reviewer: input.reviewer,
    notes: input.notes,
    sequence: state.ledger.length,
    logicalTime: input.logicalTime,
  });

  const { ledger, event } = appendLedgerEvent(state.ledger, {
    identity: input.experimentId,
    eventType: "PROMOTION_REVIEW_RECORDED",
    payload,
    logicalTime: input.logicalTime,
  });

  const updatedSnapshot = applyExperimentEvent(snapshot, event);

  return Object.freeze({
    strategyVersions: state.strategyVersions,
    experiments: replaceExperiment(state.experiments, updatedSnapshot),
    ledger,
  });
}

export function getExperimentSnapshot(state: ExperimentRegistryState, experimentId: string): ExperimentSnapshot {
  return requireSnapshot(state, experimentId);
}

export function rebuildExperimentSnapshot(ledger: ExperimentLedger, experimentId: string): ExperimentSnapshot {
  const events = ledger.filter(
    (event) => event.eventType !== "STRATEGY_VERSION_REGISTERED" && event.identity === experimentId,
  );
  let snapshot: ExperimentSnapshot | undefined;
  for (const event of events) {
    snapshot = applyExperimentEvent(snapshot, event);
  }
  if (snapshot === undefined) fail(`no ledger events found for experiment "${experimentId}"`);
  return snapshot;
}

export function exportCanonicalLedger(state: ExperimentRegistryState): ExperimentLedger {
  return state.ledger;
}
