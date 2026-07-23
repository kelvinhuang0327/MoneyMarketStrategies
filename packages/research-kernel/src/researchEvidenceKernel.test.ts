import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  decidePromotion,
  runResearchEvidenceKernel,
  type MarketDataRow,
} from "./index.js";

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
  });

  it("returns byte-identical normalized evidence for identical explicit inputs", () => {
    const first = run();
    const second = run();

    expect(canonicalStringify(first.evidence)).toBe(canonicalStringify(second.evidence));
    expect(first.evidence.normalizedEvidenceSha256)
      .toBe(second.evidence.normalizedEvidenceSha256);
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
  });
});
