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

import type { RunResearchExperimentInput } from "./researchExperimentRunner.js";
import {
  ResearchStudyRunnerError,
  runResearchStudy,
  type RunResearchStudyInput,
} from "./researchStudyRunner.js";

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
  datasetId: "synthetic-study",
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
  const { normalizedEvidenceSha256, ...baseWithoutHash } =
    VERIFIED_KERNEL_RESULT.evidence;
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
  return Object.freeze({ evidence, promotionDecision });
}

function studyRegistry(
  experiments: readonly {
    readonly experimentId: string;
    readonly ready: boolean;
  }[],
): ExperimentRegistryState {
  let state = createExperimentRegistry();
  state = registerStrategyVersion(state, {
    strategyId: "mean-reversion",
    strategyVersion: "1.0.0",
    description: "Diagnostic mean-reversion baseline",
    parameters: { lookbackDays: 20, zScoreThreshold: 1.5 },
    logicalTime: "strategy-registered",
  });
  for (const definition of experiments) {
    state = createExperiment(state, {
      experimentId: definition.experimentId,
      strategyId: "mean-reversion",
      strategyVersion: "1.0.0",
      hypothesis: "Mean reversion predicts next-day direction.",
      requiredData: DATASET_VERSION,
      successCriteria: ["final-test accuracy exceeds majority baseline"],
      logicalTime: `experiment-created-${definition.experimentId}`,
    });
    if (definition.ready) {
      state = transitionExperiment(state, {
        experimentId: definition.experimentId,
        toStatus: "READY",
        reason: "ready for deterministic research",
        logicalTime: `experiment-ready-${definition.experimentId}`,
      });
    }
  }
  return state;
}

function runnerInput(
  experimentId: string,
  evidenceRunId: string,
): RunResearchExperimentInput {
  return {
    experimentId,
    evidenceRunId,
    marketRows: MARKET_ROWS,
    logisticRegression: KERNEL_CONFIG,
    startedAtLogicalTime: `run-started-${experimentId}`,
    evidenceAttachedAtLogicalTime: `evidence-attached-${experimentId}`,
  };
}

function expectDeepFrozen(value: unknown, visited = new Set<object>()): void {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) {
    expectDeepFrozen(nested, visited);
  }
}

beforeEach(() => {
  kernelMock.runResearchEvidenceKernel.mockReset();
});

describe("ordered research study execution", () => {
  it("uses the single-run pipeline in input order and returns sorted summaries", () => {
    const initialState = studyRegistry([
      { experimentId: "study-beta", ready: true },
      { experimentId: "study-alpha", ready: true },
    ]);
    const runs = [
      runnerInput("study-beta", "run-beta"),
      runnerInput("study-alpha", "run-alpha"),
    ];
    kernelMock.runResearchEvidenceKernel
      .mockReturnValueOnce(kernelResultFor("RESEARCH_CANDIDATE"))
      .mockReturnValueOnce(
        kernelResultFor("BLOCKED_UNDERPERFORMS_BASELINE"),
      );

    const result = runResearchStudy({ initialState, runs });

    expect(kernelMock.runResearchEvidenceKernel).toHaveBeenCalledTimes(2);
    expect(result.orderedExperimentIds).toEqual([
      "study-beta",
      "study-alpha",
    ]);
    expect(result.runResults.map(({ experiment }) => experiment.experimentId))
      .toEqual(["study-beta", "study-alpha"]);
    expect(result.totalRunCount).toBe(2);
    expect(result.promotionStatusCounts).toEqual([
      { promotionStatus: "BLOCKED_UNDERPERFORMS_BASELINE", count: 1 },
      { promotionStatus: "RESEARCH_CANDIDATE", count: 1 },
    ]);
    expect(result.evidenceLevelCounts).toEqual([
      { evidenceLevel: "INFERRED", count: 1 },
      { evidenceLevel: "VERIFIED", count: 1 },
    ]);
    for (const experimentId of result.orderedExperimentIds) {
      const experiment = result.finalState.experiments.find(
        (candidate) => candidate.experimentId === experimentId,
      );
      expect(experiment?.status).toBe("RUNNING");
      expect(experiment?.evidenceAttachments).toHaveLength(1);
      expect(experiment?.promotionReviews).toEqual([]);
      expect(experiment?.status).not.toBe("VALIDATED");
    }
    expect(
      result.finalState.ledger.some(
        (event) => event.eventType === "PROMOTION_REVIEW_RECORDED",
      ),
    ).toBe(false);
  });

  it("deep-freezes the result and preserves the caller's registry and runs", () => {
    const initialState = studyRegistry([
      { experimentId: "immutable-one", ready: true },
      { experimentId: "immutable-two", ready: true },
    ]);
    const runs = [
      runnerInput("immutable-one", "immutable-run-one"),
      runnerInput("immutable-two", "immutable-run-two"),
    ];
    const input = { initialState, runs };
    const inputBefore = canonicalStringify(input);
    kernelMock.runResearchEvidenceKernel.mockReturnValue(
      kernelResultFor("RESEARCH_CANDIDATE"),
    );

    const result = runResearchStudy(input);

    expectDeepFrozen(result);
    expect(canonicalStringify(input)).toBe(inputBefore);
    expect(input.initialState).toBe(initialState);
    expect(input.runs).toBe(runs);

    type CallerControlledSummary = Extract<
      keyof RunResearchStudyInput,
      "evidenceLevel" | "promotionStatus"
    >;
    expectTypeOf<CallerControlledSummary>().toEqualTypeOf<never>();
  });
});

describe("atomic study failure boundaries", () => {
  it("rejects an empty run list", () => {
    expect(() =>
      runResearchStudy({
        initialState: createExperimentRegistry(),
        runs: [],
      }),
    ).toThrow(ResearchStudyRunnerError);
    expect(kernelMock.runResearchEvidenceKernel).not.toHaveBeenCalled();
  });

  it("rejects duplicate experiment IDs before executing a run", () => {
    const initialState = studyRegistry([
      { experimentId: "duplicate", ready: true },
    ]);
    const run = runnerInput("duplicate", "duplicate-run");
    kernelMock.runResearchEvidenceKernel.mockReturnValue(
      kernelResultFor("RESEARCH_CANDIDATE"),
    );

    expect(() =>
      runResearchStudy({ initialState, runs: [run, { ...run }] }),
    ).toThrow('duplicate experiment ID "duplicate"');
    expect(kernelMock.runResearchEvidenceKernel).not.toHaveBeenCalled();
  });

  it("fails atomically for an unknown experiment", () => {
    const initialState = studyRegistry([
      { experimentId: "known", ready: true },
    ]);
    const stateBefore = canonicalStringify(initialState);

    expect(() =>
      runResearchStudy({
        initialState,
        runs: [runnerInput("unknown", "unknown-run")],
      }),
    ).toThrow(ExperimentRegistryError);
    expect(canonicalStringify(initialState)).toBe(stateBefore);
    expect(kernelMock.runResearchEvidenceKernel).not.toHaveBeenCalled();
  });

  it("fails atomically for a non-READY experiment", () => {
    const initialState = studyRegistry([
      { experimentId: "not-ready", ready: false },
    ]);
    const stateBefore = canonicalStringify(initialState);

    expect(() =>
      runResearchStudy({
        initialState,
        runs: [runnerInput("not-ready", "not-ready-run")],
      }),
    ).toThrow(ExperimentRegistryError);
    expect(canonicalStringify(initialState)).toBe(stateBefore);
    expect(kernelMock.runResearchEvidenceKernel).not.toHaveBeenCalled();
  });

  it("returns no study output or partial registry when a later run fails", () => {
    const initialState = studyRegistry([
      { experimentId: "valid-first", ready: true },
      { experimentId: "invalid-second", ready: false },
    ]);
    const stateBefore = canonicalStringify(initialState);
    let result: ReturnType<typeof runResearchStudy> | undefined;
    kernelMock.runResearchEvidenceKernel.mockReturnValue(
      kernelResultFor("RESEARCH_CANDIDATE"),
    );

    expect(() => {
      result = runResearchStudy({
        initialState,
        runs: [
          runnerInput("valid-first", "valid-first-run"),
          runnerInput("invalid-second", "invalid-second-run"),
        ],
      });
    }).toThrow(ExperimentRegistryError);
    expect(result).toBeUndefined();
    expect(canonicalStringify(initialState)).toBe(stateBefore);
    expect(kernelMock.runResearchEvidenceKernel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when replayed against the returned registry", () => {
    const runs = [
      runnerInput("replay-one", "replay-run-one"),
      runnerInput("replay-two", "replay-run-two"),
    ];
    kernelMock.runResearchEvidenceKernel.mockReturnValue(
      kernelResultFor("RESEARCH_CANDIDATE"),
    );
    const first = runResearchStudy({
      initialState: studyRegistry([
        { experimentId: "replay-one", ready: true },
        { experimentId: "replay-two", ready: true },
      ]),
      runs,
    });

    expect(() =>
      runResearchStudy({ initialState: first.finalState, runs }),
    ).toThrow(ExperimentRegistryError);
    expect(kernelMock.runResearchEvidenceKernel).toHaveBeenCalledTimes(2);
  });
});
