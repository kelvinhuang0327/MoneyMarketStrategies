import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allocateCostBasisMinor } from "./money.js";
import { PaperTradingEngine } from "./engine.js";
import { alwaysFillNextEvent, PriceBandStrategy } from "./strategy.js";
import type { CrossSymbolResearchRiskProfile } from "./crossSymbolResearchRisk.js";
import type {
  Clock,
  MarketEvent,
  PaperOrder,
  PaperStrategy,
  PaperTradingEngineConfig,
  SimulatedFillRule,
  SimulationEvent,
  SyntheticTradingTerms,
} from "./types.js";

const SCHEMA_VERSION = 1;
const STRATEGY_VERSION = "price-band-fixed-v1";
const FILL_MODEL = "alwaysFillNextEvent";

type DataKind = "SYNTHETIC" | "HISTORICAL";

interface PaperSession {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly dataKind: DataKind;
  readonly sourceLabel: string;
  readonly asset: {
    readonly symbol: string;
    readonly currencyCode: string;
    /** Major currency units represented by one engine minor unit, e.g. "0.01". */
    readonly minorUnit: string;
  };
  readonly simulation: {
    readonly initialCashMinor: bigint;
    readonly risk: PaperTradingEngineConfig["risk"];
    readonly terms: SyntheticTradingTerms;
    readonly strategy: {
      readonly entryAtOrBelowMinor: bigint;
      readonly exitAtOrAboveMinor: bigint;
      readonly targetQuantity: number;
    };
  };
  readonly events: readonly MarketEvent[];
}

interface EventProcessingResult {
  readonly eventId: string;
  readonly timestamp: number;
  readonly status: "accepted" | "duplicate" | "stale";
  readonly reasonCode?: string;
}

interface ExactAverage {
  /** The exact average in minor units is numeratorMinor / denominator. */
  readonly numeratorMinor: string;
  readonly denominator: number;
}

interface CompletedTrade {
  readonly tradeNumber: number;
  readonly openedAtTimestamp: number;
  readonly closedAtTimestamp: number;
  readonly enteredQuantity: number;
  readonly entryFillIds: readonly string[];
  readonly exitFillIds: readonly string[];
  readonly netPnlMinor: bigint;
}

interface OpenTrade {
  openedAtTimestamp: number;
  positionQuantity: number;
  enteredQuantity: number;
  realizedPnlMinor: bigint;
  readonly lots: { quantity: number; totalCostMinor: bigint }[];
  readonly entryFillIds: string[];
  readonly exitFillIds: string[];
}

interface TradeSummary {
  readonly completedTrades: readonly CompletedTrade[];
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly netWinRate: number | null;
  readonly averageWinPnlMinor: ExactAverage | null;
  readonly averageLossPnlMinor: ExactAverage | null;
  readonly averageCompleteTradeNetPnlMinor: ExactAverage | null;
  readonly incompleteTrade: {
    readonly openedAtTimestamp: number;
    readonly positionQuantity: number;
    readonly realizedPnlMinor: bigint;
    readonly entryFillIds: readonly string[];
    readonly exitFillIds: readonly string[];
  } | null;
  readonly fillFeesMinor: bigint;
  readonly filledPositionQuantity: number;
  readonly totalRealizedPnlMinor: bigint;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(extra.length > 0 ? [`unsupported: ${extra.join(", ")}`] : []),
    ];
    throw new TypeError(`${path} has invalid fields (${details.join("; ")})`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${path} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function minorAmount(value: unknown, path: string, allowZero: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${path} must be a non-negative integer string in the configured minor unit`);
  }
  const amount = BigInt(value);
  if (!allowZero && amount === 0n) throw new TypeError(`${path} must be greater than zero`);
  return amount;
}

function validateMinorUnit(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new TypeError("asset.minorUnit must be a positive decimal string; the runner does not infer currency precision");
  }
  return value;
}

export function parsePaperSession(value: unknown): PaperSession {
  const input = record(value, "session");
  exactKeys(input, "session", ["schemaVersion", "dataKind", "sourceLabel", "asset", "simulation", "events"]);
  if (input["schemaVersion"] !== SCHEMA_VERSION) {
    throw new TypeError(`session.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const dataKind = input["dataKind"];
  if (dataKind !== "SYNTHETIC" && dataKind !== "HISTORICAL") {
    throw new TypeError("session.dataKind must be SYNTHETIC or HISTORICAL");
  }
  const sourceLabel = nonEmptyString(input["sourceLabel"], "session.sourceLabel");

  const rawAsset = record(input["asset"], "session.asset");
  exactKeys(rawAsset, "session.asset", ["symbol", "currencyCode", "minorUnit"]);
  const symbol = nonEmptyString(rawAsset["symbol"], "session.asset.symbol");
  const currencyCode = nonEmptyString(rawAsset["currencyCode"], "session.asset.currencyCode");
  if (!/^[A-Z][A-Z0-9]{2,11}$/.test(currencyCode)) {
    throw new TypeError("session.asset.currencyCode must be an explicit uppercase currency code");
  }
  const minorUnit = validateMinorUnit(rawAsset["minorUnit"]);

  const rawSimulation = record(input["simulation"], "session.simulation");
  exactKeys(rawSimulation, "session.simulation", ["initialCashMinor", "risk", "terms", "strategy"]);
  const initialCashMinor = minorAmount(rawSimulation["initialCashMinor"], "session.simulation.initialCashMinor", true);

  const rawRisk = record(rawSimulation["risk"], "session.simulation.risk");
  exactKeys(rawRisk, "session.simulation.risk", ["maxPositionQuantity", "maxExposureMinor", "maxMarketAgeMs"]);
  const risk = Object.freeze({
    maxPositionQuantity: safeInteger(rawRisk["maxPositionQuantity"], "session.simulation.risk.maxPositionQuantity", 0),
    maxExposureMinor: minorAmount(rawRisk["maxExposureMinor"], "session.simulation.risk.maxExposureMinor", true),
    maxMarketAgeMs: safeInteger(rawRisk["maxMarketAgeMs"], "session.simulation.risk.maxMarketAgeMs", 0),
  });

  const rawTerms = record(rawSimulation["terms"], "session.simulation.terms");
  exactKeys(rawTerms, "session.simulation.terms", ["label", "feeBps", "slippageBps"]);
  if (rawTerms["label"] !== "SYNTHETIC_ONLY") {
    throw new TypeError("session.simulation.terms.label must be SYNTHETIC_ONLY");
  }
  const feeBps = safeInteger(rawTerms["feeBps"], "session.simulation.terms.feeBps", 0);
  const slippageBps = safeInteger(rawTerms["slippageBps"], "session.simulation.terms.slippageBps", 0);
  if (feeBps > 10_000) throw new TypeError("session.simulation.terms.feeBps must not exceed 10000");
  if (slippageBps >= 10_000) throw new TypeError("session.simulation.terms.slippageBps must be less than 10000");
  const terms: SyntheticTradingTerms = Object.freeze({
    label: "SYNTHETIC_ONLY",
    feeBps,
    slippageBps,
  });

  const rawStrategy = record(rawSimulation["strategy"], "session.simulation.strategy");
  exactKeys(rawStrategy, "session.simulation.strategy", ["entryAtOrBelowMinor", "exitAtOrAboveMinor", "targetQuantity"]);
  const entryAtOrBelowMinor = minorAmount(rawStrategy["entryAtOrBelowMinor"], "session.simulation.strategy.entryAtOrBelowMinor", false);
  const exitAtOrAboveMinor = minorAmount(rawStrategy["exitAtOrAboveMinor"], "session.simulation.strategy.exitAtOrAboveMinor", false);
  if (exitAtOrAboveMinor <= entryAtOrBelowMinor) {
    throw new TypeError("session.simulation.strategy.exitAtOrAboveMinor must exceed entryAtOrBelowMinor");
  }
  const strategy = Object.freeze({
    entryAtOrBelowMinor,
    exitAtOrAboveMinor,
    targetQuantity: safeInteger(rawStrategy["targetQuantity"], "session.simulation.strategy.targetQuantity", 0),
  });

  const rawEvents = input["events"];
  if (!Array.isArray(rawEvents)) throw new TypeError("session.events must be an array");
  const events = rawEvents.map((rawEvent, index): MarketEvent => {
    const path = `session.events[${index}]`;
    const event = record(rawEvent, path);
    exactKeys(event, path, ["eventId", "timestamp", "symbol", "priceMinor"]);
    const eventSymbol = nonEmptyString(event["symbol"], `${path}.symbol`);
    if (eventSymbol !== symbol) throw new TypeError(`${path}.symbol must match session.asset.symbol`);
    return Object.freeze({
      eventId: nonEmptyString(event["eventId"], `${path}.eventId`),
      timestamp: safeInteger(event["timestamp"], `${path}.timestamp`, Number.MIN_SAFE_INTEGER),
      symbol: eventSymbol,
      priceMinor: minorAmount(event["priceMinor"], `${path}.priceMinor`, false),
    });
  });

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    dataKind,
    sourceLabel,
    asset: Object.freeze({ symbol, currencyCode, minorUnit }),
    simulation: Object.freeze({ initialCashMinor, risk, terms, strategy }),
    events: Object.freeze(events),
  });
}

function exactAverage(sum: bigint, count: number): ExactAverage | null {
  return count === 0 ? null : Object.freeze({ numeratorMinor: sum.toString(), denominator: count });
}

function summarizeTrades(engine: PaperTradingEngine): TradeSummary {
  const ordersById = new Map<string, PaperOrder>(engine.getOrders().map((order) => [order.clientOrderId, order]));
  const completedTrades: CompletedTrade[] = [];
  let openTrade: OpenTrade | null = null;
  let positionQuantity = 0;
  let fillFeesMinor = 0n;

  for (const fill of engine.getFills()) {
    const order = ordersById.get(fill.clientOrderId);
    if (!order) throw new Error(`fill ${fill.fillId} references a missing order`);
    fillFeesMinor += fill.feeMinor;
    if (order.side === "buy") {
      if (openTrade === null) {
        openTrade = {
          openedAtTimestamp: fill.timestamp,
          positionQuantity: 0,
          enteredQuantity: 0,
          realizedPnlMinor: 0n,
          lots: [],
          entryFillIds: [],
          exitFillIds: [],
        };
      }
      const totalCostMinor = fill.executionPriceMinor * BigInt(fill.quantity) + fill.feeMinor;
      openTrade.lots.push({ quantity: fill.quantity, totalCostMinor });
      openTrade.positionQuantity += fill.quantity;
      openTrade.enteredQuantity += fill.quantity;
      openTrade.entryFillIds.push(fill.fillId);
      positionQuantity += fill.quantity;
      continue;
    }

    if (openTrade === null || fill.quantity > openTrade.positionQuantity) {
      throw new Error(`sell fill ${fill.fillId} is not backed by an open long trade`);
    }
    let quantityToAllocate = fill.quantity;
    let basisMinor = 0n;
    while (quantityToAllocate > 0) {
      const lot = openTrade.lots[0];
      if (!lot) throw new Error(`sell fill ${fill.fillId} exceeded tracked FIFO lots`);
      const fromLot = Math.min(quantityToAllocate, lot.quantity);
      const allocatedMinor = allocateCostBasisMinor(lot.totalCostMinor, lot.quantity, fromLot);
      basisMinor += allocatedMinor;
      lot.quantity -= fromLot;
      lot.totalCostMinor -= allocatedMinor;
      quantityToAllocate -= fromLot;
      if (lot.quantity === 0) openTrade.lots.shift();
    }
    const netProceedsMinor = fill.executionPriceMinor * BigInt(fill.quantity) - fill.feeMinor;
    openTrade.realizedPnlMinor += netProceedsMinor - basisMinor;
    openTrade.positionQuantity -= fill.quantity;
    openTrade.exitFillIds.push(fill.fillId);
    positionQuantity -= fill.quantity;

    if (openTrade.positionQuantity === 0) {
      completedTrades.push(Object.freeze({
        tradeNumber: completedTrades.length + 1,
        openedAtTimestamp: openTrade.openedAtTimestamp,
        closedAtTimestamp: fill.timestamp,
        enteredQuantity: openTrade.enteredQuantity,
        entryFillIds: Object.freeze([...openTrade.entryFillIds]),
        exitFillIds: Object.freeze([...openTrade.exitFillIds]),
        netPnlMinor: openTrade.realizedPnlMinor,
      }));
      openTrade = null;
    }
  }

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let winsTotal = 0n;
  let lossesTotal = 0n;
  let allTradesTotal = 0n;
  for (const trade of completedTrades) {
    allTradesTotal += trade.netPnlMinor;
    if (trade.netPnlMinor > 0n) {
      wins += 1;
      winsTotal += trade.netPnlMinor;
    } else if (trade.netPnlMinor < 0n) {
      losses += 1;
      lossesTotal += trade.netPnlMinor;
    } else {
      breakevens += 1;
    }
  }

  return Object.freeze({
    completedTrades: Object.freeze(completedTrades),
    wins,
    losses,
    breakevens,
    netWinRate: completedTrades.length === 0 ? null : wins / completedTrades.length,
    averageWinPnlMinor: exactAverage(winsTotal, wins),
    averageLossPnlMinor: exactAverage(lossesTotal, losses),
    averageCompleteTradeNetPnlMinor: exactAverage(allTradesTotal, completedTrades.length),
    incompleteTrade: openTrade === null
      ? null
      : Object.freeze({
          openedAtTimestamp: openTrade.openedAtTimestamp,
          positionQuantity: openTrade.positionQuantity,
          realizedPnlMinor: openTrade.realizedPnlMinor,
          entryFillIds: Object.freeze([...openTrade.entryFillIds]),
          exitFillIds: Object.freeze([...openTrade.exitFillIds]),
        }),
    fillFeesMinor,
    filledPositionQuantity: positionQuantity,
    totalRealizedPnlMinor: allTradesTotal + (openTrade?.realizedPnlMinor ?? 0n),
  });
}

export function runPaperSession(
  session: PaperSession,
  inputSha256: string,
  fillRule: SimulatedFillRule = (input) => alwaysFillNextEvent(input),
  strategyOverride?: PaperStrategy,
  researchRiskProfile?: CrossSymbolResearchRiskProfile,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("inputSha256 must be a lowercase SHA-256 digest");
  if (researchRiskProfile && (
    session.asset.currencyCode !== researchRiskProfile.currency
    || session.asset.minorUnit !== "0.01"
    || researchRiskProfile.minorUnitsPerMajor !== 100
    || researchRiskProfile.initialCapitalMinor < 0n
    || researchRiskProfile.maxExposureMinor < 0n
  )) {
    throw new TypeError("cross-symbol research risk profile requires non-negative TWD minor-unit limits");
  }
  const initialCashMinor = researchRiskProfile?.initialCapitalMinor ?? session.simulation.initialCashMinor;
  const riskLimits = researchRiskProfile === undefined
    ? session.simulation.risk
    : Object.freeze({ ...session.simulation.risk, maxExposureMinor: researchRiskProfile.maxExposureMinor });
  let currentTimestamp = 0;
  const clock: Clock & { set(timestamp: number): void } = {
    now: () => currentTimestamp,
    set: (timestamp) => { currentTimestamp = timestamp; },
  };
  const strategy: PaperStrategy = strategyOverride ?? new PriceBandStrategy({
    strategyVersion: STRATEGY_VERSION,
    ...session.simulation.strategy,
  });
  const engine = new PaperTradingEngine({
    symbol: session.asset.symbol,
    initialCashMinor,
    risk: riskLimits,
    terms: session.simulation.terms,
    clock,
    strategy,
    fillRule,
  });

  const eventProcessingResults: EventProcessingResult[] = [];
  for (const event of session.events) {
    clock.set(event.timestamp);
    const result = engine.processMarketEvent(event);
    if (result.status === "rejected") {
      throw new Error(`market event ${event.eventId} rejected: ${result.reasonCode}`);
    }
    eventProcessingResults.push(Object.freeze({
      eventId: event.eventId,
      timestamp: event.timestamp,
      status: result.status,
      ...(result.status === "stale" ? { reasonCode: result.reasonCode } : {}),
    }));
  }

  const account = engine.getSnapshot();
  const trades = summarizeTrades(engine);
  const engineEvents: readonly SimulationEvent[] = engine.getEvents();
  const fillFeesMatch = trades.fillFeesMinor === account.feesPaidMinor;
  const positionsMatch = trades.filledPositionQuantity === account.positionQuantity;
  const realizedPnlMatches = trades.totalRealizedPnlMinor === account.realizedPnlMinor;
  const equityFromPnlMinor = initialCashMinor
    + account.realizedPnlMinor
    + account.unrealizedPnlMinor;
  const equityMatches = equityFromPnlMinor === account.equityMinor;
  if (!fillFeesMatch || !positionsMatch || !realizedPnlMatches || !equityMatches) {
    throw new Error("paper session account reconciliation failed against the engine ledger");
  }

  const timeRange = session.events.reduce<{ startTimestamp: number | null; endTimestamp: number | null }>(
    (range, event) => ({
      startTimestamp: range.startTimestamp === null ? event.timestamp : Math.min(range.startTimestamp, event.timestamp),
      endTimestamp: range.endTimestamp === null ? event.timestamp : Math.max(range.endTimestamp, event.timestamp),
    }),
    { startTimestamp: null, endTimestamp: null },
  );
  const accountReconciliation = Object.freeze({
    fillFeesMatch,
    positionsMatch,
    realizedPnlMatches,
    equityFromPnlMinor,
    equityMatches,
  });

  return Object.freeze({
    classification: "SIMULATION_ONLY",
    schemaVersion: SCHEMA_VERSION,
    dataKind: session.dataKind,
    sourceLabel: session.sourceLabel,
    sourceLabelMeaning: "DECLARATION_ONLY_NOT_INDEPENDENTLY_VERIFIED",
    inputSha256,
    asset: session.asset,
    strategyVersion: strategy.strategyVersion,
    simulationSettings: Object.freeze({
      initialCashMinor,
      risk: riskLimits,
      ...(researchRiskProfile === undefined ? {} : { riskProfileId: researchRiskProfile.id }),
      terms: session.simulation.terms,
      strategy: strategy.strategyParameters ?? session.simulation.strategy,
      fillModel: FILL_MODEL,
    }),
    timeRange: Object.freeze(timeRange),
    eventProcessingResults: Object.freeze(eventProcessingResults),
    journal: engineEvents,
    tradingStatistics: Object.freeze({
      completeTradeCount: trades.completedTrades.length,
      wins: trades.wins,
      losses: trades.losses,
      breakevens: trades.breakevens,
      netWinRate: trades.netWinRate,
      averageWinPnlMinor: trades.averageWinPnlMinor,
      averageLossPnlMinor: trades.averageLossPnlMinor,
      averageCompleteTradeNetPnlMinor: trades.averageCompleteTradeNetPnlMinor,
      completedTrades: trades.completedTrades,
      incompleteTrade: trades.incompleteTrade,
    }),
    accountSummary: account,
    accountReconciliation,
  });
}

export async function runSessionFile(inputPath: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(inputPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`input file is not valid UTF-8 JSON: ${detail}`);
  }
  return runPaperSession(parsePaperSession(parsedJson), digest);
}

function helpText(): string {
  return [
    "Usage: npm run --silent paper:run -- --input <session.json>",
    "",
    "Session JSON fields:",
    '  schemaVersion: 1; dataKind: "SYNTHETIC" | "HISTORICAL"; sourceLabel: string',
    '  asset: { symbol, currencyCode, minorUnit } where minorUnit is an explicit positive decimal such as "0.01"',
    '  simulation: { initialCashMinor, risk, terms, strategy }',
    '  events: [{ eventId, timestamp, symbol, priceMinor }]',
    "  Money and price values are non-negative integer strings in asset.minorUnit.",
    "  timestamp is an integer Unix epoch timestamp in milliseconds; input order is preserved.",
    "",
    "The runner uses the fixed price-band strategy and synthetic next-event full-fill model.",
    "Exact duplicate market events are idempotent; conflicting IDs and out-of-order new events fail.",
    "Input cannot contain strategy answers, fills, or realized forward returns.",
    "HISTORICAL identifies the supplied market data only; sourceLabel is a declaration, not independent verification.",
    "All results are SIMULATION_ONLY. Fees, slippage, and fills are configured simulation assumptions; no live account or broker is used.",
  ].join("\n");
}

function parseCliArguments(args: readonly string[]): { readonly help: boolean; readonly inputPath?: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const inputPath = args[1];
  if (args.length !== 2 || args[0] !== "--input" || inputPath === undefined || inputPath.trim() === "") {
    throw new TypeError("expected --input <session.json>; use --help for the supported format");
  }
  return { help: false, inputPath };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runSessionFile(options.inputPath!);
  stdout.write(`${JSON.stringify(result, jsonReplacer)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown paper session error";
    stderr.write(`paper:run: ${message}\n`);
    process.exitCode = 1;
  });
}
