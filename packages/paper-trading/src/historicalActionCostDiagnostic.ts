import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { ceilDiv, reservedBuyCashMinor } from "./money.js";
import { runPaperSession } from "./sessionRunner.js";
import { calculateTenMonthSmaSignals, TREND_VS_HOLD_VERSION, type MonthEndTrendSignal } from "./trendVsHoldDiagnostic.js";
import type { PaperStrategy, SimulationEvent, StrategyInput } from "./types.js";

export const HISTORICAL_ACTION_COST_CONFIG = "packages/paper-trading/historical-action-cost-config-v2.json";
export const HISTORICAL_ACTION_COST_OUTPUT = "packages/paper-trading/historical-action-cost-diagnostic-v2.json";
const INPUT = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv";
const DIVIDENDS = "data/market/0050-corporate-actions-v2/dividends.json";
const SPLIT_DATE = "2025-06-18";
const INITIAL = 100_000n;
const LOCK_SHA256 = "311344de3ef252035fcd9d91a49d2af1ad098e0c6b0a11621d9aa4d3a4b8bd6e";
type Json = Record<string, unknown>;
type Fill = Extract<SimulationEvent, { kind: "fill" }>;

export interface HistoricalDividend {
  readonly exDate: string;
  readonly payDate: string;
  readonly amountPerShareMinor: string;
}
export interface HistoricalDiagnosticWindow {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly rowCount: number;
}
interface Point {
  date: string;
  equity: bigint;
  grossDistribution: bigint;
  taxFloor: bigint;
  taxCeil: bigint;
  quantity: number;
}

function record(value: unknown, name: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Json;
}
function integer(value: unknown, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${name} must be an integer amount`);
}
function dateOf(eventId: string): string {
  const date = /^historical-0050-(\d{4}-\d{2}-\d{2})$/.exec(eventId)?.[1];
  if (!date) throw new TypeError(`unexpected historical event ID ${eventId}`);
  return date;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new TypeError("invalid corporate-action or window date");
  }
  return value;
}
function fraction(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new RangeError("return denominator must be positive");
  const sign = numerator < 0n ? "-" : "";
  const n = numerator < 0n ? -numerator : numerator;
  const scale = 100_000_000n;
  const value = (n * scale + denominator / 2n) / denominator;
  return `${sign}${value / scale}.${(value % scale).toString().padStart(8, "0")}`;
}
function drawdown(points: readonly Point[]): string {
  let peak = INITIAL;
  let n = 0n;
  let d = INITIAL;
  for (const point of points) {
    if (point.equity > peak) peak = point.equity;
    if ((peak - point.equity) * d > n * peak) { n = peak - point.equity; d = peak; }
  }
  return fraction(n, d);
}

/** A currency-rounding bound, not a claim about a particular broker's tax invoice. */
export function sellTaxBounds(notionalMinor: bigint): { floorMinor: bigint; ceilMinor: bigint } {
  if (notionalMinor < 0n) throw new RangeError("sell notional must be non-negative");
  // ETF sale rate 0.1%; bracket any whole-TWD rounding at the fill level.
  const denominator = 10_000n * 100n;
  return { floorMinor: notionalMinor * 10n / denominator * 100n, ceilMinor: ceilDiv(notionalMinor * 10n, denominator) * 100n };
}

function validateDividends(events: readonly HistoricalDividend[]): void {
  let previous = "";
  for (const event of events) {
    const ex = date(event.exDate);
    const pay = date(event.payDate);
    if (ex <= previous || pay < ex || !/^[1-9]\d*$/.test(event.amountPerShareMinor)) {
      throw new TypeError("dividends must be unique, sorted, positive, and payable after entitlement");
    }
    previous = ex;
  }
}

function strategy(signals: readonly MonthEndTrendSignal[], firstDate: string): PaperStrategy {
  const currentTargets = new Map(signals.filter((s) => s.targetPositionQuantity !== null).map((s) => [s.signalDate, s.targetPositionQuantity!]));
  // Equality retains the prior target, including when a portfolio resets at a calendar boundary.
  const carried = signals.filter((s) => s.signalDate < firstDate && s.targetPositionQuantity !== null).at(-1)?.targetPositionQuantity ?? 0;
  return {
    strategyVersion: TREND_VS_HOLD_VERSION,
    strategyParameters: { lookbackCompletedMonthEndCloses: 10, targetQuantity: 3, parameterSearch: false },
    decide(input: StrategyInput) {
      const today = dateOf(input.current.eventId);
      return currentTargets.get(today) ?? (today === firstDate ? carried : input.positionQuantity);
    },
  };
}

/** Reconcile the existing execution journal; no broker, risk, dedup or cancellation semantics change. */
export function reconcileHistoricalRun(
  run: Json,
  events: ParsedHistoricalCsv["session"]["events"],
  distributions: readonly HistoricalDividend[],
): { summary: Json; points: readonly Point[] } {
  validateDividends(distributions);
  const settings = record(run["simulationSettings"], "simulation settings");
  const terms = record(settings["terms"], "execution terms");
  if (integer(settings["initialCashMinor"], "initial cash") !== INITIAL || terms["feeBps"] !== 30 || terms["slippageBps"] !== 100) throw new TypeError("locked reconciliation economics mismatch");
  const journal = run["journal"] as readonly SimulationEvent[];
  const rawCurve = run["equityCurve"] as readonly unknown[];
  if (!Array.isArray(journal) || !Array.isArray(rawCurve) || rawCurve.length !== events.length) throw new TypeError("journal and equity-curve coverage missing");
  const fills = new Map<string, Fill[]>();
  const fillIds = new Set<string>();
  const reasons: Record<string, number> = {};
  const decisions = { noTrade: 0, submitted: 0, riskRejected: 0 };
  for (const item of journal) {
    if (item.kind === "fill") {
      if (fillIds.has(item.fillId)) throw new TypeError("duplicate fill in accepted journal");
      fillIds.add(item.fillId);
      const day = dateOf(item.sourceMarketEventId);
      fills.set(day, [...(fills.get(day) ?? []), item]);
    } else if (item.kind === "decision") {
      if (item.status === "risk-rejected") decisions.riskRejected++;
      else if (item.status === "order-submitted") decisions.submitted++;
      else decisions.noTrade++;
      reasons[item.reasonCode] = (reasons[item.reasonCode] ?? 0) + 1;
    }
  }
  let cash = INITIAL;
  let quantity = 0;
  let fees = 0n;
  let slippage = 0n;
  let taxFloor = 0n;
  let taxCeil = 0n;
  let distributionCash = 0n;
  let receivable = 0n;
  let tradeCashFlow = 0n;
  let tradeIncome = 0n;
  let exIndex = 0;
  const payable: { payDate: string; amount: bigint }[] = [];
  const entitlements: Json[] = [];
  const closed: { netPnlMinor: string; distributionIncomeMinor: string; closedDate: string }[] = [];
  const firstDate = dateOf(events[0]?.eventId ?? "");
  // A fresh portfolio has no rights from ex dates preceding its start.
  while (distributions[exIndex] && distributions[exIndex]!.exDate < firstDate) exIndex++;
  const points: Point[] = [];
  for (const [index, market] of events.entries()) {
    const day = dateOf(market.eventId);
    // Entitlements use holdings before today's fill; a missing ex-day observation
    // is booked on the first subsequent observation, without inventing a price.
    while (distributions[exIndex] && distributions[exIndex]!.exDate <= day) {
      const dividend = distributions[exIndex++]!;
      const amount = BigInt(dividend.amountPerShareMinor) * BigInt(quantity);
      receivable += amount;
      tradeIncome += amount;
      payable.push({ payDate: dividend.payDate, amount });
      entitlements.push({ ...dividend, observedBookingDate: day, entitledQuantity: quantity, entitlementMinor: amount.toString() });
    }
    for (let i = payable.length - 1; i >= 0; i--) {
      if (payable[i]!.payDate <= day) {
        distributionCash += payable[i]!.amount;
        receivable -= payable[i]!.amount;
        payable.splice(i, 1);
      }
    }
    for (const fill of fills.get(day) ?? []) {
      const notional = fill.executionPriceMinor * BigInt(fill.quantity);
      fees += fill.feeMinor;
      slippage += (fill.side === "buy" ? fill.executionPriceMinor - market.priceMinor : market.priceMinor - fill.executionPriceMinor) * BigInt(fill.quantity);
      if (fill.side === "buy") {
        // Dividends are excluded from execution cash: no reinvestment. The tax
        // overlay must never turn an accepted engine fill into unfunded trading.
        if (cash - taxCeil < notional + fill.feeMinor) throw new RangeError("tax-adjusted execution cash insufficient; replay is inconclusive");
        if (quantity === 0) { tradeCashFlow = 0n; tradeIncome = 0n; }
        cash -= notional + fill.feeMinor;
        tradeCashFlow -= notional + fill.feeMinor;
        quantity += fill.quantity;
      } else {
        if (fill.quantity > quantity) throw new TypeError("sell exceeds reconstructed holdings");
        const tax = sellTaxBounds(notional);
        taxFloor += tax.floorMinor;
        taxCeil += tax.ceilMinor;
        cash += notional - fill.feeMinor;
        tradeCashFlow += notional - fill.feeMinor - tax.ceilMinor;
        quantity -= fill.quantity;
        if (quantity === 0) closed.push({ netPnlMinor: (tradeCashFlow + tradeIncome).toString(), distributionIncomeMinor: tradeIncome.toString(), closedDate: day });
      }
    }
    // Check reservation feasibility as well as fills; otherwise the overlay
    // could hide a tax-induced funding change at order submission.
    for (const item of journal) {
      if (item.kind === "order" && item.sourceEventId === market.eventId && item.side === "buy" && item.status === "pending") {
        const reservation = reservedBuyCashMinor(item.remainingQuantity, market.priceMinor, 100, 30);
        if (reservation > cash - taxCeil) throw new RangeError("tax-adjusted order reservation insufficient; replay is inconclusive");
      }
    }
    const engineEquity = integer(record(rawCurve[index], "equity point")["equityMinor"], "engine equity");
    if (cash + market.priceMinor * BigInt(quantity) !== engineEquity) throw new TypeError("engine cash and holdings do not reconcile to journal");
    points.push({ date: day, equity: engineEquity + distributionCash + receivable - taxCeil, grossDistribution: distributionCash + receivable, taxFloor, taxCeil, quantity });
  }
  if ([...fills.keys()].some((day) => !points.some((p) => p.date === day))) throw new TypeError("journal contains fills outside observed coverage");
  const last = points.at(-1);
  if (!last) throw new TypeError("empty historical window");
  const statistics = record(run["tradingStatistics"], "statistics");
  const account = record(run["accountSummary"], "account");
  if (statistics["completeTradeCount"] !== closed.length || account["positionQuantity"] !== quantity
    || integer(account["feesPaidMinor"], "fees") !== fees) throw new TypeError("trade denominator or final account does not reconcile");
  const active = account["activeOrder"];
  const pending = active === null ? [] : [record(active, "active order")];
  const wins = closed.filter((t) => BigInt(t.netPnlMinor) > 0n).length;
  const losses = closed.filter((t) => BigInt(t.netPnlMinor) < 0n).length;
  return {
    points,
    summary: {
      startingEquityMinor: INITIAL.toString(), endingEquityMinor: last.equity.toString(),
      netReturnBeforePersonalDividendTaxFraction: fraction(last.equity - INITIAL, INITIAL),
      maximumDrawdownBeforePersonalDividendTaxFraction: drawdown(points),
      completedTradeCount: closed.length, wins, losses, breakevens: closed.length - wins - losses,
      completedTradeWinRateBeforePersonalDividendTax: closed.length === 0 ? null : wins / closed.length,
      completedTrades: closed, openPositionQuantity: quantity, pendingOrderCount: pending.length,
      cancelPendingOrderCount: pending.filter((o) => o["cancelPending"] === true).length,
      outcome: closed.length ? "DESCRIPTIVE_COMPLETED_TRADES" : quantity ? "OPEN_POSITION_AT_CUTOFF" : pending.length ? "UNFILLED_ORDER_AT_CUTOFF" : decisions.riskRejected ? "RISK_REJECTED_WITHOUT_COMPLETED_TRADE" : "NO_ENTRY_SIGNAL",
      feesPaidMinor: fees.toString(), simulatedSlippageCostMinor: slippage.toString(), sellTransactionTaxFloorMinor: taxFloor.toString(), sellTransactionTaxCeilMinor: taxCeil.toString(),
      distributionCashMinor: distributionCash.toString(), distributionReceivableMinor: receivable.toString(),
      dividendEntitlements: entitlements, decisions, reasonCodeCounts: reasons, fillCount: fillIds.size,
      firstInvestedDate: points.find((p) => p.quantity > 0)?.date ?? null,
      markedPositionValueAtCutoffMinor: (events.at(-1)!.priceMinor * BigInt(quantity)).toString(),
      investedSessionCount: points.filter((p) => p.quantity > 0).length, evaluatedSessionCount: points.length,
      adjustedExecutionCashAtCutoffMinor: (cash - taxCeil).toString(),
      interpretation: "Equity and closed-trade PnL include entitled distributions and conservative sell tax; personal distribution taxes and broker minimum fees remain unknown. Open positions are marked, not liquidated.",
    },
  };
}

export function evaluateHistoricalWindow(
  parsed: ParsedHistoricalCsv,
  sourceSha256: string,
  window: HistoricalDiagnosticWindow,
  signals: readonly MonthEndTrendSignal[],
  dividends: readonly HistoricalDividend[],
): Json {
  date(window.startDate); date(window.endDate);
  if (window.startDate > window.endDate || (window.startDate < SPLIT_DATE && window.endDate >= SPLIT_DATE)) throw new TypeError("independent window cannot cross the split boundary");
  const events = parsed.session.events.filter((e) => dateOf(e.eventId) >= window.startDate && dateOf(e.eventId) <= window.endDate);
  if (events.length !== window.rowCount || dateOf(events[0]?.eventId ?? "") !== window.startDate || dateOf(events.at(-1)?.eventId ?? "") !== window.endDate) throw new TypeError("window row count or endpoints do not reconcile");
  if (parsed.session.simulation.initialCashMinor !== INITIAL || parsed.session.simulation.terms.feeBps !== 30 || parsed.session.simulation.terms.slippageBps !== 100) throw new TypeError("locked execution economics mismatch");
  const session = { ...parsed.session, events };
  const benchmarkStrategy: PaperStrategy = { strategyVersion: "cost-matched-always-long-benchmark-v1", decide: () => 3 };
  const candidate = reconcileHistoricalRun(runPaperSession(session, sourceSha256, undefined, strategy(signals, window.startDate), undefined, { captureEquityCurve: true }), events, dividends);
  const benchmark = reconcileHistoricalRun(runPaperSession(session, sourceSha256, undefined, benchmarkStrategy, undefined, { captureEquityCurve: true }), events, dividends);
  const c = candidate.points.at(-1)!;
  const b = benchmark.points.at(-1)!;
  const delta = c.equity - b.equity;
  // Same unknown haircut applied to each official event in both arms. Allow
  // each event its full 0..100% range; do not invent a taxpayer rate/composition.
  let personalTaxDeltaMin = 0n;
  let personalTaxDeltaMax = 0n;
  const cEntitlements = candidate.summary["dividendEntitlements"] as Json[];
  const bEntitlements = benchmark.summary["dividendEntitlements"] as Json[];
  for (const [i, entitlement] of cEntitlements.entries()) {
    if (entitlement["exDate"] !== bEntitlements[i]?.["exDate"]) throw new TypeError("dividend comparison schedules differ");
    const differential = integer(entitlement["entitlementMinor"], "candidate dividend") - integer(bEntitlements[i]!["entitlementMinor"], "benchmark dividend");
    if (differential > 0n) personalTaxDeltaMin -= differential;
    else personalTaxDeltaMax -= differential;
  }
  const floorDelta = delta + personalTaxDeltaMin - (b.taxCeil - b.taxFloor);
  const ceilDelta = delta + personalTaxDeltaMax + (c.taxCeil - c.taxFloor);
  return {
    ...window, candidate: candidate.summary, costMatchedBenchmark: benchmark.summary,
    eligibleSignalCount: signals.filter((s) => s.signalDate >= window.startDate && s.signalDate <= window.endDate).length,
    carriedSignalAtStart: signals.filter((s) => s.signalDate < window.startDate).at(-1) ?? null,
    relativeOutcome: {
      endingEquityDeltaMinor: delta.toString(), excessNetReturnBeforePersonalDividendTaxFraction: fraction(delta, INITIAL),
      taxSensitivityEndingEquityDeltaMinor: { lower: floorDelta.toString(), upper: ceilDelta.toString() },
      taxSensitivityExcessReturnFraction: { lower: fraction(floorDelta, INITIAL), upper: fraction(ceilDelta, INITIAL) },
      directionAcrossModeledTaxBounds: floorDelta > 0n ? "CANDIDATE_HIGHER" : ceilDelta < 0n ? "BENCHMARK_HIGHER" : "INDETERMINATE",
      personalTaxInterpretation: "Common event-specific distribution haircut between 0% and 100% plus sell-tax whole-TWD rounding bounds. This is a sensitivity bound, not an actual tax return.",
    },
  };
}

export async function runHistoricalActionCostDiagnosticFiles(root = process.cwd()): Promise<Json> {
  const [input, configBytes, dividendBytes, provenanceBytes] = await Promise.all([
    readFile(resolve(root, INPUT)), readFile(resolve(root, HISTORICAL_ACTION_COST_CONFIG)), readFile(resolve(root, DIVIDENDS)),
    readFile(resolve(root, "data/market/p194-twstock-ohlcv-v1/provenance.json")),
  ]);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const config = record(JSON.parse(configBytes.toString()), "config");
  const candidate = record(config["candidate"], "candidate");
  const economics = record(config["economics"], "economics");
  if (sha(configBytes) !== LOCK_SHA256 || config["schemaVersion"] !== 2 || config["artifactId"] !== "0050-historical-action-cost-config-v2"
    || config["classification"] !== "RETROSPECTIVE_DIAGNOSTIC_ONLY" || config["sourceSha256"] !== sha(input)
    || config["dividendsSha256"] !== sha(dividendBytes)
    || candidate["version"] !== TREND_VS_HOLD_VERSION || candidate["lookbackMonths"] !== 10 || candidate["targetQuantity"] !== 3
    || candidate["candidateCount"] !== 1 || candidate["parameterSearch"] !== false
    || economics["initialCapitalMinor"] !== "100000" || economics["feeBps"] !== 30 || economics["slippageBps"] !== 100 || economics["sellTransactionTaxBps"] !== 10) {
    throw new TypeError("locked identity, economics, source hash or corporate-action hash mismatch");
  }
  const parsed = parseHistoricalCsv(input.toString(), "0050", INPUT, "twse-daily-ohlcv-close-v1");
  const provenance = record(JSON.parse(provenanceBytes.toString()), "provenance");
  if (parsed.rowCount !== config["sourceRowCount"] || parsed.startDate !== config["sourceStartDate"] || parsed.endDate !== config["sourceEndDate"]
    || provenance["csvSha256"] !== sha(input) || record(provenance["perSymbolRowCounts"], "counts")["0050"] !== parsed.rowCount) throw new TypeError("source coverage or provenance mismatch");
  const schedule = record(JSON.parse(dividendBytes.toString()), "dividend schedule");
  const dividendEvents = schedule["events"] as HistoricalDividend[];
  if (schedule["symbol"] !== "0050" || schedule["fundId"] !== "1066" || !Array.isArray(dividendEvents) || dividendEvents.length !== 14) throw new TypeError("official dividend coverage missing");
  validateDividends(dividendEvents);
  const windows = config["windows"] as HistoricalDiagnosticWindow[];
  if (!Array.isArray(windows) || windows.length !== 8) throw new TypeError("locked chronological windows missing");
  const evaluationRows = parsed.sourceRows.filter((r) => r.date >= windows[0]!.startDate);
  if (evaluationRows.some((r) => windows.filter((w) => r.date >= w.startDate && r.date <= w.endDate).length !== 1)) throw new TypeError("chronological windows have gaps or overlaps");
  const rows = parsed.session.events.map((e) => ({ date: dateOf(e.eventId), closeMinor: e.priceMinor }));
  if (rows.find((r) => r.date === "2025-06-10")?.closeMinor !== 18_865n
    || rows.find((r) => r.date === SPLIT_DATE)?.closeMinor !== 4_757n) throw new TypeError("verified split boundary evidence missing");
  const signals = calculateTenMonthSmaSignals(rows, {
    evaluationStartDate: "2020-10-01", evaluationEndDate: parsed.endDate, warmupStartDate: parsed.startDate,
    firstEligibleSignalMonth: "2020-10", lastEligibleSignalMonth: "2026-07", windows: [],
  });
  const results = windows.map((window) => evaluateHistoricalWindow(parsed, sha(input), window, signals, dividendEvents));
  const output: Json = {
    schemaVersion: 2, artifactId: "0050-historical-action-cost-diagnostic-v2", classification: "RETROSPECTIVE_DIAGNOSTIC_ONLY",
    promotionStatus: "NOT_ELIGIBLE_RETROSPECTIVE_DIAGNOSTIC", unseenHoldoutCount: 0,
    configSha256: sha(configBytes), corporateActionsSha256: sha(dividendBytes), sourceSha256: sha(input),
    sourceRowCount: parsed.rowCount, evaluationRowCount: evaluationRows.length, warmupRowCount: parsed.rowCount - evaluationRows.length,
    sourceDateRange: { start: parsed.startDate, end: parsed.endDate }, signalCount: signals.length, signals,
    corporateActions: { source: schedule["source"], sourcePageSha256: schedule["sourcePageSha256"], eventCount: dividendEvents.length, events: dividendEvents },
    economics, split: config["split"], windowPolicy: config["windowPolicy"], signalBasis: config["signalBasis"],
    results,
    descriptiveWindowCounts: {
      denominator: results.length,
      candidateHigher: results.filter((r) => record(r["relativeOutcome"], "relative outcome")["directionAcrossModeledTaxBounds"] === "CANDIDATE_HIGHER").length,
      benchmarkHigher: results.filter((r) => record(r["relativeOutcome"], "relative outcome")["directionAcrossModeledTaxBounds"] === "BENCHMARK_HIGHER").length,
      tiedOrTaxIndeterminate: results.filter((r) => record(r["relativeOutcome"], "relative outcome")["directionAcrossModeledTaxBounds"] === "INDETERMINATE").length,
      interpretation: "Independent descriptive segments; not a statistical success rate or promotion gate.",
    },
    interpretationLimits: [
      "All source prices were already observed; no new holdout or live profit evidence.",
      "Independent portfolios reset at calendar/split boundaries. Terminal positions are marked and discarded for the next independent experiment, without a synthetic sale. No compounded aggregate return or continuous split-crossing portfolio is claimed.",
      "Raw 3-share economic exposure differs before and after the split; comparisons are valid within each identical-cost window only.",
      "The existing maxPositionQuantity=4 and maxExposureMinor=50000 risk limits remain active. Rejected entries are not replaced with synthetic fills.",
      "Fees/slippage are simulated existing terms. Broker minimum fees and taxpayer distribution composition/rates are unknown. Net performance before personal distribution taxes is not fully after-tax investor performance.",
      "Source session completeness lacks an exchange-calendar attestation. Monthly closes use the last available row, confirmed by the next calendar month's presence.",
    ],
  };
  await writeFile(resolve(root, HISTORICAL_ACTION_COST_OUTPUT), `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    process.stdout.write(`${JSON.stringify({ status: "ERROR", code: "CLI_OVERRIDES_NOT_ALLOWED" })}\n`);
    process.exitCode = 1;
  } else {
    runHistoricalActionCostDiagnosticFiles().then((result) => {
      process.stdout.write(`${JSON.stringify({ status: "RETROSPECTIVE_DIAGNOSTIC_ONLY", outputPath: resolve(HISTORICAL_ACTION_COST_OUTPUT), sourceRowCount: result["sourceRowCount"], evaluationRowCount: result["evaluationRowCount"], results: result["results"] })}\n`);
    }).catch((error: unknown) => {
      process.stdout.write(`${JSON.stringify({ status: "ERROR", code: "HISTORICAL_DIAGNOSTIC_INPUT_OR_RECONCILIATION_FAILED", reason: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    });
  }
}
