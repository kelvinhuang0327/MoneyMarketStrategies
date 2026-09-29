import { allocateCostBasisMinor, executionPriceMinor, feeMinorForFill, reservedBuyCashMinor } from "./money.js";
import { buyFillRiskReason, pendingBuyRiskReason, targetRiskReason, validateRiskLimits } from "./risk.js";
import type {
  AccountSnapshot,
  CancelRequest,
  DecisionRecord,
  ExecutionReport,
  FillRuleDecision,
  HaltRequest,
  MarketEvent,
  MarketObservation,
  OperationResult,
  OrderSide,
  OrderStatus,
  PaperOrder,
  PaperTradingEngineConfig,
  RiskLimits,
  SimulationEvent,
  SyntheticTradingTerms,
} from "./types.js";

interface MutableOrder {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  referencePriceMinor: bigint;
  createdAt: number;
  createdEventId: string;
  status: OrderStatus;
  rejectionReason?: string;
}

interface Lot {
  quantity: number;
  totalCostMinor: bigint;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function safeQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function marketCanonical(event: MarketEvent): string {
  return JSON.stringify(["market", event.eventId, event.timestamp, event.symbol, event.priceMinor.toString()]);
}

function orderCopy(order: MutableOrder): PaperOrder {
  const copy: MutableOrder = { ...order };
  return Object.freeze(copy);
}

function operation(status: "accepted" | "duplicate"): OperationResult {
  return Object.freeze({ status });
}

function rejected(reasonCode: string): OperationResult {
  return Object.freeze({ status: "rejected", reasonCode });
}

function projectedPosition(order: MutableOrder, position: number): number {
  return order.side === "buy"
    ? position + order.remainingQuantity
    : position - order.remainingQuantity;
}

/** Single-symbol, long-only deterministic execution and cash/position ledger. */
export class PaperTradingEngine {
  readonly symbol: string;
  readonly strategyVersion: string;
  readonly terms: SyntheticTradingTerms;
  readonly riskLimits: RiskLimits;

  private cashMinor: bigint;
  private positionQuantity = 0;
  private realizedPnlMinor = 0n;
  private feesPaidMinor = 0n;
  private readonly lots: Lot[] = [];
  private readonly orders: MutableOrder[] = [];
  private readonly ordersById = new Map<string, MutableOrder>();
  private activeOrder: MutableOrder | null = null;
  private readonly fills: ExecutionReport[] = [];
  private readonly fillCanonicalById = new Map<string, { canonical: string; result: OperationResult }>();
  private readonly decisions: DecisionRecord[] = [];
  private readonly events: SimulationEvent[] = [];
  private readonly inputCanonicalById = new Map<string, string>();
  private readonly freshMarketsById = new Map<string, MarketObservation>();
  private readonly history: MarketObservation[] = [];
  private currentMark: MarketObservation | null = null;
  private lastMarketTimestamp: number | null = null;
  private halted = false;
  private readonly clock: PaperTradingEngineConfig["clock"];
  private readonly strategy: PaperTradingEngineConfig["strategy"];
  private readonly fillRule: PaperTradingEngineConfig["fillRule"];

  constructor(config: PaperTradingEngineConfig) {
    if (!nonEmpty(config.symbol)) throw new TypeError("symbol is required");
    if (config.initialCashMinor < 0n) throw new RangeError("initial cash must be non-negative");
    if (!nonEmpty(config.strategy.strategyVersion)) throw new TypeError("strategyVersion is required");
    if (!config.clock || typeof config.clock.now !== "function") throw new TypeError("an injected clock is required");
    if (typeof config.fillRule !== "function") throw new TypeError("an injected fill rule is required");
    validateRiskLimits(config.risk);
    if (config.terms.label !== "SYNTHETIC_ONLY") throw new TypeError("trading terms must be labeled SYNTHETIC_ONLY");
    if (!Number.isSafeInteger(config.terms.feeBps) || config.terms.feeBps < 0 || config.terms.feeBps > 10_000) {
      throw new RangeError("feeBps must be an integer from 0 through 10000");
    }
    if (!Number.isSafeInteger(config.terms.slippageBps) || config.terms.slippageBps < 0 || config.terms.slippageBps >= 10_000) {
      throw new RangeError("slippageBps must be an integer from 0 through 9999");
    }
    this.symbol = config.symbol;
    this.cashMinor = config.initialCashMinor;
    this.riskLimits = Object.freeze({ ...config.risk });
    this.terms = Object.freeze({ ...config.terms });
    this.strategyVersion = config.strategy.strategyVersion;
    this.clock = config.clock;
    this.strategy = config.strategy;
    this.fillRule = config.fillRule;
  }

  processMarketEvent(event: MarketEvent): OperationResult {
    if (!event || !nonEmpty(event.eventId)) return rejected("INVALID_EVENT_ID");
    if (!safeTimestamp(event.timestamp)) return rejected("INVALID_TIMESTAMP");
    if (event.symbol !== this.symbol) return rejected("SYMBOL_MISMATCH");
    if (typeof event.priceMinor !== "bigint" || event.priceMinor <= 0n) return rejected("INVALID_PRICE");

    const canonical = marketCanonical(event);
    const replay = this.checkInputReplay(event.eventId, canonical);
    if (replay) return replay;
    if (this.lastMarketTimestamp !== null && event.timestamp <= this.lastMarketTimestamp) {
      return rejected("NON_MONOTONIC_MARKET_EVENT");
    }
    const now = this.readClock();
    if (now === null) return rejected("INVALID_CLOCK");
    if (event.timestamp > now) return rejected("FUTURE_MARKET_EVENT");

    this.inputCanonicalById.set(event.eventId, canonical);
    this.lastMarketTimestamp = event.timestamp;
    const observation = Object.freeze({
      eventId: event.eventId,
      timestamp: event.timestamp,
      symbol: event.symbol,
      priceMinor: event.priceMinor,
    });
    const ageMs = BigInt(now) - BigInt(event.timestamp);
    if (ageMs > BigInt(this.riskLimits.maxMarketAgeMs)) {
      this.events.push(Object.freeze({
        eventId: `market/${encode(event.eventId)}`,
        timestamp: event.timestamp,
        kind: "market",
        sourceEventId: event.eventId,
        symbol: event.symbol,
        priceMinor: event.priceMinor,
        status: "stale",
        reasonCode: "STALE_MARKET",
      }));
      return { status: "stale", reasonCode: "STALE_MARKET" };
    }

    this.freshMarketsById.set(event.eventId, observation);
    this.currentMark = observation;
    this.events.push(Object.freeze({
      eventId: `market/${encode(event.eventId)}`,
      timestamp: event.timestamp,
      kind: "market",
      sourceEventId: event.eventId,
      symbol: event.symbol,
      priceMinor: event.priceMinor,
      status: "fresh",
    }));

    this.processActiveOrderAt(observation);
    this.processStrategyDecision(observation);
    this.history.push(observation);
    return operation("accepted");
  }

  acceptExecutionReport(report: ExecutionReport): OperationResult {
    if (!report || !nonEmpty(report.fillId)) return rejected("INVALID_FILL_ID");
    if (!nonEmpty(report.clientOrderId) || !nonEmpty(report.marketEventId)) return rejected("INVALID_FILL_REFERENCE");
    if (!safeTimestamp(report.timestamp)) return rejected("INVALID_FILL_TIMESTAMP");
    if (!safeQuantity(report.quantity) || report.quantity === 0) return rejected("INVALID_FILL_QUANTITY");
    if (typeof report.executionPriceMinor !== "bigint" || report.executionPriceMinor <= 0n) return rejected("INVALID_FILL_PRICE");
    if (typeof report.feeMinor !== "bigint" || report.feeMinor < 0n) return rejected("INVALID_FILL_FEE");

    const canonical = JSON.stringify([
      report.fillId,
      report.clientOrderId,
      report.marketEventId,
      report.timestamp,
      report.quantity,
      report.executionPriceMinor.toString(),
      report.feeMinor.toString(),
    ]);
    const prior = this.fillCanonicalById.get(report.fillId);
    if (prior !== undefined) {
      if (prior.canonical !== canonical) return rejected("FILL_ID_CONFLICT");
      return prior.result.status === "accepted" ? operation("duplicate") : prior.result;
    }

    const order = this.ordersById.get(report.clientOrderId);
    if (!order || !this.isActive(order)) return this.rejectFill(report.fillId, canonical, "ORDER_NOT_ACTIVE");
    const market = this.freshMarketsById.get(report.marketEventId);
    if (!market) return this.rejectFill(report.fillId, canonical, "FILL_MARKET_NOT_FOUND");
    if (this.currentMark?.eventId !== market.eventId) return this.rejectFill(report.fillId, canonical, "FILL_MARKET_NOT_CURRENT");
    if (report.timestamp !== market.timestamp || market.timestamp <= order.createdAt) {
      return this.rejectFill(report.fillId, canonical, "FILL_NOT_AFTER_ORDER");
    }
    if (report.quantity > order.remainingQuantity) return this.rejectFill(report.fillId, canonical, "FILL_EXCEEDS_REMAINING");

    const expectedExecutionPrice = executionPriceMinor(order.side, market.priceMinor, this.terms.slippageBps);
    const expectedFee = feeMinorForFill(expectedExecutionPrice, report.quantity, this.terms.feeBps);
    if (report.executionPriceMinor !== expectedExecutionPrice || report.feeMinor !== expectedFee) {
      return this.rejectFill(report.fillId, canonical, "FILL_TERMS_MISMATCH");
    }

    const notionalMinor = report.executionPriceMinor * BigInt(report.quantity);
    const totalBuyCostMinor = notionalMinor + report.feeMinor;
    const remainingAfter = order.remainingQuantity - report.quantity;
    if (order.side === "buy") {
      const cashAfterFill = this.cashMinor - totalBuyCostMinor;
      const riskReason = buyFillRiskReason({
        postFillPosition: this.positionQuantity + report.quantity,
        fillQuantity: report.quantity,
        remainingPendingQuantity: remainingAfter,
        markPriceMinor: market.priceMinor,
        executionPriceMinor: report.executionPriceMinor,
        cashAfterFillMinor: cashAfterFill,
        limits: this.riskLimits,
        terms: this.terms,
      });
      if (riskReason) return this.rejectFill(report.fillId, canonical, riskReason);
    } else {
      if (report.quantity > this.positionQuantity) return this.rejectFill(report.fillId, canonical, "FILL_EXCEEDS_POSITION");
      if (remainingAfter > this.positionQuantity - report.quantity) return this.rejectFill(report.fillId, canonical, "FILL_EXCEEDS_POSITION");
      if (report.feeMinor > notionalMinor) return this.rejectFill(report.fillId, canonical, "FILL_FEE_EXCEEDS_PROCEEDS");
    }

    const acceptedReport = Object.freeze({ ...report });
    if (order.side === "buy") {
      this.cashMinor -= totalBuyCostMinor;
      this.positionQuantity += report.quantity;
      this.lots.push({ quantity: report.quantity, totalCostMinor: totalBuyCostMinor });
    } else {
      const netProceedsMinor = notionalMinor - report.feeMinor;
      const basisMinor = this.consumeLots(report.quantity);
      this.cashMinor += netProceedsMinor;
      this.positionQuantity -= report.quantity;
      this.realizedPnlMinor += netProceedsMinor - basisMinor;
    }
    this.feesPaidMinor += report.feeMinor;
    order.filledQuantity += report.quantity;
    order.remainingQuantity = remainingAfter;
    order.status = remainingAfter === 0 ? "filled" : "partially-filled";
    if (remainingAfter === 0) this.activeOrder = null;
    this.fillCanonicalById.set(report.fillId, { canonical, result: operation("accepted") });
    this.fills.push(acceptedReport);
    this.events.push(Object.freeze({
      eventId: `fill/${encode(report.fillId)}`,
      timestamp: report.timestamp,
      kind: "fill",
      fillId: report.fillId,
      clientOrderId: report.clientOrderId,
      sourceMarketEventId: report.marketEventId,
      side: order.side,
      quantity: report.quantity,
      executionPriceMinor: report.executionPriceMinor,
      feeMinor: report.feeMinor,
    }));
    this.recordOrder(order, report.timestamp, report.marketEventId, order.status);
    return operation("accepted");
  }

  cancelOrder(request: CancelRequest): OperationResult {
    if (!request || !nonEmpty(request.eventId)) return rejected("INVALID_EVENT_ID");
    if (!safeTimestamp(request.timestamp)) return rejected("INVALID_TIMESTAMP");
    if (!nonEmpty(request.clientOrderId)) return rejected("INVALID_ORDER_ID");
    const canonical = JSON.stringify(["cancel", request.eventId, request.timestamp, request.clientOrderId]);
    const replay = this.checkInputReplay(request.eventId, canonical);
    if (replay) return replay;
    const timeReason = this.validateControlTime(request.timestamp);
    if (timeReason) return rejected(timeReason);
    this.inputCanonicalById.set(request.eventId, canonical);

    if (!this.activeOrder || this.activeOrder.clientOrderId !== request.clientOrderId) {
      this.events.push(Object.freeze({
        eventId: `cancel/${encode(request.eventId)}`,
        timestamp: request.timestamp,
        kind: "cancel",
        sourceEventId: request.eventId,
        clientOrderId: request.clientOrderId,
        status: "rejected",
        reasonCode: "ORDER_NOT_ACTIVE",
      }));
      return rejected("ORDER_NOT_ACTIVE");
    }
    this.events.push(Object.freeze({
      eventId: `cancel/${encode(request.eventId)}`,
      timestamp: request.timestamp,
      kind: "cancel",
      sourceEventId: request.eventId,
      clientOrderId: request.clientOrderId,
      status: "cancelled",
      reasonCode: "CANCEL_REQUESTED",
    }));
    this.cancelActive(request.timestamp, request.eventId, "CANCEL_REQUESTED");
    return operation("accepted");
  }

  halt(request: HaltRequest): OperationResult {
    if (!request || !nonEmpty(request.eventId)) return rejected("INVALID_EVENT_ID");
    if (!safeTimestamp(request.timestamp)) return rejected("INVALID_TIMESTAMP");
    if (!nonEmpty(request.reason)) return rejected("INVALID_HALT_REASON");
    const canonical = JSON.stringify(["halt", request.eventId, request.timestamp, request.reason]);
    const replay = this.checkInputReplay(request.eventId, canonical);
    if (replay) return replay;
    const timeReason = this.validateControlTime(request.timestamp);
    if (timeReason) return rejected(timeReason);
    this.inputCanonicalById.set(request.eventId, canonical);
    this.events.push(Object.freeze({
      eventId: `halt/${encode(request.eventId)}`,
      timestamp: request.timestamp,
      kind: "halt",
      sourceEventId: request.eventId,
      reason: request.reason,
    }));
    this.halted = true;
    if (this.activeOrder?.side === "buy") {
      this.cancelActive(request.timestamp, request.eventId, "HALTED_CANCELLED_BUY_REMAINDER");
    }
    return operation("accepted");
  }

  getSnapshot(): AccountSnapshot {
    const reservedCashMinor = this.activeOrder?.side === "buy"
      ? reservedBuyCashMinor(
          this.activeOrder.remainingQuantity,
          this.currentMark?.priceMinor ?? this.activeOrder.referencePriceMinor,
          this.terms.slippageBps,
          this.terms.feeBps,
        )
      : 0n;
    const markPriceMinor = this.currentMark?.priceMinor ?? null;
    const marketValueMinor = markPriceMinor === null ? 0n : markPriceMinor * BigInt(this.positionQuantity);
    const positionCostBasisMinor = this.lots.reduce((sum, lot) => sum + lot.totalCostMinor, 0n);
    const activeOrder = this.activeOrder ? orderCopy(this.activeOrder) : null;
    return Object.freeze({
      symbol: this.symbol,
      cashMinor: this.cashMinor,
      reservedCashMinor,
      availableCashMinor: this.cashMinor - reservedCashMinor,
      positionQuantity: this.positionQuantity,
      markPriceMinor,
      positionCostBasisMinor,
      realizedPnlMinor: this.realizedPnlMinor,
      unrealizedPnlMinor: marketValueMinor - positionCostBasisMinor,
      feesPaidMinor: this.feesPaidMinor,
      equityMinor: this.cashMinor + marketValueMinor,
      halted: this.halted,
      activeOrder,
    });
  }

  getOrders(): readonly PaperOrder[] {
    return Object.freeze(this.orders.map(orderCopy));
  }

  getFills(): readonly ExecutionReport[] {
    return Object.freeze(this.fills.map((fill) => Object.freeze({ ...fill })));
  }

  getDecisions(): readonly DecisionRecord[] {
    return Object.freeze(this.decisions.map((decision) => Object.freeze({ ...decision })));
  }

  getEvents(): readonly SimulationEvent[] {
    return Object.freeze(this.events.map((event) => Object.freeze({ ...event })));
  }

  private processActiveOrderAt(market: MarketObservation): void {
    const order = this.activeOrder;
    if (!order) return;
    if (order.side === "buy") {
      const pendingReason = pendingBuyRiskReason({
        positionQuantity: this.positionQuantity,
        pendingQuantity: order.remainingQuantity,
        markPriceMinor: market.priceMinor,
        cashMinor: this.cashMinor,
        limits: this.riskLimits,
        terms: this.terms,
      });
      if (pendingReason) {
        this.cancelActive(market.timestamp, market.eventId, pendingReason);
        return;
      }
    } else if (order.remainingQuantity > this.positionQuantity) {
      this.cancelActive(market.timestamp, market.eventId, "PENDING_POSITION_LIMIT");
      return;
    }

    let fillDecision: FillRuleDecision;
    try {
      fillDecision = this.fillRule({ order: orderCopy(order), market: Object.freeze({ ...market }) });
    } catch {
      order.status = "rejected";
      order.rejectionReason = "FILL_RULE_ERROR";
      this.activeOrder = null;
      this.recordOrder(order, market.timestamp, market.eventId, "FILL_RULE_ERROR");
      return;
    }
    if (!fillDecision || typeof fillDecision !== "object") {
      order.status = "rejected";
      order.rejectionReason = "INVALID_FILL_RULE_RESULT";
      this.activeOrder = null;
      this.recordOrder(order, market.timestamp, market.eventId, "INVALID_FILL_RULE_RESULT");
      return;
    }
    if (fillDecision.kind === "no-fill") {
      this.recordOrder(order, market.timestamp, market.eventId, "NO_FILL_THIS_EVENT");
      return;
    }
    if (fillDecision.kind === "reject") {
      const reasonCode = nonEmpty(fillDecision.reasonCode) ? fillDecision.reasonCode : "SIMULATED_REJECTION";
      order.status = "rejected";
      order.rejectionReason = reasonCode;
      this.activeOrder = null;
      this.recordOrder(order, market.timestamp, market.eventId, reasonCode);
      return;
    }
    if (fillDecision.kind !== "fill" || !nonEmpty(fillDecision.fillId) || !safeQuantity(fillDecision.quantity) || fillDecision.quantity === 0) {
      order.status = "rejected";
      order.rejectionReason = "INVALID_FILL_RULE_RESULT";
      this.activeOrder = null;
      this.recordOrder(order, market.timestamp, market.eventId, "INVALID_FILL_RULE_RESULT");
      return;
    }
    const execution = executionPriceMinor(order.side, market.priceMinor, this.terms.slippageBps);
    const report: ExecutionReport = {
      fillId: fillDecision.fillId,
      clientOrderId: order.clientOrderId,
      marketEventId: market.eventId,
      timestamp: market.timestamp,
      quantity: fillDecision.quantity,
      executionPriceMinor: execution,
      feeMinor: feeMinorForFill(execution, fillDecision.quantity, this.terms.feeBps),
    };
    const fillResult = this.acceptExecutionReport(report);
    if (fillResult.status === "rejected" && this.isFillTimeRiskReason(fillResult.reasonCode)) {
      this.cancelActive(market.timestamp, market.eventId, fillResult.reasonCode);
    }
  }

  private processStrategyDecision(market: MarketObservation): void {
    const input = Object.freeze({
      current: Object.freeze({ ...market }),
      history: Object.freeze(this.history.map((item) => Object.freeze({ ...item }))),
      positionQuantity: this.positionQuantity,
    });
    let target: number;
    try {
      target = this.strategy.decide(input);
    } catch {
      this.recordDecision(market, null, "risk-rejected", "STRATEGY_ERROR");
      return;
    }
    if (!safeQuantity(target)) {
      this.recordDecision(market, null, "risk-rejected", "INVALID_TARGET_QUANTITY");
      return;
    }

    const order = this.activeOrder;
    const targetChanged = order !== null && projectedPosition(order, this.positionQuantity) !== target;
    if (order && !targetChanged) {
      this.recordDecision(market, target, "no-trade", "PENDING_ORDER_MATCHES_TARGET");
      return;
    }

    const currentPosition = this.positionQuantity;
    const side: OrderSide | null = target > currentPosition ? "buy" : target < currentPosition ? "sell" : null;
    if (side === null) {
      this.recordDecision(market, target, "no-trade", targetChanged ? "TARGET_UNCHANGED" : "NO_POSITION_CHANGE");
      if (targetChanged && order) this.cancelActive(market.timestamp, market.eventId, "STRATEGY_TARGET_CHANGED");
      return;
    }

    const quantity = Math.abs(target - currentPosition);
    const reservedCash = this.activeOrder && !targetChanged
      ? this.currentReservedCashMinor()
      : 0n;
    const riskReason = targetRiskReason({
      targetQuantity: target,
      currentPosition,
      markPriceMinor: market.priceMinor,
      cashMinor: this.cashMinor,
      reservedCashMinor: reservedCash,
      halted: this.halted,
      limits: this.riskLimits,
      terms: this.terms,
    });
    const reasonCode = riskReason ?? "ORDER_ACCEPTED";
    this.recordDecision(market, target, riskReason ? "risk-rejected" : "order-submitted", reasonCode);
    if (targetChanged && order) this.cancelActive(market.timestamp, market.eventId, "STRATEGY_TARGET_CHANGED");

    const clientOrderId = `co:${encode(this.strategyVersion)}:${encode(market.eventId)}`;
    const newOrder: MutableOrder = {
      clientOrderId,
      symbol: this.symbol,
      side,
      quantity,
      filledQuantity: 0,
      remainingQuantity: quantity,
      referencePriceMinor: market.priceMinor,
      createdAt: market.timestamp,
      createdEventId: market.eventId,
      status: riskReason ? "rejected" : "pending",
      ...(riskReason ? { rejectionReason: riskReason } : {}),
    };
    this.orders.push(newOrder);
    this.ordersById.set(clientOrderId, newOrder);
    if (!riskReason) this.activeOrder = newOrder;
    this.recordOrder(newOrder, market.timestamp, market.eventId, riskReason ?? "ORDER_ACCEPTED");
  }

  private recordDecision(
    market: MarketObservation,
    target: number | null,
    status: DecisionRecord["status"],
    reasonCode: string,
  ): void {
    const decision: DecisionRecord = Object.freeze({
      eventId: `decision/${encode(market.eventId)}`,
      timestamp: market.timestamp,
      sourceEventId: market.eventId,
      strategyVersion: this.strategyVersion,
      currentPositionQuantity: this.positionQuantity,
      targetPositionQuantity: target,
      status,
      reasonCode,
    });
    this.decisions.push(decision);
    this.events.push(Object.freeze({ kind: "decision", ...decision }));
  }

  private recordOrder(order: MutableOrder, timestamp: number, sourceEventId: string, reasonCode?: string): void {
    this.events.push(Object.freeze({
      eventId: `order-state/${encode(order.clientOrderId)}/${encode(sourceEventId)}/${order.status}`,
      timestamp,
      kind: "order",
      sourceEventId,
      clientOrderId: order.clientOrderId,
      status: order.status,
      side: order.side,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
      ...(reasonCode ? { reasonCode } : {}),
    }));
  }

  private cancelActive(timestamp: number, sourceEventId: string, reasonCode: string): void {
    const order = this.activeOrder;
    if (!order) return;
    order.status = "cancelled";
    order.rejectionReason = reasonCode;
    this.activeOrder = null;
    this.recordOrder(order, timestamp, sourceEventId, reasonCode);
  }

  private checkInputReplay(eventId: string, canonical: string): OperationResult | null {
    const previous = this.inputCanonicalById.get(eventId);
    if (previous === undefined) return null;
    return previous === canonical ? operation("duplicate") : rejected("EVENT_ID_CONFLICT");
  }

  private rejectFill(fillId: string, canonical: string, reasonCode: string): OperationResult {
    const result = rejected(reasonCode);
    this.fillCanonicalById.set(fillId, { canonical, result });
    return result;
  }

  private validateControlTime(timestamp: number): string | null {
    const now = this.readClock();
    if (now === null) return "INVALID_CLOCK";
    if (timestamp > now) return "FUTURE_CONTROL_EVENT";
    if (this.lastMarketTimestamp !== null && timestamp < this.lastMarketTimestamp) return "NON_MONOTONIC_CONTROL_EVENT";
    return null;
  }

  private readClock(): number | null {
    try {
      const value = this.clock.now();
      return safeTimestamp(value) ? value : null;
    } catch {
      return null;
    }
  }

  private currentReservedCashMinor(): bigint {
    if (!this.activeOrder || this.activeOrder.side !== "buy") return 0n;
    return reservedBuyCashMinor(
      this.activeOrder.remainingQuantity,
      this.currentMark?.priceMinor ?? this.activeOrder.referencePriceMinor,
      this.terms.slippageBps,
      this.terms.feeBps,
    );
  }

  private isActive(order: MutableOrder): boolean {
    return order.status === "pending" || order.status === "partially-filled";
  }

  private isFillTimeRiskReason(reasonCode: string | undefined): reasonCode is string {
    return reasonCode === "INSUFFICIENT_FUNDS_AT_FILL"
      || reasonCode === "FILL_POSITION_LIMIT"
      || reasonCode === "FILL_EXPOSURE_LIMIT";
  }

  private consumeLots(quantity: number): bigint {
    let left = quantity;
    let costBasisMinor = 0n;
    while (left > 0) {
      const lot = this.lots[0];
      if (!lot) throw new Error("position lot ledger is inconsistent with holdings");
      const soldFromLot = Math.min(left, lot.quantity);
      const allocated = allocateCostBasisMinor(lot.totalCostMinor, lot.quantity, soldFromLot);
      lot.quantity -= soldFromLot;
      lot.totalCostMinor -= allocated;
      costBasisMinor += allocated;
      left -= soldFromLot;
      if (lot.quantity === 0) this.lots.shift();
    }
    return costBasisMinor;
  }
}
