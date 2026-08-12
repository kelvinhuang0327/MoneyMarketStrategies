import {
  canonicalStringify,
  type FinalTestEconomicEvidence,
} from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  reconcileFinalTestEconomicEdge,
  type FinalTestEconomicReconciliationScenarioInput,
} from "./index.js";

function evidence(forwardReturns: readonly number[], featureDateOffset = 0): FinalTestEconomicEvidence {
  const rows = forwardReturns.map((forwardReturn, index) => {
    const entryDay = 1 + featureDateOffset + index * 8;
    const entryDate = `2025-01-${String(entryDay).padStart(2, "0")}`;
    const exitDate = `2025-01-${String(entryDay + 7).padStart(2, "0")}`;
    const probabilityUp = index === 1 ? 0.4 : 0.8;
    return {
      symbol: "0050",
      featureDate: entryDate,
      targetDate: exitDate,
      target: forwardReturn > 0 ? 1 : 0,
      forwardReturn,
      probabilityUp,
      prediction: probabilityUp >= 0.5 ? 1 : 0,
    } as const;
  });
  return {
    evaluationPartition: "FINAL_TEST",
    finalTestRowsSha256: "a".repeat(64),
    finalTestScoredRowsSha256: "b".repeat(64),
    frozenThreshold: 0.5,
    finalTestRowCount: rows.length,
    rows,
  };
}

function scenario(
  scenarioId: "0050_RAW" | "0050_SOURCE_QUALIFIED_ADJUSTED",
  sourceDataQualityClassification: "RAW_UNADJUSTED_PRICE_PATH" | "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
  finalTestEvidence: FinalTestEconomicEvidence,
): FinalTestEconomicReconciliationScenarioInput {
  return {
    scenario: scenarioId,
    sourceDataQualityClassification,
    sourceEvidenceReference: `${scenarioId}:test-owned/in-memory`,
    finalTestEvidence,
    dataQualityFindings: [],
    corporateActionWarnings: ["test-owned corporate-action warning"],
  };
}

describe("reconcileFinalTestEconomicEdge", () => {
  it("compares identical frozen FINAL_TEST windows and classifies a removed positive edge", () => {
    const raw = evidence([0.1, 0.1, -0.05]);
    const adjusted = evidence([-0.1, 0.1, -0.05]);
    const sourceBefore = canonicalStringify({ raw, adjusted });
    const first = reconcileFinalTestEconomicEdge({
      raw: scenario("0050_RAW", "RAW_UNADJUSTED_PRICE_PATH", raw),
      adjusted: scenario(
        "0050_SOURCE_QUALIFIED_ADJUSTED",
        "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        adjusted,
      ),
      roundTripCostBps: 10,
      initialCapital: 100,
    });
    const second = reconcileFinalTestEconomicEdge({
      raw: scenario("0050_RAW", "RAW_UNADJUSTED_PRICE_PATH", raw),
      adjusted: scenario(
        "0050_SOURCE_QUALIFIED_ADJUSTED",
        "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        adjusted,
      ),
      roundTripCostBps: 10,
      initialCapital: 100,
    });

    expect(first.classification).toBe("DATA_QUALITY_ARTIFACT");
    expect(first.commonWindowCheck.status).toBe("IDENTICAL");
    expect(first.raw.finalTestRowCount).toBe(3);
    expect(first.adjusted.finalTestRowCount).toBe(3);
    expect(first.raw.predictionSource).toBe("MMS_RESEARCH_EVIDENCE_V1_FINAL_TEST_SCORED_ROWS");
    expect(first.adjusted.positionSource).toBe(
      "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1_FROZEN_THRESHOLD_DECISION",
    );
    expect(first.rawVsAdjusted.benchmarkReturnDelta).toBe(
      Number((first.adjusted.benchmarkNetReturn - first.raw.benchmarkNetReturn).toFixed(8)),
    );
    expect(first.rawVsAdjusted.excessReturnDelta).toBe(
      Number((first.adjusted.excessReturn - first.raw.excessReturn).toFixed(8)),
    );
    expect(first.promotionDecision).toBe("do_not_promote");
    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(canonicalStringify({ raw, adjusted })).toBe(sourceBefore);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.raw)).toBe(true);
  });

  it("fails closed to UNRESOLVED_COMPARABILITY when the final-test windows differ", () => {
    const result = reconcileFinalTestEconomicEdge({
      raw: scenario("0050_RAW", "RAW_UNADJUSTED_PRICE_PATH", evidence([0.1, 0.1, -0.05])),
      adjusted: scenario(
        "0050_SOURCE_QUALIFIED_ADJUSTED",
        "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        evidence([-0.1, 0.1, -0.05], 1),
      ),
      roundTripCostBps: 10,
      initialCapital: 100,
    });

    expect(result.classification).toBe("UNRESOLVED_COMPARABILITY");
    expect(result.commonWindowCheck.status).toBe("UNRESOLVED");
    expect(result.commonWindowCheck.reason).toMatch(/date keys differ/);
    expect(result.rawVsAdjusted).toEqual({
      benchmarkReturnDelta: null,
      strategyReturnDelta: null,
      excessReturnDelta: null,
    });
  });
});
