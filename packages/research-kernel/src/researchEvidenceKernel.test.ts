import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  decidePromotion,
  hashValue,
  runResearchEvidenceKernel,
  type MarketDataRow,
} from "./index.js";
import { buildProbabilityCalibrationProfile } from "./buildProbabilityCalibrationProfile.js";
import { buildSymbolReliabilityProfile } from "./buildSymbolReliabilityProfile.js";
import type { FeatureRow, FinalTestScoredRow } from "./types.js";

function fixtureRows(count = 120): MarketDataRow[] {
  const rows: MarketDataRow[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const cycle = Math.sin(index * Math.PI / 9);
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

function run(rows: readonly MarketDataRow[] = fixtureRows()) {
  return runResearchEvidenceKernel({
    datasetVersion: {
      datasetId: "synthetic-cycle",
      version: "v1",
      source: "test-owned/in-memory",
    },
    marketRows: rows,
    logisticRegression: {
      iterations: 600,
      learningRate: 0.08,
      l2: 0.01,
    },
  });
}

function symbolReliabilityFixture(
  entries: readonly [string, 0 | 1, number, 0 | 1][],
): { rows: FeatureRow[]; scoredRows: FinalTestScoredRow[] } {
  return {
    rows: entries.map(([symbol, target], index) => ({
      symbol,
      featureDate: `2025-01-${String(index + 1).padStart(2, "0")}`,
      targetDate: `2025-02-${String(index + 1).padStart(2, "0")}`,
      featureSourceStartDate: "2025-01-01",
      featureSourceEndDate: "2025-01-01",
      features: [0, 0, 0, 0, 0],
      target,
      forwardReturn: target === 1 ? 0.01 : -0.01,
    })),
    scoredRows: entries.map(([symbol, target, probability, prediction], index) => ({
      symbol,
      featureDate: `2025-01-${String(index + 1).padStart(2, "0")}`,
      targetDate: `2025-02-${String(index + 1).padStart(2, "0")}`,
      target,
      probability,
      prediction,
    })),
  };
}

function probabilityCalibrationFixture(
  entries: readonly [number, 0 | 1][],
): { rows: FeatureRow[]; scoredRows: FinalTestScoredRow[] } {
  return {
    rows: entries.map(([, target], index) => ({
      symbol: "CALIBRATION",
      featureDate: `2025-03-${String(index + 1).padStart(2, "0")}`,
      targetDate: `2025-04-${String(index + 1).padStart(2, "0")}`,
      featureSourceStartDate: "2025-03-01",
      featureSourceEndDate: "2025-03-01",
      features: [0, 0, 0, 0, 0],
      target,
      forwardReturn: target === 1 ? 0.01 : -0.01,
    })),
    scoredRows: entries.map(([probability, target], index) => ({
      symbol: "CALIBRATION",
      featureDate: `2025-03-${String(index + 1).padStart(2, "0")}`,
      targetDate: `2025-04-${String(index + 1).padStart(2, "0")}`,
      target,
      probability,
      prediction: probability >= 0.5 ? 1 : 0,
    })),
  };
}

describe("research evidence kernel", () => {
  it("produces non-empty training, validation, both purge, and final-test evidence", () => {
    const { evidence } = run();

    expect(evidence.split.trainingRowCount).toBeGreaterThan(0);
    expect(evidence.split.trainValidationPurgeRowCount).toBeGreaterThan(0);
    expect(evidence.split.validationRowCount).toBeGreaterThan(0);
    expect(evidence.split.validationFinalPurgeRowCount).toBeGreaterThan(0);
    expect(evidence.split.finalTestRowCount).toBeGreaterThan(0);
  });

  it("proves scaler and model identities reference training rows only", () => {
    const { evidence } = run();

    expect(evidence.fit.fitPartition).toBe("TRAINING");
    expect(evidence.fit.trainingRowsSha256).toBe(evidence.split.trainingRowsSha256);
    expect(evidence.fit.scalerFitRowCount).toBe(evidence.split.trainingRowCount);
    expect(evidence.fit.modelFitRowCount).toBe(evidence.split.trainingRowCount);
  });

  it("selects the frozen threshold from validation candidates only", () => {
    const { evidence } = run();

    expect(evidence.thresholdSelection.selectionPartition).toBe("VALIDATION");
    expect(evidence.thresholdSelection.candidates.map(({ threshold }) => threshold))
      .toEqual(evidence.thresholdSelection.fixedThresholdGrid);
    expect(evidence.thresholdSelection.fixedThresholdGrid)
      .toContain(evidence.thresholdSelection.selectedThreshold);
    expect(evidence.thresholdSelection.validationRowsSha256)
      .not.toBe(evidence.finalTest.finalTestRowsSha256);
    expect(evidence.finalTest.frozenThreshold)
      .toBe(evidence.thresholdSelection.selectedThreshold);
  });

  it("evaluates the untouched final test exactly once", () => {
    const { evidence } = run();

    expect(evidence.finalTest.evaluationPartition).toBe("FINAL_TEST");
    expect(evidence.finalTest.evaluatorExecutionCount).toBe(1);
    expect(evidence.finalTest.metrics.sampleCount).toBe(evidence.split.finalTestRowCount);
    expect(evidence.finalTest.symbolReliability).toBeDefined();
    expect(evidence.finalTest.probabilityCalibration).toBeDefined();
    expect(evidence.finalTest.probabilityCalibration.brierScore).toBeNull();
  });

  it("calculates fixed-bin calibration metrics from hand-checked pairs", () => {
    const fixture = probabilityCalibrationFixture([
      [0.5, 1],
      [0.54, 0],
      [0.55, 1],
      [0.59, 0],
      [0.6, 1],
      [0.65, 1],
      [0.7, 0],
      [0.75, 1],
      [1, 0],
    ]);

    const profile = buildProbabilityCalibrationProfile(fixture.rows, fixture.scoredRows, 0.32524444);

    expect(profile.resolvedPairCount).toBe(9);
    expect(profile.meanProbabilityUp).toBe(0.65333333);
    expect(profile.actualUpRate).toBe(0.55555556);
    expect(profile.brierScore).toBe(0.32524444);
    expect(profile.expectedCalibrationError).toBe(0.26444444);
    expect(profile.maximumCalibrationGap).toBe(0.7);
    expect(profile.bins.map(({ lowerBound, upperBound, resolvedPairCount }) =>
      ({ lowerBound, upperBound, resolvedPairCount }))).toEqual([
      { lowerBound: 0.5, upperBound: 0.55, resolvedPairCount: 2 },
      { lowerBound: 0.55, upperBound: 0.6, resolvedPairCount: 2 },
      { lowerBound: 0.6, upperBound: 0.65, resolvedPairCount: 1 },
      { lowerBound: 0.65, upperBound: 0.7, resolvedPairCount: 1 },
      { lowerBound: 0.7, upperBound: 0.75, resolvedPairCount: 1 },
      { lowerBound: 0.75, upperBound: null, resolvedPairCount: 2 },
    ]);
  });

  it("uses legacy lower-inclusive and finite-upper-exclusive boundaries", () => {
    const fixture = probabilityCalibrationFixture([
      [0.5, 1],
      [0.54999999, 1],
      [0.55, 1],
      [0.59999999, 1],
      [0.6, 1],
      [0.64999999, 1],
      [0.65, 1],
      [0.69999999, 1],
      [0.7, 1],
      [0.74999999, 1],
      [0.75, 1],
      [1, 1],
    ]);

    expect(buildProbabilityCalibrationProfile(fixture.rows, fixture.scoredRows, 0).bins)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ lowerBound: 0.5, upperBound: 0.55, resolvedPairCount: 2 }),
        expect.objectContaining({ lowerBound: 0.55, upperBound: 0.6, resolvedPairCount: 2 }),
        expect.objectContaining({ lowerBound: 0.6, upperBound: 0.65, resolvedPairCount: 2 }),
        expect.objectContaining({ lowerBound: 0.65, upperBound: 0.7, resolvedPairCount: 2 }),
        expect.objectContaining({ lowerBound: 0.7, upperBound: 0.75, resolvedPairCount: 2 }),
        expect.objectContaining({ lowerBound: 0.75, upperBound: null, resolvedPairCount: 2 }),
      ]));
  });

  it("keeps empty bins canonical and excludes unsupported probabilities without sentinels", () => {
    const fixture = probabilityCalibrationFixture([
      [0.4, 1],
      [0.5, 0],
      [0.8, 1],
    ]);

    const profile = buildProbabilityCalibrationProfile(fixture.rows, fixture.scoredRows, 0.2);

    expect(profile.resolvedPairCount).toBe(2);
    expect(profile.brierScore).toBeNull();
    expect(profile.bins).toHaveLength(6);
    expect(profile.bins[1]).toMatchObject({
      lowerBound: 0.55,
      upperBound: 0.6,
      resolvedPairCount: 0,
      meanProbabilityUp: null,
      actualUpRate: null,
      calibrationGap: null,
    });
    expect(profile.caveats).toContain(
      "Final-test probabilities below 0.5 are outside the pinned legacy calibration domain and are excluded as unresolved.",
    );
  });

  it("does not consume forward returns or frozen predictions", () => {
    const fixture = probabilityCalibrationFixture([
      [0.5, 1],
      [0.75, 0],
    ]);
    const baseline = buildProbabilityCalibrationProfile(fixture.rows, fixture.scoredRows, 0.25);
    const changedRows = fixture.rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * 100 }));
    const changedScoredRows = fixture.scoredRows.map((row) => ({ ...row, prediction: row.prediction === 1 ? 0 : 1 }));

    expect(buildProbabilityCalibrationProfile(changedRows, changedScoredRows, 0.25))
      .toEqual(baseline);
  });

  it("calculates hand-checked symbol reliability metrics and status", () => {
    const fixture = symbolReliabilityFixture([
      ["BETA", 1, 0.8, 1],
      ["ALPHA", 0, 0.1, 0],
      ["BETA", 1, 0.7, 1],
      ["ALPHA", 1, 0.6, 0],
      ["BETA", 0, 0.4, 0],
      ["ALPHA", 0, 0.4, 1],
      ["ALPHA", 1, 0.5, 1],
      ["GAMMA", 1, 0.9, 1],
      ["GAMMA", 0, 0.1, 1],
    ]);

    const profile = buildSymbolReliabilityProfile(fixture.rows, fixture.scoredRows);

    expect(profile.rows).toEqual([
      expect.objectContaining({
        symbol: "ALPHA",
        resolvedPairCount: 4,
        correctRate: 0.5,
        actualUpRate: 0.5,
        meanProbabilityUp: 0.4,
        calibrationGap: 0.1,
        predictedUpCount: 2,
      }),
      expect.objectContaining({
        symbol: "BETA",
        resolvedPairCount: 3,
        correctRate: 1,
        actualUpRate: 0.66666667,
        meanProbabilityUp: 0.63333333,
        calibrationGap: 0.03333333,
        predictedUpCount: 2,
      }),
      expect.objectContaining({
        symbol: "GAMMA",
        resolvedPairCount: 2,
        correctRate: 0.5,
        actualUpRate: 0.5,
        meanProbabilityUp: 0.5,
        calibrationGap: 0,
        predictedUpCount: 2,
      }),
    ]);
    expect(profile.rows.find((row) => row.symbol === "GAMMA")?.warnings)
      .toEqual({ lowSample: true, poorCalibration: false });
    expect(profile.status).toMatchObject({
      enoughSymbols: true,
      minPairCount: 3,
      worstCalibrationSymbol: "ALPHA",
      bestHitRateSymbol: "BETA",
    });
  });

  it("applies warning boundaries, deterministic ordering, and tie-breaking", () => {
    const boundary = symbolReliabilityFixture([
      ["BOUNDARY", 1, 0.75, 1],
      ["BOUNDARY", 1, 0.75, 1],
      ["BOUNDARY", 1, 0.75, 1],
      ["BOUNDARY", 1, 0.75, 1],
      ["BELOW", 1, 0.750000001, 1],
      ["BELOW", 1, 0.750000001, 1],
      ["BELOW", 1, 0.750000001, 1],
      ["BELOW", 1, 0.750000001, 1],
      ["ALPHA", 1, 0.5, 1],
      ["ALPHA", 0, 0.5, 0],
      ["ALPHA", 1, 0.5, 0],
      ["BETA", 1, 0.5, 1],
      ["BETA", 0, 0.5, 0],
      ["BETA", 1, 0.5, 0],
    ]);
    const boundaryProfile = buildSymbolReliabilityProfile(boundary.rows, boundary.scoredRows);
    expect(boundaryProfile.rows.find((row) => row.symbol === "BOUNDARY")?.warnings)
      .toEqual({ lowSample: false, poorCalibration: true });
    expect(boundaryProfile.rows.find((row) => row.symbol === "BELOW")?.warnings)
      .toEqual({ lowSample: false, poorCalibration: false });
    expect(boundaryProfile.rows.slice(-2).map((row) => row.symbol)).toEqual(["ALPHA", "BETA"]);

    const lexicalTie = symbolReliabilityFixture([
      ["BETA", 1, 0.5, 1],
      ["ALPHA", 0, 0.5, 0],
      ["BETA", 0, 0.5, 1],
      ["ALPHA", 1, 0.5, 0],
      ["BETA", 1, 0.5, 0],
      ["ALPHA", 0, 0.5, 1],
    ]);
    const lexicalTieProfile = buildSymbolReliabilityProfile(lexicalTie.rows, lexicalTie.scoredRows);
    expect(lexicalTieProfile.status.worstCalibrationSymbol).toBe("ALPHA");
    expect(lexicalTieProfile.status.bestHitRateSymbol).toBe("ALPHA");

    const sampleTie = symbolReliabilityFixture([
      ["SMALL", 1, 0.5, 1],
      ["SMALL", 0, 0.5, 0],
      ["SMALL", 1, 0.5, 0],
      ["LARGE", 1, 0.5, 1],
      ["LARGE", 0, 0.5, 1],
      ["LARGE", 1, 0.5, 1],
      ["LARGE", 0, 0.5, 0],
      ["LARGE", 1, 0.5, 1],
      ["LARGE", 0, 0.5, 1],
    ]);
    expect(buildSymbolReliabilityProfile(sampleTie.rows, sampleTie.scoredRows).status.bestHitRateSymbol)
      .toBe("LARGE");
  });

  it("sets enoughSymbols only after two symbols meet the minimum sample", () => {
    const oneSymbol = symbolReliabilityFixture([
      ["ONLY", 1, 0.5, 1],
      ["ONLY", 0, 0.5, 0],
      ["ONLY", 1, 0.5, 1],
    ]);
    expect(buildSymbolReliabilityProfile(oneSymbol.rows, oneSymbol.scoredRows).status.enoughSymbols)
      .toBe(false);
  });

  it("returns byte-identical normalized evidence for identical explicit inputs", () => {
    const first = run();
    const second = run();

    expect(canonicalStringify(first.evidence)).toBe(canonicalStringify(second.evidence));
    expect(first.evidence.normalizedEvidenceSha256)
      .toBe(second.evidence.normalizedEvidenceSha256);
    expect(first.evidence.finalTest.symbolReliability)
      .toEqual(second.evidence.finalTest.symbolReliability);
  });

  it("includes final-test symbol evidence in the normalized evidence hash", () => {
    const { evidence } = run();
    const { normalizedEvidenceSha256, ...normalized } = evidence;
    void normalizedEvidenceSha256;
    const firstHash = hashValue(normalized);
    const firstRow = normalized.finalTest.symbolReliability.rows[0];
    if (firstRow === undefined) throw new Error("symbol reliability fixture row is missing");
    const changed = {
      ...normalized,
      finalTest: {
        ...normalized.finalTest,
        symbolReliability: {
          ...normalized.finalTest.symbolReliability,
          rows: [
            { ...firstRow, correctRate: firstRow.correctRate + 0.00000001 },
            ...normalized.finalTest.symbolReliability.rows.slice(1),
          ],
        },
      },
    };
    expect(hashValue(changed)).not.toBe(firstHash);
  });

  it("includes final-test probability calibration in the normalized evidence hash", () => {
    const { evidence } = run();
    const { normalizedEvidenceSha256, ...normalized } = evidence;
    void normalizedEvidenceSha256;
    const firstHash = hashValue(normalized);
    const changed = {
      ...normalized,
      finalTest: {
        ...normalized.finalTest,
        probabilityCalibration: {
          ...normalized.finalTest.probabilityCalibration,
          expectedCalibrationError: (normalized.finalTest.probabilityCalibration.expectedCalibrationError ?? 0) + 0.00000001,
        },
      },
    };
    expect(hashValue(changed)).not.toBe(firstHash);
  });

  it("returns a research candidate only when final evidence beats its baseline", () => {
    const result = run();

    expect(result.evidence.finalTest.metrics.accuracy)
      .toBeGreaterThan(result.evidence.finalTest.metrics.majorityBaseline);
    expect(result.promotionDecision).toMatchObject({
      status: "RESEARCH_CANDIDATE",
      automaticPromotion: false,
      manualApprovalRequired: true,
    });
  });

  it("blocks a final result that equals its required majority baseline", () => {
    const { evidence } = run();
    const equalToBaselineEvidence = {
      ...evidence,
      finalTest: {
        ...evidence.finalTest,
        metrics: {
          ...evidence.finalTest.metrics,
          accuracy: evidence.finalTest.metrics.majorityBaseline,
        },
      },
    };

    expect(decidePromotion(equalToBaselineEvidence).status)
      .toBe("BLOCKED_UNDERPERFORMS_BASELINE");
  });

  it("blocks promotion when deterministic identity evidence is incomplete", () => {
    const { evidence } = run();
    const incompleteEvidence = {
      ...evidence,
      normalizedEvidenceSha256: "missing",
    };

    expect(decidePromotion(incompleteEvidence).status)
      .toBe("BLOCKED_INSUFFICIENT_EVIDENCE");
  });

  it("blocks promotion when a price discontinuity is detected", () => {
    const rows = fixtureRows();
    const row = rows[70];
    if (row === undefined) throw new Error("test fixture row is missing");
    rows[70] = {
      ...row,
      open: row.open * 2,
      high: row.high * 2,
      low: row.low * 2,
      close: row.close * 2,
    };

    const result = run(rows);

    expect(result.evidence.dataQualityFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNADJUSTED_PRICE_DISCONTINUITY_RISK" }),
    ]));
    expect(result.promotionDecision.status).toBe("BLOCKED_DATA_QUALITY");
  });

  it("keeps the returned evidence immutable", () => {
    const { evidence } = run();

    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.metrics)).toBe(true);
    expect(Object.isFrozen(evidence.thresholdSelection.candidates)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.symbolReliability)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.symbolReliability.rows)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.symbolReliability.rows[0])).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.symbolReliability.status)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.probabilityCalibration)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.probabilityCalibration.bins)).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.probabilityCalibration.bins[0])).toBe(true);
    expect(Object.isFrozen(evidence.finalTest.probabilityCalibration.caveats)).toBe(true);
  });
});
