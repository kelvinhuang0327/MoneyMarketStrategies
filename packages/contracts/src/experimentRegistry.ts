import type { DatasetVersion, ExperimentRunEvidence, PromotionDecision } from "./researchEvidence.js";

export const EXPERIMENT_STATUSES = [
  "IDEA",
  "READY",
  "RUNNING",
  "BLOCKED",
  "PARTIAL",
  "VALIDATED",
  "REJECTED",
  "DEFERRED",
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EVIDENCE_LEVELS = ["VERIFIED", "INFERRED", "NEEDS_DATA", "UNVERIFIED"] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const PROMOTION_REVIEW_OUTCOMES = [
  "ACCEPTED_FOR_RESEARCH_VALIDATION",
  "NEEDS_MORE_DATA",
  "REJECTED",
] as const;

export type PromotionReviewOutcome = (typeof PROMOTION_REVIEW_OUTCOMES)[number];

export const EXPERIMENT_LEDGER_EVENT_TYPES = [
  "STRATEGY_VERSION_REGISTERED",
  "EXPERIMENT_CREATED",
  "STATUS_TRANSITIONED",
  "RUN_EVIDENCE_ATTACHED",
  "PROMOTION_REVIEW_RECORDED",
] as const;

export type ExperimentLedgerEventType = (typeof EXPERIMENT_LEDGER_EVENT_TYPES)[number];

export const GENESIS_PREVIOUS_EVENT_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export interface StrategyVersionDefinition {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export interface RegisteredStrategyVersion {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly strategyDefinitionHash: string;
  readonly definition: StrategyVersionDefinition;
  readonly sequence: number;
  readonly logicalTime: string;
}

export interface ExperimentDefinition {
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly hypothesis: string;
  readonly requiredData: DatasetVersion;
  readonly successCriteria: readonly string[];
}

export interface ExperimentBlocker {
  readonly code: string;
  readonly message: string;
  readonly raisedAtSequence: number;
  readonly resolvedAtSequence: number | null;
  readonly resolutionEvidence: string | null;
}

export interface EvidenceAttachment {
  readonly experimentId: string;
  readonly evidenceRunId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly datasetVersion: DatasetVersion;
  readonly evidence: ExperimentRunEvidence;
  readonly evidenceHash: string;
  readonly promotionDecision: PromotionDecision;
  readonly promotionDecisionHash: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly sequence: number;
  readonly logicalTime: string;
}

export interface PromotionReviewRecord {
  readonly experimentId: string;
  readonly evidenceRunId: string;
  readonly evidenceHash: string;
  readonly outcome: PromotionReviewOutcome;
  readonly isDiagnosticResearchReviewOnly: true;
  readonly reviewer: string;
  readonly notes: string;
  readonly sequence: number;
  readonly logicalTime: string;
}

export interface ExperimentStatusHistoryEntry {
  readonly status: ExperimentStatus;
  readonly reason: string;
  readonly sequence: number;
  readonly logicalTime: string;
}

export interface ExperimentSnapshot {
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly hypothesis: string;
  readonly requiredData: DatasetVersion;
  readonly successCriteria: readonly string[];
  readonly status: ExperimentStatus;
  readonly evidenceLevel: EvidenceLevel;
  readonly blockers: readonly ExperimentBlocker[];
  readonly evidenceAttachments: readonly EvidenceAttachment[];
  readonly promotionReviews: readonly PromotionReviewRecord[];
  readonly statusHistory: readonly ExperimentStatusHistoryEntry[];
  readonly createdAtSequence: number;
  readonly lastSequence: number;
}

export interface ExperimentLedgerEvent {
  readonly sequence: number;
  readonly identity: string;
  readonly eventType: ExperimentLedgerEventType;
  readonly payload: unknown;
  readonly logicalTime: string;
  readonly previousEventHash: string;
  readonly eventHash: string;
}

export type ExperimentLedger = readonly ExperimentLedgerEvent[];

export interface LedgerIntegrityFinding {
  readonly code: string;
  readonly message: string;
  readonly sequence: number | null;
}

export interface LedgerIntegrityResult {
  readonly valid: boolean;
  readonly findings: readonly LedgerIntegrityFinding[];
  readonly verifiedEventCount: number;
}

export interface ExperimentRegistryState {
  readonly strategyVersions: readonly RegisteredStrategyVersion[];
  readonly experiments: readonly ExperimentSnapshot[];
  readonly ledger: ExperimentLedger;
}
