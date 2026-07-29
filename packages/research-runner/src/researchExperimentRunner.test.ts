import type {
  DataQualityFinding,
  DatasetVersion,
  ExperimentRegistryState,
  ExperimentRunEvidence,
  MarketDataRow,
  PromotionStatus,
} from "@mms/contracts";
import {
  createExperiment,
  createExperimentRegistry,
  ExperimentRegistryError,
  registerStrategyVersion,
  transitionExperiment,
} from "@mms/experiment-registry";
import {
  canonicalStringify,
  decidePromotion,
  hashValue,
  type ResearchEvidenceKernelResult,
} from "@mms/research-kernel";
import {
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  deriveRequestedEvidenceLevel,
  runResearchExperiment,
  type RunResearchExperimentInput,
} from "./researchExperimentRunner.js";

const kernelMock = vi.hoisted(() => ({
  runResearchEvidenceKernel: vi.fn(),
}));

vi.mock("@mms/research-kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mms/research-kernel")>();
  return {
    ...actual,
    runResearchEvidenceKernel: kernelMock.runResearchEvidenceKernel,
  };
});

const actualKernel = await vi.importActual<
  typeof import("@mms/research-kernel")
>("@mms/research-kernel");

const DATASET_VERSION: DatasetVersion = Object.freeze({
  datasetId: "synthetic-cycle",
  version: "v1",
  source: "test-owned/in-memory",
});

function fixtureMarketRows(count = 120): MarketDataRow[] {
  const rows: MarketDataRow[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
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

const MARKET_ROWS = fixtureMarketRows();
const KERNEL_CONFIG = Object.freeze({
  iterations: 600,
  learningRate: 0.08,
  l2: 0.01,
});

const VERIFIED_KERNEL_RESULT = actualKernel.runResearchEvidenceKernel({
  datasetVersion: DATASET_VERSION,
  marketRows: MARKET_ROWS,
  logisticRegression: KERNEL_CONFIG,
});

function rehashEvidence(
  overrides: Partial<Omit<ExperimentRunEvidence, "normalizedEvidenceSha256">>,
): ExperimentRunEvidence {
  const {
    normalizedEvidenceSha256,
    ...baseWithoutHash
  } = VERIFIED_KERNEL_RESULT.evidence;
  if (!/^[a-f0-9]{64}$/.test(normalizedEvidenceSha256)) {
    throw new Error("verified fixture is missing its normalized evidence hash");
  }
  const withoutSelfHash = {
    ...baseWithoutHash,
    ...overrides,
  };
  return {
    ...withoutSelfHash,
    normalizedEvidenceSha256: hashValue(withoutSelfHash),
  };
}

function kernelResultFor(
  status: PromotionStatus,
): ResearchEvidenceKernelResult {
  let evidence = VERIFIED_KERNEL_RESULT.evidence;
  if (status === "BLOCKED_DATA_QUALITY") {
    const finding: DataQualityFinding = {
      code: "UNADJUSTED_PRICE_DISCONTINUITY_RISK",
      severity: "BLOCKING",
      message: "Test-owned blocking discontinuity.",
      symbol: "SYNTH",
      date: "2024-03-11",
    };
    evidence = rehashEvidence({ dataQualityFindings: [finding] });
  } else if (status === "BLOCKED_INSUFFICIENT_EVIDENCE") {
    evidence = rehashEvidence({ datasetSha256: "missing" });
  } else if (status === "BLOCKED_UNDERPERFORMS_BASELINE") {
    evidence = rehashEvidence({
      finalTest: {
        ...VERIFIED_KERNEL_RESULT.evidence.finalTest,
        metrics: {
          ...VERIFIED_KERNEL_RESULT.evidence.finalTest.metrics,
          accuracy:
            VERIFIED_KERNEL_RESULT.evidence.finalTest.metrics.majorityBaseline,
        },
      },
    });
  }

  const promotionDecision = decidePromotion(evidence);
  if (promotionDecision.status !== status) {
    throw new Error(
      `fixture produced ${promotionDecision.status}; expected ${status}`,
    );
  }
  return { evidence, promotionDecision };
}

function readyExperiment(experimentId: string): ExperimentRegistryState {
  let state = createExperimentRegistry();
  state = registerStrategyVersion(state, {
    strategyId: "mean-reversion",
    strategyVersion: "1.0.0",
    description: "Diagnostic mean-reversion baseline",
    parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    logicalTime: "strategy-registered",
  });
  state = createExperiment(state, {
    experimentId,
    strategyId: "mean-reversion",
    strategyVersion: "1.0.0",
    hypothesis: "Mean reversion predicts next-day direction.",
    requiredData: DATASET_VERSION,
    successCriteria: ["final-test accuracy exceeds majority baseline"],
    logicalTime: "experiment-created",
  });
  return transitionExperiment(state, {
    experimentId,
    toStatus: "READY",
    reason: "ready for deterministic research",
    logicalTime: "experiment-ready",
  });
}

function runnerInput(
  experimentId: string,
  evidenceRunId = "run-1",
): RunResearchExperimentInput {
  return {
    experimentId,
    evidenceRunId,
    marketRows: MARKET_ROWS,
    logisticRegression: KERNEL_CONFIG,
    startedAtLogicalTime: "run-started",
    evidenceAttachedAtLogicalTime: "evidence-attached",
  };
}

beforeEach(() => {
  kernelMock.runResearchEvidenceKernel.mockReset();
});

describe("evidence-level mapping and attachment", () => {
  it.each([
    ["RESEARCH_CANDIDATE", "VERIFIED"],
    ["BLOCKED_DATA_QUALITY", "UNVERIFIED"],
    ["BLOCKED_INSUFFICIENT_EVIDENCE", "NEEDS_DATA"],
    ["BLOCKED_UNDERPERFORMS_BASELINE", "INFERRED"],
  ] as const)("%s attaches %s", (promotionStatus, expectedEvidenceLevel) => {
    const experimentId = `mapping-${promotionStatus}`;
    const kernelResult = kernelResultFor(promotionStatus);
    kernelMock.runResearchEvidenceKernel.mockReturnValueOnce(kernelResult);

    const result = runResearchExperiment(
      readyExperiment(experimentId),
      runnerInput(experimentId),
    );

    expect(result.evidenceLevel).toBe(expectedEvidenceLevel);
    expect(result.promotionDecision).toEqual(kernelResult.promotionDecision);
    expect(result.promotionDecision.automaticPromotion).toBe(false);
    expect(result.promotionDecision.manualApprovalRequired).toBe(true);
    expect(result.experiment.evidenceAttachments).toHaveLength(1);
    expect(result.experiment.evidenceAttachments[0]?.evidenceLevel).toBe(
      expectedEvidenceLevel,
    );
    expect(
      result.experiment.evidenceAttachments[0]?.promotionDecision.status,
    ).toBe(promotionStatus);
  });

  it("derives every level without exposing or honoring a caller override", () => {
    type CallerEvidenceOverride = Extract<
      keyof RunResearchExperimentInput,
      "requestedEvidenceLevel" | "evidenceLevel"
    >;
    expectTypeOf<CallerEvidenceOverride>().toEqualTypeOf<never>();

    const experimentId = "override-attempt";
    kernelMock.runResearchEvidenceKernel.mockReturnValueOnce(
      kernelResultFor("RESEARCH_CANDIDATE"),
    );
    const inputWithRuntimeOnlyExtraProperty = {
      ...runnerInput(experimentId),
      requestedEvidenceLevel: "UNVERIFIED",
    } as unknown as RunResearchExperimentInput;

    const result = runResearchExperiment(
      readyExperiment(experimentId),
      inputWithRuntimeOnlyExtraProperty,
    );

    expect(result.evidenceLevel).toBe("VERIFIED");
    expect(result.experiment.evidenceAttachments[0]?.evidenceLevel).toBe(
      "VERIFIED",
    );
  });

  it("fails closed for an unknown runtime promotion status", () => {
    expect(() =>
      deriveRequestedEvidenceLevel({
        ...VERIFIED_KERNEL_RESULT.promotionDecision,
        status: "UNKNOWN",
      } as unknown as typeof VERIFIED_KERNEL_RESULT.promotionDecision),
    ).toThrow("unsupported promotion status");
  });
});

describe("research experiment orchestration boundaries", () => {
  it("keeps a blocked decision blocked, leaves the experiment RUNNING, and creates no manual review", () => {
    const experimentId = "blocked-boundaries";
    kernelMock.runResearchEvidenceKernel.mockReturnValueOnce(
      kernelResultFor("BLOCKED_UNDERPERFORMS_BASELINE"),
    );

    const result = runResearchExperiment(
      readyExperiment(experimentId),
      runnerInput(experimentId),
    );

    expect(result.promotionDecision.status).toBe(
      "BLOCKED_UNDERPERFORMS_BASELINE",
    );
    expect(result.experiment.status).toBe("RUNNING");
    expect(result.experiment.status).not.toBe("VALIDATED");
    expect(result.experiment.promotionReviews).toEqual([]);
    expect(
      result.state.ledger.some(
        (event) => event.eventType === "PROMOTION_REVIEW_RECORDED",
      ),
    ).toBe(false);
  });

  it("returns deterministic output and the same derived level for identical input", () => {
    const experimentId = "deterministic-run";
    kernelMock.runResearchEvidenceKernel.mockImplementation(
      actualKernel.runResearchEvidenceKernel,
    );
    const state = readyExperiment(experimentId);
    const input = runnerInput(experimentId);

    const first = runResearchExperiment(state, input);
    const second = runResearchExperiment(state, input);

    expect(first.evidenceLevel).toBe(second.evidenceLevel);
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
  });

  it("fails closed when replayed against the returned RUNNING state", () => {
    const experimentId = "replay-fails-closed";
    kernelMock.runResearchEvidenceKernel.mockImplementation(
      actualKernel.runResearchEvidenceKernel,
    );
    const input = runnerInput(experimentId);
    const first = runResearchExperiment(readyExperiment(experimentId), input);

    expect(first.experiment.status).toBe("RUNNING");
    expect(() => runResearchExperiment(first.state, input)).toThrow(
      ExperimentRegistryError,
    );
    expect(first.experiment.evidenceAttachments).toHaveLength(1);
  });
});
