import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  hashValue,
  runResearchEvidenceKernel,
  type MarketDataRow,
} from "./index.js";

function deterministicRows(): MarketDataRow[] {
  const start = Date.UTC(2022, 0, 1);
  return Array.from({ length: 110 }, (_, index) => {
    const close = 120 + Math.sin(index * Math.PI / 10) * 9 + index * 0.04;
    return {
      symbol: "DETERMINISTIC",
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open: close - 0.15,
      high: close + 0.7,
      low: close - 0.7,
      close,
      volume: 1100 + (index % 7) * 23,
      source: "test-owned/in-memory",
    };
  });
}

function invokeIndependently() {
  return runResearchEvidenceKernel({
    datasetVersion: {
      datasetId: "determinism-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    marketRows: deterministicRows(),
    logisticRegression: {
      iterations: 500,
      learningRate: 0.08,
      l2: 0.01,
    },
  });
}

describe("deterministic evidence identities", () => {
  it("matches a known SHA-256 vector for canonical JSON text", () => {
    expect(hashValue("abc"))
      .toBe("6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25");
  });

  it("reproduces every required SHA-256 identity across independent invocations", () => {
    const first = invokeIndependently();
    const second = invokeIndependently();
    const firstHashes = {
      dataset: first.evidence.datasetSha256,
      features: first.evidence.featureRowsSha256,
      training: first.evidence.split.trainingRowsSha256,
      scaler: first.evidence.fit.scalerStateSha256,
      model: first.evidence.fit.modelStateSha256,
      validationCandidates: first.evidence.thresholdSelection.validationCandidateStateSha256,
      finalTestScoredRows: first.evidence.finalTest.finalTestScoredRowsSha256,
      normalizedEvidence: first.evidence.normalizedEvidenceSha256,
    };
    const secondHashes = {
      dataset: second.evidence.datasetSha256,
      features: second.evidence.featureRowsSha256,
      training: second.evidence.split.trainingRowsSha256,
      scaler: second.evidence.fit.scalerStateSha256,
      model: second.evidence.fit.modelStateSha256,
      validationCandidates: second.evidence.thresholdSelection.validationCandidateStateSha256,
      finalTestScoredRows: second.evidence.finalTest.finalTestScoredRowsSha256,
      normalizedEvidence: second.evidence.normalizedEvidenceSha256,
    };

    expect(secondHashes).toEqual(firstHashes);
    expect(Object.values(firstHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(canonicalStringify(second.evidence)).toBe(canonicalStringify(first.evidence));
  });
});
