import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  determineFuturePromotionStatusV2,
  WIN_RATE_OBJECTIVE,
  WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
  wilsonLowerBound95,
  type WinRateV2Metrics,
} from "./winRateOptimizerV2.js";
import {
  PRICE_BAND_FIXED_STRATEGY_VERSION,
  TWSE_SOURCE_PROFILE_ARGUMENT,
  type TradeCounts,
  type WinRateParameters,
} from "./winRateOptimizer.js";
import type { PaperStrategy, SimulationEvent } from "./types.js";

export const FORWARD_DATA_CSV_PATH = "data/market/forward/0050-forward-v1/0050_forward.csv" as const;
export const FORWARD_DATA_PROVENANCE_PATH = "data/market/forward/0050-forward-v1/provenance.json" as const;
export const WIN_RATE_V2_ARTIFACT_PATH = "packages/paper-trading/win-rate-optimizer-v2.json" as const;
export const FORWARD_EVALUATION_OUTPUT_PATH = "packages/paper-trading/forward-win-rate-evaluation-v1.json" as const;
const FORWARD_DATA_SOURCE = "TWSE STOCK_DAY monthly report API" as const;

export type ForwardWinRateCliFailureCode =
  | "MISSING_INPUT_FILE"
  | "STALE_FORWARD_SNAPSHOT"
  | "INVALID_FORWARD_DATA"
  | "INVALID_FROZEN_ARTIFACT"
  | "INVALID_ARGUMENTS"
  | "EVALUATION_FAILED";

export interface ForwardWinRateCliFailure {
  readonly schemaVersion: 1;
  readonly status: "ERROR";
  readonly error: {
    readonly code: ForwardWinRateCliFailureCode;
    readonly message: string;
  };
}

class ForwardWinRateInputError extends Error {
  constructor(readonly code: ForwardWinRateCliFailureCode, message: string) {
    super(message);
    this.name = "ForwardWinRateInputError";
  }
}

type PromotionStatus = "PROMOTE" | "NO_PROMOTION" | "INSUFFICIENT_FRESH_TRADES" | "NO_FRESH_DATA";
type ForwardEvaluationState =
  | "NO_FRESH_DATA"
  | "NO_ACCEPTED_MARKET_EVENTS"
  | "NO_SIGNAL"
  | "RISK_REJECTED"
  | "UNFILLED_ORDER_AT_CUTOFF"
  | "OPEN_POSITION_AT_CUTOFF"
  | "COMPLETED_TRADES"
  | "ACTIVITY_WITHOUT_COMPLETED_TRADES";

interface PublicParameters {
  readonly entryAtOrBelowMinor: string;
  readonly exitAtOrAboveMinor: string;
  readonly targetQuantity: number;
  readonly currencyCode: "TWD";
  readonly minorUnit: "0.01";
  readonly entryAtOrBelowTwd: string;
  readonly exitAtOrAboveTwd: string;
}

interface FrozenForwardIdentities {
  readonly objective: typeof WIN_RATE_OBJECTIVE;
  readonly selectionPolicyVersion: typeof WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION;
  readonly historicalCutoff: string;
  readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
  readonly championParameters: WinRateParameters;
  readonly challengerId: string;
  readonly challengerParameters: WinRateParameters;
}

interface ForwardMetrics {
  readonly freshDataSha256: string;
  readonly completedTradeCount: number;
  readonly freshCompletedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly rawNetWinRate: number | null;
  readonly wilsonLowerBound95: number | null;
}

interface ForwardStageCounts {
  readonly sourceRows: number;
  readonly processedEvents: { readonly accepted: number; readonly duplicate: number; readonly stale: number };
  readonly decisions: {
    readonly total: number;
    readonly noTrade: number;
    readonly riskRejected: number;
    readonly orderSubmitted: number;
  };
  readonly orders: {
    readonly attempted: number;
    readonly submitted: number;
    readonly pending: number;
    readonly partiallyFilled: number;
    readonly filled: number;
    readonly rejected: number;
    readonly cancelled: number;
    readonly absent: number;
    readonly open: number;
    readonly cancelPending: number;
  };
  readonly fills: {
    readonly count: number;
    readonly quantity: number;
    readonly afterCancelPending: number;
  };
  readonly completedTradeCount: number;
  readonly openPositionQuantity: number;
  readonly reasonCodeCounts: Readonly<Record<string, number>>;
}

interface CostMatchedBenchmark {
  readonly policy: "ALWAYS_LONG";
  readonly sizingPolicy: "SAME_FROZEN_TARGET_QUANTITY";
  readonly fillModel: string | null;
  readonly status: ForwardEvaluationState;
  readonly feeBps: number | null;
  readonly slippageBps: number | null;
  readonly initialCapitalMinor: string | null;
  readonly endingEquityMinor: string | null;
  readonly netReturnFraction: string | null;
  readonly maximumDrawdownFraction: string | null;
  readonly excessNetReturnFraction: string | null;
  readonly feesPaidMinor: string | null;
  readonly openPositionQuantity: number;
}

interface ForwardCandidateDiagnostics {
  readonly outcome: ForwardEvaluationState;
  readonly inconclusiveReasonCodes: readonly string[];
  readonly stages: ForwardStageCounts;
  readonly economics: {
    readonly returnBasis: "MARK_TO_MARKET_AFTER_SIMULATED_FEES_AND_SLIPPAGE";
    readonly currencyCode: string;
    readonly initialCapitalMinor: string | null;
    readonly endingEquityMinor: string | null;
    readonly realizedPnlMinor: string | null;
    readonly completedTradeNetPnlMinor: string | null;
    readonly openTradeRealizedPnlMinor: string | null;
    readonly unrealizedPnlMinor: string | null;
    readonly feesPaidMinor: string | null;
    readonly netReturnFraction: string | null;
    readonly maximumDrawdownFraction: string | null;
    readonly costMatchedBenchmark: CostMatchedBenchmark;
  };
}

interface ProvenanceDateRange {
  readonly start: string | null;
  readonly end: string | null;
}

interface FreshProvenance {
  readonly artifactId: "0050-forward-v1";
  readonly symbol: "0050";
  readonly source: typeof FORWARD_DATA_SOURCE;
  readonly fetchedAtUtc: string;
  readonly dateRange: ProvenanceDateRange;
  readonly rowCount: number;
  readonly sha256: string;
  readonly historicalCutoff: string;
  readonly purpose: "FORWARD_EVALUATION_ONLY";
}

export interface ForwardWinRateEvaluation {
  readonly schemaVersion: 1;
  readonly objective: typeof WIN_RATE_OBJECTIVE;
  readonly selectionPolicyVersion: typeof WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION;
  readonly historicalCutoff: string;
  readonly freshDataSha256: string;
  readonly freshDateRange: { readonly start: string; readonly end: string } | null;
  readonly freshRowCount: number;
  readonly priceUnit: { readonly currencyCode: "TWD"; readonly minorUnit: "0.01"; readonly minorUnitsPerMajor: 100 };
  readonly dataCoverage: {
    readonly inputIntegrity: "PROVENANCE_HASH_ROW_COUNT_AND_DATE_RANGE_MATCHED";
    readonly providerSessionCompleteness: "UNKNOWN";
    readonly providerCompletenessReason: "NO_EXCHANGE_CALENDAR_OR_PROVIDER_COMPLETENESS_ATTESTATION";
  };
  readonly freshCompletedTradeCount: { readonly champion: number; readonly challenger: number };
  readonly champion: {
    readonly id: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly parameters: PublicParameters;
    readonly diagnostics: ForwardCandidateDiagnostics;
  } & ForwardMetrics;
  readonly challenger: {
    readonly id: string;
    readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly parameters: PublicParameters;
    readonly diagnostics: ForwardCandidateDiagnostics;
  } & ForwardMetrics;
  readonly promotionStatus: PromotionStatus;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseParameters(value: unknown, label: string): WinRateParameters {
  const parameters = asRecord(value, label);
  const entry = parameters["entryAtOrBelowMinor"];
  const exit = parameters["exitAtOrAboveMinor"];
  const quantity = parameters["targetQuantity"];
  if (typeof entry !== "string" || !/^(?:0|[1-9]\d*)$/.test(entry)) {
    throw new TypeError(`${label}.entryAtOrBelowMinor must be a canonical non-negative integer string`);
  }
  if (typeof exit !== "string" || !/^(?:0|[1-9]\d*)$/.test(exit)) {
    throw new TypeError(`${label}.exitAtOrAboveMinor must be a canonical non-negative integer string`);
  }
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 0) {
    throw new TypeError(`${label}.targetQuantity must be a non-negative safe integer`);
  }
  return Object.freeze({
    entryAtOrBelowMinor: BigInt(entry),
    exitAtOrAboveMinor: BigInt(exit),
    targetQuantity: quantity as number,
  });
}

function sameParameters(left: WinRateParameters, right: WinRateParameters): boolean {
  return left.entryAtOrBelowMinor === right.entryAtOrBelowMinor
    && left.exitAtOrAboveMinor === right.exitAtOrAboveMinor
    && left.targetQuantity === right.targetQuantity;
}

function derivedCandidateId(parameters: WinRateParameters): string {
  return `entry-${parameters.entryAtOrBelowMinor.toString()}-exit-${parameters.exitAtOrAboveMinor.toString()}`;
}

function publicParameters(parameters: WinRateParameters): PublicParameters {
  const asTwd = (minor: bigint): string => `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, "0")}`;
  return Object.freeze({
    entryAtOrBelowMinor: parameters.entryAtOrBelowMinor.toString(),
    exitAtOrAboveMinor: parameters.exitAtOrAboveMinor.toString(),
    targetQuantity: parameters.targetQuantity,
    currencyCode: "TWD",
    minorUnit: "0.01",
    entryAtOrBelowTwd: asTwd(parameters.entryAtOrBelowMinor),
    exitAtOrAboveTwd: asTwd(parameters.exitAtOrAboveMinor),
  });
}

export function loadFrozenForwardIdentities(value: unknown): FrozenForwardIdentities {
  const artifact = asRecord(value, "V2 optimizer artifact");
  const championDevelopment = asRecord(artifact["championDevelopment"], "V2 championDevelopment");
  const selectedFutureChallenger = asRecord(artifact["selectedFutureChallenger"], "V2 selectedFutureChallenger");
  const objective = artifact["objective"];
  const selectionPolicyVersion = artifact["FROZEN_SELECTION_POLICY_VERSION"];
  const strategyVersion = artifact["FROZEN_STRATEGY_VERSION"];
  const historicalCutoff = artifact["observedThroughDate"];
  const challengerId = artifact["FROZEN_CHALLENGER_ID"];
  if (artifact["schemaVersion"] !== 2 || objective !== WIN_RATE_OBJECTIVE) {
    throw new TypeError("V2 optimizer artifact has an unsupported schema or objective");
  }
  if (selectionPolicyVersion !== WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION) {
    throw new TypeError("V2 optimizer artifact has an unsupported frozen selection policy");
  }
  if (strategyVersion !== PRICE_BAND_FIXED_STRATEGY_VERSION) {
    throw new TypeError("V2 optimizer artifact has an unsupported frozen strategy version");
  }
  if (typeof historicalCutoff !== "string" || !validDate(historicalCutoff)) {
    throw new TypeError("V2 optimizer artifact has an invalid observed-through date");
  }
  if (typeof challengerId !== "string" || challengerId.length === 0) {
    throw new TypeError("V2 optimizer artifact is missing its frozen challenger identity");
  }

  const championParameters = parseParameters(championDevelopment["parameters"], "V2 championDevelopment.parameters");
  const challengerParameters = parseParameters(artifact["FROZEN_PARAMETERS"], "V2 FROZEN_PARAMETERS");
  const selectedChallengerParameters = parseParameters(
    selectedFutureChallenger["parameters"],
    "V2 selectedFutureChallenger.parameters",
  );
  if (
    selectedFutureChallenger["id"] !== challengerId
    || !sameParameters(challengerParameters, selectedChallengerParameters)
    || derivedCandidateId(challengerParameters) !== challengerId
  ) {
    throw new TypeError("V2 optimizer artifact has inconsistent frozen challenger identity fields");
  }

  return Object.freeze({
    objective: WIN_RATE_OBJECTIVE,
    selectionPolicyVersion: WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
    historicalCutoff,
    strategyVersion: PRICE_BAND_FIXED_STRATEGY_VERSION,
    championParameters,
    challengerId,
    challengerParameters,
  });
}

function parseFreshProvenance(value: unknown): FreshProvenance {
  const provenance = asRecord(value, "forward-data provenance");
  const dateRange = asRecord(provenance["dateRange"], "forward-data provenance.dateRange");
  const fetchedAtUtc = provenance["fetchedAtUtc"];
  const source = provenance["source"];
  const rowCount = provenance["rowCount"];
  const sha256 = provenance["sha256"];
  if (
    provenance["schemaVersion"] !== 1
    || provenance["artifactId"] !== "0050-forward-v1"
    || provenance["symbol"] !== "0050"
    || provenance["purpose"] !== "FORWARD_EVALUATION_ONLY"
  ) {
    throw new TypeError("forward-data provenance has an unsupported identity or purpose");
  }
  if (source !== FORWARD_DATA_SOURCE) {
    throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", "forward-data provenance source does not match the supported TWSE source");
  }
  if (typeof fetchedAtUtc !== "string" || !validUtcTimestamp(fetchedAtUtc)) {
    throw new TypeError("forward-data provenance fetchedAtUtc must be a canonical UTC timestamp");
  }
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new TypeError("forward-data provenance rowCount must be a non-negative safe integer");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError("forward-data provenance sha256 must be a lowercase SHA-256 digest");
  }
  const start = dateRange["start"];
  const end = dateRange["end"];
  if (rowCount === 0) {
    if (start !== null || end !== null) throw new TypeError("empty forward data must have a null date range");
  } else if (
    typeof start !== "string"
    || typeof end !== "string"
    || !validDate(start)
    || !validDate(end)
    || start > end
  ) {
    throw new TypeError("forward-data provenance dateRange is invalid");
  }
  return Object.freeze({
    artifactId: "0050-forward-v1",
    symbol: "0050",
    source,
    fetchedAtUtc,
    dateRange: Object.freeze({ start: start as string | null, end: end as string | null }),
    rowCount,
    sha256,
    historicalCutoff: typeof provenance["historicalCutoff"] === "string" ? provenance["historicalCutoff"] : "",
    purpose: "FORWARD_EVALUATION_ONLY",
  });
}

interface FreshCsvSummary {
  readonly rowCount: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

function validateFreshCsv(contents: string, historicalCutoff: string): FreshCsvSummary {
  if (contents.includes("\r") && /\r(?!\n)/.test(contents)) {
    throw new TypeError("fresh CSV must use LF or CRLF line endings");
  }
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "symbol,date,open,high,low,close,volume,source") {
    throw new TypeError("fresh CSV has an unsupported header");
  }
  const rows = lines.slice(1);
  let previousDate: string | null = null;
  for (const [index, line] of rows.entries()) {
    const fields = line.split(",");
    if (fields.length !== 8 || fields.some((field) => field === "" || field.trim() !== field)) {
      throw new TypeError(`fresh CSV row ${index + 2} must contain eight non-empty unquoted fields`);
    }
    const [symbol, date, open, high, low, close, volume, source] = fields as [string, string, string, string, string, string, string, string];
    if (symbol !== "0050") throw new TypeError(`fresh CSV row ${index + 2} is not for 0050`);
    if (!validDate(date)) throw new TypeError(`fresh CSV row ${index + 2} has an invalid date`);
    if (date <= historicalCutoff) {
      throw new ForwardWinRateInputError("STALE_FORWARD_SNAPSHOT", `fresh CSV row ${index + 2} is on or before the historical cutoff`);
    }
    if (previousDate !== null && date <= previousDate) {
      throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", `fresh CSV row ${index + 2} is duplicate or out of chronological order`);
    }
    if (![open, high, low, close].every((price) => /^\d+(?:\.\d+)?$/.test(price))) {
      throw new TypeError(`fresh CSV row ${index + 2} contains an invalid OHLC price`);
    }
    if (!/^\d+$/.test(volume)) throw new TypeError(`fresh CSV row ${index + 2} contains an invalid volume`);
    if (source !== "twse/STOCK_DAY") throw new TypeError(`fresh CSV row ${index + 2} has an unsupported source`);
    previousDate = date;
  }
  return Object.freeze({
    rowCount: rows.length,
    startDate: rows[0]?.split(",")[1] ?? null,
    endDate: rows.at(-1)?.split(",")[1] ?? null,
  });
}

function forwardMetrics(stats: TradeCounts, freshDataSha256: string): ForwardMetrics {
  return Object.freeze({
    freshDataSha256,
    completedTradeCount: stats.completedTradeCount,
    freshCompletedTradeCount: stats.completedTradeCount,
    wins: stats.wins,
    losses: stats.losses,
    breakevens: stats.breakevens,
    rawNetWinRate: stats.netWinRate,
    wilsonLowerBound95: wilsonLowerBound95(stats.wins, stats.completedTradeCount),
  });
}

function emptyForwardMetrics(freshDataSha256: string): ForwardMetrics {
  return Object.freeze({
    freshDataSha256,
    completedTradeCount: 0,
    freshCompletedTradeCount: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    rawNetWinRate: null,
    wilsonLowerBound95: null,
  });
}

const RETURN_SCALE = 100_000_000n;

interface EquityPoint {
  readonly equityMinor: bigint;
}

interface SessionRunSummary {
  readonly tradeCounts: TradeCounts;
  readonly stages: ForwardStageCounts;
  readonly outcome: ForwardEvaluationState;
  readonly initialCapitalMinor: bigint;
  readonly endingEquityMinor: bigint;
  readonly realizedPnlMinor: bigint;
  readonly completedTradeNetPnlMinor: bigint;
  readonly openTradeRealizedPnlMinor: bigint;
  readonly unrealizedPnlMinor: bigint;
  readonly feesPaidMinor: bigint;
  readonly currencyCode: string;
  readonly fillModel: string;
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly netReturnScaled: bigint | null;
  readonly maximumDrawdownScaled: bigint | null;
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function bigintValue(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${label} must be a bigint`);
  return value;
}

function ratioScaled(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator <= 0n) return null;
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute * RETURN_SCALE + denominator / 2n) / denominator);
}

function formatScaledRatio(value: bigint | null): string | null {
  if (value === null) return null;
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const integer = absolute / RETURN_SCALE;
  const fraction = (absolute % RETURN_SCALE).toString().padStart(8, "0");
  return `${sign}${integer.toString()}.${fraction}`;
}

function maximumDrawdownScaled(initialCapitalMinor: bigint, curve: readonly EquityPoint[]): bigint | null {
  if (curve.length === 0) return null;
  let peak = initialCapitalMinor;
  let largestNumerator = 0n;
  let largestDenominator: bigint | null = null;
  for (const point of curve) {
    if (point.equityMinor > peak) peak = point.equityMinor;
    if (peak <= 0n || point.equityMinor >= peak) continue;
    const numerator = peak - point.equityMinor;
    if (largestDenominator === null || numerator * largestDenominator > largestNumerator * peak) {
      largestNumerator = numerator;
      largestDenominator = peak;
    }
  }
  if (largestDenominator === null) return peak === 0n ? null : 0n;
  return ratioScaled(largestNumerator, largestDenominator);
}

function readRunTradeCounts(run: Record<string, unknown>): TradeCounts {
  const statistics = asRecord(run["tradingStatistics"], "paper session tradingStatistics");
  const completedTradeCount = safeCount(statistics["completeTradeCount"], "completeTradeCount");
  const wins = safeCount(statistics["wins"], "wins");
  const losses = safeCount(statistics["losses"], "losses");
  const breakevens = safeCount(statistics["breakevens"], "breakevens");
  const netWinRate = statistics["netWinRate"];
  if (wins + losses + breakevens !== completedTradeCount) {
    throw new Error("paper session win/loss counts do not reconcile to completed trades");
  }
  const expectedRate = completedTradeCount === 0 ? null : wins / completedTradeCount;
  if (netWinRate !== expectedRate) throw new Error("paper session win rate has an incorrect completed-trade denominator");
  return Object.freeze({ completedTradeCount, wins, losses, breakevens, netWinRate: expectedRate });
}

function summarizeRunStages(
  run: Record<string, unknown>,
  sourceRows: number,
  tradeCounts: TradeCounts,
): { readonly stages: ForwardStageCounts; readonly outcome: ForwardEvaluationState; readonly curve: readonly EquityPoint[] } {
  const rawProcessing = run["eventProcessingResults"];
  if (!Array.isArray(rawProcessing)) throw new TypeError("paper session eventProcessingResults must be an array");
  if (rawProcessing.length !== sourceRows) throw new Error("paper session did not submit every validated source row");
  const reasonCodeCounts = new Map<string, number>();
  const countReason = (reasonCode: string | undefined) => {
    if (reasonCode !== undefined) reasonCodeCounts.set(reasonCode, (reasonCodeCounts.get(reasonCode) ?? 0) + 1);
  };
  const processedEvents = { accepted: 0, duplicate: 0, stale: 0 };
  for (const [index, raw] of rawProcessing.entries()) {
    const event = asRecord(raw, `eventProcessingResults[${index}]`);
    const status = event["status"];
    if (status !== "accepted" && status !== "duplicate" && status !== "stale") {
      throw new TypeError(`eventProcessingResults[${index}].status is unsupported`);
    }
    processedEvents[status] += 1;
  }

  const rawJournal = run["journal"];
  if (!Array.isArray(rawJournal)) throw new TypeError("paper session journal must be an array");
  const journal = rawJournal as readonly SimulationEvent[];
  const decisions = { noTrade: 0, riskRejected: 0, orderSubmitted: 0 };
  const orderStates = new Map<string, {
    readonly status: string;
    readonly cancelPending: boolean;
    readonly cancelPendingSeen: boolean;
    readonly filledQuantity: number;
  }>();
  const fillIds = new Set<string>();
  let fillQuantity = 0;
  let fillsAfterCancelPending = 0;
  for (const event of journal) {
    if (event.kind === "decision") {
      if (event.status === "no-trade") decisions.noTrade += 1;
      else if (event.status === "risk-rejected") decisions.riskRejected += 1;
      else decisions.orderSubmitted += 1;
      countReason(event.reasonCode);
    } else if (event.kind === "order") {
      const previous = orderStates.get(event.clientOrderId);
      const status = event.status as string;
      const cancelPending = status === "cancel-pending" || ("cancelPending" in event && event.cancelPending === true);
      orderStates.set(event.clientOrderId, {
        status,
        cancelPending,
        cancelPendingSeen: cancelPending || previous?.cancelPendingSeen === true,
        filledQuantity: event.filledQuantity,
      });
      countReason(event.reasonCode);
    } else if (event.kind === "fill") {
      if (fillIds.has(event.fillId)) continue;
      fillIds.add(event.fillId);
      fillQuantity += event.quantity;
      if (orderStates.get(event.clientOrderId)?.cancelPendingSeen === true) fillsAfterCancelPending += 1;
    } else if (event.kind === "cancel") {
      countReason(event.reasonCode);
    } else if (event.kind === "market" && event.status === "stale") {
      countReason(event.reasonCode);
    }
  }

  const orders = {
    attempted: orderStates.size,
    submitted: decisions.orderSubmitted,
    pending: 0,
    partiallyFilled: 0,
    filled: 0,
    rejected: 0,
    cancelled: 0,
    absent: 0,
    open: 0,
    cancelPending: 0,
  };
  for (const state of orderStates.values()) {
    const pending = state.status === "pending" || (state.status === "cancel-pending" && state.filledQuantity === 0);
    const partiallyFilled = state.status === "partially-filled" || (state.status === "cancel-pending" && state.filledQuantity > 0);
    if (pending) orders.pending += 1;
    else if (partiallyFilled) orders.partiallyFilled += 1;
    else if (state.status === "filled") orders.filled += 1;
    else if (state.status === "rejected") orders.rejected += 1;
    else if (state.status === "cancelled") orders.cancelled += 1;
    else if (state.status === "absent") orders.absent += 1;
    if (pending || partiallyFilled || state.status === "cancel-pending") orders.open += 1;
    if (state.cancelPending && (pending || partiallyFilled || state.status === "cancel-pending")) {
      orders.cancelPending += 1;
    }
  }

  const account = asRecord(run["accountSummary"], "paper session accountSummary");
  const positionQuantity = safeCount(account["positionQuantity"], "accountSummary.positionQuantity");
  const statistics = asRecord(run["tradingStatistics"], "paper session tradingStatistics");
  const incompleteTrade = statistics["incompleteTrade"];
  const incompletePositionQuantity = incompleteTrade === null
    ? 0
    : safeCount(asRecord(incompleteTrade, "tradingStatistics.incompleteTrade")["positionQuantity"], "incompleteTrade.positionQuantity");
  if (positionQuantity !== incompletePositionQuantity) {
    throw new Error("open position quantity does not reconcile with the incomplete trade");
  }

  const rawCurve = run["equityCurve"];
  if (!Array.isArray(rawCurve)) throw new TypeError("paper session equityCurve was not captured");
  const curve = rawCurve.map((raw, index): EquityPoint => {
    const point = asRecord(raw, `equityCurve[${index}]`);
    return Object.freeze({ equityMinor: bigintValue(point["equityMinor"], `equityCurve[${index}].equityMinor`) });
  });
  if (curve.length !== processedEvents.accepted) throw new Error("equity curve does not match accepted market events");

  const stages: ForwardStageCounts = Object.freeze({
    sourceRows,
    processedEvents: Object.freeze(processedEvents),
    decisions: Object.freeze({
      total: decisions.noTrade + decisions.riskRejected + decisions.orderSubmitted,
      noTrade: decisions.noTrade,
      riskRejected: decisions.riskRejected,
      orderSubmitted: decisions.orderSubmitted,
    }),
    orders: Object.freeze(orders),
    fills: Object.freeze({ count: fillIds.size, quantity: fillQuantity, afterCancelPending: fillsAfterCancelPending }),
    completedTradeCount: tradeCounts.completedTradeCount,
    openPositionQuantity: positionQuantity,
    reasonCodeCounts: Object.freeze(Object.fromEntries([...reasonCodeCounts.entries()].sort(([left], [right]) => left.localeCompare(right)))),
  });
  const outcome: ForwardEvaluationState = sourceRows === 0
    ? "NO_FRESH_DATA"
    : processedEvents.accepted === 0
      ? "NO_ACCEPTED_MARKET_EVENTS"
    : positionQuantity > 0
      ? "OPEN_POSITION_AT_CUTOFF"
      : orders.open > 0
        ? "UNFILLED_ORDER_AT_CUTOFF"
        : tradeCounts.completedTradeCount > 0
          ? "COMPLETED_TRADES"
          : decisions.riskRejected > 0
            ? "RISK_REJECTED"
            : orders.submitted === 0 && fillIds.size === 0
              ? "NO_SIGNAL"
              : "ACTIVITY_WITHOUT_COMPLETED_TRADES";
  return Object.freeze({ stages, outcome, curve: Object.freeze(curve) });
}

function readSessionEconomics(
  run: Record<string, unknown>,
  initialCapitalMinor: bigint,
  curve: readonly EquityPoint[],
): Omit<SessionRunSummary, "tradeCounts" | "stages" | "outcome"> {
  const account = asRecord(run["accountSummary"], "paper session accountSummary");
  const settings = asRecord(run["simulationSettings"], "paper session simulationSettings");
  const configuredInitialCapitalMinor = bigintValue(settings["initialCashMinor"], "simulationSettings.initialCashMinor");
  if (configuredInitialCapitalMinor !== initialCapitalMinor) {
    throw new Error("paper session starting cash does not match the expected cost-matched starting cash");
  }
  const terms = asRecord(settings["terms"], "paper session simulationSettings.terms");
  const asset = asRecord(run["asset"], "paper session asset");
  const statistics = asRecord(run["tradingStatistics"], "paper session tradingStatistics");
  const completedTrades = statistics["completedTrades"];
  if (!Array.isArray(completedTrades)) throw new TypeError("paper session completedTrades must be an array");
  const completedTradeNetPnlMinor = completedTrades.reduce((sum: bigint, raw, index) => {
    const trade = asRecord(raw, `completedTrades[${index}]`);
    return sum + bigintValue(trade["netPnlMinor"], `completedTrades[${index}].netPnlMinor`);
  }, 0n);
  const incompleteTrade = statistics["incompleteTrade"];
  const openTradeRealizedPnlMinor = incompleteTrade === null
    ? 0n
    : bigintValue(asRecord(incompleteTrade, "tradingStatistics.incompleteTrade")["realizedPnlMinor"], "incompleteTrade.realizedPnlMinor");
  const realizedPnlMinor = bigintValue(account["realizedPnlMinor"], "accountSummary.realizedPnlMinor");
  if (realizedPnlMinor !== completedTradeNetPnlMinor + openTradeRealizedPnlMinor) {
    throw new Error("realized P&L does not reconcile between completed and incomplete trades");
  }
  const endingEquityMinor = bigintValue(account["equityMinor"], "accountSummary.equityMinor");
  const feesPaidMinor = bigintValue(account["feesPaidMinor"], "accountSummary.feesPaidMinor");
  const unrealizedPnlMinor = bigintValue(account["unrealizedPnlMinor"], "accountSummary.unrealizedPnlMinor");
  const returnScaled = ratioScaled(endingEquityMinor - initialCapitalMinor, initialCapitalMinor);
  const feeBps = safeCount(terms["feeBps"], "simulationSettings.terms.feeBps");
  const slippageBps = safeCount(terms["slippageBps"], "simulationSettings.terms.slippageBps");
  if (typeof settings["fillModel"] !== "string") throw new TypeError("paper session simulationSettings.fillModel must be a string");
  if (typeof asset["currencyCode"] !== "string") throw new TypeError("paper session asset.currencyCode must be a string");
  return Object.freeze({
    initialCapitalMinor,
    endingEquityMinor,
    realizedPnlMinor,
    completedTradeNetPnlMinor,
    openTradeRealizedPnlMinor,
    unrealizedPnlMinor,
    feesPaidMinor,
    currencyCode: asset["currencyCode"],
    fillModel: settings["fillModel"],
    feeBps,
    slippageBps,
    netReturnScaled: returnScaled,
    maximumDrawdownScaled: maximumDrawdownScaled(initialCapitalMinor, curve),
  });
}

function forwardOutcomeReasons(stages: ForwardStageCounts, outcome: ForwardEvaluationState): readonly string[] {
  const reasons: string[] = [];
  if (outcome === "NO_FRESH_DATA") reasons.push("NO_FRESH_DATA");
  if (outcome === "NO_ACCEPTED_MARKET_EVENTS") reasons.push("NO_ACCEPTED_MARKET_EVENTS");
  if (stages.completedTradeCount === 0 && outcome !== "NO_FRESH_DATA") reasons.push("NO_COMPLETED_TRADES");
  if (stages.processedEvents.stale > 0) reasons.push("STALE_MARKET_EVENTS_PRESENT");
  if (stages.openPositionQuantity > 0) reasons.push("OPEN_POSITION_AT_CUTOFF");
  if (stages.orders.open > 0) reasons.push("UNFILLED_ORDER_AT_CUTOFF");
  if (stages.decisions.riskRejected > 0) reasons.push("RISK_REJECTED_DECISION");
  if (outcome === "NO_SIGNAL") reasons.push("NO_SIGNAL");
  return Object.freeze(reasons);
}

function createEmptyDiagnostics(): ForwardCandidateDiagnostics {
  return Object.freeze({
    outcome: "NO_FRESH_DATA",
    inconclusiveReasonCodes: Object.freeze(["NO_FRESH_DATA"]),
    stages: Object.freeze({
      sourceRows: 0,
      processedEvents: Object.freeze({ accepted: 0, duplicate: 0, stale: 0 }),
      decisions: Object.freeze({ total: 0, noTrade: 0, riskRejected: 0, orderSubmitted: 0 }),
      orders: Object.freeze({ attempted: 0, submitted: 0, pending: 0, partiallyFilled: 0, filled: 0, rejected: 0, cancelled: 0, absent: 0, open: 0, cancelPending: 0 }),
      fills: Object.freeze({ count: 0, quantity: 0, afterCancelPending: 0 }),
      completedTradeCount: 0,
      openPositionQuantity: 0,
      reasonCodeCounts: Object.freeze({}),
    }),
    economics: Object.freeze({
      returnBasis: "MARK_TO_MARKET_AFTER_SIMULATED_FEES_AND_SLIPPAGE",
      currencyCode: "TWD",
      initialCapitalMinor: null,
      endingEquityMinor: null,
      realizedPnlMinor: null,
      completedTradeNetPnlMinor: null,
      openTradeRealizedPnlMinor: null,
      unrealizedPnlMinor: null,
      feesPaidMinor: null,
      netReturnFraction: null,
      maximumDrawdownFraction: null,
      costMatchedBenchmark: Object.freeze({
        policy: "ALWAYS_LONG",
        sizingPolicy: "SAME_FROZEN_TARGET_QUANTITY",
        status: "NO_FRESH_DATA",
        fillModel: null,
        feeBps: null,
        slippageBps: null,
        initialCapitalMinor: null,
        endingEquityMinor: null,
        netReturnFraction: null,
        maximumDrawdownFraction: null,
        excessNetReturnFraction: null,
        feesPaidMinor: null,
        openPositionQuantity: 0,
      }),
    }),
  });
}

function readSessionSummary(
  run: Record<string, unknown>,
  sourceRows: number,
  initialCapitalMinor: bigint,
): SessionRunSummary {
  const tradeCounts = readRunTradeCounts(run);
  const { stages, outcome, curve } = summarizeRunStages(run, sourceRows, tradeCounts);
  return Object.freeze({
    tradeCounts,
    stages,
    outcome,
    ...readSessionEconomics(run, initialCapitalMinor, curve),
  });
}

export function summarizeForwardSessionRuns(
  run: Record<string, unknown>,
  benchmarkRun: Record<string, unknown>,
  sourceRows: number,
  initialCapitalMinor: bigint,
): ForwardCandidateDiagnostics {
  const candidate = readSessionSummary(run, sourceRows, initialCapitalMinor);
  const benchmark = readSessionSummary(benchmarkRun, sourceRows, initialCapitalMinor);
  if (candidate.feeBps !== benchmark.feeBps
    || candidate.slippageBps !== benchmark.slippageBps
    || candidate.fillModel !== benchmark.fillModel
    || candidate.initialCapitalMinor !== benchmark.initialCapitalMinor) {
    throw new Error("cost-matched benchmark terms do not match the frozen strategy terms");
  }
  const benchmarkComparable = benchmark.stages.processedEvents.accepted > 0
    && benchmark.stages.processedEvents.stale === 0
    && benchmark.stages.orders.open === 0
    && benchmark.stages.decisions.riskRejected === 0;
  const excessScaled = benchmarkComparable && candidate.netReturnScaled !== null && benchmark.netReturnScaled !== null
    ? candidate.netReturnScaled - benchmark.netReturnScaled
    : null;
  const benchmarkMetrics: CostMatchedBenchmark = Object.freeze({
    policy: "ALWAYS_LONG",
    sizingPolicy: "SAME_FROZEN_TARGET_QUANTITY",
    fillModel: benchmark.fillModel,
    status: benchmark.outcome,
    feeBps: benchmark.feeBps,
    slippageBps: benchmark.slippageBps,
    initialCapitalMinor: benchmark.initialCapitalMinor.toString(),
    endingEquityMinor: benchmark.endingEquityMinor.toString(),
    netReturnFraction: formatScaledRatio(benchmark.netReturnScaled),
    maximumDrawdownFraction: formatScaledRatio(benchmark.maximumDrawdownScaled),
    excessNetReturnFraction: formatScaledRatio(excessScaled),
    feesPaidMinor: benchmark.feesPaidMinor.toString(),
    openPositionQuantity: benchmark.stages.openPositionQuantity,
  });
  return Object.freeze({
    outcome: candidate.outcome,
    inconclusiveReasonCodes: forwardOutcomeReasons(candidate.stages, candidate.outcome),
    stages: candidate.stages,
    economics: Object.freeze({
      returnBasis: "MARK_TO_MARKET_AFTER_SIMULATED_FEES_AND_SLIPPAGE",
      currencyCode: candidate.currencyCode,
      initialCapitalMinor: candidate.initialCapitalMinor.toString(),
      endingEquityMinor: candidate.endingEquityMinor.toString(),
      realizedPnlMinor: candidate.realizedPnlMinor.toString(),
      completedTradeNetPnlMinor: candidate.completedTradeNetPnlMinor.toString(),
      openTradeRealizedPnlMinor: candidate.openTradeRealizedPnlMinor.toString(),
      unrealizedPnlMinor: candidate.unrealizedPnlMinor.toString(),
      feesPaidMinor: candidate.feesPaidMinor.toString(),
      netReturnFraction: formatScaledRatio(candidate.netReturnScaled),
      maximumDrawdownFraction: formatScaledRatio(candidate.maximumDrawdownScaled),
      costMatchedBenchmark: benchmarkMetrics,
    }),
  });
}

function alwaysLongBenchmark(targetQuantity: number): PaperStrategy {
  return Object.freeze({
    strategyVersion: "cost-matched-always-long-benchmark-v1",
    strategyParameters: Object.freeze({ policy: "ALWAYS_LONG", targetQuantity }),
    decide: () => targetQuantity,
  });
}

function runFrozenCandidate(
  parsed: ParsedHistoricalCsv,
  freshDataSha256: string,
  parameters: WinRateParameters,
): { readonly metrics: ForwardMetrics; readonly diagnostics: ForwardCandidateDiagnostics } {
  const session = Object.freeze({
    ...parsed.session,
    simulation: Object.freeze({
      ...parsed.session.simulation,
      strategy: Object.freeze({
        entryAtOrBelowMinor: parameters.entryAtOrBelowMinor,
        exitAtOrAboveMinor: parameters.exitAtOrAboveMinor,
        targetQuantity: parameters.targetQuantity,
      }),
    }),
  });
  const options = Object.freeze({ captureEquityCurve: true });
  const run = runPaperSession(session, freshDataSha256, undefined, undefined, undefined, options);
  const benchmark = runPaperSession(
    session,
    freshDataSha256,
    undefined,
    alwaysLongBenchmark(parameters.targetQuantity),
    undefined,
    options,
  );
  const tradeCounts = readRunTradeCounts(run);
  return Object.freeze({
    metrics: forwardMetrics(tradeCounts, freshDataSha256),
    diagnostics: summarizeForwardSessionRuns(run, benchmark, parsed.rowCount, parsed.session.simulation.initialCashMinor),
  });
}

export function determineForwardPromotionStatus(
  champion: WinRateV2Metrics,
  challenger: WinRateV2Metrics,
  firstEvidenceDate: string,
  historicalCutoff: string,
): PromotionStatus {
  if (champion.completedTradeCount === 0 || challenger.completedTradeCount === 0) {
    return "INSUFFICIENT_FRESH_TRADES";
  }
  return determineFuturePromotionStatusV2(champion, challenger, firstEvidenceDate, historicalCutoff);
}

export function evaluateForwardWinRate(input: {
  readonly frozenArtifact: unknown;
  readonly freshDataBytes: Uint8Array;
  readonly freshProvenance: unknown;
}): ForwardWinRateEvaluation {
  const identities = loadFrozenForwardIdentities(input.frozenArtifact);
  const provenance = parseFreshProvenance(input.freshProvenance);
  if (provenance.historicalCutoff !== identities.historicalCutoff) {
    throw new ForwardWinRateInputError("STALE_FORWARD_SNAPSHOT", "forward-data provenance historicalCutoff does not match the frozen V2 cutoff");
  }
  const freshDataSha256 = createHash("sha256").update(input.freshDataBytes).digest("hex");
  if (freshDataSha256 !== provenance.sha256) {
    throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", "forward-data CSV SHA-256 does not match its provenance");
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(input.freshDataBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`forward-data CSV is not valid UTF-8: ${detail}`);
  }

  const csvSummary = validateFreshCsv(contents, identities.historicalCutoff);
  if (csvSummary.rowCount !== provenance.rowCount) {
    throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", "forward-data provenance rowCount does not match its CSV");
  }
  if (csvSummary.rowCount === 0) {
    if (provenance.dateRange.start !== null || provenance.dateRange.end !== null) {
      throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", "empty forward data provenance must have a null date range");
    }
    const emptyMetrics = emptyForwardMetrics(freshDataSha256);
    return Object.freeze({
      schemaVersion: 1,
      objective: identities.objective,
      selectionPolicyVersion: identities.selectionPolicyVersion,
      historicalCutoff: identities.historicalCutoff,
      freshDataSha256,
      freshDateRange: null,
      freshRowCount: 0,
      priceUnit: Object.freeze({ currencyCode: "TWD", minorUnit: "0.01", minorUnitsPerMajor: 100 }),
      dataCoverage: Object.freeze({
        inputIntegrity: "PROVENANCE_HASH_ROW_COUNT_AND_DATE_RANGE_MATCHED",
        providerSessionCompleteness: "UNKNOWN",
        providerCompletenessReason: "NO_EXCHANGE_CALENDAR_OR_PROVIDER_COMPLETENESS_ATTESTATION",
      }),
      freshCompletedTradeCount: Object.freeze({ champion: 0, challenger: 0 }),
      champion: Object.freeze({
        id: identities.strategyVersion,
        strategyVersion: identities.strategyVersion,
        parameters: publicParameters(identities.championParameters),
        ...emptyMetrics,
        diagnostics: createEmptyDiagnostics(),
      }),
      challenger: Object.freeze({
        id: identities.challengerId,
        strategyVersion: identities.strategyVersion,
        parameters: publicParameters(identities.challengerParameters),
        ...emptyMetrics,
        diagnostics: createEmptyDiagnostics(),
      }),
      promotionStatus: "NO_FRESH_DATA",
    });
  }
  if (csvSummary.startDate !== provenance.dateRange.start || csvSummary.endDate !== provenance.dateRange.end) {
    throw new ForwardWinRateInputError("INVALID_FORWARD_DATA", "forward-data provenance dateRange does not match its CSV");
  }

  const parsed = parseHistoricalCsv(contents, "0050", "0050 forward evaluation evidence", TWSE_SOURCE_PROFILE_ARGUMENT);
  if (parsed.rowCount !== csvSummary.rowCount || parsed.startDate !== csvSummary.startDate || parsed.endDate !== csvSummary.endDate) {
    throw new Error("parsed forward-data rows do not reconcile with their source CSV");
  }
  const championRun = runFrozenCandidate(parsed, freshDataSha256, identities.championParameters);
  const challengerRun = runFrozenCandidate(parsed, freshDataSha256, identities.challengerParameters);
  const championMetrics = championRun.metrics;
  const challengerMetrics = challengerRun.metrics;
  const championV2Metrics: WinRateV2Metrics = championMetrics;
  const challengerV2Metrics: WinRateV2Metrics = challengerMetrics;
  const promotionStatus = determineForwardPromotionStatus(
    championV2Metrics,
    challengerV2Metrics,
    parsed.startDate,
    identities.historicalCutoff,
  );

  return Object.freeze({
    schemaVersion: 1,
    objective: identities.objective,
    selectionPolicyVersion: identities.selectionPolicyVersion,
    historicalCutoff: identities.historicalCutoff,
    freshDataSha256,
    freshDateRange: Object.freeze({ start: parsed.startDate, end: parsed.endDate }),
    freshRowCount: parsed.rowCount,
    priceUnit: Object.freeze({ currencyCode: "TWD", minorUnit: "0.01", minorUnitsPerMajor: 100 }),
    dataCoverage: Object.freeze({
      inputIntegrity: "PROVENANCE_HASH_ROW_COUNT_AND_DATE_RANGE_MATCHED",
      providerSessionCompleteness: "UNKNOWN",
      providerCompletenessReason: "NO_EXCHANGE_CALENDAR_OR_PROVIDER_COMPLETENESS_ATTESTATION",
    }),
    freshCompletedTradeCount: Object.freeze({
      champion: championMetrics.completedTradeCount,
      challenger: challengerMetrics.completedTradeCount,
    }),
    champion: Object.freeze({
      id: identities.strategyVersion,
      strategyVersion: identities.strategyVersion,
      parameters: publicParameters(identities.championParameters),
      ...championMetrics,
      diagnostics: championRun.diagnostics,
    }),
    challenger: Object.freeze({
      id: identities.challengerId,
      strategyVersion: identities.strategyVersion,
      parameters: publicParameters(identities.challengerParameters),
      ...challengerMetrics,
      diagnostics: challengerRun.diagnostics,
    }),
    promotionStatus,
  });
}

export function assertNoForwardCliOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("forward evaluator accepts no strategy, data, or tuning overrides");
}

async function readRequiredInput(root: string, relativePath: string): Promise<Buffer> {
  try {
    return await readFile(resolve(root, relativePath));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new ForwardWinRateInputError("MISSING_INPUT_FILE", `required input file is missing: ${relativePath}`);
    }
    throw error;
  }
}

export function forwardWinRateCliFailure(error: unknown): ForwardWinRateCliFailure {
  const message = error instanceof Error ? error.message : String(error);
  const codeFromError = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  let code: ForwardWinRateCliFailureCode = "EVALUATION_FAILED";
  if (error instanceof ForwardWinRateInputError) code = error.code;
  else if (codeFromError === "MISSING_INPUT_FILE") code = "MISSING_INPUT_FILE";
  else if (error instanceof TypeError && message.startsWith("forward evaluator accepts no strategy")) code = "INVALID_ARGUMENTS";
  else if (error instanceof TypeError && message.startsWith("V2 optimizer artifact")) code = "INVALID_FROZEN_ARTIFACT";
  else if (error instanceof TypeError && /forward-data provenance|fresh CSV|CSV line|duplicate or out of chronological order/.test(message)) {
    code = "INVALID_FORWARD_DATA";
  }
  return Object.freeze({ schemaVersion: 1, status: "ERROR", error: Object.freeze({ code, message }) });
}

export async function runForwardWinRateEvaluationFiles(root = process.cwd()): Promise<ForwardWinRateEvaluation> {
  const [frozenBytes, freshDataBytes, provenanceBytes] = await Promise.all([
    readRequiredInput(root, WIN_RATE_V2_ARTIFACT_PATH),
    readRequiredInput(root, FORWARD_DATA_CSV_PATH),
    readRequiredInput(root, FORWARD_DATA_PROVENANCE_PATH),
  ]);
  const frozenArtifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frozenBytes)) as unknown;
  const freshProvenance = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes)) as unknown;
  const result = evaluateForwardWinRate({ frozenArtifact, freshDataBytes, freshProvenance });
  await writeFile(resolve(root, FORWARD_EVALUATION_OUTPUT_PATH), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(args: readonly string[]): Promise<void> {
  assertNoForwardCliOverrides(args);
  stdout.write(`${JSON.stringify(await runForwardWinRateEvaluationFiles())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    stdout.write(`${JSON.stringify(forwardWinRateCliFailure(error))}\n`);
    process.exitCode = 1;
  });
}
