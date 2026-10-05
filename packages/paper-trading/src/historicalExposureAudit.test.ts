import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commonEligibilityWindow, relativePnlAttribution, runHistoricalExposureAuditFiles, HISTORICAL_EXPOSURE_AUDIT_OUTPUT } from "./historicalExposureAudit.js";
import { evaluateHistoricalWindow, HISTORICAL_ACTION_COST_CONFIG, HISTORICAL_ACTION_COST_OUTPUT } from "./historicalActionCostDiagnostic.js";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import type { MonthEndTrendSignal } from "./trendVsHoldDiagnostic.js";

function signal(signalDate: string): MonthEndTrendSignal {
  return { month: signalDate.slice(0, 7), signalDate, targetPositionQuantity: 0, relation: "BELOW", closeMinor: "10000", comparisonCloseMinor: "10000", movingAverageNumeratorMinor: "110000", movingAverageDenominator: 10 };
}
type Json = Record<string, unknown>;
describe("historical exposure and fair opportunity diagnostics", () => {
  it("moves both arms to the first available completed signal without backfilling missing warmup", () => {
    const dates = ["2020-10-05", "2020-10-30", "2020-11-02"];
    const window = { id: "synthetic", startDate: dates[0]!, endDate: dates[2]!, rowCount: 3 };
    expect(commonEligibilityWindow(window, [signal("2020-10-30")], dates)).toEqual({ ...window, startDate: "2020-10-30", rowCount: 2 });
    expect(() => commonEligibilityWindow(window, [], dates)).toThrow("unavailable");
    expect(() => commonEligibilityWindow({ ...window, endDate: "2020-10-05" }, [signal("2020-10-30")], dates)).toThrow("before common eligibility");
  });
  it("reconciles exposure timing, dividends and every cost separately to the equity difference", () => {
    const candidate = { endingEquityMinor: "100194", pnlAttribution: { priceMovementMinor: "600", grossDistributionMinor: "0", feesMinor: "94", slippageMinor: "312", sellTaxMinor: "0" } };
    const benchmark = { endingEquityMinor: "99935", pnlAttribution: { priceMovementMinor: "345", grossDistributionMinor: "0", feesMinor: "95", slippageMinor: "315", sellTaxMinor: "0" } };
    expect(relativePnlAttribution(candidate, benchmark)).toMatchObject({ differentHoldingDatesPriceEffectMinor: "255", commissionEffectMinor: "1", slippageEffectMinor: "3", endingEquityDeltaMinor: "259" });
    expect(() => relativePnlAttribution({ ...candidate, endingEquityMinor: "100195" }, benchmark)).toThrow("does not reconcile");
  });
  it("matches monthly buying opportunities with the original dollar cap and never rescues an infeasible order", () => {
    const parsed = parseHistoricalCsv("date,symbol,close\n2024-01-02,0050,200\n2024-01-03,0050,100\n2024-01-04,0050,100\n2024-01-31,0050,100\n2024-02-01,0050,100", "0050", "synthetic risk opportunities", "twse-daily-ohlcv-close-v1");
    const window = { id: "synthetic", startDate: "2024-01-02", endDate: "2024-02-01", rowCount: 5 };
    const daily = evaluateHistoricalWindow(parsed, "a".repeat(64), window, [signal("2024-01-31")], [], "EVERY_EVENT", true);
    const monthly = evaluateHistoricalWindow(parsed, "a".repeat(64), window, [signal("2024-01-31")], [], "SAME_MONTHLY_OPPORTUNITIES", true);
    const dailyBenchmark = daily["costMatchedBenchmark"] as Json;
    const monthlyBenchmark = monthly["costMatchedBenchmark"] as Json;
    expect(dailyBenchmark["firstInvestedDate"]).toBe("2024-01-04");
    expect(monthlyBenchmark["firstInvestedDate"]).toBe("2024-02-01");
    const audit = monthlyBenchmark["exposureAudit"] as Json;
    expect((audit["rejectedDecisions"] as Json[])[0]).toMatchObject({ reasonCode: "MAX_EXPOSURE_EXCEEDED", projectedExposureMinor: "60600", executionCashMinor: "100000" });
    expect(monthlyBenchmark["openPositionQuantity"]).toBe(3);
    expect(() => evaluateHistoricalWindow({ ...parsed, session: { ...parsed.session, simulation: { ...parsed.session.simulation, risk: { ...parsed.session.simulation.risk, maxExposureMinor: 60_000n } } } }, "a".repeat(64), window, [], [])).toThrow("risk mismatch");
  });
  it("replays the fixed eight windows, removes the startup advantage, and preserves the frozen report", async () => {
    const root = await mkdtemp(join(tmpdir(), "mms-exposure-audit-"));
    const paths = ["data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv", "data/market/0050-corporate-actions-v2/dividends.json", HISTORICAL_ACTION_COST_CONFIG, HISTORICAL_ACTION_COST_OUTPUT];
    try {
      for (const path of paths) { await mkdir(join(root, path, ".."), { recursive: true }); await copyFile(path, join(root, path)); }
      const original = await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT));
      const result = await runHistoricalExposureAuditFiles(root);
      expect(result).toMatchObject({ commonEligibilityEvaluationRowCount: 1399, extraInitialWarmupRowCount: 18, positiveAbsoluteAndBenchmarkExcessWindowCount: 0, frozenStrategyAndRiskUnchanged: true, sourceReportReconciledWithoutOverwrite: true });
      expect(result["commonEligibilityWindowCounts"]).toEqual({ denominator: 8, candidateHigher: 1, benchmarkHigher: 4, tiedOrTaxIndeterminate: 3 });
      expect(result["sameMonthlyOpportunityCounts"]).toEqual({ denominator: 7, candidateHigher: 1, benchmarkHigher: 3, tiedOrTaxIndeterminate: 3, configuredWindowCount: 8, inconclusiveBenchmarkWindowCount: 1 });
      const audits = result["audits"] as Json[];
      expect((audits[0]!["relativePnlAttribution"] as Json)["differentHoldingDatesPriceEffectMinor"]).toBe("255");
      const blocked = audits.find((a) => a["id"] === "2025-pre-split")!;
      expect(blocked).toMatchObject({ startDateRiskReason: "MAX_EXPOSURE_EXCEEDED", projectedInitialBuyExposureMinor: "58800", projectedInitialBuyReservationMinor: "58977" });
      expect((blocked["sameMonthlyOpportunityControl"] as Json)["evaluationStatus"]).toBe("INCONCLUSIVE_BENCHMARK_NOT_INVESTABLE");
      expect(await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT))).toEqual(original);
      const before = await readFile(join(root, HISTORICAL_EXPOSURE_AUDIT_OUTPUT));
      const altered = JSON.parse(original.toString()); altered.results[0].candidate.endingEquityMinor = "1";
      await writeFile(join(root, HISTORICAL_ACTION_COST_OUTPUT), JSON.stringify(altered));
      await expect(runHistoricalExposureAuditFiles(root)).rejects.toThrow("frozen result changed");
      expect(await readFile(join(root, HISTORICAL_EXPOSURE_AUDIT_OUTPUT))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
