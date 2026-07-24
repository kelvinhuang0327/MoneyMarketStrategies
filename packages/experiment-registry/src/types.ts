import type {
  DatasetVersion,
  EvidenceLevel,
  ExperimentRunEvidence,
  ExperimentStatus,
  PromotionDecision,
  PromotionReviewOutcome,
} from "@mms/contracts";

export class ExperimentRegistryError extends Error {
  constructor(message: string) {
    super(`experiment registry rejected the operation: ${message}`);
    this.name = "ExperimentRegistryError";
  }
}

export function fail(message: string): never {
  throw new ExperimentRegistryError(message);
}

// Clones so a caller's later mutation of their input can never reach stored state.
export function deepFreezeClone<T>(value: T): T {
  return deepCloneAndFreeze(value) as T;
}

function deepCloneAndFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepCloneAndFreeze(item)));
  }
  const source = value as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    cloned[key] = deepCloneAndFreeze(source[key]);
  }
  return Object.freeze(cloned);
}

export interface RegisterStrategyVersionInput {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly logicalTime: string;
}

export interface CreateExperimentInput {
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly hypothesis: string;
  readonly requiredData: DatasetVersion;
  readonly successCriteria: readonly string[];
  readonly logicalTime: string;
}

export interface TransitionExperimentInput {
  readonly experimentId: string;
  readonly toStatus: ExperimentStatus;
  readonly reason: string;
  readonly logicalTime: string;
  readonly blocker?: { readonly code: string; readonly message: string };
  readonly blockerResolutionEvidence?: string;
}

export interface AttachRunEvidenceInput {
  readonly experimentId: string;
  readonly evidenceRunId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly datasetVersion: DatasetVersion;
  readonly evidence: ExperimentRunEvidence;
  readonly promotionDecision: PromotionDecision;
  readonly requestedEvidenceLevel: EvidenceLevel;
  readonly logicalTime: string;
}

export interface RecordPromotionReviewInput {
  readonly experimentId: string;
  readonly evidenceRunId: string;
  readonly outcome: PromotionReviewOutcome;
  readonly isDiagnosticResearchReviewOnly: true;
  readonly reviewer: string;
  readonly notes: string;
  readonly logicalTime: string;
}

export interface ExperimentCreatedPayload {
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly hypothesis: string;
  readonly requiredData: DatasetVersion;
  readonly successCriteria: readonly string[];
}

export interface StatusTransitionedPayload {
  readonly experimentId: string;
  readonly fromStatus: ExperimentStatus;
  readonly toStatus: ExperimentStatus;
  readonly reason: string;
  readonly blocker: { readonly code: string; readonly message: string } | null;
  readonly blockerResolutionEvidence: string | null;
}
