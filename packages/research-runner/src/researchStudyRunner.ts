import type {
  EvidenceLevel,
  ExperimentRegistryState,
  PromotionStatus,
} from "@mms/contracts";

import {
  runResearchExperiment,
  type RunResearchExperimentInput,
  type RunResearchExperimentResult,
} from "./researchExperimentRunner.js";

export interface RunResearchStudyInput {
  readonly initialState: ExperimentRegistryState;
  readonly runs: readonly RunResearchExperimentInput[];
}

export interface PromotionStatusCount {
  readonly promotionStatus: PromotionStatus;
  readonly count: number;
}

export interface EvidenceLevelCount {
  readonly evidenceLevel: EvidenceLevel;
  readonly count: number;
}

export interface RunResearchStudyResult {
  readonly finalState: ExperimentRegistryState;
  readonly runResults: readonly RunResearchExperimentResult[];
  readonly orderedExperimentIds: readonly string[];
  readonly totalRunCount: number;
  readonly promotionStatusCounts: readonly PromotionStatusCount[];
  readonly evidenceLevelCounts: readonly EvidenceLevelCount[];
}

export class ResearchStudyRunnerError extends Error {
  constructor(message: string) {
    super(`research study runner failed closed: ${message}`);
    this.name = "ResearchStudyRunnerError";
  }
}

function immutableResultClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableResultClone(item))) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    clone[key] = immutableResultClone(nested);
  }
  return Object.freeze(clone) as T;
}

function validateRunList(
  runs: readonly RunResearchExperimentInput[],
): readonly string[] {
  if (runs.length === 0) {
    throw new ResearchStudyRunnerError("at least one run is required");
  }

  const experimentIds: string[] = [];
  for (const run of runs) {
    if (experimentIds.includes(run.experimentId)) {
      throw new ResearchStudyRunnerError(
        `duplicate experiment ID "${run.experimentId}"`,
      );
    }
    experimentIds.push(run.experimentId);
  }
  return Object.freeze(experimentIds);
}

function buildPromotionStatusCounts(
  runResults: readonly RunResearchExperimentResult[],
): readonly PromotionStatusCount[] {
  const counts: Partial<Record<PromotionStatus, number>> = {};
  for (const result of runResults) {
    const status = result.promotionDecision.status;
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return Object.freeze(
    (Object.keys(counts) as PromotionStatus[])
      .sort()
      .map((promotionStatus) =>
        Object.freeze({
          promotionStatus,
          count: counts[promotionStatus] ?? 0,
        }),
      ),
  );
}

function buildEvidenceLevelCounts(
  runResults: readonly RunResearchExperimentResult[],
): readonly EvidenceLevelCount[] {
  const counts: Partial<Record<EvidenceLevel, number>> = {};
  for (const result of runResults) {
    const level = result.evidenceLevel;
    counts[level] = (counts[level] ?? 0) + 1;
  }

  return Object.freeze(
    (Object.keys(counts) as EvidenceLevel[])
      .sort()
      .map((evidenceLevel) =>
        Object.freeze({
          evidenceLevel,
          count: counts[evidenceLevel] ?? 0,
        }),
      ),
  );
}

export function runResearchStudy(
  input: RunResearchStudyInput,
): RunResearchStudyResult {
  const orderedExperimentIds = validateRunList(input.runs);
  const runResults: RunResearchExperimentResult[] = [];
  let state = input.initialState;

  for (const run of input.runs) {
    const result = runResearchExperiment(state, run);
    runResults.push(result);
    state = result.state;
  }

  const frozenRunResults = Object.freeze(runResults);
  return immutableResultClone({
    finalState: state,
    runResults: frozenRunResults,
    orderedExperimentIds,
    totalRunCount: frozenRunResults.length,
    promotionStatusCounts: buildPromotionStatusCounts(frozenRunResults),
    evidenceLevelCounts: buildEvidenceLevelCounts(frozenRunResults),
  });
}
