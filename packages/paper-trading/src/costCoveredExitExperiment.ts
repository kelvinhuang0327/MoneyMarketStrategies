import { createHash } from "node:crypto";
import { CostCoveredZScoreExitV1Strategy } from "./costCoveredZScoreExit.js";
import { CROSS_SYMBOL_RESEARCH_RISK_V1 } from "./crossSymbolResearchRisk.js";
import { executionPriceMinor, feeMinorForFill } from "./money.js";
import { parsePaperSession, runPaperSession } from "./sessionRunner.js";
import { RollingZScoreMeanReversionV1Strategy, rollingCloseZScore } from "./zscoreStrategy.js";
import type { AccountSnapshot, PaperStrategy, SimulationEvent } from "./types.js";

export const COST_COVERED_EXIT_PARAMETERS = Object.freeze({ lookback: 40, entryZ: 1, exitZ: 0, maxHoldBars: 20 });
export const COST_COVERED_EXIT_TERMS = Object.freeze({ label: "SYNTHETIC_ONLY", feeBps: 30, slippageBps: 100 } as const);
export const COST_COVERED_EXIT_SYMBOLS = Object.freeze(["0056", "2317", "2330", "2454"]);

interface Row {
  readonly eventId: string;
  readonly timestamp: number;
  readonly priceMinor: string;
  readonly receivedAtTimestamp: number;
}
interface Dataset {
  readonly symbol: string;
  readonly source: { readonly uri: string; readonly sha256: string };
  readonly rows: readonly Row[];
}
export interface CostCoveredExitExperimentInput {
  readonly schemaVersion: 1;
  readonly dataKind: "SYNTHETIC" | "HISTORICAL";
  readonly datasets: readonly Dataset[];
}
interface Replay {
  readonly accountSummary: AccountSnapshot;
  readonly journal: readonly SimulationEvent[];
  readonly equityCurve: readonly { timestamp: number; equityMinor: bigint }[];
  readonly eventProcessingResults: readonly { timestamp: number; status: string }[];
  readonly tradingStatistics: {
    readonly completeTradeCount: number; readonly wins: number; readonly losses: number; readonly breakevens: number;
    readonly netWinRate: number | null; readonly completedTrades: readonly unknown[]; readonly incompleteTrade: unknown;
  };
  readonly accountReconciliation: Readonly<Record<string, unknown>>;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError(`expected fields: ${keys.join(", ")}; overrides are not supported`);
  }
  return record;
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** No already occurred window can become this candidate's final holdout. Real
 * receipt times must precede the next decision/fill tick; late batch downloads
 * are retrospective replay, not prospective evidence, and are rejected here.
 */
export function parseCostCoveredExitInput(value: unknown, freezeTimestamp: number, nowTimestamp: number): CostCoveredExitExperimentInput {
  if (!integer(freezeTimestamp) || !integer(nowTimestamp)) throw new TypeError("invalid freeze/current timestamp");
  const input = object(value, ["schemaVersion", "dataKind", "datasets"]);
  if (input["schemaVersion"] !== 1 || (input["dataKind"] !== "SYNTHETIC" && input["dataKind"] !== "HISTORICAL")) throw new TypeError("invalid schema/dataKind");
  const kind = input["dataKind"] as CostCoveredExitExperimentInput["dataKind"];
  if (!Array.isArray(input["datasets"]) || input["datasets"].length < 1 || input["datasets"].length > 4) throw new TypeError("expected 1–4 datasets");
  const symbols = new Set<string>();
  const datasets: Dataset[] = input["datasets"].map((raw: unknown) => {
    const data = object(raw, ["symbol", "source", "rows"]);
    if (typeof data["symbol"] !== "string") throw new TypeError("symbol must be a string");
    const symbol = data["symbol"];
    if (!COST_COVERED_EXIT_SYMBOLS.includes(symbol) || symbols.has(symbol)) throw new TypeError("invalid/duplicate frozen symbol");
    symbols.add(symbol);
    const source = object(data["source"], ["uri", "sha256"]);
    if (typeof source["uri"] !== "string" || !source["uri"].trim() || typeof source["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(source["sha256"])) throw new TypeError("missing source URI/SHA-256");
    if (kind === "HISTORICAL") {
      const uri = new URL(source["uri"]);
      if (uri.protocol !== "https:" || uri.hostname !== "www.twse.com.tw" || uri.pathname !== "/exchangeReport/STOCK_DAY" || uri.username || uri.password || uri.searchParams.get("stockNo") !== symbol) throw new TypeError("only frozen official TWSE source is admitted");
    }
    if (!Array.isArray(data["rows"]) || data["rows"].length < 1 || data["rows"].length > 256) throw new TypeError("expected 1–256 rows per symbol; larger runs require a coordinated slot");
    const rows: Row[] = data["rows"].map((rawRow: unknown) => {
      const row = object(rawRow, ["eventId", "timestamp", "priceMinor", "receivedAtTimestamp"]);
      if (typeof row["eventId"] !== "string" || !row["eventId"].trim() || !integer(row["timestamp"]) || !integer(row["receivedAtTimestamp"])
        || typeof row["priceMinor"] !== "string" || !/^[1-9][0-9]*$/.test(row["priceMinor"])) throw new TypeError("invalid/missing market row");
      if (BigInt(row["priceMinor"]) > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("price exceeds safe z-score numeric precision");
      if (row["receivedAtTimestamp"] < row["timestamp"]) throw new TypeError("receipt predates market data");
      if (kind === "HISTORICAL" && (row["timestamp"] > nowTimestamp || row["receivedAtTimestamp"] > nowTimestamp)) throw new TypeError("future real data cannot be supplied");
      return row as unknown as Row;
    });
    const seen = new Map<string, Row>();
    let lastTimestamp = -1;
    const unique: Row[] = [];
    for (const row of rows) {
      const prior = seen.get(row.eventId);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(row)) throw new TypeError("conflicting duplicate event");
        continue;
      }
      if (row.timestamp <= lastTimestamp) throw new TypeError("market rows must be strictly chronological");
      lastTimestamp = row.timestamp; seen.set(row.eventId, row); unique.push(row);
    }
    const evaluation = unique.filter((row) => row.timestamp > freezeTimestamp);
    if (evaluation.length === 0) throw new TypeError("NO_UNSEEN_EVALUATION_ROWS: all supplied data predate freeze");
    if (kind === "HISTORICAL") {
      const first = evaluation[0]!;
      for (let i = 0; i < unique.length; i += 1) {
        const row = unique[i]!;
        const next = unique[i + 1];
        if ((row.timestamp <= freezeTimestamp && row.receivedAtTimestamp > first.receivedAtTimestamp)
          || (row.timestamp > freezeTimestamp && next && row.receivedAtTimestamp >= next.timestamp)) {
          throw new TypeError("LATE_RECEIPT: retrospective batch is not prospective evidence");
        }
      }
    }
    return { symbol, source: source as unknown as Dataset["source"], rows };
  });
  return { schemaVersion: 1, dataKind: kind, datasets };
}

export function descriptiveWilson95(wins: number, count: number): { lower: number; upper: number } | null {
  if (count === 0) return null;
  const z = 1.959963984540054, p = wins / count, denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

function replay(data: Dataset, kind: CostCoveredExitExperimentInput["dataKind"], hash: string, freezeTimestamp: number, strategy: PaperStrategy) {
  const exposure: number[] = [];
  let insufficientLookbackOrZeroVarianceDecisions = 0;
  const wrapped: PaperStrategy = {
    strategyVersion: strategy.strategyVersion, strategyParameters: strategy.strategyParameters ?? {},
    decide(input) {
      if (input.current.timestamp > freezeTimestamp) {
        exposure.push(Number(input.current.priceMinor * BigInt(input.positionQuantity)) / Number(CROSS_SYMBOL_RESEARCH_RISK_V1.initialCapitalMinor));
        if (rollingCloseZScore(input.history, input.current.priceMinor, 40) === null) insufficientLookbackOrZeroVarianceDecisions += 1;
      }
      return strategy.decide(input);
    },
  };
  const session = parsePaperSession({
    schemaVersion: 1, dataKind: kind, sourceLabel: data.source.uri,
    asset: { symbol: data.symbol, currencyCode: "TWD", minorUnit: "0.01" },
    simulation: {
      initialCashMinor: "10000000", risk: { maxPositionQuantity: 4, maxExposureMinor: "2000000", maxMarketAgeMs: 5000 },
      terms: COST_COVERED_EXIT_TERMS,
      strategy: { entryAtOrBelowMinor: "10000", exitAtOrAboveMinor: "11000", targetQuantity: 3 },
    },
    events: data.rows.map((row) => ({ eventId: row.eventId, timestamp: row.timestamp, symbol: data.symbol, priceMinor: row.priceMinor })),
  });
  const result = runPaperSession(session, hash, undefined, wrapped, CROSS_SYMBOL_RESEARCH_RISK_V1, { captureEquityCurve: true }) as unknown as Replay;
  const account = result.accountSummary;
  const initial = CROSS_SYMBOL_RESEARCH_RISK_V1.initialCapitalMinor;
  const curve = result.equityCurve.filter((point) => point.timestamp > freezeTimestamp);
  let peak = Number(initial), maximumDrawdown = 0;
  for (const point of curve) { peak = Math.max(peak, Number(point.equityMinor)); maximumDrawdown = Math.max(maximumDrawdown, (peak - Number(point.equityMinor)) / peak); }
  let terminalLiquidationEquity = account.equityMinor;
  if (account.positionQuantity > 0 && account.markPriceMinor !== null) {
    const price = executionPriceMinor("sell", account.markPriceMinor, COST_COVERED_EXIT_TERMS.slippageBps);
    terminalLiquidationEquity = account.cashMinor + price * BigInt(account.positionQuantity) - feeMinorForFill(price, account.positionQuantity, COST_COVERED_EXIT_TERMS.feeBps);
  }
  const decisions = result.journal.filter((event) => event.kind === "decision" && event.timestamp > freezeTimestamp);
  const stages = {
    acceptedEvaluationEvents: result.eventProcessingResults.filter((event) => event.timestamp > freezeTimestamp && event.status === "accepted").length,
    duplicateEvents: result.eventProcessingResults.filter((event) => event.status === "duplicate").length,
    insufficientLookbackOrZeroVarianceDecisions,
    flatNoSignalDecisions: decisions.filter((event) => event.kind === "decision" && event.currentPositionQuantity === 0 && event.targetPositionQuantity === 0).length,
    riskRejected: decisions.filter((event) => event.kind === "decision" && event.status === "risk-rejected").length,
    ordersSubmitted: decisions.filter((event) => event.kind === "decision" && event.status === "order-submitted").length,
    fills: result.journal.filter((event) => event.kind === "fill").length,
    decisionReasons: Object.fromEntries([...new Set(decisions.map((event) => event.kind === "decision" ? event.reasonCode : ""))].map((reason) => [reason, decisions.filter((event) => event.kind === "decision" && event.reasonCode === reason).length])),
  };
  return {
    ...result.tradingStatistics, stages, netWinRateWilson95: descriptiveWilson95(result.tradingStatistics.wins, result.tradingStatistics.completeTradeCount),
    openPositionQuantity: account.positionQuantity, pendingOrder: account.activeOrder,
    netReturnAfterModeledCostsFraction: Number(account.equityMinor - initial) / Number(initial),
    terminalLiquidationEstimateReturnFraction: Number(terminalLiquidationEquity - initial) / Number(initial),
    maximumDrawdownFraction: maximumDrawdown,
    maximumExposureFractionOfInitialCapital: Math.max(0, ...exposure),
    averageExposureFractionOfInitialCapital: exposure.length ? exposure.reduce((sum, item) => sum + item, 0) / exposure.length : null,
    fractionOfEvaluationEventsWithPosition: exposure.length ? exposure.filter((value) => value > 0).length / exposure.length : null,
    feesPaidMinor: account.feesPaidMinor, realizedPnlMinor: account.realizedPnlMinor, unrealizedPnlMinor: account.unrealizedPnlMinor,
    accountReconciliation: result.accountReconciliation, journal: result.journal,
  };
}

export function runCostCoveredExitExperiment(input: CostCoveredExitExperimentInput, inputSha256: string, freezeTimestamp: number) {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("invalid input hash");
  const config = { ...COST_COVERED_EXIT_PARAMETERS, activeFromTimestamp: freezeTimestamp + 1 };
  const results = input.datasets.map((data) => {
    const candidateStrategy = new CostCoveredZScoreExitV1Strategy({ ...config, ...COST_COVERED_EXIT_TERMS });
    const baseline = replay(data, input.dataKind, inputSha256, freezeTimestamp, new RollingZScoreMeanReversionV1Strategy(config));
    const candidate = replay(data, input.dataKind, inputSha256, freezeTimestamp, candidateStrategy);
    const costMatchedBenchmark = replay(data, input.dataKind, inputSha256, freezeTimestamp, {
      strategyVersion: "fixed-quantity-hold-first-eligible-next-event-v1",
      decide: (event) => event.current.timestamp > freezeTimestamp ? 3 : 0,
    });
    return {
      symbol: data.symbol, source: data.source,
      warmupRows: data.rows.filter((row) => row.timestamp <= freezeTimestamp).length,
      baseline, candidate: { ...candidate, exitDiagnostics: candidateStrategy.getDiagnostics() }, costMatchedBenchmark,
      candidateMinusBaselineReturnFraction: candidate.netReturnAfterModeledCostsFraction - baseline.netReturnAfterModeledCostsFraction,
      candidateMinusBenchmarkReturnFraction: candidate.netReturnAfterModeledCostsFraction - costMatchedBenchmark.netReturnAfterModeledCostsFraction,
    };
  });
  const eligibility = {
    requiredSymbols: 3, requiredCompletedTradesPerArm: 12,
    symbolsWithCompletedTradesInBothArms: results.filter((row) => row.baseline.completeTradeCount > 0 && row.candidate.completeTradeCount > 0).length,
    baselineCompletedTrades: results.reduce((n, row) => n + row.baseline.completeTradeCount, 0),
    candidateCompletedTrades: results.reduce((n, row) => n + row.candidate.completeTradeCount, 0),
    meaning: "MINIMUM_ELIGIBILITY_ONLY_NOT_STATISTICAL_PROOF",
  };
  return {
    classification: input.dataKind === "SYNTHETIC" ? "SYNTHETIC_BEHAVIOR_ONLY" : "PROSPECTIVE_REPLAY_REQUIRES_SOURCE_VERIFICATION",
    status: "INCONCLUSIVE", inputSha256, freezeTimestamp,
    attemptId: createHash("sha256").update(`cost-covered-zscore-exit-v1:${freezeTimestamp}:${inputSha256}`).digest("hex"),
    eligibility, results,
    uncertainty: {
      winRateInterval: "TWO_SIDED_WILSON_95_DESCRIPTIVE_IID_ASSUMPTION_NOT_VALIDATED",
      effectInterval: null,
      effectIntervalReason: "Single small prospective window lacks independent time blocks; paired return/drawdown estimates are descriptive, not significance or a promotion test.",
      limitations: ["Development baseline selected from 24 tried configurations; multiplicity and temporal/cross-symbol dependence remain.", "Open trades are excluded from win-rate denominator and included in marked equity/exposure.", "Net return includes modeled fee/slippage only; sell tax, personal dividend tax, broker minimum fees, distributions and splits need verified economic treatment.", "Current-quote cost coverage does not guarantee next-event execution proceeds or partial-fill fee totals.", "Synthetic observations cannot meet real sample eligibility."],
    },
    benchmarkDefinition: "Quantity 3 from the first eligible quote, next-event fills, identical capital/risk/fee/slippage; no liquidation imposed on any arm. Terminal liquidation is a separate estimate.",
    nonDeterminationReasons: [
      ...(input.dataKind === "SYNTHETIC" ? ["SYNTHETIC_ONLY_NO_REAL_EVIDENCE"] : ["RECEIPT_AND_SOURCE_AUTHENTICITY_REQUIRE_INDEPENDENT_VERIFICATION", "UNKNOWN_CORPORATE_ACTION_AND_REAL_COST_COVERAGE"]),
      ...(eligibility.baselineCompletedTrades < 12 || eligibility.candidateCompletedTrades < 12 || eligibility.symbolsWithCompletedTradesInBothArms < 3 ? ["MINIMUM_SAMPLE_NOT_MET"] : []),
      ...(results.some((row) => row.candidate.openPositionQuantity > 0) ? ["OPEN_TRADES_NOT_SETTLED"] : []),
    ],
  };
}
