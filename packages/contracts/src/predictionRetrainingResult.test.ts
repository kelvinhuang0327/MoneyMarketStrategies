import { describe, expect, it } from "vitest";

import {
  buildPredictionRetrainingResultV1,
  readLatestPredictionsArtifact,
  type BuildPredictionRetrainingResultV1Input,
  type LegacyLatestPredictionArtifact,
} from "./predictionRetrainingResult.js";
import {
  runResearchEvidenceKernel,
  type ExperimentRunEvidence,
  type MarketDataRow,
} from "@mms/research-kernel";
import {
  buildFinalTestPerSymbolEconomicEdge,
  buildPerSymbolLogisticChallengerEvaluation,
  buildPerSymbolLogisticFeatureChallengerEvaluation,
  reconcileFinalTestEconomicEdge,
  simulateLongCashReplay,
} from "@mms/strategy-simulator";

function fixtureRows(count = 120): MarketDataRow[] {
  const rows: MarketDataRow[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
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

const kernelResult = runResearchEvidenceKernel({
  datasetVersion: {
    datasetId: "synthetic-cycle",
    version: "v1",
    source: "test-owned/in-memory",
  },
  marketRows: fixtureRows(),
  logisticRegression: {
    iterations: 600,
    learningRate: 0.08,
    l2: 0.01,
  },
});

const simulation = simulateLongCashReplay({
  symbol: "SYNTH",
  validationThreshold: 0.6,
  roundTripCostBps: 10,
  initialCapital: 1_000,
  rows: [
    {
      entryDate: "2024-04-24",
      exitDate: "2024-04-25",
      probabilityUp: 0.7,
      realizedForwardReturn: 0.01,
    },
    {
      entryDate: "2024-04-26",
      exitDate: "2024-04-29",
      probabilityUp: 0.4,
      realizedForwardReturn: -0.01,
    },
  ],
});

const latestPredictions = [
  {
    symbol: "SYNTH",
    featureDate: "2024-04-29",
    probabilityUp: 0.58,
    predictedDirection: "up" as const,
    operativeThreshold: 0.55,
    close: 103.2,
  },
  {
    symbol: "ALPHA",
    featureDate: "2024-04-28",
    probabilityUp: 0.42,
    predictedDirection: "down" as const,
    operativeThreshold: 0.6,
    targetDate: "2024-05-03",
  },
];

function buildInput(
  overrides: Partial<BuildPredictionRetrainingResultV1Input> = {},
): BuildPredictionRetrainingResultV1Input {
  return {
    runId: "contract-sample-run-001",
    generatedAt: "2026-08-12T00:00:00.000Z",
    dataAsOf: "2024-04-29",
    modelAlgorithm: "binary_logistic_regression",
    evidence: kernelResult.evidence,
    promotionDecision: kernelResult.promotionDecision,
    latestPredictions,
    simulation,
    provenanceReferences: [
      {
        kind: "latest_predictions",
        reference: "test.latest_predictions.v1",
        sha256: "latest-predictions-sha256",
      },
    ],
    ...overrides,
  };
}

describe("Prediction & Retraining Result Contract V1", () => {
  it("generates deterministic output from actual kernel and simulator evidence", () => {
    const first = buildPredictionRetrainingResultV1(buildInput());
    const second = buildPredictionRetrainingResultV1(buildInput());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.schemaVersion).toBe("MMS_PREDICTION_RETRAINING_RESULT_V1");
    expect(first.retraining.availability).toBe("available");
    expect(first.finalTestMetrics.availability).toBe("available");
    expect(first.baselineMetrics.availability).toBe("available");
    expect(first.finalTestReliability.availability).toBe("unavailable");
    expect(first.latestPredictions.availability).toBe("available");
    if (first.latestPredictions.availability === "available") {
      expect(first.latestPredictions.value.map(({ operativeThreshold }) => operativeThreshold)).toEqual([
        { availability: "available", value: 0.6 },
        { availability: "available", value: 0.55 },
      ]);
    }
    expect(first.simulation.availability).toBe("available");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.provenanceReferences)).toBe(true);
  });

  it("exposes current predictions as explicitly unresolved while preserving resolved evidence", () => {
    const result = buildPredictionRetrainingResultV1(buildInput({
      latestPredictions: [{
        scenario: "SYNTH_RESOLVED",
        symbol: "SYNTH",
        featureDate: "2024-04-29",
        probabilityUp: 0.58,
        predictedDirection: "up",
        operativeThreshold: 0.55,
        position: "LONG",
        targetDate: "2024-05-06",
        predictionRole: "resolved_historical",
        resolutionStatus: "resolved",
      }],
      currentUnresolvedPredictions: [{
        scenario: "SYNTH_CURRENT",
        symbol: "SYNTH",
        featureDate: "2024-05-06",
        probabilityUp: 0.61,
        predictedDirection: "up",
        operativeThreshold: 0.6,
        position: "LONG",
        targetDate: "2024-05-13",
        predictionRole: "current_unresolved",
        resolutionStatus: "unresolved",
        predictionHorizon: { unit: "trading_rows", rows: 5 },
      }],
      currentPredictionUnavailable: [{
        scenario: "MISSING_SCENARIO",
        reason: "No eligible current feature row was available.",
      }],
    }));

    expect(result.latestPredictions).toMatchObject({
      availability: "available",
      value: [expect.objectContaining({
        predictionRole: "resolved_historical",
        resolutionStatus: "resolved",
      })],
    });
    expect(result.currentUnresolvedPredictions).toMatchObject({
      availability: "available",
      value: [expect.objectContaining({
        predictionRole: "current_unresolved",
        resolutionStatus: "unresolved",
        predictionHorizon: { availability: "available", value: { unit: "trading_rows", rows: 5 } },
        actualDirection: expect.objectContaining({ availability: "unavailable" }),
        realizedReturn: expect.objectContaining({ availability: "unavailable" }),
      })],
    });
    expect(result.currentPredictionUnavailable).toEqual([{
      scenario: "MISSING_SCENARIO",
      reason: "No eligible current feature row was available.",
    }]);
  });

  it("fails closed when an unresolved prediction carries a future outcome", () => {
    expect(() => buildPredictionRetrainingResultV1(buildInput({
      currentUnresolvedPredictions: [{
        scenario: "SYNTH_CURRENT",
        symbol: "SYNTH",
        featureDate: "2024-05-06",
        probabilityUp: 0.61,
        predictedDirection: "up",
        operativeThreshold: 0.6,
        position: "LONG",
        targetDate: "2024-05-13",
        predictionRole: "current_unresolved",
        resolutionStatus: "unresolved",
        predictionHorizon: { unit: "trading_rows", rows: 5 },
        actualDirection: "up",
      }],
    }))).toThrow(/unresolved predictions must not contain actualDirection/);
  });

  it("keeps validation selection separate from final-test evaluation", () => {
    const result = buildPredictionRetrainingResultV1(buildInput());

    expect(result.thresholdSelection).toMatchObject({
      availability: "available",
      value: {
        selectionSource: "VALIDATION",
        selectedThreshold: kernelResult.evidence.finalTest.frozenThreshold,
        selectionRowsSha256: kernelResult.evidence.thresholdSelection.validationRowsSha256,
      },
    });
    expect(result.partitions.validation.rowsSha256).toEqual({
      availability: "available",
      value: kernelResult.evidence.thresholdSelection.validationRowsSha256,
    });
    expect(result.partitions.finalTest.rowsSha256).toEqual({
      availability: "available",
      value: kernelResult.evidence.finalTest.finalTestRowsSha256,
    });
    expect(kernelResult.evidence.thresholdSelection.validationRowsSha256)
      .not.toBe(kernelResult.evidence.finalTest.finalTestRowsSha256);
    expect(result.partitions.finalTest.endDate.availability).toBe("unavailable");
  });

  it("normalizes additive per-symbol reliability and audits its partition count", () => {
    const reliability = kernelResult.finalTestReliability;
    if (reliability === undefined) throw new Error("kernel reliability fixture is missing");
    const result = buildPredictionRetrainingResultV1(buildInput({
      finalTestReliability: reliability,
    }));

    expect(result.finalTestReliability).toMatchObject({
      availability: "available",
      value: {
        groupDimension: "symbol",
        baselineMetricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY",
        finalTestRowCount: kernelResult.evidence.finalTest.metrics.sampleCount,
        groups: [expect.objectContaining({ symbol: "SYNTH" })],
      },
    });
    if (result.finalTestReliability.availability === "available") {
      expect(result.finalTestReliability.value.groups.reduce(
        (total, group) => total + group.finalTestRowCount,
        0,
      )).toBe(result.finalTestReliability.value.finalTestRowCount);
    }

    expect(() => buildPredictionRetrainingResultV1(buildInput({
      finalTestReliability: {
        ...reliability,
        finalTestRowCount: reliability.finalTestRowCount + 1,
      },
    }))).toThrow(/group counts .* differ from final-test row count/);
  });

  it("forwards per-symbol final-test economic edge without changing aggregate metrics or promotion", () => {
    const economicEvidence = kernelResult.finalTestEconomicEvidence;
    if (economicEvidence === undefined) throw new Error("kernel economic evidence is missing");
    const economicEdge = buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: economicEvidence,
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });
    const result = buildPredictionRetrainingResultV1(buildInput({ finalTestEconomicEdge: economicEdge }));

    expect(result.finalTestEconomicEdge).toMatchObject({
      availability: "available",
      value: {
        schemaVersion: "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1",
        evaluationPartition: "FINAL_TEST",
        finalTestRowCount: kernelResult.evidence.finalTest.metrics.sampleCount,
        groups: [expect.objectContaining({ symbol: "SYNTH" })],
      },
    });
    expect(result.finalTestMetrics).toEqual({
      availability: "available",
      value: kernelResult.evidence.finalTest.metrics,
    });
    expect(result.promotion.verdict).toBe(
      kernelResult.promotionDecision.status === "RESEARCH_CANDIDATE"
        ? "research_only"
        : "do_not_promote",
    );
    expect(result.promotion.automaticPromotion).toBe(false);
    expect(result.provenanceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "economic_edge",
        reference: "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1",
        sha256: economicEdge.normalizedResultSha256,
      }),
    ]));
  });

  it("forwards additive raw-vs-adjusted reconciliation without changing aggregate metrics or promotion", () => {
    const economicEvidence = kernelResult.finalTestEconomicEvidence;
    if (economicEvidence === undefined) throw new Error("kernel economic evidence is missing");
    const reconciliationEvidence = {
      ...economicEvidence,
      rows: economicEvidence.rows.map((row) => ({ ...row, symbol: "0050" })),
    };
    const reconciliation = reconcileFinalTestEconomicEdge({
      raw: {
        scenario: "0050_RAW",
        sourceDataQualityClassification: "RAW_UNADJUSTED_PRICE_PATH",
        sourceEvidenceReference: "test-owned/raw",
        finalTestEvidence: reconciliationEvidence,
        dataQualityFindings: [],
        corporateActionWarnings: [],
      },
      adjusted: {
        scenario: "0050_SOURCE_QUALIFIED_ADJUSTED",
        sourceDataQualityClassification: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        sourceEvidenceReference: "test-owned/adjusted",
        finalTestEvidence: reconciliationEvidence,
        dataQualityFindings: [],
        corporateActionWarnings: [],
      },
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });
    const result = buildPredictionRetrainingResultV1(buildInput({
      finalTestEconomicReconciliation: reconciliation,
    }));

    expect(result.finalTestEconomicReconciliation).toMatchObject({
      schemaVersion: "MMS_0050_RAW_ADJUSTED_ECONOMIC_EDGE_RECONCILIATION_V1",
      classification: reconciliation.classification,
      commonWindowCheck: { status: "IDENTICAL" },
    });
    expect(result.finalTestMetrics).toEqual({
      availability: "available",
      value: kernelResult.evidence.finalTest.metrics,
    });
    expect(result.promotion.verdict).toBe(
      kernelResult.promotionDecision.status === "RESEARCH_CANDIDATE"
        ? "research_only"
        : "do_not_promote",
    );
    expect(result.provenanceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "economic_edge",
        reference: "MMS_0050_RAW_ADJUSTED_ECONOMIC_EDGE_RECONCILIATION_V1",
        sha256: reconciliation.normalizedResultSha256,
      }),
    ]));
  });

  it("forwards per-symbol logistic challenger evidence without enabling promotion", () => {
    const challenger = kernelResult.perSymbolLogisticChallenger;
    const economicEvidence = kernelResult.finalTestEconomicEvidence;
    if (challenger === undefined || economicEvidence === undefined) {
      throw new Error("per-symbol challenger evidence is missing");
    }
    const challengerResult = buildPerSymbolLogisticChallengerEvaluation({
      challenger,
      incumbentEvidence: kernelResult.evidence,
      incumbentFinalTestEconomicEvidence: economicEvidence,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });
    const result = buildPredictionRetrainingResultV1(buildInput({
      perSymbolLogisticChallenger: challengerResult,
    }));

    expect(result.perSymbolLogisticChallenger).toMatchObject({
      availability: "available",
      value: {
        schemaVersion: "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1",
        candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        groups: [expect.objectContaining({ symbol: "SYNTH" })],
        promotionDecision: "do_not_promote",
      },
    });
    expect(result.promotion.automaticPromotion).toBe(false);
    expect(result.promotion.manualApprovalRequired).toBe(true);
    expect(result.provenanceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "challenger",
        reference: "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1",
        sha256: challengerResult.normalizedResultSha256,
      }),
    ]));
  });

  it("forwards the additive legacy feature challenger against its unchanged control", () => {
    const control = kernelResult.perSymbolLogisticChallenger;
    const challenger = kernelResult.perSymbolLogisticFeatureChallenger;
    if (control === undefined || challenger === undefined) {
      throw new Error("legacy feature challenger evidence is missing");
    }
    const resultValue = buildPerSymbolLogisticFeatureChallengerEvaluation({
      control,
      challenger,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });
    const result = buildPredictionRetrainingResultV1(buildInput({
      perSymbolLogisticChallenger: resultValue,
    }));

    expect(result.perSymbolLogisticChallenger).toMatchObject({
      availability: "available",
      value: {
        comparisonBaseline: "PER_SYMBOL_CONTROL",
        controlFeatureNames: [
          "return_5d",
          "return_20d",
          "volatility_10d",
          "volume_ratio_20d",
          "drawdown_20d",
        ],
        featureNames: [
          "return_5d",
          "return_20d",
          "volatility_10d",
          "volume_ratio_20d",
          "drawdown_20d",
          "breakout_20d_high",
        ],
        featureFamily: {
          featureFamilyName: "legacy_breakout_20d_high",
          newFeatureFields: ["breakout_20d_high"],
        },
        promotionDecision: "do_not_promote",
      },
    });
    expect(result.promotion.automaticPromotion).toBe(false);
    expect(result.provenanceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "challenger",
        reference: "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1",
        sha256: resultValue.normalizedResultSha256,
      }),
    ]));
  });

  it("fails closed when selection or final-test boundary semantics are violated", () => {
    const invalidSelection = {
      ...kernelResult.evidence,
      thresholdSelection: {
        ...kernelResult.evidence.thresholdSelection,
        selectionPartition: "FINAL_TEST",
      },
    } as unknown as ExperimentRunEvidence;

    expect(() => buildPredictionRetrainingResultV1(buildInput({ evidence: invalidSelection })))
      .toThrow(/threshold selection must use the VALIDATION partition/);
  });

  it("defaults promotion to do_not_promote and exposes missing evidence", () => {
    const result = buildPredictionRetrainingResultV1({
      runId: "missing-evidence-run",
      generatedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(result.promotion).toMatchObject({
      verdict: "do_not_promote",
      upstreamStatus: null,
      automaticPromotion: false,
      manualApprovalRequired: true,
    });
    expect(result.finalTestMetrics).toEqual({
      availability: "unavailable",
      reason: "No ExperimentRunEvidence was supplied.",
    });
    expect(result.latestPredictions.availability).toBe("unavailable");
    expect(result.simulation.availability).toBe("unavailable");
    expect(result.unavailableFields.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["dataAsOf", "dataset", "finalTestMetrics", "latestPredictions", "simulation"]),
    );
  });

  it("does not fabricate a threshold/cost grid from a single simulation result", () => {
    const result = buildPredictionRetrainingResultV1(buildInput());

    expect(result.simulation).toMatchObject({
      availability: "available",
      value: {
        evaluatedThreshold: simulation.validationThreshold,
        roundTripCostBps: simulation.roundTripCostBps,
        excessReturn: simulation.excessReturn,
      },
    });
    if (result.simulation.availability === "available") {
      expect(result.simulation.value).not.toHaveProperty("candidateThresholds");
      expect(result.simulation.value).not.toHaveProperty("costGrid");
      expect(Object.keys(result.simulation.value.strategy)).toEqual([
        "maximumDrawdown",
        "policy",
        "totalReturn",
        "totalTransactionCost",
      ]);
    }
  });

  it("reads only latest per-symbol records and preserves the source artifact", () => {
    const artifact: LegacyLatestPredictionArtifact = {
      schemaVersion: "p193.latest_predictions.1",
      runId: "p193-real-ohlcv-example",
      sourceSha256: "source-sha256",
      dataEndDate: "2026-07-01",
      openPredictions: [
        {
          symbol: "0050",
          featureDate: "2026-06-30",
          probabilityUp: 0.54,
          predictedDirection: "up",
          close: 107.8,
          isLatest: false,
        },
        {
          symbol: "0056",
          featureDate: "2026-07-01",
          probabilityUp: 0.55,
          predictedDirection: "up",
          close: 52.75,
          isLatest: true,
        },
        {
          symbol: "0050",
          featureDate: "2026-07-01",
          probabilityUp: 0.56,
          predictedDirection: "up",
          close: 109.35,
          isLatest: true,
        },
      ],
    };
    const before = JSON.stringify(artifact);

    const latest = readLatestPredictionsArtifact(artifact);

    expect(latest.map(({ symbol }) => symbol)).toEqual(["0050", "0056"]);
    expect(JSON.stringify(artifact)).toBe(before);
    expect(Object.isFrozen(latest)).toBe(true);

    const result = buildPredictionRetrainingResultV1(buildInput({ latestPredictions: latest }));
    expect(result.latestPredictions).toMatchObject({
      availability: "available",
      value: expect.arrayContaining([
        expect.objectContaining({ symbol: "0050", featureDate: "2026-07-01" }),
        expect.objectContaining({ symbol: "0056", featureDate: "2026-07-01" }),
      ]),
    });
    if (result.latestPredictions.availability === "available") {
      expect(result.latestPredictions.value.every(({ operativeThreshold }) =>
        operativeThreshold.availability === "unavailable")).toBe(true);
    }
  });

  it("keeps source artifacts immutable while building the sample", () => {
    const input = buildInput();
    const before = JSON.stringify(input);

    const result = buildPredictionRetrainingResultV1(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result).not.toBe(input);
    expect(result.guardrails.providesInvestmentRecommendation).toBe(false);
  });
});
