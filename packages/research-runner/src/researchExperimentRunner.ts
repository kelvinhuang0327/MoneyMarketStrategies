import type {
  EvidenceLevel,
  ExperimentRegistryState,
  ExperimentRunEvidence,
  ExperimentSnapshot,
  PromotionDecision,
} from "@mms/contracts";
import {
  attachRunEvidence,
  getExperimentSnapshot,
  transitionExperiment,
} from "@mms/experiment-registry";
import {
  runResearchEvidenceKernel,
  type LogisticRegressionConfig,
  type MarketDataRow,
} from "@mms/research-kernel";

export interface RunResearchExperimentInput {
  readonly experimentId: string;
  readonly evidenceRunId: string;
  readonly marketRows: readonly MarketDataRow[];
  readonly logisticRegression?: Partial<LogisticRegressionConfig>;
  readonly discontinuityThreshold?: number;
  readonly startedAtLogicalTime: string;
  readonly evidenceAttachedAtLogicalTime: string;
}

export interface RunResearchExperimentResult {
  readonly state: ExperimentRegistryState;
  readonly experiment: ExperimentSnapshot;
  readonly evidence: ExperimentRunEvidence;
  readonly promotionDecision: PromotionDecision;
  readonly evidenceLevel: EvidenceLevel;
}

export class ResearchExperimentRunnerError extends Error {
  constructor(message: string) {
    super(`research experiment runner failed closed: ${message}`);
    this.name = "ResearchExperimentRunnerError";
  }
}

export function deriveRequestedEvidenceLevel(
  promotionDecision: PromotionDecision,
): EvidenceLevel {
  switch (promotionDecision.status) {
    case "RESEARCH_CANDIDATE":
      return "VERIFIED";
    case "BLOCKED_DATA_QUALITY":
      return "UNVERIFIED";
    case "BLOCKED_INSUFFICIENT_EVIDENCE":
      return "NEEDS_DATA";
    case "BLOCKED_UNDERPERFORMS_BASELINE":
      return "INFERRED";
    default:
      throw new ResearchExperimentRunnerError(
        `unsupported promotion status "${String(promotionDecision.status)}"`,
      );
  }
}

export function runResearchExperiment(
  state: ExperimentRegistryState,
  input: RunResearchExperimentInput,
): RunResearchExperimentResult {
  const experiment = getExperimentSnapshot(state, input.experimentId);
  const runningState = transitionExperiment(state, {
    experimentId: input.experimentId,
    toStatus: "RUNNING",
    reason: `research evidence run "${input.evidenceRunId}" started`,
    logicalTime: input.startedAtLogicalTime,
  });

  const kernelResult = runResearchEvidenceKernel({
    datasetVersion: experiment.requiredData,
    marketRows: input.marketRows,
    ...(input.logisticRegression === undefined
      ? {}
      : { logisticRegression: input.logisticRegression }),
    ...(input.discontinuityThreshold === undefined
      ? {}
      : { discontinuityThreshold: input.discontinuityThreshold }),
  });
  const evidenceLevel = deriveRequestedEvidenceLevel(
    kernelResult.promotionDecision,
  );

  const attachedState = attachRunEvidence(runningState, {
    experimentId: input.experimentId,
    evidenceRunId: input.evidenceRunId,
    strategyId: experiment.strategyId,
    strategyVersion: experiment.strategyVersion,
    datasetVersion: experiment.requiredData,
    evidence: kernelResult.evidence,
    promotionDecision: kernelResult.promotionDecision,
    requestedEvidenceLevel: evidenceLevel,
    logicalTime: input.evidenceAttachedAtLogicalTime,
  });

  return Object.freeze({
    state: attachedState,
    experiment: getExperimentSnapshot(attachedState, input.experimentId),
    evidence: kernelResult.evidence,
    promotionDecision: kernelResult.promotionDecision,
    evidenceLevel,
  });
}
