import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import {
  calculateTenMonthSmaSignals,
  evaluateTrendVsHoldDiagnostic,
  runTrendVsHoldDiagnosticFiles,
  TREND_VS_HOLD_OUTPUT_PATH,
} from "./trendVsHoldDiagnostic.js";

type Scenario = "roundTrip" | "openPosition" | "noEntry";

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function rowsForScenario(scenario: Scenario): readonly { readonly date: string; readonly close: string }[] {
  const rows: { date: string; close: string }[] = [];
  for (let month = 9; month <= 12; month += 1) rows.push({ date: lastDayOfMonth(2024, month), close: "188.65" });
  for (let month = 1; month <= 5; month += 1) rows.push({ date: lastDayOfMonth(2025, month), close: "188.65" });
  rows.push({ date: "2025-06-10", close: "188.65" });
  rows.push({ date: "2025-06-18", close: "47.57" });
  if (scenario === "roundTrip") {
    rows.push({ date: "2025-06-30", close: "60.00" });
    rows.push({ date: "2025-07-31", close: "55.00" });
    rows.push({ date: "2025-08-29", close: "30.00" });
    rows.push({ date: "2025-09-01", close: "28.00" });
  } else if (scenario === "openPosition") {
    rows.push({ date: "2025-06-30", close: "60.00" });
    rows.push({ date: "2025-07-31", close: "55.00" });
    rows.push({ date: "2025-08-29", close: "55.00" });
    rows.push({ date: "2025-09-01", close: "55.00" });
  } else {
    rows.push({ date: "2025-06-30", close: "47.16" });
    rows.push({ date: "2025-07-31", close: "47.00" });
    rows.push({ date: "2025-08-29", close: "46.00" });
    rows.push({ date: "2025-09-01", close: "46.00" });
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function parsedScenario(scenario: Scenario) {
  const csv = [
    "date,symbol,close",
    ...rowsForScenario(scenario).map((row) => `${row.date},0050,${row.close}`),
  ].join("\n");
  return parseHistoricalCsv(csv, "0050", "synthetic-0050-trend.csv", "twse-daily-ohlcv-close-v1");
}

function plan(endDate = "2025-09-01") {
  return Object.freeze({
    evaluationStartDate: "2025-06-18",
    evaluationEndDate: endDate,
    warmupStartDate: "2024-09-30",
    firstEligibleSignalMonth: "2025-06",
    lastEligibleSignalMonth: "2025-08",
    windows: Object.freeze([{ id: "synthetic", startDate: "2025-06-18", endDate }]),
    lookbackMonths: 10,
    targetQuantity: 3,
    initialCapitalMinor: 100_000n,
    splitEffectiveDate: "2025-06-18",
    splitRatio: 4n,
  });
}

function evaluate(scenario: Scenario) {
  const parsed = parsedScenario(scenario);
  return evaluateTrendVsHoldDiagnostic(parsed, "a".repeat(64), plan(), []);
}

function resultFor(artifact: Record<string, unknown>, name: string): Record<string, unknown> {
  const results = artifact["results"] as Record<string, unknown>;
  return results[name] as Record<string, unknown>;
}

describe("0050 10-month SMA retrospective diagnostic", () => {
  it("normalizes the split before computing the fixed 10-month moving average", () => {
    const rows = rowsForScenario("roundTrip").map((row) => ({
      date: row.date,
      closeMinor: BigInt(Math.round(Number(row.close) * 100)),
    }));
    const signals = calculateTenMonthSmaSignals(rows, plan());
    const june = signals.find((signal) => signal.month === "2025-06");
    expect(june).toMatchObject({
      signalDate: "2025-06-30",
      closeMinor: "6000",
      comparisonCloseMinor: "24000",
      movingAverageDenominator: 10,
      relation: "ABOVE",
      targetPositionQuantity: 3,
    });
    expect(signals.at(-1)?.month).toBe("2025-08");
  });

  it("replays fills and costs, reports completed round trips, and compares net equity with the holding benchmark", () => {
    const artifact = evaluate("roundTrip");
    const candidate = resultFor(artifact, "candidate");
    const benchmark = resultFor(artifact, "costMatchedBenchmark");
    expect(candidate["completedTradeCount"]).toBe(1);
    expect(candidate["fillCount"]).toBe(2);
    expect(candidate["openPositionQuantity"]).toBe(0);
    expect(candidate["feesPaidMinor"]).toBeTruthy();
    expect(candidate["completedTradeWinRate"]).toBe(0);
    expect(candidate["netReturnFraction"]).not.toBe("0.00000000");
    expect(candidate["excessNetReturnFractionVsBenchmark"]).toBeTypeOf("string");
    expect(benchmark["openPositionQuantity"]).toBe(3);
  });

  it("leaves no-trade win rate undefined and keeps an open position separate from completed trades", () => {
    const noEntry = resultFor(evaluate("noEntry"), "candidate");
    expect(noEntry["completedTradeCount"]).toBe(0);
    expect(noEntry["completedTradeWinRate"]).toBeNull();
    expect(noEntry["orderSubmittedDecisionCount"]).toBe(0);
    expect(noEntry["tradeOutcomeStatus"]).toBe("NOT_CALCULABLE_NO_COMPLETED_TRADES");

    const open = resultFor(evaluate("openPosition"), "candidate");
    expect(open["completedTradeCount"]).toBe(0);
    expect(open["completedTradeWinRate"]).toBeNull();
    expect(open["openPositionQuantity"]).toBe(3);
    expect(open["fillCount"]).toBe(1);
  });

  it("rejects a missing warm-up month instead of building an SMA from an incomplete window", () => {
    const rows = rowsForScenario("roundTrip")
      .filter((row) => !row.date.startsWith("2024-10"))
      .map((row) => ({ date: row.date, closeMinor: BigInt(Math.round(Number(row.close) * 100)) }));
    expect(() => calculateTenMonthSmaSignals(rows, plan())).toThrow("monthly close data is missing 2024-10");
  });

  it("replays the locked local P194 sample into a reproducible retrospective artifact", async () => {
    const artifact = await runTrendVsHoldDiagnosticFiles();
    const data = artifact["data"] as Record<string, unknown>;
    const candidate = resultFor(artifact, "candidate");
    const benchmark = resultFor(artifact, "costMatchedBenchmark");
    const saved = JSON.parse(await readFile(TREND_VS_HOLD_OUTPUT_PATH, "utf8")) as Record<string, unknown>;

    expect(artifact["classification"]).toBe("RETROSPECTIVE_DIAGNOSTIC_ONLY");
    expect(data["sourceRowCount"]).toBe(1599);
    expect(data["evaluationRowCount"]).toBe(281);
    expect(data["alreadyObservedHistoricalData"]).toBe(true);
    expect(data["unseenHoldoutWindows"]).toEqual([]);
    expect(candidate["netReturnFraction"]).toBeTypeOf("string");
    expect(candidate["maximumDrawdownFraction"]).toBeTypeOf("string");
    expect(benchmark["netReturnFraction"]).toBeTypeOf("string");
    expect(benchmark["openPositionQuantity"]).toBe(3);
    expect(saved["artifactId"]).toBe("0050-10m-sma-trend-vs-hold-diagnostic-v1");
  });
});
