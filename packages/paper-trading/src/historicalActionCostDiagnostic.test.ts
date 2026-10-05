import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import { evaluateHistoricalWindow, reconcileHistoricalRun, runHistoricalActionCostDiagnosticFiles, sellTaxBounds, HISTORICAL_ACTION_COST_CONFIG, HISTORICAL_ACTION_COST_OUTPUT } from "./historicalActionCostDiagnostic.js";
import type { MonthEndTrendSignal } from "./trendVsHoldDiagnostic.js";

const SHA = "a".repeat(64);
const WINDOW = { id: "synthetic", startDate: "2024-01-02", endDate: "2024-02-02", rowCount: 4 };
function parsed(price = "100.00") {
  return parseHistoricalCsv(`date,symbol,close\n2024-01-02,0050,${price}\n2024-01-03,0050,${price}\n2024-01-31,0050,100.00\n2024-02-02,0050,110.00`, "0050", "synthetic", "twse-daily-ohlcv-close-v1");
}
function signal(signalDate: string, target: 0 | 3): MonthEndTrendSignal {
  return { month: signalDate.slice(0, 7), signalDate, targetPositionQuantity: target, relation: target === 3 ? "ABOVE" : "BELOW", closeMinor: "10000", comparisonCloseMinor: "10000", movingAverageNumeratorMinor: "100000", movingAverageDenominator: 10 };
}
const DIVIDEND = { exDate: "2024-01-31", payDate: "2024-02-01", amountPerShareMinor: "100" };
const arm = (result: Record<string, unknown>) => result["candidate"] as Record<string, unknown>;

describe("historical actions and matched cost accounting", () => {
  it("reconstructs a completed trade including fees, slippage, dividend entitlement and sell tax", () => {
    const result = evaluateHistoricalWindow(parsed(), SHA, WINDOW, [signal("2023-12-29", 3), signal("2024-01-31", 0)], [DIVIDEND]);
    const candidate = arm(result);
    // Buy: 3*101.00 + .91 fee. Sell: 3*108.90 - .99 fee - 1.00 tax. Dividend: 3.00.
    expect(candidate).toMatchObject({ completedTradeCount: 1, completedTradeWinRateBeforePersonalDividendTax: 1, openPositionQuantity: 0, endingEquityMinor: "102380", feesPaidMinor: "190", simulatedSlippageCostMinor: "630", sellTransactionTaxFloorMinor: "0", sellTransactionTaxCeilMinor: "100", distributionCashMinor: "300", distributionReceivableMinor: "0" });
    expect((candidate["completedTrades"] as Record<string, unknown>[])[0]?.["netPnlMinor"]).toBe("2380");
    expect(candidate["maximumDrawdownBeforePersonalDividendTaxFraction"]).toBe("0.00391000");
  });
  it("keeps open positions and no-signal outcomes out of the win-rate denominator", () => {
    const open = arm(evaluateHistoricalWindow(parsed(), SHA, WINDOW, [signal("2023-12-29", 3)], [DIVIDEND]));
    expect(open).toMatchObject({ completedTradeCount: 0, completedTradeWinRateBeforePersonalDividendTax: null, openPositionQuantity: 3, outcome: "OPEN_POSITION_AT_CUTOFF", sellTransactionTaxCeilMinor: "0" });
    const none = arm(evaluateHistoricalWindow(parsed(), SHA, WINDOW, [], [DIVIDEND]));
    expect(none).toMatchObject({ completedTradeCount: 0, completedTradeWinRateBeforePersonalDividendTax: null, fillCount: 0, outcome: "NO_ENTRY_SIGNAL", endingEquityMinor: "100000" });
  });
  it("reports unchanged risk rejection and never fabricates a fill", () => {
    const candidate = arm(evaluateHistoricalWindow(parsed("200.00"), SHA, WINDOW, [signal("2023-12-29", 3)], []));
    expect(candidate["fillCount"]).toBe(0);
    expect(candidate["outcome"]).toBe("RISK_REJECTED_WITHOUT_COMPLETED_TRADE");
    expect((candidate["decisions"] as Record<string, number>)["riskRejected"]).toBe(1);
  });
  it("books missing payment observations at the next observation and does not grant ex-day buyers entitlement", () => {
    const result = arm(evaluateHistoricalWindow(parsed(), SHA, WINDOW, [signal("2023-12-29", 3)], [{ ...DIVIDEND, exDate: "2024-01-03", payDate: "2024-01-04" }]));
    expect(result["distributionCashMinor"]).toBe("0");
    const later = arm(evaluateHistoricalWindow(parsed(), SHA, WINDOW, [signal("2023-12-29", 3)], [{ ...DIVIDEND, exDate: "2024-01-04", payDate: "2024-02-01" }]));
    expect(later["distributionCashMinor"]).toBe("300");
    expect((later["dividendEntitlements"] as Record<string, unknown>[])[0]?.["observedBookingDate"]).toBe("2024-01-31");
  });
  it("preserves unfilled end orders, duplicate-event idempotence, and rejects duplicate accepted fills", () => {
    const source = parsed();
    const duplicateSession = { ...source.session, events: [source.session.events[0]!, source.session.events[0]!, ...source.session.events.slice(1)] };
    const strategy = { strategyVersion: "synthetic", decide: () => 3 };
    const run = runPaperSession(duplicateSession, SHA, undefined, strategy, undefined, { captureEquityCurve: true });
    const normal = runPaperSession(source.session, SHA, undefined, strategy, undefined, { captureEquityCurve: true });
    expect(reconcileHistoricalRun(run, source.session.events, [DIVIDEND]).summary).toEqual(reconcileHistoricalRun(normal, source.session.events, [DIVIDEND]).summary);
    const journal = run["journal"] as { kind: string }[];
    expect(() => reconcileHistoricalRun({ ...run, journal: [...journal, journal.find((e) => e.kind === "fill")!] }, source.session.events, [])).toThrow("duplicate fill");
    const pending = arm(evaluateHistoricalWindow(source, SHA, WINDOW, [signal("2024-02-02", 3)], []));
    expect(pending).toMatchObject({ pendingOrderCount: 1, fillCount: 0, outcome: "UNFILLED_ORDER_AT_CUTOFF", completedTradeWinRateBeforePersonalDividendTax: null });
  });
  it("brackets rounding and fails for missing coverage, crossing a split, or duplicate corporate actions", () => {
    expect(sellTaxBounds(200_000n)).toEqual({ floorMinor: 200n, ceilMinor: 200n });
    expect(sellTaxBounds(32_670n)).toEqual({ floorMinor: 0n, ceilMinor: 100n });
    expect(() => evaluateHistoricalWindow(parsed(), SHA, { ...WINDOW, rowCount: 5 }, [], [])).toThrow("row count");
    expect(() => evaluateHistoricalWindow(parsed(), SHA, { ...WINDOW, endDate: "2025-06-18" }, [], [])).toThrow("split boundary");
    expect(() => evaluateHistoricalWindow(parsed(), SHA, WINDOW, [], [DIVIDEND, DIVIDEND])).toThrow("unique");
  });
  it("bounds unknown personal distribution taxes identically per official event in both arms", () => {
    const result = evaluateHistoricalWindow(parsed(), SHA, WINDOW, [signal("2024-01-31", 3)], [DIVIDEND]);
    const relative = result["relativeOutcome"] as Record<string, unknown>;
    const range = relative["taxSensitivityEndingEquityDeltaMinor"] as Record<string, string>;
    expect(BigInt(range["upper"]!) - BigInt(range["lower"]!)).toBe(300n);
    expect(range["lower"]).toBe(relative["endingEquityDeltaMinor"]);
  });
  it("fails instead of hiding an order that sale taxes would leave unfunded", () => {
    const prices = ["100", "100", "1", "100", "100", "1", "100", "100", "1", "31.96"];
    const source = parseHistoricalCsv(["date,symbol,close", ...prices.map((p, i) => `2024-01-${String(i + 2).padStart(2, "0")},0050,${p}`)].join("\n"), "0050", "synthetic funding", "twse-daily-ohlcv-close-v1");
    const run = runPaperSession(source.session, SHA, undefined, {
      strategyVersion: "synthetic funding",
      decide(input) { return (Number(input.current.eventId.slice(-2)) - 2) % 3 === 0 ? 3 : 0; },
    }, undefined, { captureEquityCurve: true });
    expect(() => reconcileHistoricalRun(run, source.session.events, [])).toThrow("tax-adjusted order reservation insufficient");
  });
  it("runs the locked local archive in a temporary root and preserves output on invalid input", async () => {
    const root = await mkdtemp(join(tmpdir(), "mms-actions-v2-"));
    const paths = ["data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv", "data/market/p194-twstock-ohlcv-v1/provenance.json", "data/market/0050-corporate-actions-v2/dividends.json", HISTORICAL_ACTION_COST_CONFIG];
    try {
      for (const path of paths) { await mkdir(join(root, path, ".."), { recursive: true }); await copyFile(path, join(root, path)); }
      const result = await runHistoricalActionCostDiagnosticFiles(root);
      expect(result).toMatchObject({ sourceRowCount: 1599, evaluationRowCount: 1417, warmupRowCount: 182, unseenHoldoutCount: 0, signalCount: 70, promotionStatus: "NOT_ELIGIBLE_RETROSPECTIVE_DIAGNOSTIC" });
      expect(result["descriptiveWindowCounts"]).toMatchObject({ denominator: 8, candidateHigher: 2, benchmarkHigher: 4, tiedOrTaxIndeterminate: 2 });
      const windows = result["results"] as Record<string, unknown>[];
      const legacy = JSON.parse(await readFile("packages/paper-trading/trend-vs-hold-diagnostic-v1.json", "utf8"));
      const post = windows.find((w) => w["id"] === "2025-post-split")!;
      expect((post["candidate"] as Record<string, unknown>)["netReturnBeforePersonalDividendTaxFraction"]).toBe(legacy.results.candidate.chronologicalWindows[0].netReturnFraction);
      expect((post["costMatchedBenchmark"] as Record<string, unknown>)["netReturnBeforePersonalDividendTaxFraction"]).toBe(legacy.results.costMatchedBenchmark.chronologicalWindows[0].netReturnFraction);
      const before = await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT));
      await writeFile(join(root, paths[0]!), "bad input");
      await expect(runHistoricalActionCostDiagnosticFiles(root)).rejects.toThrow("hash");
      expect(await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT))).toEqual(before);
      await copyFile(paths[0]!, join(root, paths[0]!));
      const config = JSON.parse(await readFile(join(root, HISTORICAL_ACTION_COST_CONFIG), "utf8"));
      config.candidate.targetQuantity = 4;
      await writeFile(join(root, HISTORICAL_ACTION_COST_CONFIG), JSON.stringify(config));
      await expect(runHistoricalActionCostDiagnosticFiles(root)).rejects.toThrow("locked identity");
      expect(await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT))).toEqual(before);
      await copyFile(HISTORICAL_ACTION_COST_CONFIG, join(root, HISTORICAL_ACTION_COST_CONFIG));
      await rm(join(root, paths[2]!));
      await expect(runHistoricalActionCostDiagnosticFiles(root)).rejects.toThrow("ENOENT");
      expect(await readFile(join(root, HISTORICAL_ACTION_COST_OUTPUT))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
