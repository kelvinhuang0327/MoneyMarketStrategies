import { describe, expect, it } from "vitest";

import {
  buildPredictionRetrainingResultV1,
  readLatestPredictionsArtifact,
  readPredictionRetrainingResultArtifact,
  PredictionRetrainingResultContractError,
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

describe("readPredictionRetrainingResultArtifact", () => {
  it("round-trips valid builder output from JSON string and parsed object", () => {
    const original = buildPredictionRetrainingResultV1(buildInput({
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

    const serialized = JSON.stringify(original);
    const fromString = readPredictionRetrainingResultArtifact(serialized);
    expect(fromString).toEqual(original);

    const parsed = JSON.parse(serialized);
    const fromObject = readPredictionRetrainingResultArtifact(parsed);
    expect(fromObject).toEqual(original);
  });

  it("ensures deep freeze and defensive cloning from parsed object input", () => {
    const original = buildPredictionRetrainingResultV1(buildInput());
    const parsed = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;

    const result = readPredictionRetrainingResultArtifact(parsed);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.partitions)).toBe(true);
    expect(Object.isFrozen(result.promotion)).toBe(true);
    expect(Object.isFrozen(result.guardrails)).toBe(true);
    expect(Object.isFrozen(result.provenanceReferences)).toBe(true);

    // Mutate caller input
    parsed["runId"] = "TAMPERED_RUN_ID";
    const partitions = parsed["partitions"] as Record<string, unknown>;
    const purgeRowCounts = partitions["purgeRowCounts"] as Record<string, unknown>;
    const trainValidation = purgeRowCounts["trainValidation"] as Record<string, unknown>;
    trainValidation["value"] = 9999;
    const guardrails = parsed["guardrails"] as Record<string, unknown>;
    guardrails["providesInvestmentRecommendation"] = true;

    expect(result.runId).toBe(original.runId);
    expect(result.partitions.purgeRowCounts.trainValidation).toEqual(
      original.partitions.purgeRowCounts.trainValidation,
    );
    expect(result.guardrails.providesInvestmentRecommendation).toBe(false);
  });

  it("fails closed with PredictionRetrainingResultContractError on malformed JSON string", () => {
    expect(() => readPredictionRetrainingResultArtifact("{invalid json"))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact("{invalid json"))
      .toThrow(/malformed JSON input/);
  });

  it("fails closed on non-object or invalid input types", () => {
    expect(() => readPredictionRetrainingResultArtifact(null))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact(12345))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact([]))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact(true))
      .toThrow(PredictionRetrainingResultContractError);
  });

  it("fails closed on schema version mismatch, missing, or blank", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput())));

    expect(() => readPredictionRetrainingResultArtifact({ ...valid, schemaVersion: "INVALID_VERSION" }))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact({ ...valid, schemaVersion: "" }))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact({ ...valid, schemaVersion: undefined }))
      .toThrow(PredictionRetrainingResultContractError);
    expect(() => readPredictionRetrainingResultArtifact({ ...valid, schemaVersion: 123 }))
      .toThrow(PredictionRetrainingResultContractError);
  });

  it("fails closed on guardrail tampering", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput())));

    expect(() => readPredictionRetrainingResultArtifact({
      ...valid,
      guardrails: { ...valid.guardrails, providesInvestmentRecommendation: true },
    })).toThrow(PredictionRetrainingResultContractError);

    expect(() => readPredictionRetrainingResultArtifact({
      ...valid,
      guardrails: { ...valid.guardrails, supportsOrderExecution: true },
    })).toThrow(PredictionRetrainingResultContractError);

    expect(() => readPredictionRetrainingResultArtifact({
      ...valid,
      guardrails: { ...valid.guardrails, supportsAutomaticPromotion: true },
    })).toThrow(PredictionRetrainingResultContractError);

    expect(() => readPredictionRetrainingResultArtifact({
      ...valid,
      promotion: { ...valid.promotion, automaticPromotion: true },
    })).toThrow(PredictionRetrainingResultContractError);

    expect(() => readPredictionRetrainingResultArtifact({
      ...valid,
      promotion: { ...valid.promotion, manualApprovalRequired: false },
    })).toThrow(PredictionRetrainingResultContractError);
  });

  it("fails closed on invalid promotion verdict", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput())));

    for (const invalidVerdict of ["BUY", "SELL", "STRONG_BUY", "AUTO_PROMOTE", "EXECUTE", ""]) {
      expect(() => readPredictionRetrainingResultArtifact({
        ...valid,
        promotion: { ...valid.promotion, verdict: invalidVerdict },
      })).toThrow(PredictionRetrainingResultContractError);
    }
  });

  it("fails closed on missing required load-bearing fields", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput())));

    const requiredFields = [
      "runId",
      "generatedAt",
      "dataAsOf",
      "dataset",
      "model",
      "retraining",
      "partitions",
      "thresholdSelection",
      "finalTestMetrics",
      "baselineMetrics",
      "finalTestReliability",
      "finalTestEconomicEdge",
      "perSymbolLogisticChallenger",
      "latestPredictions",
      "currentUnresolvedPredictions",
      "currentPredictionUnavailable",
      "simulation",
      "promotion",
      "warnings",
      "unavailableFields",
      "provenanceReferences",
      "guardrails",
    ] as const;

    for (const field of requiredFields) {
      const tampered = { ...valid };
      delete (tampered as Record<string, unknown>)[field];
      expect(() => readPredictionRetrainingResultArtifact(tampered))
        .toThrow(PredictionRetrainingResultContractError);
    }
  });

  it("fails closed on non-finite or out-of-domain numeric evidence", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput())));

    // Non-finite numbers in metrics / simulation
    const tamperedNaN = JSON.parse(JSON.stringify(valid));
    tamperedNaN.finalTestMetrics.value.accuracy = Number.NaN;
    expect(() => readPredictionRetrainingResultArtifact(tamperedNaN))
      .toThrow(PredictionRetrainingResultContractError);

    const tamperedInf = JSON.parse(JSON.stringify(valid));
    tamperedInf.simulation.value.excessReturn = Number.POSITIVE_INFINITY;
    expect(() => readPredictionRetrainingResultArtifact(tamperedInf))
      .toThrow(PredictionRetrainingResultContractError);

    // Probability out of [0, 1] range
    const tamperedProbHigh = JSON.parse(JSON.stringify(valid));
    tamperedProbHigh.thresholdSelection.value.selectedThreshold = 1.25;
    expect(() => readPredictionRetrainingResultArtifact(tamperedProbHigh))
      .toThrow(PredictionRetrainingResultContractError);

    const tamperedProbLow = JSON.parse(JSON.stringify(valid));
    tamperedProbLow.thresholdSelection.value.selectedThreshold = -0.05;
    expect(() => readPredictionRetrainingResultArtifact(tamperedProbLow))
      .toThrow(PredictionRetrainingResultContractError);
  });

  it("preserves deterministic output across repeated reads", () => {
    const valid = buildPredictionRetrainingResultV1(buildInput());
    const serialized = JSON.stringify(valid);

    const first = readPredictionRetrainingResultArtifact(serialized);
    const second = readPredictionRetrainingResultArtifact(serialized);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
  });

  it("round-trips rich research artifacts with all optional evidence components", () => {
    const reliability = kernelResult.finalTestReliability;
    if (reliability === undefined) throw new Error("kernel reliability fixture is missing");
    const economicEvidence = kernelResult.finalTestEconomicEvidence;
    if (economicEvidence === undefined) throw new Error("kernel economic evidence is missing");

    const economicEdge = buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: economicEvidence,
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });

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

    const challenger = kernelResult.perSymbolLogisticChallenger;
    if (challenger === undefined) throw new Error("challenger fixture is missing");
    const challengerResult = buildPerSymbolLogisticChallengerEvaluation({
      challenger,
      incumbentEvidence: kernelResult.evidence,
      incumbentFinalTestEconomicEvidence: economicEvidence,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });

    const rich = buildPredictionRetrainingResultV1(buildInput({
      finalTestReliability: reliability,
      finalTestEconomicEdge: economicEdge,
      finalTestEconomicReconciliation: reconciliation,
      perSymbolLogisticChallenger: challengerResult,
    }));

    const serialized = JSON.stringify(rich);
    const read = readPredictionRetrainingResultArtifact(serialized);
    expect(read).toEqual(rich);
  });

  it("fails closed when unresolved prediction in reader input contains future outcome", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput({
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
    })))) as Record<string, unknown>;

    const currentUnresolved = valid["currentUnresolvedPredictions"] as Record<string, unknown>;
    const value = currentUnresolved["value"] as unknown[];
    const firstPred = value[0] as Record<string, unknown>;
    firstPred["actualDirection"] = { availability: "available", value: "up" };

    expect(() => readPredictionRetrainingResultArtifact(valid))
      .toThrow(/unresolved predictions must not contain actualDirection/);
  });

  it("fails closed when partition chronological order is inverted", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput()))) as Record<string, unknown>;
    const partitions = valid["partitions"] as Record<string, unknown>;
    const training = partitions["training"] as Record<string, unknown>;
    const validation = partitions["validation"] as Record<string, unknown>;
    const trainEndDate = training["endDate"] as Record<string, unknown>;
    const valStartDate = validation["startDate"] as Record<string, unknown>;

    // Invert: trainEndDate >= valStartDate
    trainEndDate["value"] = "2025-01-01";
    valStartDate["value"] = "2024-01-01";

    expect(() => readPredictionRetrainingResultArtifact(valid))
      .toThrow(/training endDate must precede validation startDate/);
  });

  it("fails closed when ResultContractField has invalid availability", () => {
    const valid = JSON.parse(JSON.stringify(buildPredictionRetrainingResultV1(buildInput()))) as Record<string, unknown>;
    const dataAsOf = valid["dataAsOf"] as Record<string, unknown>;
    dataAsOf["availability"] = "maybe";

    expect(() => readPredictionRetrainingResultArtifact(valid))
      .toThrow(/dataAsOf\.availability must be 'available' or 'unavailable'/);
  });
});
