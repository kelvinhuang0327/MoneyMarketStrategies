import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stdout } from "node:process";
import { PAPER_TRADING_DEMO_SETTINGS } from "./fixture.js";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import { PriceBandStrategy } from "./strategy.js";
import type { PaperStrategy, SimulationEvent } from "./types.js";

export const SPLIT_REBASED_BENCHMARK_VERSION = "price-band-split-rebased-historical-v1" as const;
export const SPLIT_REBASED_BENCHMARK_INPUT_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv" as const;
export const SPLIT_REBASED_BENCHMARK_PROVENANCE_PATH = "data/market/p194-twstock-ohlcv-v1/provenance.json" as const;
export const SPLIT_REBASED_BENCHMARK_SELECTION_PATH = "packages/paper-trading/win-rate-optimizer-v2.json" as const;
export const SPLIT_REBASED_BENCHMARK_FORWARD_INPUT_PATH = "data/market/forward/0050-forward-v2/0050_forward.csv" as const;
export const SPLIT_REBASED_BENCHMARK_FORWARD_PROVENANCE_PATH = "data/market/forward/0050-forward-v2/provenance.json" as const;
export const SPLIT_REBASED_BENCHMARK_FORWARD_EVALUATION_PATH = "packages/paper-trading/forward-win-rate-evaluation-v2.json" as const;
export const SPLIT_REBASED_BENCHMARK_OUTPUT_PATH = "packages/paper-trading/split-rebased-benchmark-v1.json" as const;

const SYMBOL = "0050";
const TWSE_PROFILE = "twse-daily-ohlcv-close-v1" as const;
const SPLIT_EFFECTIVE_DATE = "2025-06-18";
const SPLIT_RATIO = 4n;
const RETURN_SCALE = 100_000_000n;
const TWSE_SPLIT_SOURCE = "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other";
const YUANTA_DISTRIBUTION_SOURCE = "https://www.yuantafunds.com/myfund/information/1066?tab=3";

interface CalendarWindow {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface SplitRebasedDividend {
  readonly exDate: string;
  readonly payDate: string;
  readonly amountPerShareMinor: string;
  readonly source: string;
}

export const SPLIT_REBASED_DIVIDENDS: readonly SplitRebasedDividend[] = Object.freeze([
  Object.freeze({ exDate: "2025-07-21", payDate: "2025-08-08", amountPerShareMinor: "36", source: YUANTA_DISTRIBUTION_SOURCE }),
  Object.freeze({ exDate: "2026-01-22", payDate: "2026-02-11", amountPerShareMinor: "100", source: YUANTA_DISTRIBUTION_SOURCE }),
  Object.freeze({ exDate: "2026-07-21", payDate: "2026-08-10", amountPerShareMinor: "60", source: YUANTA_DISTRIBUTION_SOURCE }),
]);

const CALENDAR_WINDOWS: readonly CalendarWindow[] = Object.freeze([
  Object.freeze({ id: "post-split-2025-h2", startDate: "2025-06-18", endDate: "2025-12-31" }),
  Object.freeze({ id: "post-split-2026-h1", startDate: "2026-01-01", endDate: "2026-06-30" }),
  Object.freeze({ id: "post-split-2026-h2-to-cutoff", startDate: "2026-07-01", endDate: "2026-08-11" }),
]);

type JsonRecord = Record<string, unknown>;

interface FixedParameters {
  readonly entryAtOrBelowMinor: bigint;
  readonly exitAtOrAboveMinor: bigint;
  readonly targetQuantity: number;
}

interface CurvePoint {
  readonly date: string;
  readonly marketCloseMinor: bigint;
  readonly engineEquityMinor: bigint;
  readonly dividendCashMinor: bigint;
  readonly dividendReceivableMinor: bigint;
  readonly equityMinor: bigint;
  readonly openPositionQuantity: number;
  readonly dailyReturnFraction: string;
  readonly drawdownFraction: string;
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function safeCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function positiveMinor(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${path} must be a positive integer string in TWD 0.01 units`);
  }
  return BigInt(value);
}

function bigintValue(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${path} must be an integer amount`);
}

function formatFraction(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new RangeError("fraction denominator must be positive");
  const sign = numerator < 0n ? "-" : "";
  const absolute = numerator < 0n ? -numerator : numerator;
  const scaled = (absolute * RETURN_SCALE + denominator / 2n) / denominator;
  return `${sign}${(scaled / RETURN_SCALE).toString()}.${(scaled % RETURN_SCALE).toString().padStart(8, "0")}`;
}

function subtractFractions(left: string, right: string): string {
  const toScaled = (value: string): bigint => {
    const match = /^(-?)(\d+)\.(\d{8})$/.exec(value);
    if (!match) throw new TypeError(`invalid fixed-point fraction ${value}`);
    const magnitude = BigInt(match[2]!) * RETURN_SCALE + BigInt(match[3]!);
    return match[1] === "-" ? -magnitude : magnitude;
  };
  return formatFraction(toScaled(left) - toScaled(right), RETURN_SCALE);
}

function parseFixedParameters(value: unknown, path: string): FixedParameters {
  const parameters = asRecord(value, path);
  const entryAtOrBelowMinor = positiveMinor(parameters["entryAtOrBelowMinor"], `${path}.entryAtOrBelowMinor`);
  const exitAtOrAboveMinor = positiveMinor(parameters["exitAtOrAboveMinor"], `${path}.exitAtOrAboveMinor`);
  const targetQuantity = safeCount(parameters["targetQuantity"], `${path}.targetQuantity`);
  if (exitAtOrAboveMinor <= entryAtOrBelowMinor || targetQuantity === 0) {
    throw new TypeError(`${path} must have entry below exit and a positive target quantity`);
  }
  return Object.freeze({ entryAtOrBelowMinor, exitAtOrAboveMinor, targetQuantity });
}

export function rebasePriceBandForSplit(parameters: FixedParameters, ratio = SPLIT_RATIO): FixedParameters {
  if (ratio <= 0n) throw new RangeError("split ratio must be positive");
  if (parameters.entryAtOrBelowMinor % ratio !== 0n || parameters.exitAtOrAboveMinor % ratio !== 0n) {
    throw new RangeError("price-band thresholds cannot be represented exactly after this split");
  }
  return Object.freeze({
    entryAtOrBelowMinor: parameters.entryAtOrBelowMinor / ratio,
    exitAtOrAboveMinor: parameters.exitAtOrAboveMinor / ratio,
    targetQuantity: parameters.targetQuantity,
  });
}

function parseFrozenSelection(value: unknown, inputSha256: string): {
  readonly champion: FixedParameters;
  readonly challenger: FixedParameters;
  readonly challengerId: string;
  readonly selection: JsonRecord;
} {
  const selection = asRecord(value, "frozen selection artifact");
  if (selection["schemaVersion"] !== 2 || selection["symbol"] !== SYMBOL) {
    throw new TypeError("frozen selection artifact must be schema v2 for 0050");
  }
  if (selection["inputSha256"] !== inputSha256 || selection["FROZEN_SELECTION_INPUT_SHA256"] !== inputSha256) {
    throw new TypeError("frozen selection input hash does not match the local historical archive");
  }
  if (selection["FROZEN_STRATEGY_VERSION"] !== "price-band-fixed-v1") {
    throw new TypeError("frozen selection strategy identity is unsupported");
  }
  const championDevelopment = asRecord(selection["championDevelopment"], "championDevelopment");
  const challengerSelection = asRecord(selection["selectedFutureChallenger"], "selectedFutureChallenger");
  const champion = parseFixedParameters(championDevelopment["parameters"], "championDevelopment.parameters");
  const challenger = parseFixedParameters(selection["FROZEN_PARAMETERS"], "FROZEN_PARAMETERS");
  const selectedChallenger = parseFixedParameters(challengerSelection["parameters"], "selectedFutureChallenger.parameters");
  if (challenger.entryAtOrBelowMinor !== selectedChallenger.entryAtOrBelowMinor
    || challenger.exitAtOrAboveMinor !== selectedChallenger.exitAtOrAboveMinor
    || challenger.targetQuantity !== selectedChallenger.targetQuantity) {
    throw new Error("frozen challenger parameters disagree with the selection result");
  }
  if (selection["FROZEN_CHALLENGER_ID"] !== challengerSelection["id"]) {
    throw new Error("frozen challenger identity disagrees with the selection result");
  }
  return Object.freeze({
    champion,
    challenger,
    challengerId: nonEmptyString(challengerSelection["id"], "selectedFutureChallenger.id"),
    selection,
  });
}

function validateSourceProvenance(
  parsed: ParsedHistoricalCsv,
  sourceSha256: string,
  value: unknown,
): JsonRecord {
  const provenance = asRecord(value, "P194 provenance");
  if (provenance["csvSha256"] !== sourceSha256) throw new TypeError("P194 provenance SHA-256 does not match its CSV");
  const perSymbolRows = asRecord(provenance["perSymbolRowCounts"], "P194 provenance.perSymbolRowCounts");
  if (perSymbolRows[SYMBOL] !== parsed.rowCount) throw new TypeError("P194 provenance row count does not match parsed 0050 rows");
  if (provenance["provider"] !== "twstock Stock.fetch(year, month); TWSE/TPEX") {
    throw new TypeError("P194 provenance provider identity is unsupported");
  }
  return provenance;
}

function rowByDate(parsed: ParsedHistoricalCsv, date: string): ParsedHistoricalCsv["sourceRows"][number] {
  const row = parsed.sourceRows.find((candidate) => candidate.date === date);
  if (!row) throw new TypeError(`historical archive is missing required 0050 row ${date}`);
  return row;
}

function validateSplitRows(parsed: ParsedHistoricalCsv): {
  readonly previousCloseMinor: bigint;
  readonly postSplitCloseMinor: bigint;
} {
  const previous = rowByDate(parsed, "2025-06-10");
  const postSplit = rowByDate(parsed, SPLIT_EFFECTIVE_DATE);
  const previousCloseMinor = positiveMinorDecimal(previous.valuesByColumn["close"], "2025-06-10 close");
  const postSplitCloseMinor = positiveMinorDecimal(postSplit.valuesByColumn["close"], `${SPLIT_EFFECTIVE_DATE} close`);
  const officialReferenceMinor = (previousCloseMinor + SPLIT_RATIO / 2n) / SPLIT_RATIO;
  if (previousCloseMinor !== 18_865n || postSplitCloseMinor !== 4_757n || officialReferenceMinor !== 4_716n) {
    throw new TypeError("P194 split boundary prices do not match the official 0050 4:1 split evidence");
  }
  return Object.freeze({ previousCloseMinor, postSplitCloseMinor });
}

function positiveMinorDecimal(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new TypeError(`${path} must be a positive TWD price with at most two decimal places`);
  }
  const [whole = "0", fractional = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0") || "0");
  if (minor <= 0n) throw new TypeError(`${path} must be positive`);
  return minor;
}

function formatTwd(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function fillRowsByDate(run: JsonRecord): ReadonlyMap<string, readonly SimulationEvent[]> {
  const journal = run["journal"];
  if (!Array.isArray(journal)) throw new TypeError("paper session journal must be an array");
  const fills = new Map<string, SimulationEvent[]>();
  for (const raw of journal as readonly SimulationEvent[]) {
    if (raw.kind !== "fill") continue;
    const match = /^historical-0050-(\d{4}-\d{2}-\d{2})$/.exec(raw.sourceMarketEventId);
    if (!match) throw new TypeError(`fill ${raw.fillId} is not associated with a dated 0050 close event`);
    const date = match[1]!;
    const items = fills.get(date) ?? [];
    items.push(raw);
    fills.set(date, items);
  }
  return fills;
}

function dividendEligibilityQuantities(
  fillsByDate: ReadonlyMap<string, readonly SimulationEvent[]>,
  dividends: readonly SplitRebasedDividend[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const dividend of dividends) {
    let position = 0;
    for (const [date, fills] of [...fillsByDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (date >= dividend.exDate) break;
      for (const fill of fills) {
        if (fill.kind !== "fill") continue;
        position += fill.side === "buy" ? fill.quantity : -fill.quantity;
      }
    }
    if (position < 0) throw new Error(`reconstructed holdings are negative before ${dividend.exDate}`);
    quantities.set(dividend.exDate, position);
  }
  return quantities;
}

function accountCurve(
  run: JsonRecord,
  dates: readonly string[],
  pricesByDate: ReadonlyMap<string, bigint>,
  dividends: readonly SplitRebasedDividend[],
  initialCapitalMinor: bigint,
): readonly CurvePoint[] {
  const rawCurve = run["equityCurve"];
  if (!Array.isArray(rawCurve) || rawCurve.length !== dates.length) {
    throw new TypeError("paper session daily equity curve does not match its historical rows");
  }
  const fillsByDate = fillRowsByDate(run);
  const eligibleQuantities = dividendEligibilityQuantities(fillsByDate, dividends);
  const dividendByExDate = new Map(dividends.map((dividend) => [dividend.exDate, dividend]));
  const payDateByDate = new Map(dividends.map((dividend) => [dividend.payDate, dividend]));
  const pendingByPayDate = new Map<string, bigint>();
  let dividendReceivableMinor = 0n;
  let dividendCashMinor = 0n;
  let openPositionQuantity = 0;
  let previousEquity = initialCapitalMinor;
  let peakEquity = initialCapitalMinor;

  return Object.freeze(dates.map((date, index) => {
    const entitlement = dividendByExDate.get(date);
    if (entitlement) {
      const eligibleQuantity = eligibleQuantities.get(date) ?? 0;
      const distributionMinor = BigInt(eligibleQuantity) * positiveMinor(entitlement.amountPerShareMinor, "distribution amount");
      dividendReceivableMinor += distributionMinor;
      pendingByPayDate.set(entitlement.payDate, (pendingByPayDate.get(entitlement.payDate) ?? 0n) + distributionMinor);
    }
    const paidMinor = pendingByPayDate.get(date) ?? 0n;
    if (payDateByDate.has(date)) {
      if (paidMinor > dividendReceivableMinor) throw new Error(`dividend payment on ${date} exceeds accrued receivable`);
      dividendReceivableMinor -= paidMinor;
      dividendCashMinor += paidMinor;
      pendingByPayDate.delete(date);
    }

    for (const fill of fillsByDate.get(date) ?? []) {
      if (fill.kind !== "fill") continue;
      openPositionQuantity += fill.side === "buy" ? fill.quantity : -fill.quantity;
    }
    if (openPositionQuantity < 0) throw new Error(`reconstructed holdings are negative after ${date}`);

    const rawPoint = asRecord(rawCurve[index], `equityCurve[${index}]`);
    const engineEquityMinor = bigintValue(rawPoint["equityMinor"], `equityCurve[${index}].equityMinor`);
    const marketCloseMinor = pricesByDate.get(date);
    if (marketCloseMinor === undefined) throw new Error(`missing raw close for ${date}`);
    const equityMinor = engineEquityMinor + dividendReceivableMinor + dividendCashMinor;
    const dailyReturnFraction = formatFraction(equityMinor - previousEquity, previousEquity);
    if (equityMinor > peakEquity) peakEquity = equityMinor;
    const drawdownFraction = peakEquity === 0n ? "0.00000000" : formatFraction(peakEquity - equityMinor, peakEquity);
    previousEquity = equityMinor;
    return Object.freeze({
      date,
      marketCloseMinor,
      engineEquityMinor,
      dividendCashMinor,
      dividendReceivableMinor,
      equityMinor,
      openPositionQuantity,
      dailyReturnFraction,
      drawdownFraction,
    });
  }));
}

function maxDrawdownFraction(points: readonly CurvePoint[], initialEquityMinor: bigint): string {
  let peak = initialEquityMinor;
  let maximumNumerator = 0n;
  let maximumDenominator = initialEquityMinor;
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
  return formatFraction(maximumNumerator, maximumDenominator);
}

function serializeCurve(points: readonly CurvePoint[]): readonly JsonRecord[] {
  return Object.freeze(points.map((point) => Object.freeze({
    date: point.date,
    marketCloseMinor: point.marketCloseMinor.toString(),
    engineEquityMinor: point.engineEquityMinor.toString(),
    dividendCashMinor: point.dividendCashMinor.toString(),
    dividendReceivableMinor: point.dividendReceivableMinor.toString(),
    equityMinor: point.equityMinor.toString(),
    openPositionQuantity: point.openPositionQuantity,
    dailyReturnFraction: point.dailyReturnFraction,
    drawdownFraction: point.drawdownFraction,
  })));
}

function summarizeWindow(
  points: readonly CurvePoint[],
  window: { readonly id: string; readonly startDate: string; readonly endDate: string },
  initialCapitalMinor: bigint,
): JsonRecord {
  const before = points.filter((point) => point.date < window.startDate).at(-1);
  const windowPoints = points.filter((point) => point.date >= window.startDate && point.date <= window.endDate);
  const startingEquityMinor = before?.equityMinor ?? initialCapitalMinor;
  const endingEquityMinor = windowPoints.at(-1)?.equityMinor ?? startingEquityMinor;
  const firstPoint = windowPoints[0];
  const startDividendWealth = before
    ? before.dividendCashMinor + before.dividendReceivableMinor
    : 0n;
  const endDividendWealth = windowPoints.at(-1)
    ? windowPoints.at(-1)!.dividendCashMinor + windowPoints.at(-1)!.dividendReceivableMinor
    : startDividendWealth;
  return Object.freeze({
    id: window.id,
    configuredDateRange: Object.freeze({ start: window.startDate, end: window.endDate }),
    observedDateRange: Object.freeze({ start: firstPoint?.date ?? null, end: windowPoints.at(-1)?.date ?? null }),
    rowCount: windowPoints.length,
    startingEquityMinor: startingEquityMinor.toString(),
    endingEquityMinor: endingEquityMinor.toString(),
    netReturnFraction: windowPoints.length === 0 ? null : formatFraction(endingEquityMinor - startingEquityMinor, startingEquityMinor),
    maximumDrawdownFraction: windowPoints.length === 0 ? null : maxDrawdownFraction(windowPoints, startingEquityMinor),
    incrementalDistributionIncomeMinor: (endDividendWealth - startDividendWealth).toString(),
  });
}

function summarizeRun(
  run: JsonRecord,
  points: readonly CurvePoint[],
  parameters: FixedParameters | null,
  initialCapitalMinor: bigint,
  windows: readonly CalendarWindow[],
): JsonRecord {
  const account = asRecord(run["accountSummary"], "accountSummary");
  const statistics = asRecord(run["tradingStatistics"], "tradingStatistics");
  const journal = run["journal"];
  if (!Array.isArray(journal)) throw new TypeError("paper session journal must be an array");
  const decisions = { noTrade: 0, riskRejected: 0, orderSubmitted: 0 };
  let fillCount = 0;
  let fillQuantity = 0;
  for (const raw of journal as readonly SimulationEvent[]) {
    if (raw.kind === "decision") {
      if (raw.status === "no-trade") decisions.noTrade += 1;
      else if (raw.status === "risk-rejected") decisions.riskRejected += 1;
      else decisions.orderSubmitted += 1;
    } else if (raw.kind === "fill") {
      fillCount += 1;
      fillQuantity += raw.quantity;
    }
  }
  const trades = statistics["completedTrades"];
  if (!Array.isArray(trades)) throw new TypeError("tradingStatistics.completedTrades must be an array");
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  for (const [index, raw] of trades.entries()) {
    const pnl = bigintValue(asRecord(raw, `completedTrades[${index}]`)["netPnlMinor"], `completedTrades[${index}].netPnlMinor`);
    if (pnl > 0n) wins += 1;
    else if (pnl < 0n) losses += 1;
    else breakevens += 1;
  }
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "tradingStatistics.completeTradeCount");
  if (completedTradeCount !== trades.length || completedTradeCount !== wins + losses + breakevens) {
    throw new Error("completed-trade counts do not reconcile");
  }
  const openPositionQuantity = safeCount(account["positionQuantity"], "accountSummary.positionQuantity");
  const endingEquityMinor = points.at(-1)?.equityMinor ?? initialCapitalMinor;
  const feesPaidMinor = bigintValue(account["feesPaidMinor"], "accountSummary.feesPaidMinor");
  const distributionIncomeMinor = (points.at(-1)?.dividendCashMinor ?? 0n)
    + (points.at(-1)?.dividendReceivableMinor ?? 0n);
  const minimumCloseMinor = points.reduce<bigint | null>(
    (minimum, point) => minimum === null || point.marketCloseMinor < minimum ? point.marketCloseMinor : minimum,
    null,
  );
  const maximumCloseMinor = points.reduce<bigint | null>(
    (maximum, point) => maximum === null || point.marketCloseMinor > maximum ? point.marketCloseMinor : maximum,
    null,
  );
  return Object.freeze({
    strategyVersion: parameters === null ? "cost-matched-always-long-benchmark-v1" : SPLIT_REBASED_BENCHMARK_VERSION,
    parameters: parameters === null ? null : Object.freeze({
      entryAtOrBelowMinor: parameters.entryAtOrBelowMinor.toString(),
      exitAtOrAboveMinor: parameters.exitAtOrAboveMinor.toString(),
      targetQuantity: parameters.targetQuantity,
      currencyCode: "TWD",
      minorUnit: "0.01",
      entryAtOrBelowTwd: (Number(parameters.entryAtOrBelowMinor) / 100).toFixed(2),
      exitAtOrAboveTwd: (Number(parameters.exitAtOrAboveMinor) / 100).toFixed(2),
    }),
    sample: Object.freeze({
      start: points[0]?.date ?? null,
      end: points.at(-1)?.date ?? null,
      rowCount: points.length,
      rawCloseRangeMinor: Object.freeze({ min: minimumCloseMinor?.toString() ?? null, max: maximumCloseMinor?.toString() ?? null }),
      rawCloseRangeTwd: Object.freeze({ min: minimumCloseMinor === null ? null : formatTwd(minimumCloseMinor), max: maximumCloseMinor === null ? null : formatTwd(maximumCloseMinor) }),
    }),
    rawPriceBoundaryObservations: parameters === null ? null : Object.freeze({
      closesAtOrBelowEntry: points.filter(({ marketCloseMinor }) => marketCloseMinor <= parameters.entryAtOrBelowMinor).length,
      closesAtOrAboveExit: points.filter(({ marketCloseMinor }) => marketCloseMinor >= parameters.exitAtOrAboveMinor).length,
    }),
    decisions: Object.freeze({ ...decisions, total: decisions.noTrade + decisions.riskRejected + decisions.orderSubmitted }),
    fills: Object.freeze({ count: fillCount, quantity: fillQuantity }),
    completedTradeCount,
    wins,
    losses,
    breakevens,
    rawNetWinRate: completedTradeCount === 0 ? null : formatFraction(BigInt(wins), BigInt(completedTradeCount)),
    openPositionQuantity,
    feesPaidMinor: feesPaidMinor.toString(),
    distributionIncomeMinor: distributionIncomeMinor.toString(),
    initialCapitalMinor: initialCapitalMinor.toString(),
    engineEndingEquityMinor: bigintValue(account["equityMinor"], "accountSummary.equityMinor").toString(),
    endingEquityMinor: endingEquityMinor.toString(),
    netReturnFraction: formatFraction(endingEquityMinor - initialCapitalMinor, initialCapitalMinor),
    maximumDrawdownFraction: maxDrawdownFraction(points, initialCapitalMinor),
    outcome: completedTradeCount === 0 && decisions.orderSubmitted === 0
      ? "NO_SIGNAL"
      : openPositionQuantity > 0
        ? "OPEN_POSITION_AT_CUTOFF"
        : completedTradeCount > 0
          ? "COMPLETED_TRADES"
          : decisions.riskRejected > 0
            ? "RISK_REJECTED"
            : "ACTIVITY_WITHOUT_COMPLETED_TRADES",
    inconclusiveReasonCodes: Object.freeze(completedTradeCount === 0
      ? ["NO_COMPLETED_TRADES", ...(decisions.orderSubmitted === 0 ? ["NO_SIGNAL"] : []), ...(openPositionQuantity > 0 ? ["OPEN_POSITION_AT_CUTOFF"] : [])]
      : []),
    chronologicalWindows: Object.freeze(windows.map((window) => summarizeWindow(points, window, initialCapitalMinor))),
    dailyEquity: serializeCurve(points),
  });
}

function createSession(parsed: ParsedHistoricalCsv, parameters: FixedParameters) {
  const startIndex = parsed.sourceRows.findIndex(({ date }) => date >= SPLIT_EFFECTIVE_DATE);
  if (startIndex < 0) throw new TypeError(`historical archive has no data on or after split date ${SPLIT_EFFECTIVE_DATE}`);
  return createRawSession(parsed, parameters, startIndex);
}

function createRawSession(parsed: ParsedHistoricalCsv, parameters: FixedParameters, startIndex: number) {
  return Object.freeze({
    ...parsed.session,
    sourceLabel: `${parsed.session.sourceLabel}; post-split raw 0050 close sample`,
    simulation: Object.freeze({
      ...parsed.session.simulation,
      strategy: Object.freeze({ ...parameters }),
    }),
    events: Object.freeze(parsed.session.events.slice(startIndex)),
  });
}

function alwaysLongBenchmark(targetQuantity: number): PaperStrategy {
  return Object.freeze({
    strategyVersion: "cost-matched-always-long-benchmark-v1",
    strategyParameters: Object.freeze({ policy: "ALWAYS_LONG", targetQuantity }),
    decide: () => targetQuantity,
  });
}

function runWithStrategy(
  session: ReturnType<typeof createSession>,
  sourceSha256: string,
  strategy: PaperStrategy,
): JsonRecord {
  return runPaperSession(session, sourceSha256, undefined, strategy, undefined, { captureEquityCurve: true });
}

export function evaluateSplitRebasedForwardSample(
  parsed: ParsedHistoricalCsv,
  freshDataSha256: string,
  historicalSourceSha256: string,
  selectionArtifact: unknown,
  forwardProvenanceArtifact: unknown,
  frozenForwardEvaluationArtifact: unknown,
  dividends: readonly SplitRebasedDividend[] = SPLIT_REBASED_DIVIDENDS,
): JsonRecord {
  if (!/^[a-f0-9]{64}$/.test(freshDataSha256)) throw new TypeError("freshDataSha256 must be a lowercase SHA-256 digest");
  if (parsed.symbol !== SYMBOL || parsed.sourceProfile !== "TWSE_DAILY_OHLCV_CLOSE_V1" || parsed.minorUnitsPerMajor !== 100) {
    throw new TypeError("fresh input must be raw TWSE 0050 close data in TWD 0.01 minor units");
  }
  if (parsed.rowCount !== parsed.sourceRows.length || parsed.rowCount !== parsed.session.events.length) {
    throw new TypeError("parsed forward 0050 source rows, events, and rowCount do not reconcile");
  }
  const provenance = asRecord(forwardProvenanceArtifact, "forward provenance");
  const baseEvaluation = asRecord(frozenForwardEvaluationArtifact, "frozen forward evaluation");
  if (provenance["schemaVersion"] !== 1 || provenance["artifactId"] !== "0050-forward-v2" || provenance["symbol"] !== SYMBOL) {
    throw new TypeError("forward provenance is not the expected local 0050-forward-v2 artifact");
  }
  if (provenance["sha256"] !== freshDataSha256 || provenance["rowCount"] !== parsed.rowCount) {
    throw new TypeError("forward provenance hash or row count does not match the local CSV");
  }
  const historicalCutoff = nonEmptyString(provenance["historicalCutoff"], "forward provenance.historicalCutoff");
  const dateRange = asRecord(provenance["dateRange"], "forward provenance.dateRange");
  const evaluationDateRange = asRecord(baseEvaluation["freshDateRange"], "forward evaluation.freshDateRange");
  if (baseEvaluation["historicalCutoff"] !== historicalCutoff
    || baseEvaluation["freshDataSha256"] !== freshDataSha256
    || baseEvaluation["freshRowCount"] !== parsed.rowCount
    || dateRange["start"] !== parsed.startDate
    || dateRange["end"] !== parsed.endDate
    || evaluationDateRange["start"] !== parsed.startDate
    || evaluationDateRange["end"] !== parsed.endDate) {
    throw new TypeError("forward CSV, provenance, and frozen evaluation window do not reconcile");
  }
  if (parsed.startDate <= historicalCutoff || parsed.startDate <= SPLIT_EFFECTIVE_DATE) {
    throw new TypeError("fresh forward rows must be strictly after both the historical cutoff and the split");
  }
  if (dividends.some((dividend) => (
    dividend.exDate >= parsed.startDate && dividend.exDate <= parsed.endDate
  ) || (
    dividend.payDate >= parsed.startDate && dividend.payDate <= parsed.endDate
  ))) {
    throw new TypeError("fresh forward sample crosses a known distribution date; update the action input before evaluating");
  }

  const frozen = parseFrozenSelection(selectionArtifact, historicalSourceSha256);
  const rebasedChampion = rebasePriceBandForSplit(frozen.champion);
  const rebasedChallenger = rebasePriceBandForSplit(frozen.challenger);
  const championSession = createRawSession(parsed, rebasedChampion, 0);
  const challengerSession = createRawSession(parsed, rebasedChallenger, 0);
  const benchmarkSession = createRawSession(parsed, rebasedChampion, 0);
  const championRun = runWithStrategy(championSession, freshDataSha256, new PriceBandStrategy({
    strategyVersion: SPLIT_REBASED_BENCHMARK_VERSION,
    ...rebasedChampion,
  }));
  const challengerRun = runWithStrategy(challengerSession, freshDataSha256, new PriceBandStrategy({
    strategyVersion: SPLIT_REBASED_BENCHMARK_VERSION,
    ...rebasedChallenger,
  }));
  const benchmarkRun = runWithStrategy(benchmarkSession, freshDataSha256, alwaysLongBenchmark(rebasedChampion.targetQuantity));
  const dates = parsed.sourceRows.map(({ date }) => date);
  const pricesByDate = new Map(parsed.sourceRows.map(({ date, valuesByColumn }) => [date, positiveMinorDecimal(valuesByColumn["close"], `${date}.close`)]));
  const noForwardDistributions: readonly SplitRebasedDividend[] = Object.freeze([]);
  const initialCapitalMinor = championSession.simulation.initialCashMinor;
  const championCurve = accountCurve(championRun, dates, pricesByDate, noForwardDistributions, initialCapitalMinor);
  const challengerCurve = accountCurve(challengerRun, dates, pricesByDate, noForwardDistributions, initialCapitalMinor);
  const benchmarkCurve = accountCurve(benchmarkRun, dates, pricesByDate, noForwardDistributions, initialCapitalMinor);
  const window: CalendarWindow = Object.freeze({ id: "true-forward-after-2026-08-11-cutoff", startDate: dates[0]!, endDate: dates.at(-1)! });
  const championSummary = summarizeRun(championRun, championCurve, rebasedChampion, initialCapitalMinor, [window]);
  const challengerSummary = summarizeRun(challengerRun, challengerCurve, rebasedChallenger, initialCapitalMinor, [window]);
  const benchmarkSummary = summarizeRun(benchmarkRun, benchmarkCurve, null, initialCapitalMinor, [window]);
  const benchmarkNetReturn = String(benchmarkSummary["netReturnFraction"]);
  const compareToBenchmark = (summary: JsonRecord): JsonRecord => Object.freeze({
    ...summary,
    costMatchedBenchmark: Object.freeze({
      policy: "ALWAYS_LONG",
      sizingPolicy: "SAME_TARGET_QUANTITY",
      netReturnFraction: benchmarkNetReturn,
      maximumDrawdownFraction: benchmarkSummary["maximumDrawdownFraction"],
      excessNetReturnFraction: subtractFractions(String(summary["netReturnFraction"]), benchmarkNetReturn),
      completedTradeCount: benchmarkSummary["completedTradeCount"],
      openPositionQuantity: benchmarkSummary["openPositionQuantity"],
      feesPaidMinor: benchmarkSummary["feesPaidMinor"],
      distributionIncomeMinor: benchmarkSummary["distributionIncomeMinor"],
    }),
  });
  const result = Object.freeze({
    classification: "TRUE_FORWARD_SAMPLE_DIAGNOSTIC",
    status: "INSUFFICIENT_FRESH_TRADES",
    historicalCutoff,
    dataSourceArtifactId: provenance["artifactId"],
    dataSource: provenance["source"],
    sourceLicenseStatus: "AUTOMATED_DOWNLOAD_PERMISSION_NOT_REVERIFIED; EXISTING_LOCAL_COPY_REUSED; NO_NEW_NETWORK_REQUESTS",
    freshDataSha256,
    sample: Object.freeze({ start: parsed.startDate, end: parsed.endDate, rowCount: parsed.rowCount }),
    dividendEventsInWindow: 0,
    champion: compareToBenchmark(championSummary),
    challenger: compareToBenchmark(challengerSummary),
    costMatchedBenchmark: benchmarkSummary,
  });
  return result;
}

export function evaluateSplitRebasedHistoricalBenchmark(
  parsed: ParsedHistoricalCsv,
  sourceSha256: string,
  selectionArtifact: unknown,
  provenanceArtifact: unknown,
  dividends: readonly SplitRebasedDividend[] = SPLIT_REBASED_DIVIDENDS,
  freshForwardDiagnostic: JsonRecord | null = null,
): JsonRecord {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new TypeError("sourceSha256 must be a lowercase SHA-256 digest");
  if (parsed.symbol !== SYMBOL || parsed.sourceProfile !== "TWSE_DAILY_OHLCV_CLOSE_V1" || parsed.minorUnitsPerMajor !== 100) {
    throw new TypeError("input must be raw TWSE 0050 close data in TWD 0.01 minor units");
  }
  if (parsed.rowCount !== parsed.sourceRows.length || parsed.rowCount !== parsed.session.events.length) {
    throw new TypeError("parsed 0050 source rows, events, and rowCount do not reconcile");
  }
  const provenance = validateSourceProvenance(parsed, sourceSha256, provenanceArtifact);
  const frozen = parseFrozenSelection(selectionArtifact, sourceSha256);
  const splitEvidence = validateSplitRows(parsed);
  for (const dividend of dividends) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dividend.exDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dividend.payDate)) {
      throw new TypeError("dividend exDate and payDate must use YYYY-MM-DD");
    }
    positiveMinor(dividend.amountPerShareMinor, `distribution ${dividend.exDate}.amountPerShareMinor`);
    if (dividend.source !== YUANTA_DISTRIBUTION_SOURCE) throw new TypeError(`distribution ${dividend.exDate} has an unsupported source`);
    rowByDate(parsed, dividend.exDate);
    rowByDate(parsed, dividend.payDate);
  }

  const rebasedChampion = rebasePriceBandForSplit(frozen.champion);
  const rebasedChallenger = rebasePriceBandForSplit(frozen.challenger);
  const championSession = createSession(parsed, rebasedChampion);
  const challengerSession = createSession(parsed, rebasedChallenger);
  const benchmarkSession = createSession(parsed, rebasedChampion);
  const championRun = runWithStrategy(championSession, sourceSha256, new PriceBandStrategy({
    strategyVersion: SPLIT_REBASED_BENCHMARK_VERSION,
    ...rebasedChampion,
  }));
  const challengerRun = runWithStrategy(challengerSession, sourceSha256, new PriceBandStrategy({
    strategyVersion: SPLIT_REBASED_BENCHMARK_VERSION,
    ...rebasedChallenger,
  }));
  const benchmarkRun = runWithStrategy(benchmarkSession, sourceSha256, alwaysLongBenchmark(rebasedChampion.targetQuantity));
  const dates = parsed.sourceRows.slice(championSession.events.length * -1).map(({ date }) => date);
  const pricesByDate = new Map(parsed.sourceRows.map(({ date, valuesByColumn }) => [date, positiveMinorDecimal(valuesByColumn["close"], `${date}.close`)]));
  const initialCapitalMinor = championSession.simulation.initialCashMinor;
  const championCurve = accountCurve(championRun, dates, pricesByDate, dividends, initialCapitalMinor);
  const challengerCurve = accountCurve(challengerRun, dates, pricesByDate, dividends, initialCapitalMinor);
  const benchmarkCurve = accountCurve(benchmarkRun, dates, pricesByDate, dividends, initialCapitalMinor);
  const windows = CALENDAR_WINDOWS.filter((window) => window.endDate >= (dates[0] ?? "9999-12-31")
    && window.startDate <= (dates.at(-1) ?? "0000-01-01"));
  const championSummary = summarizeRun(championRun, championCurve, rebasedChampion, initialCapitalMinor, windows);
  const challengerSummary = summarizeRun(challengerRun, challengerCurve, rebasedChallenger, initialCapitalMinor, windows);
  const benchmarkSummary = summarizeRun(benchmarkRun, benchmarkCurve, null, initialCapitalMinor, windows);
  const benchmarkNetReturn = String(benchmarkSummary["netReturnFraction"]);
  const championNetReturn = String(championSummary["netReturnFraction"]);
  const challengerNetReturn = String(challengerSummary["netReturnFraction"]);
  const withBenchmark = (summary: JsonRecord, returnFraction: string): JsonRecord => Object.freeze({
    ...summary,
    costMatchedBenchmark: Object.freeze({
      policy: "ALWAYS_LONG",
      sizingPolicy: "SAME_TARGET_QUANTITY",
      strategyVersion: benchmarkSummary["strategyVersion"],
      netReturnFraction: benchmarkNetReturn,
      maximumDrawdownFraction: benchmarkSummary["maximumDrawdownFraction"],
      excessNetReturnFraction: subtractFractions(returnFraction, benchmarkNetReturn),
      completedTradeCount: benchmarkSummary["completedTradeCount"],
      openPositionQuantity: benchmarkSummary["openPositionQuantity"],
      feesPaidMinor: benchmarkSummary["feesPaidMinor"],
      distributionIncomeMinor: benchmarkSummary["distributionIncomeMinor"],
    }),
  });

  return Object.freeze({
    schemaVersion: 1,
    artifactId: "0050-split-rebased-benchmark-v1",
    classification: "HISTORICAL_DIAGNOSTIC_ONLY",
    promotionStatus: "NOT_ELIGIBLE_ZERO_OR_INSUFFICIENT_COMPLETED_TRADES",
    trueForwardStatus: freshForwardDiagnostic === null ? "AWAITING_UNSEEN_DATA" : "OBSERVED_BUT_INSUFFICIENT_COMPLETED_TRADES",
    returnBasis: "RAW_CLOSE_PLUS_CASH_DISTRIBUTION_ENTITLEMENTS_AFTER_SIMULATED_FEES_AND_SLIPPAGE",
    methodology: Object.freeze({
      symbol: SYMBOL,
      currencyCode: "TWD",
      priceUnit: "TWD_PER_SHARE",
      minorUnit: "0.01",
      sourcePriceColumn: "close",
      historicalInputInterpretation: "RAW_UNADJUSTED_CLOSE",
      evaluationStartsOnEffectiveSplitTradingDate: SPLIT_EFFECTIVE_DATE,
      split: Object.freeze({
        effectiveDate: SPLIT_EFFECTIVE_DATE,
        postToPreShareRatio: 4,
        preSplitLastTradingDate: "2025-06-10",
        preSplitLastCloseTwd: "188.65",
        officialReferencePriceTwd: "47.16",
        localPostSplitFirstCloseTwd: "47.57",
        inputPricesAreAdjusted: false,
        source: TWSE_SPLIT_SOURCE,
      }),
      thresholdTransformation: "Divide frozen pre-split thresholds by 4; only raw post-split prices are evaluated.",
      dividendTreatment: "Credit distribution entitlement once from raw-price holdings at the prior close; track unpaid amounts as receivables until pay date; do not use dividend-adjusted prices or reinvest distributions.",
      initialCapitalMinor: initialCapitalMinor.toString(),
      targetQuantity: rebasedChampion.targetQuantity,
      feeBps: PAPER_TRADING_DEMO_SETTINGS.terms.feeBps,
      slippageBps: PAPER_TRADING_DEMO_SETTINGS.terms.slippageBps,
      fillModel: "alwaysFillNextEvent",
      terminalPositionValuation: "MARKED_AT_FINAL_RAW_CLOSE; NO_UNFILLED_TERMINAL_LIQUIDATION_COST",
      calendarWindowsInterpretation: "Descriptive, pre-fixed calendar segments. Parameters are unchanged across segments; this is not a preregistered prospective holdout.",
    }),
    source: Object.freeze({
      artifactId: provenance["artifactId"],
      producer: provenance["producer"],
      provider: provenance["provider"],
      providerVersion: provenance["providerVersion"],
      fetchedAtUtc: provenance["fetchedAtUtc"],
      csvSha256: sourceSha256,
      symbolRowCount: parsed.rowCount,
      actualDateRange: Object.freeze({ start: parsed.startDate, end: parsed.endDate }),
      reusedExistingArchive: true,
      newHistoricalDownloads: 0,
      sourceAccessStatus: "AUTOMATED_DOWNLOAD_PERMISSION_NOT_REVERIFIED; EXISTING_LOCAL_ARCHIVE_REUSED; NO_NEW_NETWORK_REQUESTS",
      splitBoundaryClosesMinor: Object.freeze({
        preSplit: splitEvidence.previousCloseMinor.toString(),
        firstPostSplit: splitEvidence.postSplitCloseMinor.toString(),
        officialReference: "4716",
      }),
    }),
    selectionOrigin: Object.freeze({
      selectionArtifact: SPLIT_REBASED_BENCHMARK_SELECTION_PATH,
      sourceSha256,
      strategyVersion: frozen.selection["FROZEN_STRATEGY_VERSION"],
      selectionPolicyVersion: frozen.selection["FROZEN_SELECTION_POLICY_VERSION"],
      developmentBoundary: frozen.selection["developmentBoundary"],
      observedThroughDate: frozen.selection["observedThroughDate"],
      champion: Object.freeze({
        ...asRecord(frozen.selection["championDevelopment"], "championDevelopment"),
        parameters: Object.freeze({
          entryAtOrBelowMinor: frozen.champion.entryAtOrBelowMinor.toString(),
          exitAtOrAboveMinor: frozen.champion.exitAtOrAboveMinor.toString(),
          targetQuantity: frozen.champion.targetQuantity,
          entryAtOrBelowTwd: (Number(frozen.champion.entryAtOrBelowMinor) / 100).toFixed(2),
          exitAtOrAboveTwd: (Number(frozen.champion.exitAtOrAboveMinor) / 100).toFixed(2),
        }),
      }),
      challenger: Object.freeze({
        id: frozen.challengerId,
        ...asRecord(frozen.selection["selectedFutureChallenger"], "selectedFutureChallenger"),
        parameters: Object.freeze({
          entryAtOrBelowMinor: frozen.challenger.entryAtOrBelowMinor.toString(),
          exitAtOrAboveMinor: frozen.challenger.exitAtOrAboveMinor.toString(),
          targetQuantity: frozen.challenger.targetQuantity,
          entryAtOrBelowTwd: (Number(frozen.challenger.entryAtOrBelowMinor) / 100).toFixed(2),
          exitAtOrAboveTwd: (Number(frozen.challenger.exitAtOrAboveMinor) / 100).toFixed(2),
        }),
      }),
    }),
    corporateActions: Object.freeze({
      split: Object.freeze({ effectiveDate: SPLIT_EFFECTIVE_DATE, ratio: "4:1", source: TWSE_SPLIT_SOURCE }),
      distributions: Object.freeze(dividends.map((dividend) => Object.freeze({
        ...dividend,
        amountPerShareTwd: (Number(dividend.amountPerShareMinor) / 100).toFixed(2),
        source: dividend.source,
      }))),
    }),
    sample: Object.freeze({ start: dates[0] ?? null, end: dates.at(-1) ?? null, rowCount: dates.length }),
    results: Object.freeze({
      champion: withBenchmark(championSummary, championNetReturn),
      challenger: withBenchmark(challengerSummary, challengerNetReturn),
      costMatchedBenchmark: benchmarkSummary,
    }),
    freshForwardDiagnostic,
  });
}

export async function runSplitRebasedHistoricalBenchmarkFiles(
  inputPath = SPLIT_REBASED_BENCHMARK_INPUT_PATH,
  selectionPath = SPLIT_REBASED_BENCHMARK_SELECTION_PATH,
  provenancePath = SPLIT_REBASED_BENCHMARK_PROVENANCE_PATH,
  outputPath = SPLIT_REBASED_BENCHMARK_OUTPUT_PATH,
): Promise<JsonRecord> {
  const [inputBytes, selectionBytes, provenanceBytes, forwardBytes, forwardProvenanceBytes, forwardEvaluationBytes] = await Promise.all([
    readFile(inputPath),
    readFile(selectionPath),
    readFile(provenancePath),
    readFile(SPLIT_REBASED_BENCHMARK_FORWARD_INPUT_PATH),
    readFile(SPLIT_REBASED_BENCHMARK_FORWARD_PROVENANCE_PATH),
    readFile(SPLIT_REBASED_BENCHMARK_FORWARD_EVALUATION_PATH),
  ]);
  const sourceSha256 = createHash("sha256").update(inputBytes).digest("hex");
  const freshDataSha256 = createHash("sha256").update(forwardBytes).digest("hex");
  const parsed = parseHistoricalCsv(
    new TextDecoder("utf-8", { fatal: true }).decode(inputBytes),
    SYMBOL,
    inputPath,
    TWSE_PROFILE,
  );
  const parsedForward = parseHistoricalCsv(
    new TextDecoder("utf-8", { fatal: true }).decode(forwardBytes),
    SYMBOL,
    SPLIT_REBASED_BENCHMARK_FORWARD_INPUT_PATH,
    TWSE_PROFILE,
  );
  const selection = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(selectionBytes)) as unknown;
  const provenance = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes)) as unknown;
  const forwardProvenance = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(forwardProvenanceBytes)) as unknown;
  const forwardEvaluation = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(forwardEvaluationBytes)) as unknown;
  const freshForwardDiagnostic = evaluateSplitRebasedForwardSample(
    parsedForward,
    freshDataSha256,
    sourceSha256,
    selection,
    forwardProvenance,
    forwardEvaluation,
  );
  const result = evaluateSplitRebasedHistoricalBenchmark(
    parsed,
    sourceSha256,
    selection,
    provenance,
    SPLIT_REBASED_DIVIDENDS,
    freshForwardDiagnostic,
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(): Promise<void> {
  const result = await runSplitRebasedHistoricalBenchmarkFiles();
  const results = asRecord(result["results"], "results");
  const champion = asRecord(results["champion"], "results.champion");
  const challenger = asRecord(results["challenger"], "results.challenger");
  const benchmark = asRecord(results["costMatchedBenchmark"], "results.costMatchedBenchmark");
  const freshForward = asRecord(result["freshForwardDiagnostic"], "freshForwardDiagnostic");
  const forwardChampion = asRecord(freshForward["champion"], "freshForwardDiagnostic.champion");
  const forwardChallenger = asRecord(freshForward["challenger"], "freshForwardDiagnostic.challenger");
  const forwardBenchmark = asRecord(freshForward["costMatchedBenchmark"], "freshForwardDiagnostic.costMatchedBenchmark");
  stdout.write(`${JSON.stringify({
    artifactId: result["artifactId"],
    outputPath: resolve(SPLIT_REBASED_BENCHMARK_OUTPUT_PATH),
    sample: result["sample"],
    champion: {
      completedTradeCount: champion["completedTradeCount"],
      rawNetWinRate: champion["rawNetWinRate"],
      netReturnFraction: champion["netReturnFraction"],
      maximumDrawdownFraction: champion["maximumDrawdownFraction"],
    },
    challenger: {
      completedTradeCount: challenger["completedTradeCount"],
      rawNetWinRate: challenger["rawNetWinRate"],
      netReturnFraction: challenger["netReturnFraction"],
      maximumDrawdownFraction: challenger["maximumDrawdownFraction"],
    },
    costMatchedBenchmark: {
      netReturnFraction: benchmark["netReturnFraction"],
      maximumDrawdownFraction: benchmark["maximumDrawdownFraction"],
      distributionIncomeMinor: benchmark["distributionIncomeMinor"],
    },
    freshForward: {
      sample: freshForward["sample"],
      status: freshForward["status"],
      champion: {
        completedTradeCount: forwardChampion["completedTradeCount"],
        rawNetWinRate: forwardChampion["rawNetWinRate"],
        outcome: forwardChampion["outcome"],
      },
      challenger: {
        completedTradeCount: forwardChallenger["completedTradeCount"],
        rawNetWinRate: forwardChallenger["rawNetWinRate"],
        outcome: forwardChallenger["outcome"],
      },
      benchmark: {
        netReturnFraction: forwardBenchmark["netReturnFraction"],
        maximumDrawdownFraction: forwardBenchmark["maximumDrawdownFraction"],
      },
    },
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`${JSON.stringify({ status: "ERROR", error: message })}\n`);
    process.exitCode = 1;
  });
}
