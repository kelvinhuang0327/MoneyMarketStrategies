import {
  fail,
  type FeatureRow,
  type FinalTestEconomicEvidence,
  type FinalTestScoredRow,
} from "./types.js";

/**
 * Converts an already-scored FINAL_TEST pass into the replay-only evidence
 * consumed by the canonical strategy simulator. No fitting or threshold
 * selection occurs here.
 */
export function buildFinalTestEconomicEvidence(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
  frozenThreshold: number,
  finalTestRowsSha256: string,
  finalTestScoredRowsSha256: string,
): FinalTestEconomicEvidence {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test economic evidence rows and scored rows must have identical lengths");
  }
  const rows = finalTestRows.map((row, index) => {
    const scored = scoredRows[index];
    if (scored === undefined) fail("final-test economic evidence scored row is missing");
    if (
      row.symbol !== scored.symbol
      || row.featureDate !== scored.featureDate
      || row.targetDate !== scored.targetDate
      || row.target !== scored.target
    ) {
      fail("final-test economic evidence rows are not aligned with the scored pass");
    }
    return Object.freeze({
      symbol: row.symbol,
      featureDate: row.featureDate,
      targetDate: row.targetDate,
      target: row.target,
      forwardReturn: row.forwardReturn,
      probabilityUp: scored.probability,
      prediction: scored.prediction,
    });
  });
  return Object.freeze({
    evaluationPartition: "FINAL_TEST",
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
    frozenThreshold,
    finalTestRowCount: finalTestRows.length,
    rows: Object.freeze(rows),
  });
}
