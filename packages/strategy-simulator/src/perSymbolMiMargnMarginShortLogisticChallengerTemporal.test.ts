import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  CANONICAL_TRANSACTION_COST_BPS,
  parseTwStrategyResearchCsvText,
  parseTwseMiMargnCsvText,
  RESEARCH_FEATURE_NAMES,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  TWSE_MI_MARGN_FEATURE_FIELDS,
  validateTwStrategyResearchRows,
} from "@mms/research-kernel";
import {
  runPerSymbolMiMargnMarginShortLogisticChallengerTemporal,
  type MiMargnMarginShortTemporalInput,
} from "./perSymbolMiMargnMarginShortLogisticChallengerTemporal.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadCanonicalInput(): MiMargnMarginShortTemporalInput {
  const ohlcvPath = "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System/outputs/retraining/p194_twstock_ohlcv_export.csv";
  const miMargnPath = path.resolve("outputs/retraining/p197_0056_twse_mi_margn_margin_short_balances.csv");
  const ohlcvText = readFileSync(ohlcvPath, "utf8");
  const miMargnText = readFileSync(miMargnPath, "utf8");
  const parsedOhlcv = parseTwStrategyResearchCsvText(ohlcvText);
  const validatedOhlcv = validateTwStrategyResearchRows(parsedOhlcv, {
    dataEndDate: "2026-08-11",
    requiredSymbols: ["0056"],
  });
  return {
    rawRows: validatedOhlcv.rows,
    miMargnRecords: parseTwseMiMargnCsvText(miMargnText),
    cutoffDates: SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    source: {
      ohlcvPath,
      ohlcvSha256: sha256(ohlcvText),
      miMargnPath,
      miMargnSha256: sha256(miMargnText),
    },
    datasetVersion: {
      datasetId: "p197_0056_twse_mi_margn_margin_short_balances",
      version: "WORKTREE",
      source: "TWSE_MI_MARGN_DAILY_MARGIN_TRADING",
    },
    reviewDate: "2026-08-20",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_TWSE_MI_MARGN_AND_OHLCV",
    roundTripCostBps: CANONICAL_TRANSACTION_COST_BPS,
    initialCapital: 1_000_000,
  };
}

describe("0056 MI_MARGN margin/short balance temporal challenger", () => {
  it("evaluates the canonical four cutoffs with identical control/challenger populations", () => {
    const result = runPerSymbolMiMargnMarginShortLogisticChallengerTemporal(loadCanonicalInput());

    expect(result.symbol).toBe("0056");
    expect(result.classification).toBe("MMS_0056_MI_MARGN_MARGIN_SHORT_FEATURE_CHALLENGER_V1_READY_FOR_CTO_REVIEW");
    expect(result.requestedCutoffDates).toEqual([...SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES]);
    expect(result.cutoffRuns).toHaveLength(4);
    expect(result.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(result.featureNames).toEqual([...RESEARCH_FEATURE_NAMES, ...TWSE_MI_MARGN_FEATURE_FIELDS]);
    expect(result.controlReproduction.status).toBe("PASS");
    expect(result.decision).toBe("NEED_ONE_CONFIRMATION");
    expect(result.comparisonSummaryVsControl.drawdownWinsVsControl).toBe(0);
    expect(result.comparisonSummaryVsControl.allQualityWinsVsControl).toBe(0);

    for (const cutoffRun of result.cutoffRuns) {
      expect(cutoffRun.asOf <= cutoffRun.cutoff).toBe(true);
      expect(cutoffRun.controlMetrics.trainingRows).toBe(cutoffRun.challengerMetrics.trainingRows);
      expect(cutoffRun.controlMetrics.validationRows).toBe(cutoffRun.challengerMetrics.validationRows);
      expect(cutoffRun.controlMetrics.finalTestRows).toBe(cutoffRun.challengerMetrics.finalTestRows);
      expect(cutoffRun.control.trainEndDate).toBe(cutoffRun.challenger.trainEndDate);
      expect(cutoffRun.control.validationStartDate).toBe(cutoffRun.challenger.validationStartDate);
      expect(cutoffRun.control.validationEndDate).toBe(cutoffRun.challenger.validationEndDate);
      expect(cutoffRun.control.finalTestStartDate).toBe(cutoffRun.challenger.finalTestStartDate);
      expect(cutoffRun.control.fit.fitPartition).toBe("TRAINING");
      expect(cutoffRun.challenger.fit.fitPartition).toBe("TRAINING");
      expect(cutoffRun.control.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(cutoffRun.challenger.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(cutoffRun.control.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(cutoffRun.challenger.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(cutoffRun.controlEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.challengerEconomic.transactionCostBps).toBe(10);
      expect(cutoffRun.controlEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(cutoffRun.challengerEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(cutoffRun.controlEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(cutoffRun.challengerEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(cutoffRun.miMargnContext.strictPitRule).toBe("tradeDate < featureDate");
      expect(cutoffRun.miMargnContext.missingContextRows).toBe(0);
      expect(cutoffRun.control.finalTestMetrics).toHaveProperty("accuracy");
      expect(cutoffRun.control.finalTestMetrics).toHaveProperty("balancedAccuracy");
      expect(cutoffRun.control.finalTestMetrics).toHaveProperty("logLoss");
      expect(cutoffRun.control.finalTestMetrics).toHaveProperty("brierScore");
      expect(cutoffRun.controlEconomic).toHaveProperty("strategyNetReturn");
      expect(cutoffRun.controlEconomic).toHaveProperty("benchmarkNetReturn");
      expect(cutoffRun.controlEconomic).toHaveProperty("excessReturn");
      expect(cutoffRun.controlEconomic).toHaveProperty("strategyMaximumDrawdown");
      expect(cutoffRun.controlEconomic).toHaveProperty("tradeCount");
      expect(cutoffRun.challenger.finalTestEconomicEvidence.rows.every((row) => row.targetDate <= cutoffRun.asOf))
        .toBe(true);
      expect(cutoffRun.normalizedResultSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 120_000);

  it("replays deterministically with fixed cost and no final-test tuning", () => {
    const input = loadCanonicalInput();
    const first = runPerSymbolMiMargnMarginShortLogisticChallengerTemporal(input);
    const second = runPerSymbolMiMargnMarginShortLogisticChallengerTemporal(input);

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(second.roundTripCostBps).toBe(CANONICAL_TRANSACTION_COST_BPS);
    expect(second.promotionDecision).toBe("do_not_promote");
    expect(second.guardrails.supportsAutomaticPromotion).toBe(false);
    expect(second.featureNames).toHaveLength(8);
  }, 120_000);
});
