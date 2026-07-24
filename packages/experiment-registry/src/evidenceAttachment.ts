import { decidePromotion, hashValue } from "@mms/research-kernel";
import type { DatasetVersion, EvidenceAttachment } from "@mms/contracts";

import { deepFreezeClone, fail, type AttachRunEvidenceInput } from "./types.js";

export interface BuildEvidenceAttachmentParams {
  readonly input: AttachRunEvidenceInput;
  readonly expectedStrategyId: string;
  readonly expectedStrategyVersion: string;
  readonly expectedDatasetVersion: DatasetVersion;
  readonly sequence: number;
  readonly existingAttachment: EvidenceAttachment | undefined;
}

export interface BuildEvidenceAttachmentResult {
  readonly attachment: EvidenceAttachment;
  readonly isNoOpDuplicate: boolean;
}

export function buildEvidenceAttachment(
  params: BuildEvidenceAttachmentParams,
): BuildEvidenceAttachmentResult {
  const { input, expectedStrategyId, expectedStrategyVersion, expectedDatasetVersion } = params;

  const evidence = deepFreezeClone(input.evidence);
  const promotionDecision = deepFreezeClone(input.promotionDecision);
  const datasetVersion = deepFreezeClone(input.datasetVersion);

  const { normalizedEvidenceSha256, ...normalizedWithoutSelfHash } = evidence;
  const recomputedEvidenceHash = hashValue(normalizedWithoutSelfHash);
  if (recomputedEvidenceHash !== normalizedEvidenceSha256) {
    fail(
      `evidence hash mismatch: recomputed "${recomputedEvidenceHash}" does not match the evidence's own normalizedEvidenceSha256 "${normalizedEvidenceSha256}"`,
    );
  }

  if (input.strategyId !== expectedStrategyId || input.strategyVersion !== expectedStrategyVersion) {
    fail(
      `strategy linkage mismatch: evidence declares ${input.strategyId}@${input.strategyVersion}, experiment expects ${expectedStrategyId}@${expectedStrategyVersion}`,
    );
  }

  if (hashValue(evidence.datasetVersion) !== hashValue(expectedDatasetVersion)) {
    fail("dataset linkage mismatch: evidence.datasetVersion does not match the experiment's requiredData");
  }
  if (hashValue(datasetVersion) !== hashValue(expectedDatasetVersion)) {
    fail("dataset linkage mismatch: supplied datasetVersion does not match the experiment's requiredData");
  }

  if (promotionDecision.automaticPromotion !== false) {
    fail("promotion decision rejected: automaticPromotion must be false");
  }
  if (promotionDecision.manualApprovalRequired !== true) {
    fail("promotion decision rejected: manualApprovalRequired must be true");
  }

  const rederivedPromotionDecision = decidePromotion(evidence);
  const suppliedPromotionDecisionHash = hashValue(promotionDecision);
  const rederivedPromotionDecisionHash = hashValue(rederivedPromotionDecision);
  if (suppliedPromotionDecisionHash !== rederivedPromotionDecisionHash) {
    fail(
      "promotion decision mismatch: supplied PromotionDecision does not match a fresh deterministic re-derivation from this evidence",
    );
  }

  if (input.requestedEvidenceLevel === "VERIFIED") {
    if (promotionDecision.status !== "RESEARCH_CANDIDATE" || evidence.dataQualityFindings.length > 0) {
      fail(
        "evidence cannot be attached at level VERIFIED: promotion status is not RESEARCH_CANDIDATE or blocking data-quality findings are present",
      );
    }
  }

  const attachment: EvidenceAttachment = Object.freeze({
    experimentId: input.experimentId,
    evidenceRunId: input.evidenceRunId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    datasetVersion,
    evidence,
    evidenceHash: recomputedEvidenceHash,
    promotionDecision,
    promotionDecisionHash: rederivedPromotionDecisionHash,
    evidenceLevel: input.requestedEvidenceLevel,
    sequence: params.sequence,
    logicalTime: input.logicalTime,
  });

  const existing = params.existingAttachment;
  if (existing !== undefined) {
    const identical = existing.evidenceHash === attachment.evidenceHash
      && existing.promotionDecisionHash === attachment.promotionDecisionHash
      && existing.strategyId === attachment.strategyId
      && existing.strategyVersion === attachment.strategyVersion
      && existing.evidenceLevel === attachment.evidenceLevel
      && hashValue(existing.datasetVersion) === hashValue(attachment.datasetVersion);
    if (identical) {
      return { attachment: existing, isNoOpDuplicate: true };
    }
    fail(
      `evidenceRunId "${input.evidenceRunId}" is already attached to experiment "${input.experimentId}" with a different payload`,
    );
  }

  return { attachment, isNoOpDuplicate: false };
}
