import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  runPerSymbolMarketRegimeLogisticChallengerTemporal,
  type MarketRegimeTemporalInput,
} from "./perSymbolMarketRegimeLogisticChallengerTemporal.js";
import {
  applyBoundedAdjustment,
  buildTwseQualificationSnapshotFromFixture,
  canonicalStringify,
  CANONICAL_TRANSACTION_COST_BPS,
  parseCommittedQualificationObservationsFromText,
  parseTwStrategyResearchCsvText,
  qualifyTwseSnapshot,
  RESEARCH_FEATURE_NAMES,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  toMarketRows,
  TWSE_QUALIFICATION_FIXTURE_PAYLOADS,
  validateTwStrategyResearchRows,
  type RawTwStrategyResearchRow,
} from "@mms/research-kernel";
import { createHash } from "node:crypto";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fixtureSyntheticRows(count = 520, closeDrift = 0): RawTwStrategyResearchRow[] {
  const start = Date.UTC(2024, 0, 1);
  return ["0056", "0050"].flatMap((symbol, symbolIndex) =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const cycle = Math.sin((index + symbolIndex * 3) * Math.PI / 10);
      const lateDrift = date > "2025-04-30" ? closeDrift : 0;
      const close = 100 + cycle * 7 + index * (symbolIndex === 0 ? 0.05 : 0.08) + lateDrift;
      return {
        symbol,
        date,
        open: close - 0.2,
        high: close + 0.8,
        low: close - 0.8,
        close,
        volume: 1000 + (index % 13) * 23 + symbolIndex * 5,
        source: "test-owned/in-memory",
        fetched_at_utc: "2026-08-12T00:00:00.000Z",
      };
    }),
  );
}

function runSynthetic(rows: readonly RawTwStrategyResearchRow[] = fixtureSyntheticRows()) {
  return runPerSymbolMarketRegimeLogisticChallengerTemporal({
    rawRows: rows,
    cutoffDates: ["2024-08-31", "2024-12-31", "2025-04-30", "2025-08-31"],
    source: {
      path: "test-owned/in-memory.csv",
      sha256: "b".repeat(64),
    },
    datasetVersion: {
      datasetId: "market-regime-challenger-temporal-fixture",
      version: "v1",
      source: "test-owned/in-memory",
    },
    reviewDate: "2026-08-12",
    candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    roundTripCostBps: 10,
    initialCapital: 1_000_000,
  });
}

function loadCanonicalHistoricalRows(): RawTwStrategyResearchRow[] {
  const csvPath = "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System/outputs/retraining/p194_twstock_ohlcv_export.csv";
  const csvText = readFileSync(csvPath, "utf8");
  const raw = parseTwStrategyResearchCsvText(csvText);
  const validated = validateTwStrategyResearchRows(raw, {
    dataEndDate: "2026-08-11",
    requiredSymbols: ["0050", "0056", "2317", "2330", "2454"],
  });

  const committed = parseCommittedQualificationObservationsFromText(csvText);
  const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
    {
      splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
      stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
      stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
    },
    "2025-06-18T10:00:00.000Z",
  );
  const qual = qualifyTwseSnapshot(qualificationSnapshot, committed, "2025-06-18T10:00:00.000Z");
  const recon = qual["0050Reconciliation"];

  return validated.rows.map((row) => {
    if (row.symbol !== "0050") return row;
    const marketRow = toMarketRows([row], "0050")[0]!;
    const adjustedRow = applyBoundedAdjustment(
      [marketRow],
      recon.effectiveDate,
      recon.derivedAdjustmentFactor,
    )[0]!;
    return {
      ...row,
      open: adjustedRow.open,
      high: adjustedRow.high,
      low: adjustedRow.low,
      close: adjustedRow.close,
    };
  });
}

describe("perSymbolMarketRegimeLogisticChallengerTemporal", () => {
  it("enforces canonical 10 bps transaction cost and fails closed on non-canonical costs", () => {
    const mockRows = fixtureSyntheticRows();
    const input: MarketRegimeTemporalInput = {
      rawRows: mockRows,
      cutoffDates: ["2024-08-31"],
      source: { path: "test.csv", sha256: "test" },
      datasetVersion: { datasetId: "test", version: "test", source: "test" },
      reviewDate: "2026-08-12",
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: 20,
      initialCapital: 1_000_000,
    };

    expect(() => runPerSymbolMarketRegimeLogisticChallengerTemporal(input)).toThrow(
      "canonical 10 bps transaction cost required",
    );
  });

  it("fails closed if data quality basis is not SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH", () => {
    const mockRows = fixtureSyntheticRows();
    const input: MarketRegimeTemporalInput = {
      rawRows: mockRows,
      cutoffDates: ["2024-08-31"],
      source: { path: "test.csv", sha256: "test" },
      datasetVersion: { datasetId: "test", version: "test", source: "test" },
      reviewDate: "2026-08-12",
      candidateDataQualityBasis: "RAW_UNADJUSTED_PRICE_PATH",
      roundTripCostBps: CANONICAL_TRANSACTION_COST_BPS,
      initialCapital: 1_000_000,
    };

    expect(() => runPerSymbolMarketRegimeLogisticChallengerTemporal(input)).toThrow(
      "STOP_MMS_0056_MARKET_REGIME_ADJUSTED_0050_UNAVAILABLE",
    );
  });

  it("evaluates control and challenger on identical eligible populations across all partitions", () => {
    const result = runSynthetic();

    expect(result.symbol).toBe("0056");
    expect(result.cutoffRuns).toHaveLength(4);
    expect(result.controlFeatureNames).toEqual([...RESEARCH_FEATURE_NAMES]);
    expect(result.featureNames).toEqual([
      ...RESEARCH_FEATURE_NAMES,
      "market_return_20d",
      "market_volatility_10d",
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

  it("keeps cutoff refits independent of later-window data", () => {
    const baseline = runSynthetic();
    const mutated = runSynthetic(fixtureSyntheticRows(520, 25));

    const firstBaseline = baseline.cutoffRuns[0]!;
    const firstMutated = mutated.cutoffRuns[0]!;
    const lastBaseline = baseline.cutoffRuns.at(-1)!;
    const lastMutated = mutated.cutoffRuns.at(-1)!;

    expect(firstMutated.normalizedResultSha256).toBe(firstBaseline.normalizedResultSha256);
    expect(firstMutated.control.fit.modelStateSha256).toBe(firstBaseline.control.fit.modelStateSha256);
    expect(firstMutated.challenger.fit.modelStateSha256).toBe(firstBaseline.challenger.fit.modelStateSha256);

    expect(lastMutated.normalizedResultSha256).not.toBe(lastBaseline.normalizedResultSha256);
  });

  it("is strictly deterministic across repeated runs", () => {
    const first = runSynthetic();
    const second = runSynthetic();

    expect(canonicalStringify(second)).toBe(canonicalStringify(first));
    expect(second.normalizedResultSha256).toBe(first.normalizedResultSha256);
    expect(second.promotionDecision).toBe("do_not_promote");
    expect(second.guardrails.supportsAutomaticPromotion).toBe(false);
  });

  it("reproduces accepted control numbers and confirms temporal evidence on canonical dataset", () => {
    const canonicalRows = loadCanonicalHistoricalRows();
    const result = runPerSymbolMarketRegimeLogisticChallengerTemporal({
      rawRows: canonicalRows,
      cutoffDates: SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
      source: {
        path: "outputs/retraining/p194_twstock_ohlcv_export.csv",
        sha256: "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7",
      },
      datasetVersion: {
        datasetId: "p194_twstock_ohlcv_export",
        version: "WORKTREE",
        source: "twstock/twse",
      },
      reviewDate: "2026-08-12",
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
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

    // Verify conclusion
    expect(result.doesMarketRegimeContextImproveDirectionalEvidence).toBe("MIXED");
    expect(result.doesMarketRegimeContextImproveEconomicEvidence).toBe("MIXED");
    expect(result.marketRegimeChallengerConclusion).toBe("NOT_SUPPORTED");
    expect(result.ceoNextRoute).toBe("STOP_CURRENT_5_FEATURE_RESEARCH_LINE_AND_REASSESS_DATA_STRATEGY");
    expect(result.promotionDecision).toBe("do_not_promote");
  }, 60_000);
});
