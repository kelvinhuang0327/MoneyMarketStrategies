import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  runPerSymbolT86InstitutionalFlowLogisticChallengerTemporal,
  type T86InstitutionalFlowTemporalInput,
} from "./perSymbolT86InstitutionalFlowLogisticChallengerTemporal.js";
import {
  canonicalStringify,
  CANONICAL_TRANSACTION_COST_BPS,
  parseTwStrategyResearchCsvText,
  parseTwseT86CsvText,
  RESEARCH_FEATURE_NAMES,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  TWSE_T86_FEATURE_FIELDS,
  validateTwStrategyResearchRows,
  type RawTwStrategyResearchRow,
  type TwseT86FlowRecord,
} from "@mms/research-kernel";

function fixtureSyntheticData(count = 520, closeDrift = 0): {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly t86Records: readonly TwseT86FlowRecord[];
} {
  const start = Date.UTC(2024, 0, 1);
  const rawRows: RawTwStrategyResearchRow[] = [];
  const t86Records: TwseT86FlowRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const cycle = Math.sin((i * Math.PI) / 10);
    const lateDrift = date > "2025-04-30" ? closeDrift : 0;
    const close = 30 + cycle * 3 + i * 0.03 + lateDrift;
    const volume = 10_000 + (i % 13) * 500;

    rawRows.push({
      symbol: "0056",
      date,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume,
      source: "test-owned/in-memory",
      fetched_at_utc: "2026-08-18T00:00:00.000Z",
    });

    const foreignNet = (i % 2 === 0 ? 1 : -1) * (1000 + (i % 7) * 200);
    const trustNet = (i % 3 === 0 ? 500 : -200) + (i % 5) * 50;
    const dealerSelf = (i % 4 === 0 ? 100 : -50);
    const dealerHedge = 0;
    const totalNet = foreignNet + trustNet + dealerSelf + dealerHedge;

    t86Records.push({
      symbol: "0056",
      tradeDate: date,
      foreignBuyShares: Math.max(0, foreignNet),
      foreignSellShares: Math.max(0, -foreignNet),
      foreignNetShares: foreignNet,
      investmentTrustBuyShares: Math.max(0, trustNet),
      investmentTrustSellShares: Math.max(0, -trustNet),
      investmentTrustNetShares: trustNet,
      dealerSelfBuyShares: Math.max(0, dealerSelf),
      dealerSelfSellShares: Math.max(0, -dealerSelf),
      dealerSelfNetShares: dealerSelf,
      dealerHedgeBuyShares: 0,
      dealerHedgeSellShares: 0,
      dealerHedgeNetShares: 0,
      institutionalTotalNetShares: totalNet,
      sourceIdentity: "TWSE_T86_DAILY_INSTITUTIONAL_REPORT",
      sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
    });
  }

  return {
    rawRows: Object.freeze(rawRows),
    t86Records: Object.freeze(t86Records),
  };
}

function runSynthetic(
  synthetic = fixtureSyntheticData(),
  cutoffDates = ["2024-08-31", "2024-12-31", "2025-04-30", "2025-08-31"],
) {
  return runPerSymbolT86InstitutionalFlowLogisticChallengerTemporal({
    rawRows: synthetic.rawRows,
    t86Records: synthetic.t86Records,
    cutoffDates,
    source: {
      ohlcvPath: "test-owned/in-memory-ohlcv.csv",
      ohlcvSha256: "a".repeat(64),
      t86Path: "test-owned/in-memory-t86.csv",
      t86Sha256: "b".repeat(64),
    },
    datasetVersion: {
      datasetId: "t86-flow-challenger-temporal-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    reviewDate: "2026-08-18",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_T86_AND_OHLCV",
    roundTripCostBps: 10,
    initialCapital: 1_000_000,
  });
}

function loadCanonicalHistoricalData(): {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly t86Records: readonly TwseT86FlowRecord[];
  readonly ohlcvSha256: string;
  readonly t86Sha256: string;
} {
  const ohlcvCsvPath = "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System/outputs/retraining/p194_twstock_ohlcv_export.csv";
  const t86CsvPath = path.resolve("outputs/retraining/p196_0056_twse_t86_institutional_flows.csv");

  const ohlcvText = readFileSync(ohlcvCsvPath, "utf8");
  const t86Text = readFileSync(t86CsvPath, "utf8");

  const rawOhlcv = parseTwStrategyResearchCsvText(ohlcvText);
  const validatedOhlcv = validateTwStrategyResearchRows(rawOhlcv, {
    dataEndDate: "2026-08-11",
    requiredSymbols: ["0056"],
  });

  const parsedT86 = parseTwseT86CsvText(t86Text);

  return {
    rawRows: validatedOhlcv.rows,
    t86Records: parsedT86,
    ohlcvSha256: "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7",
    t86Sha256: "de7ba543ded92141b8971bf752a4b4ff36a11732bf7769399f8faa16bd7480f1",
  };
}

describe("perSymbolT86InstitutionalFlowLogisticChallengerTemporal", () => {
  it("enforces canonical 10 bps transaction cost and fails closed on non-canonical costs", () => {
    const synthetic = fixtureSyntheticData();
    const input: T86InstitutionalFlowTemporalInput = {
      rawRows: synthetic.rawRows,
      t86Records: synthetic.t86Records,
      cutoffDates: ["2024-08-31"],
      source: {
        ohlcvPath: "test.csv",
        ohlcvSha256: "test",
        t86Path: "t86.csv",
        t86Sha256: "test",
      },
      datasetVersion: { datasetId: "test", version: "test", source: "test" },
      reviewDate: "2026-08-18",
      candidateDataQualityBasis: "SOURCE_QUALIFIED_T86_AND_OHLCV",
      roundTripCostBps: 20,
      initialCapital: 1_000_000,
    };

    expect(() => runPerSymbolT86InstitutionalFlowLogisticChallengerTemporal(input)).toThrow(
      "canonical 10 bps transaction cost required",
    );
  });

  it("evaluates control and challenger on identical eligible populations across all partitions", () => {
    const result = runSynthetic();

    expect(result.symbol).toBe("0056");
    expect(result.cutoffRuns).toHaveLength(4);
    expect(result.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(result.featureNames).toEqual([
      ...RESEARCH_FEATURE_NAMES,
      ...TWSE_T86_FEATURE_FIELDS,
    ]);
    expect(result.promotionDecision).toBe("do_not_promote");

    for (const run of result.cutoffRuns) {
      expect(run.asOf <= run.cutoff).toBe(true);
      expect(run.controlMetrics.trainingRows).toBe(run.challengerMetrics.trainingRows);
      expect(run.controlMetrics.validationRows).toBe(run.challengerMetrics.validationRows);
      expect(run.controlMetrics.finalTestRows).toBe(run.challengerMetrics.finalTestRows);
      expect(run.control.trainEndDate).toBe(run.challenger.trainEndDate);
      expect(run.control.validationStartDate).toBe(run.challenger.validationStartDate);
      expect(run.control.validationEndDate).toBe(run.challenger.validationEndDate);
      expect(run.control.finalTestStartDate).toBe(run.challenger.finalTestStartDate);

      // Scaler and fit partitions
      expect(run.control.fit.fitPartition).toBe("TRAINING");
      expect(run.challenger.fit.fitPartition).toBe("TRAINING");
      expect(run.control.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(run.challenger.thresholdSelection.selectionPartition).toBe("VALIDATION");
      expect(run.control.finalTest.evaluationPartition).toBe("FINAL_TEST");
      expect(run.challenger.finalTest.evaluationPartition).toBe("FINAL_TEST");

      // Simulator policy
      expect(run.controlEconomic.transactionCostBps).toBe(10);
      expect(run.challengerEconomic.transactionCostBps).toBe(10);
      expect(run.controlEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(run.challengerEconomic.strategyPolicy).toBe("VALIDATION_THRESHOLD_LONG_CASH");
      expect(run.controlEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
      expect(run.challengerEconomic.benchmarkPolicy).toBe("ALWAYS_LONG_BENCHMARK");
    }
  });

  it("is strictly deterministic across repeated runs", () => {
    const first = runSynthetic();
    const second = runSynthetic();

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(second.promotionDecision).toBe("do_not_promote");
    expect(second.guardrails.supportsAutomaticPromotion).toBe(false);
  });

  it("reproduces accepted control numbers and evaluates 4 cutoffs on canonical historical data", () => {
    const canonical = loadCanonicalHistoricalData();
    const result = runPerSymbolT86InstitutionalFlowLogisticChallengerTemporal({
      rawRows: canonical.rawRows,
      t86Records: canonical.t86Records,
      cutoffDates: SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
      source: {
        ohlcvPath: "outputs/retraining/p194_twstock_ohlcv_export.csv",
        ohlcvSha256: canonical.ohlcvSha256,
        t86Path: "outputs/retraining/p196_0056_twse_t86_institutional_flows.csv",
        t86Sha256: canonical.t86Sha256,
      },
      datasetVersion: {
        datasetId: "p196_0056_twse_t86_institutional_flows",
        version: "WORKTREE",
        source: "TWSE_T86_DAILY_INSTITUTIONAL_REPORT",
      },
      reviewDate: "2026-08-18",
      candidateDataQualityBasis: "SOURCE_QUALIFIED_T86_AND_OHLCV",
      roundTripCostBps: CANONICAL_TRANSACTION_COST_BPS,
      initialCapital: 1_000_000,
    });

    expect(result.controlReproduction.status).toBe("PASS");
    expect(result.cutoffRuns).toHaveLength(4);

    // Verify 4 cutoffs control reproduction explicitly
    const c0 = result.cutoffRuns[0]!;
    expect(c0.controlMetrics.accuracy).toBeCloseTo(0.57818182, 6);
    expect(c0.controlMetrics.majorityBaselineAccuracy).toBeCloseTo(0.52000000, 6);
    expect(c0.controlMetrics.excessReturn).toBeCloseTo(0.09185705, 6);

    const c1 = result.cutoffRuns[1]!;
    expect(c1.controlMetrics.accuracy).toBeCloseTo(0.52961672, 6);
    expect(c1.controlMetrics.majorityBaselineAccuracy).toBeCloseTo(0.50174216, 6);
    expect(c1.controlMetrics.excessReturn).toBeCloseTo(0.00236880, 6);

    const c2 = result.cutoffRuns[2]!;
    expect(c2.controlMetrics.accuracy).toBeCloseTo(0.51677852, 6);
    expect(c2.controlMetrics.majorityBaselineAccuracy).toBeCloseTo(0.53355705, 6);
    expect(c2.controlMetrics.excessReturn).toBeCloseTo(0.20152868, 6);

    const c3 = result.cutoffRuns[3]!;
    expect(c3.controlMetrics.accuracy).toBeCloseTo(0.48874598, 6);
    expect(c3.controlMetrics.majorityBaselineAccuracy).toBeCloseTo(0.56913183, 6);
    expect(c3.controlMetrics.excessReturn).toBeCloseTo(-0.01025134, 6);

    // Verify decision and properties
    expect(["KEEP_T86_FEATURE_SLICE", "REJECT_T86_FEATURE_SLICE", "NEED_ONE_CONFIRMATION"]).toContain(result.decision);
    expect(result.promotionDecision).toBe("do_not_promote");
    expect(result.guardrails.supportsAutomaticPromotion).toBe(false);
  }, 60_000);
});
