import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stderr, stdout } from "node:process";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import { SPLIT_REBASED_DIVIDENDS, type SplitRebasedDividend } from "./splitRebasedHistoricalBenchmark.js";
import type { PaperStrategy, SimulationEvent, StrategyInput } from "./types.js";

export const TREND_VS_HOLD_VERSION = "0050-month-end-10m-sma-long-cash-v1" as const;
export const TREND_VS_HOLD_CONFIG_PATH = "packages/paper-trading/trend-vs-hold-config-v1.json" as const;
export const TREND_VS_HOLD_INPUT_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv" as const;
export const TREND_VS_HOLD_PROVENANCE_PATH = "data/market/p194-twstock-ohlcv-v1/provenance.json" as const;
export const TREND_VS_HOLD_OUTPUT_PATH = "packages/paper-trading/trend-vs-hold-diagnostic-v1.json" as const;

const SYMBOL = "0050";
const TWSE_PROFILE = "twse-daily-ohlcv-close-v1" as const;
const SPLIT_EFFECTIVE_DATE = "2025-06-18";
const SPLIT_RATIO = 4n;
const LOOKBACK_MONTHS = 10;
const TARGET_QUANTITY = 3;
const RETURN_SCALE = 100_000_000n;
const TWSE_SPLIT_SOURCE = "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other";

type JsonRecord = Record<string, unknown>;

export interface TrendEvaluationWindow {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface TenMonthTrendPlan {
  readonly evaluationStartDate: string;
  readonly evaluationEndDate: string;
  readonly warmupStartDate: string;
  readonly firstEligibleSignalMonth: string;
  readonly lastEligibleSignalMonth: string;
  readonly windows: readonly TrendEvaluationWindow[];
  readonly lookbackMonths?: number;
  readonly targetQuantity?: number;
  readonly initialCapitalMinor?: bigint;
  readonly splitEffectiveDate?: string;
  readonly splitRatio?: bigint;
}

export interface MonthEndTrendSignal {
  readonly month: string;
  readonly signalDate: string;
  readonly closeMinor: string;
  readonly comparisonCloseMinor: string;
  readonly movingAverageNumeratorMinor: string;
  readonly movingAverageDenominator: number;
  readonly relation: "ABOVE" | "BELOW" | "EQUAL";
  readonly targetPositionQuantity: number | null;
}

interface DailyPoint {
  readonly date: string;
  readonly equityMinor: bigint;
  readonly engineEquityMinor: bigint;
  readonly positionQuantity: number;
  readonly markedPositionValueMinor: bigint;
  readonly distributionCashMinor: bigint;
  readonly distributionReceivableMinor: bigint;
  readonly dailyReturnFraction: string;
}

interface RunMetrics {
  readonly strategyVersion: string;
  readonly completedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly completedTradeWinRate: number | null;
  readonly noTradeDecisionCount: number;
  readonly orderSubmittedCount: number;
  readonly riskRejectedDecisionCount: number;
  readonly fillCount: number;
  readonly filledQuantity: number;
  readonly openPositionQuantity: number;
  readonly feesPaidMinor: bigint;
  readonly initialCapitalMinor: bigint;
  readonly accountEquityMinor: bigint;
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function safeCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function positiveMinorString(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${path} must be a positive integer string in TWD 0.01 units`);
  }
  return BigInt(value);
}

function integerValue(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${path} must be an integer amount`);
}

function decimalPriceMinor(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new TypeError(`${path} must be a positive TWD price with at most two decimal places`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (result <= 0n) throw new TypeError(`${path} must be positive`);
  return result;
}

function fraction(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new RangeError("fraction denominator must be positive");
  const sign = numerator < 0n ? "-" : "";
  const absolute = numerator < 0n ? -numerator : numerator;
  const scaled = (absolute * RETURN_SCALE + denominator / 2n) / denominator;
  return `${sign}${(scaled / RETURN_SCALE).toString()}.${(scaled % RETURN_SCALE).toString().padStart(8, "0")}`;
}

function parsePlan(value: unknown): TenMonthTrendPlan & {
  readonly lookbackMonths: number;
  readonly targetQuantity: number;
  readonly initialCapitalMinor: bigint;
  readonly splitEffectiveDate: string;
  readonly splitRatio: bigint;
} {
  const root = asRecord(value, "trend diagnostic config");
  if (root["schemaVersion"] !== 1 || root["artifactId"] !== "0050-10m-sma-trend-vs-hold-config-v1") {
    throw new TypeError("trend diagnostic config identity is unsupported");
  }
  if (root["classification"] !== "RETROSPECTIVE_DIAGNOSTIC_ONLY") {
    throw new TypeError("trend diagnostic must remain retrospective-only");
  }

  const candidate = asRecord(root["lockedCandidate"], "lockedCandidate");
  if (candidate["strategyVersion"] !== TREND_VS_HOLD_VERSION
    || candidate["lookbackCompletedMonthEndCloses"] !== LOOKBACK_MONTHS
    || candidate["targetQuantity"] !== TARGET_QUANTITY
    || candidate["candidateCount"] !== 1
    || candidate["parameterSearch"] !== false) {
    throw new TypeError("locked candidate parameters do not match the implemented single 10-month SMA rule");
  }

  const economics = asRecord(root["economics"], "economics");
  const data = asRecord(root["data"], "data");
  const split = asRecord(root["splitHandling"], "splitHandling");
  const rawWindows = data["evaluationWindows"];
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) throw new TypeError("evaluationWindows must be a non-empty array");
  const windows = Object.freeze(rawWindows.map((raw, index) => {
    const window = asRecord(raw, `evaluationWindows[${index}]`);
    return Object.freeze({
      id: requiredString(window["id"], `evaluationWindows[${index}].id`),
      startDate: requiredString(window["start"], `evaluationWindows[${index}].start`),
      endDate: requiredString(window["end"], `evaluationWindows[${index}].end`),
    });
  }));

  if (data["inputPath"] !== TREND_VS_HOLD_INPUT_PATH
    || data["sha256"] !== "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7"
    || data["symbol"] !== SYMBOL
    || data["alreadyObservedHistoricalData"] !== true
    || data["unseenHoldoutWindows"] === undefined
    || !Array.isArray(data["unseenHoldoutWindows"])
    || data["unseenHoldoutWindows"].length !== 0) {
    throw new TypeError("data source, hash, or retrospective window lock is unsupported");
  }
  if (economics["currencyCode"] !== "TWD"
    || economics["initialCapitalMinor"] !== "100000"
    || economics["feeBpsPerFill"] !== 30
    || economics["slippageBpsPerFill"] !== 100
    || economics["fillModel"] !== "EXISTING_ALWAYS_FILL_NEXT_OBSERVED_CLOSE_EVENT") {
    throw new TypeError("cost model does not match the frozen cost-matched benchmark terms");
  }
  if (split["effectiveDate"] !== SPLIT_EFFECTIVE_DATE
    || split["postToPreShareRatio"] !== Number(SPLIT_RATIO)
    || split["evaluationStartDate"] !== "2025-06-18") {
    throw new TypeError("split normalization or evaluation start does not match the verified 0050 split");
  }

  const evaluationRange = asRecord(data["evaluationDateRange"], "data.evaluationDateRange");
  const returnPlan = Object.freeze({
    evaluationStartDate: requiredString(evaluationRange["start"], "data.evaluationDateRange.start"),
    evaluationEndDate: requiredString(evaluationRange["end"], "data.evaluationDateRange.end"),
    warmupStartDate: requiredString(split["warmupStartDate"], "splitHandling.warmupStartDate"),
    firstEligibleSignalMonth: requiredString(split["firstEligibleSignalMonth"], "splitHandling.firstEligibleSignalMonth"),
    lastEligibleSignalMonth: requiredString(split["lastEligibleSignalMonth"], "splitHandling.lastEligibleSignalMonth"),
    windows,
    lookbackMonths: LOOKBACK_MONTHS,
    targetQuantity: TARGET_QUANTITY,
    initialCapitalMinor: positiveMinorString(economics["initialCapitalMinor"], "economics.initialCapitalMinor"),
    splitEffectiveDate: SPLIT_EFFECTIVE_DATE,
    splitRatio: SPLIT_RATIO,
  });
  return returnPlan;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function parseMonthKey(value: string, path: string): { readonly year: number; readonly month: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new TypeError(`${path} must use YYYY-MM`);
  return Object.freeze({ year: Number(match[1]), month: Number(match[2]) });
}

function nextMonth(value: string): string {
  const parsed = parseMonthKey(value, "month");
  return parsed.month === 12
    ? `${parsed.year + 1}-01`
    : `${parsed.year}-${String(parsed.month + 1).padStart(2, "0")}`;
}

export function calculateTenMonthSmaSignals(
  rows: readonly { readonly date: string; readonly closeMinor: bigint }[],
  plan: TenMonthTrendPlan,
): readonly MonthEndTrendSignal[] {
  const lookback = plan.lookbackMonths ?? LOOKBACK_MONTHS;
  const targetQuantity = plan.targetQuantity ?? TARGET_QUANTITY;
  const splitDate = plan.splitEffectiveDate ?? SPLIT_EFFECTIVE_DATE;
  const splitRatio = plan.splitRatio ?? SPLIT_RATIO;
  if (!Number.isSafeInteger(lookback) || lookback !== LOOKBACK_MONTHS) {
    throw new RangeError("the locked candidate uses exactly 10 month-end closes");
  }
  if (!Number.isSafeInteger(targetQuantity) || targetQuantity !== TARGET_QUANTITY) {
    throw new RangeError("the locked candidate uses exactly 3 shares");
  }
  if (splitRatio !== SPLIT_RATIO || splitDate !== SPLIT_EFFECTIVE_DATE) {
    throw new RangeError("split normalization must match the verified 0050 4:1 split");
  }

  const latestByMonth = new Map<string, { date: string; closeMinor: bigint }>();
  let previousDate = "";
  for (const [index, row] of rows.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date <= previousDate) {
      throw new TypeError(`trend input row ${index} dates must be valid and strictly increasing`);
    }
    if (row.closeMinor <= 0n) throw new TypeError(`trend input row ${index} close must be positive`);
    previousDate = row.date;
    latestByMonth.set(monthKey(row.date), { date: row.date, closeMinor: row.closeMinor });
  }
  if (latestByMonth.size === 0) throw new TypeError("trend input has no monthly closes");

  const monthly = [...latestByMonth.entries()].map(([month, value]) => ({ month, ...value }));
  const monthIndexes = new Map(monthly.map((entry, index) => [entry.month, index]));
  const warmupMonth = monthKey(plan.warmupStartDate);
  let expectedMonth = warmupMonth;
  while (expectedMonth <= plan.lastEligibleSignalMonth) {
    if (!monthIndexes.has(expectedMonth)) throw new TypeError(`monthly close data is missing ${expectedMonth}`);
    expectedMonth = nextMonth(expectedMonth);
  }

  const results: MonthEndTrendSignal[] = [];
  for (let index = 0; index < monthly.length; index += 1) {
    const current = monthly[index]!;
    const next = monthly[index + 1];
    // The next calendar month in the archive confirms the prior calendar month's final observed close.
    const monthIsComplete = next !== undefined && next.month === nextMonth(current.month);
    if (!monthIsComplete
      || current.month < plan.firstEligibleSignalMonth
      || current.month > plan.lastEligibleSignalMonth
      || current.date < plan.evaluationStartDate
      || current.date > plan.evaluationEndDate) continue;
    if (index + 1 < lookback) continue;

    const trailing = monthly.slice(index - lookback + 1, index + 1);
    if (trailing.length !== lookback) continue;
    for (let offset = 1; offset < trailing.length; offset += 1) {
      if (trailing[offset]!.month !== nextMonth(trailing[offset - 1]!.month)) {
        throw new TypeError(`10-month SMA window before ${current.month} has a missing month`);
      }
    }

    const scaled = (entry: typeof current): bigint => entry.closeMinor
      * (entry.date >= splitDate ? splitRatio : 1n);
    const currentComparisonPrice = scaled(current);
    const sum = trailing.reduce((total, entry) => total + scaled(entry), 0n);
    const delta = currentComparisonPrice * BigInt(lookback) - sum;
    const relation = delta > 0n ? "ABOVE" : delta < 0n ? "BELOW" : "EQUAL";
    results.push(Object.freeze({
      month: current.month,
      signalDate: current.date,
      closeMinor: current.closeMinor.toString(),
      comparisonCloseMinor: currentComparisonPrice.toString(),
      movingAverageNumeratorMinor: sum.toString(),
      movingAverageDenominator: lookback,
      relation,
      targetPositionQuantity: relation === "ABOVE" ? targetQuantity : relation === "BELOW" ? 0 : null,
    }));
  }

  if (results.length === 0) throw new TypeError("no completed month-end signal is available in the locked evaluation range");
  return Object.freeze(results);
}

function dateFromEventId(eventId: string): string {
  const match = /^historical-0050-(\d{4}-\d{2}-\d{2})$/.exec(eventId);
  if (!match) throw new TypeError(`trend strategy received an invalid 0050 historical event ID: ${eventId}`);
  return match[1]!;
}

function trendStrategy(signals: readonly MonthEndTrendSignal[]): PaperStrategy {
  const targetByDate = new Map(signals
    .filter((signal) => signal.targetPositionQuantity !== null)
    .map((signal) => [signal.signalDate, signal.targetPositionQuantity!]));
  return Object.freeze({
    strategyVersion: TREND_VS_HOLD_VERSION,
    strategyParameters: Object.freeze({
      lookbackCompletedMonthEndCloses: LOOKBACK_MONTHS,
      targetQuantity: TARGET_QUANTITY,
      signalTiming: "COMPLETED_CALENDAR_MONTH_END",
      priceBasis: "RAW_CLOSE_SPLIT_NORMALIZED_FOR_SMA",
    }),
    decide: (input: StrategyInput) => targetByDate.get(dateFromEventId(input.current.eventId)) ?? input.positionQuantity,
  });
}

function createEvaluationSession(parsed: ParsedHistoricalCsv, plan: TenMonthTrendPlan & { readonly initialCapitalMinor: bigint }) {
  const events = parsed.session.events.filter((event) => {
    const date = dateFromEventId(event.eventId);
    return date >= plan.evaluationStartDate && date <= plan.evaluationEndDate;
  });
  const expectedRows = parsed.sourceRows.filter((row) => row.date >= plan.evaluationStartDate && row.date <= plan.evaluationEndDate);
  if (events.length === 0 || events.length !== expectedRows.length) {
    throw new TypeError("evaluation events do not reconcile to the locked P194 row range");
  }
  if (expectedRows[0]?.date !== plan.evaluationStartDate || expectedRows.at(-1)?.date !== plan.evaluationEndDate) {
    throw new TypeError("evaluation dates do not reach both locked endpoints");
  }
  return Object.freeze({
    ...parsed.session,
    sourceLabel: `${parsed.session.sourceLabel}; retrospective post-split 0050 trend diagnostic`,
    simulation: Object.freeze({ ...parsed.session.simulation, initialCashMinor: plan.initialCapitalMinor }),
    events: Object.freeze(events),
  });
}

function runSummary(run: JsonRecord): RunMetrics {
  const account = asRecord(run["accountSummary"], "accountSummary");
  const statistics = asRecord(run["tradingStatistics"], "tradingStatistics");
  const journal = run["journal"];
  if (!Array.isArray(journal)) throw new TypeError("paper session journal must be an array");
  let noTradeDecisionCount = 0;
  let orderSubmittedCount = 0;
  let riskRejectedDecisionCount = 0;
  let fillCount = 0;
  let filledQuantity = 0;
  for (const raw of journal as readonly SimulationEvent[]) {
    if (raw.kind === "decision") {
      if (raw.status === "no-trade") noTradeDecisionCount += 1;
      else if (raw.status === "risk-rejected") riskRejectedDecisionCount += 1;
      else orderSubmittedCount += 1;
    } else if (raw.kind === "fill") {
      fillCount += 1;
      filledQuantity += raw.quantity;
    }
  }
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "tradingStatistics.completeTradeCount");
  const completedTradeWinRate = completedTradeCount === 0
    ? null
    : typeof statistics["netWinRate"] === "number" ? statistics["netWinRate"] : null;
  if (completedTradeCount > 0 && completedTradeWinRate === null) {
    throw new TypeError("completed trades have no reconciled win-rate denominator");
  }
  return Object.freeze({
    strategyVersion: requiredString(run["strategyVersion"], "strategyVersion"),
    completedTradeCount,
    wins: safeCount(statistics["wins"], "tradingStatistics.wins"),
    losses: safeCount(statistics["losses"], "tradingStatistics.losses"),
    breakevens: safeCount(statistics["breakevens"], "tradingStatistics.breakevens"),
    completedTradeWinRate,
    noTradeDecisionCount,
    orderSubmittedCount,
    riskRejectedDecisionCount,
    fillCount,
    filledQuantity,
    openPositionQuantity: safeCount(account["positionQuantity"], "accountSummary.positionQuantity"),
    feesPaidMinor: integerValue(account["feesPaidMinor"], "accountSummary.feesPaidMinor"),
    initialCapitalMinor: integerValue(run["simulationSettings"] && asRecord(run["simulationSettings"], "simulationSettings")["initialCashMinor"], "simulationSettings.initialCashMinor"),
    accountEquityMinor: integerValue(account["equityMinor"], "accountSummary.equityMinor"),
  });
}

function fillsByDate(run: JsonRecord): ReadonlyMap<string, readonly Extract<SimulationEvent, { kind: "fill" }>[]> {
  const journal = run["journal"];
  if (!Array.isArray(journal)) throw new TypeError("paper session journal must be an array");
  const fills = new Map<string, Extract<SimulationEvent, { kind: "fill" }>[] >();
  for (const event of journal as readonly SimulationEvent[]) {
    if (event.kind !== "fill") continue;
    const date = dateFromEventId(event.sourceMarketEventId);
    const daily = fills.get(date) ?? [];
    daily.push(event);
    fills.set(date, daily);
  }
  return fills;
}

function accountCurve(
  run: JsonRecord,
  dates: readonly string[],
  pricesByDate: ReadonlyMap<string, bigint>,
  distributions: readonly SplitRebasedDividend[],
  initialCapitalMinor: bigint,
): readonly DailyPoint[] {
  const rawCurve = run["equityCurve"];
  if (!Array.isArray(rawCurve) || rawCurve.length !== dates.length) {
    throw new TypeError("paper session daily equity curve does not match its evaluation rows");
  }
  const fills = fillsByDate(run);
  const distributionByExDate = new Map(distributions.map((event) => [event.exDate, event]));
  const distributionByPayDate = new Map(distributions.map((event) => [event.payDate, event]));
  const quantityBeforeExDate = new Map<string, number>();
  const pendingByPayDate = new Map<string, bigint>();
  let positionQuantity = 0;
  for (const date of dates) {
    if (distributionByExDate.has(date)) quantityBeforeExDate.set(date, positionQuantity);
    for (const fill of fills.get(date) ?? []) positionQuantity += fill.side === "buy" ? fill.quantity : -fill.quantity;
    if (positionQuantity < 0) throw new Error(`reconstructed holdings became negative on ${date}`);
  }

  let receivableMinor = 0n;
  let cashMinor = 0n;
  let previousEquityMinor = initialCapitalMinor;
  let reconstructedPosition = 0;
  const results = dates.map((date, index): DailyPoint => {
    const exDateEvent = distributionByExDate.get(date);
    if (exDateEvent) {
      const quantity = quantityBeforeExDate.get(date) ?? 0;
      const amount = positiveMinorString(exDateEvent.amountPerShareMinor, `distribution ${date}.amountPerShareMinor`);
      const receivable = BigInt(quantity) * amount;
      receivableMinor += receivable;
      pendingByPayDate.set(exDateEvent.payDate, (pendingByPayDate.get(exDateEvent.payDate) ?? 0n) + receivable);
    }
    if (distributionByPayDate.has(date)) {
      const paid = pendingByPayDate.get(date) ?? 0n;
      if (paid > receivableMinor) throw new Error(`distribution payment on ${date} exceeds its receivable`);
      receivableMinor -= paid;
      cashMinor += paid;
      pendingByPayDate.delete(date);
    }

    for (const fill of fills.get(date) ?? []) reconstructedPosition += fill.side === "buy" ? fill.quantity : -fill.quantity;
    const point = asRecord(rawCurve[index], `equityCurve[${index}]`);
    const engineEquityMinor = integerValue(point["equityMinor"], `equityCurve[${index}].equityMinor`);
    const priceMinor = pricesByDate.get(date);
    if (priceMinor === undefined) throw new Error(`missing raw P194 close for ${date}`);
    const markedPositionValueMinor = priceMinor * BigInt(reconstructedPosition);
    const equityMinor = engineEquityMinor + receivableMinor + cashMinor;
    const dailyReturnFraction = fraction(equityMinor - previousEquityMinor, previousEquityMinor);
    previousEquityMinor = equityMinor;
    return Object.freeze({
      date,
      equityMinor,
      engineEquityMinor,
      positionQuantity: reconstructedPosition,
      markedPositionValueMinor,
      distributionCashMinor: cashMinor,
      distributionReceivableMinor: receivableMinor,
      dailyReturnFraction,
    });
  });
  return Object.freeze(results);
}

function maximumDrawdown(points: readonly DailyPoint[], startingEquity: bigint): string {
  let peak = startingEquity;
  let maximumNumerator = 0n;
  let maximumDenominator = startingEquity;
  for (const point of points) {
    if (point.equityMinor > peak) peak = point.equityMinor;
    if (peak > 0n && point.equityMinor < peak) {
      const numerator = peak - point.equityMinor;
      if (numerator * maximumDenominator > maximumNumerator * peak) {
        maximumNumerator = numerator;
        maximumDenominator = peak;
      }
    }
  }
  return fraction(maximumNumerator, maximumDenominator);
}

function summarizeWindow(
  points: readonly DailyPoint[],
  window: TrendEvaluationWindow,
  initialCapitalMinor: bigint,
  signals: readonly MonthEndTrendSignal[],
): JsonRecord {
  const prior = points.filter((point) => point.date < window.startDate).at(-1);
  const selected = points.filter((point) => point.date >= window.startDate && point.date <= window.endDate);
  const startingEquityMinor = prior?.equityMinor ?? initialCapitalMinor;
  const endingEquityMinor = selected.at(-1)?.equityMinor ?? startingEquityMinor;
  const distributionBefore = prior ? prior.distributionCashMinor + prior.distributionReceivableMinor : 0n;
  const distributionAfter = selected.at(-1)
    ? selected.at(-1)!.distributionCashMinor + selected.at(-1)!.distributionReceivableMinor
    : distributionBefore;
  return Object.freeze({
    id: window.id,
    configuredDateRange: Object.freeze({ start: window.startDate, end: window.endDate }),
    observedDateRange: Object.freeze({ start: selected[0]?.date ?? null, end: selected.at(-1)?.date ?? null }),
    rowCount: selected.length,
    startingEquityMinor: startingEquityMinor.toString(),
    endingEquityMinor: endingEquityMinor.toString(),
    netReturnFraction: selected.length === 0 ? null : fraction(endingEquityMinor - startingEquityMinor, startingEquityMinor),
    maximumDrawdownFraction: selected.length === 0 ? null : maximumDrawdown(selected, startingEquityMinor),
    incrementalDistributionIncomeMinor: (distributionAfter - distributionBefore).toString(),
    investedSessionCount: selected.filter((point) => point.positionQuantity > 0).length,
    evaluatedMonthEndSignals: signals.filter((signal) => signal.signalDate >= window.startDate && signal.signalDate <= window.endDate).length,
  });
}

function summarizeRun(
  label: string,
  run: JsonRecord,
  points: readonly DailyPoint[],
  plan: TenMonthTrendPlan & { readonly initialCapitalMinor: bigint },
  windows: readonly TrendEvaluationWindow[],
  signals: readonly MonthEndTrendSignal[],
): JsonRecord {
  const metrics = runSummary(run);
  const final = points.at(-1);
  if (!final || final.equityMinor !== metrics.accountEquityMinor + final.distributionCashMinor + final.distributionReceivableMinor) {
    throw new Error(`${label} final equity does not reconcile to the engine ledger and distribution balance`);
  }
  const markedExposure = points.reduce((maximum, point) => point.markedPositionValueMinor > maximum ? point.markedPositionValueMinor : maximum, 0n);
  const firstInvested = points.find((point) => point.positionQuantity > 0);
  const investmentDays = points.filter((point) => point.positionQuantity > 0).length;
  const netReturnFraction = fraction(final.equityMinor - plan.initialCapitalMinor, plan.initialCapitalMinor);
  return Object.freeze({
    label,
    strategyVersion: metrics.strategyVersion,
    startingEquityMinor: plan.initialCapitalMinor.toString(),
    endingEquityMinor: final.equityMinor.toString(),
    netReturnFraction,
    maximumDrawdownFraction: maximumDrawdown(points, plan.initialCapitalMinor),
    completedTradeCount: metrics.completedTradeCount,
    wins: metrics.wins,
    losses: metrics.losses,
    breakevens: metrics.breakevens,
    completedTradeWinRate: metrics.completedTradeWinRate,
    tradeOutcomeStatus: metrics.completedTradeCount === 0 ? "NOT_CALCULABLE_NO_COMPLETED_TRADES" : "DESCRIPTIVE_ONLY",
    openPositionQuantity: metrics.openPositionQuantity,
    fillCount: metrics.fillCount,
    filledQuantity: metrics.filledQuantity,
    orderSubmittedDecisionCount: metrics.orderSubmittedCount,
    noTradeDecisionCount: metrics.noTradeDecisionCount,
    riskRejectedDecisionCount: metrics.riskRejectedDecisionCount,
    feesPaidMinor: metrics.feesPaidMinor.toString(),
    distributionCashMinor: final.distributionCashMinor.toString(),
    distributionReceivableMinor: final.distributionReceivableMinor.toString(),
    markedPositionValueAtCutoffMinor: final.markedPositionValueMinor.toString(),
    firstInvestedDate: firstInvested?.date ?? null,
    firstInvestedPositionValueMinor: (firstInvested?.markedPositionValueMinor ?? 0n).toString(),
    firstInvestedCashRemainingMinor: firstInvested
      ? (firstInvested.engineEquityMinor - firstInvested.markedPositionValueMinor).toString()
      : plan.initialCapitalMinor.toString(),
    firstInvestedPositionFractionOfStartingEquity: fraction(firstInvested?.markedPositionValueMinor ?? 0n, plan.initialCapitalMinor),
    maximumMarkedPositionValueMinor: markedExposure.toString(),
    maximumMarkedPositionFractionOfStartingEquity: fraction(markedExposure, plan.initialCapitalMinor),
    investedSessionCount: investmentDays,
    evaluatedSessionCount: points.length,
    investedSessionFraction: points.length === 0 ? null : fraction(BigInt(investmentDays), BigInt(points.length)),
    chronologicalWindows: Object.freeze(windows.map((window) => summarizeWindow(points, window, plan.initialCapitalMinor, signals))),
  });
}

function alwaysLongStrategy(quantity: number): PaperStrategy {
  return Object.freeze({
    strategyVersion: "cost-matched-always-long-benchmark-v1",
    strategyParameters: Object.freeze({ policy: "ALWAYS_LONG", targetQuantity: quantity }),
    decide: () => quantity,
  });
}

function validateSplitEvidence(parsed: ParsedHistoricalCsv): void {
  const previous = parsed.sourceRows.find((row) => row.date === "2025-06-10");
  const firstPostSplit = parsed.sourceRows.find((row) => row.date === SPLIT_EFFECTIVE_DATE);
  if (!previous || !firstPostSplit) throw new TypeError("P194 archive is missing the verified 0050 split boundary rows");
  const previousClose = decimalPriceMinor(previous.valuesByColumn["close"], "2025-06-10.close");
  const postClose = decimalPriceMinor(firstPostSplit.valuesByColumn["close"], `${SPLIT_EFFECTIVE_DATE}.close`);
  if (previousClose !== 18_865n || postClose !== 4_757n || (previousClose + 2n) / SPLIT_RATIO !== 4_716n) {
    throw new TypeError("P194 split boundary prices do not reconcile to the documented 4:1 0050 split");
  }
}

export function evaluateTrendVsHoldDiagnostic(
  parsed: ParsedHistoricalCsv,
  sourceSha256: string,
  plan: TenMonthTrendPlan & { readonly lookbackMonths: number; readonly targetQuantity: number; readonly initialCapitalMinor: bigint; readonly splitEffectiveDate: string; readonly splitRatio: bigint },
  distributions: readonly SplitRebasedDividend[] = SPLIT_REBASED_DIVIDENDS,
  configSha256 = "",
): JsonRecord {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new TypeError("sourceSha256 must be a lowercase SHA-256 digest");
  if (parsed.symbol !== SYMBOL || parsed.sourceProfile !== "TWSE_DAILY_OHLCV_CLOSE_V1" || parsed.minorUnitsPerMajor !== 100) {
    throw new TypeError("trend input must be raw TWSE 0050 close data in TWD 0.01 minor units");
  }
  if (parsed.rowCount !== parsed.sourceRows.length || parsed.rowCount !== parsed.session.events.length) {
    throw new TypeError("parsed P194 source rows, events, and rowCount do not reconcile");
  }
  if (parsed.startDate > plan.warmupStartDate || parsed.endDate !== plan.evaluationEndDate) {
    throw new TypeError("P194 source range does not cover the locked trend evaluation and cutoff");
  }
  validateSplitEvidence(parsed);

  const inputRows = parsed.sourceRows.map((row) => Object.freeze({
    date: row.date,
    closeMinor: decimalPriceMinor(row.valuesByColumn["close"], `${row.date}.close`),
  }));
  const signals = calculateTenMonthSmaSignals(inputRows, plan);
  const session = createEvaluationSession(parsed, plan);
  const dates = session.events.map((event) => dateFromEventId(event.eventId));
  const pricesByDate = new Map(inputRows
    .filter((row) => row.date >= plan.evaluationStartDate && row.date <= plan.evaluationEndDate)
    .map((row) => [row.date, row.closeMinor]));

  const candidateRun = runPaperSession(session, sourceSha256, undefined, trendStrategy(signals), undefined, { captureEquityCurve: true });
  const benchmarkRun = runPaperSession(session, sourceSha256, undefined, alwaysLongStrategy(plan.targetQuantity), undefined, { captureEquityCurve: true });
  const candidatePoints = accountCurve(candidateRun, dates, pricesByDate, distributions, plan.initialCapitalMinor);
  const benchmarkPoints = accountCurve(benchmarkRun, dates, pricesByDate, distributions, plan.initialCapitalMinor);
  const candidate = summarizeRun("10M_SMA_LONG_OR_CASH", asRecord(candidateRun, "candidateRun"), candidatePoints, plan, plan.windows, signals);
  const benchmark = summarizeRun("COST_MATCHED_ALWAYS_LONG_3_SHARES", asRecord(benchmarkRun, "benchmarkRun"), benchmarkPoints, plan, plan.windows, []);
  const candidateReturn = String(candidate["netReturnFraction"]);
  const benchmarkReturn = String(benchmark["netReturnFraction"]);
  const endingEquityDeltaMinor = integerValue(candidate["endingEquityMinor"], "candidate.endingEquityMinor")
    - integerValue(benchmark["endingEquityMinor"], "benchmark.endingEquityMinor");
  const excessNetReturnFraction = fraction(endingEquityDeltaMinor, plan.initialCapitalMinor);

  return Object.freeze({
    schemaVersion: 1,
    artifactId: "0050-10m-sma-trend-vs-hold-diagnostic-v1",
    classification: "RETROSPECTIVE_DIAGNOSTIC_ONLY",
    promotionStatus: "NOT_ELIGIBLE_RETROSPECTIVE_SINGLE_CANDIDATE_DIAGNOSTIC",
    winRateInterpretation: "A null completedTradeWinRate means there are no completed trades; 0% and PASS are not substituted.",
    config: Object.freeze({
      artifactId: "0050-10m-sma-trend-vs-hold-config-v1",
      sha256: configSha256 || null,
      committedBeforeReplay: true,
    }),
    data: Object.freeze({
      sourceArtifact: "p194-twstock-ohlcv-v1",
      inputPath: TREND_VS_HOLD_INPUT_PATH,
      sourceSha256,
      sourceRowCount: parsed.rowCount,
      sourceDateRange: Object.freeze({ start: parsed.startDate, end: parsed.endDate }),
      evaluationDateRange: Object.freeze({ start: dates[0] ?? null, end: dates.at(-1) ?? null }),
      evaluationRowCount: dates.length,
      alreadyObservedHistoricalData: true,
      unseenHoldoutWindows: Object.freeze([]),
      newNetworkDownloads: 0,
      sourceAccessStatus: "REUSE_EXISTING_LOCAL_ARCHIVE_ONLY; AUTOMATED_DOWNLOAD_PERMISSION_NOT_REVERIFIED",
    }),
    lockedCandidate: Object.freeze({
      strategyVersion: TREND_VS_HOLD_VERSION,
      lookbackCompletedMonthEndCloses: plan.lookbackMonths,
      signalCount: signals.length,
      aboveSmaSignalCount: signals.filter((signal) => signal.relation === "ABOVE").length,
      belowSmaSignalCount: signals.filter((signal) => signal.relation === "BELOW").length,
      equalSmaSignalCount: signals.filter((signal) => signal.relation === "EQUAL").length,
      signals,
      parameterSearch: false,
    }),
    economics: Object.freeze({
      currencyCode: "TWD",
      minorUnit: "0.01",
      initialCapitalMinor: plan.initialCapitalMinor.toString(),
      targetQuantity: plan.targetQuantity,
      feeBpsPerFill: 30,
      slippageBpsPerFill: 100,
      fillModel: "alwaysFillNextEvent",
      distributionTreatment: "POST_SPLIT_CASH_ENTITLEMENTS_AT_EX_DATE_AND_PAY_DATE; NO_REINVESTMENT",
      cashYieldFraction: "0.00000000",
      taxes: "EXCLUDED",
      terminalMark: "FINAL_RAW_CLOSE; NO_HYPOTHETICAL_LIQUIDATION_FEE",
    }),
    splitNormalization: Object.freeze({
      effectiveDate: SPLIT_EFFECTIVE_DATE,
      postToPreShareRatio: "4:1",
      comparisonPriceScale: "Scale post-split closes by 4 for SMA comparison; keep pre-split closes in original share units.",
      source: TWSE_SPLIT_SOURCE,
    }),
    corporateActions: Object.freeze({
      distributions: Object.freeze(distributions.map((item) => Object.freeze({ ...item }))),
      taxModel: "NOT_AVAILABLE",
      unrecordedHistoricalDistributionsAreNotImputed: true,
    }),
    results: Object.freeze({
      candidate: Object.freeze({
        ...candidate,
        excessNetReturnFractionVsBenchmark: excessNetReturnFraction,
        endingEquityDeltaMinorVsBenchmark: endingEquityDeltaMinor.toString(),
      }),
      costMatchedBenchmark: benchmark,
      relativeOutcome: Object.freeze({
        candidateNetReturnFraction: candidateReturn,
        benchmarkNetReturnFraction: benchmarkReturn,
        excessNetReturnFraction,
        endingEquityDeltaMinor: endingEquityDeltaMinor.toString(),
        measurement: "Candidate minus cost-matched 3-share holding benchmark, using identical TWD 1,000 initial capital and execution costs.",
      }),
    }),
    evaluationWindows: Object.freeze(plan.windows),
    interpretationLimits: Object.freeze([
      "Every source row and evaluation period was already available before this review; no result is a new unseen holdout.",
      "This is a fixed retrospective adaptation, not evidence that trend following is profitable or suitable for live use.",
      "The source paper used total-return data and Treasury-bill cash returns; this diagnostic has raw-close signals and zero cash yield.",
      "Taxes are excluded; only the three documented post-split distributions are modeled, so incomplete corporate-action history is not fabricated.",
      "The 3-share benchmark uses only a minority of TWD 1,000 starting cash; its return is not the fully invested 0050 return.",
    ]),
  });
}

function validateConfiguredDistributions(config: unknown): void {
  const root = asRecord(config, "trend diagnostic config");
  const raw = root["distributionEvents"];
  if (!Array.isArray(raw) || raw.length !== SPLIT_REBASED_DIVIDENDS.length) {
    throw new TypeError("trend diagnostic distribution schedule must match the documented post-split events");
  }
  for (const [index, value] of raw.entries()) {
    const actual = asRecord(value, `distributionEvents[${index}]`);
    const expected = SPLIT_REBASED_DIVIDENDS[index]!;
    if (actual["exDate"] !== expected.exDate
      || actual["payDate"] !== expected.payDate
      || actual["amountPerShareMinor"] !== expected.amountPerShareMinor
      || actual["source"] !== expected.source) {
      throw new TypeError(`distributionEvents[${index}] does not match the existing corporate-action evidence`);
    }
  }
}

export async function runTrendVsHoldDiagnosticFiles(
  inputPath = TREND_VS_HOLD_INPUT_PATH,
  configPath = TREND_VS_HOLD_CONFIG_PATH,
  provenancePath = TREND_VS_HOLD_PROVENANCE_PATH,
  outputPath = TREND_VS_HOLD_OUTPUT_PATH,
): Promise<JsonRecord> {
  const [inputBytes, configBytes, provenanceBytes] = await Promise.all([
    readFile(inputPath),
    readFile(configPath),
    readFile(provenancePath),
  ]);
  const sourceSha256 = createHash("sha256").update(inputBytes).digest("hex");
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)) as unknown;
  const plan = parsePlan(config);
  const dataConfig = asRecord(asRecord(config, "config")["data"], "data");
  if (dataConfig["sha256"] !== sourceSha256) throw new TypeError("local P194 input hash does not match the committed candidate lock");

  const parsed = parseHistoricalCsv(
    new TextDecoder("utf-8", { fatal: true }).decode(inputBytes),
    SYMBOL,
    inputPath,
    TWSE_PROFILE,
  );
  const provenance = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes)) as unknown, "P194 provenance");
  const perSymbolCounts = asRecord(provenance["perSymbolRowCounts"], "P194 provenance.perSymbolRowCounts");
  if (provenance["csvSha256"] !== sourceSha256
    || perSymbolCounts[SYMBOL] !== parsed.rowCount
    || provenance["artifactId"] !== "p194-twstock-ohlcv-v1") {
    throw new TypeError("P194 provenance does not reconcile to the committed local input");
  }
  validateConfiguredDistributions(config);

  const result = evaluateTrendVsHoldDiagnostic(parsed, sourceSha256, plan, SPLIT_REBASED_DIVIDENDS, configSha256);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(): Promise<void> {
  const result = await runTrendVsHoldDiagnosticFiles();
  const results = asRecord(result["results"], "results");
  const candidate = asRecord(results["candidate"], "results.candidate");
  const benchmark = asRecord(results["costMatchedBenchmark"], "results.costMatchedBenchmark");
  stdout.write(`${JSON.stringify({
    artifactId: result["artifactId"],
    outputPath: resolve(TREND_VS_HOLD_OUTPUT_PATH),
    sample: result["data"],
    candidate: {
      completedTradeCount: candidate["completedTradeCount"],
      completedTradeWinRate: candidate["completedTradeWinRate"],
      netReturnFraction: candidate["netReturnFraction"],
      maximumDrawdownFraction: candidate["maximumDrawdownFraction"],
      openPositionQuantity: candidate["openPositionQuantity"],
    },
    costMatchedBenchmark: {
      netReturnFraction: benchmark["netReturnFraction"],
      maximumDrawdownFraction: benchmark["maximumDrawdownFraction"],
      openPositionQuantity: benchmark["openPositionQuantity"],
    },
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${JSON.stringify({ status: "ERROR", error: message })}\n`);
    process.exitCode = 1;
  });
}
