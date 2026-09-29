import { describe, expect, it } from "vitest";
import { PaperTradingEngine, alwaysFillNextEvent } from "./index.js";
import { runDemoFixture } from "./fixture.js";
import { executionPriceMinor, feeMinorForFill } from "./money.js";
import type {
  Clock,
  ExecutionReport,
  MarketEvent,
  PaperStrategy,
  PaperTradingEngineConfig,
  SimulatedFillRule,
  StrategyInput,
} from "./types.js";

class ManualClock implements Clock {
  private current = 0;

  now(): number {
    return this.current;
  }

  set(timestamp: number): void {
    this.current = timestamp;
  }
}

type Target = number | ((input: StrategyInput) => number);

interface HarnessOptions {
  readonly target?: Target;
  readonly strategy?: PaperStrategy;
  readonly fillRule?: SimulatedFillRule;
  readonly initialCashMinor?: bigint;
  readonly maxPositionQuantity?: number;
  readonly maxExposureMinor?: bigint;
  readonly maxMarketAgeMs?: number;
  readonly feeBps?: number;
  readonly slippageBps?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new ManualClock();
  const target = options.target ?? 0;
  const strategy = options.strategy ?? {
    strategyVersion: "test-fixed-v1",
    decide: (input: StrategyInput) => typeof target === "function" ? target(input) : target,
  };
  const config: PaperTradingEngineConfig = {
    symbol: "SYNTH",
    initialCashMinor: options.initialCashMinor ?? 100_000n,
    risk: {
      maxPositionQuantity: options.maxPositionQuantity ?? 10,
      maxExposureMinor: options.maxExposureMinor ?? 1_000_000n,
      maxMarketAgeMs: options.maxMarketAgeMs ?? 1_000,
    },
    terms: {
      label: "SYNTHETIC_ONLY",
      feeBps: options.feeBps ?? 0,
      slippageBps: options.slippageBps ?? 0,
    },
    clock,
    strategy,
    fillRule: options.fillRule ?? ((input) => alwaysFillNextEvent(input)),
  };
  return { clock, engine: new PaperTradingEngine(config) };
}

function quote(eventId: string, timestamp: number, priceMinor = 1_000n): MarketEvent {
  return { eventId, timestamp, symbol: "SYNTH", priceMinor };
}

function send(
  harness: ReturnType<typeof createHarness>,
  event: MarketEvent,
  clockTimestamp = event.timestamp,
) {
  harness.clock.set(clockTimestamp);
  return harness.engine.processMarketEvent(event);
}

function makeSequenceStrategy(targets: readonly number[]): PaperStrategy {
  let index = 0;
  return {
    strategyVersion: "sequence-test-v1",
    decide: () => {
      const target = targets[Math.min(index, targets.length - 1)] ?? 0;
      index += 1;
      return target;
    },
  };
}

describe("paper trading execution loop", () => {
  it("keeps decisions prefix-only and leaves a final-event order pending", () => {
    const seenHistory: string[][] = [];
    const strategy: PaperStrategy = {
      strategyVersion: "history-test-v1",
      decide: (input) => {
        seenHistory.push(input.history.map((event) => event.eventId));
        return input.current.priceMinor <= 1_000n ? 1 : input.positionQuantity;
      },
    };
    const first = createHarness({ strategy });
    send(first, quote("q0", 0, 1_000n));
    expect(seenHistory[0]).toEqual([]);
    expect(first.engine.getOrders()[0]).toMatchObject({ status: "pending", quantity: 1, filledQuantity: 0 });
    expect(first.engine.getFills()).toHaveLength(0);
    expect(first.engine.getSnapshot()).toMatchObject({
      cashMinor: 100_000n,
      reservedCashMinor: 1_000n,
      availableCashMinor: 99_000n,
      equityMinor: 100_000n,
    });

    const runPrefix = (futurePrice: bigint) => {
      const harness = createHarness({ target: (input) => input.positionQuantity === 0 ? 1 : input.positionQuantity });
      send(harness, quote("same-0", 0, 1_000n));
      send(harness, quote("same-1", 1, 1_000n));
      send(harness, quote("future", 2, futurePrice));
      return harness.engine.getDecisions().slice(0, 2);
    };
    expect(runPrefix(500n)).toEqual(runPrefix(50_000n));
  });

  it("produces the same events and account summary from the fixed fixture", () => {
    const first = runDemoFixture();
    const second = runDemoFixture();
    expect(first.outcomes.every((result) => result.status === "accepted")).toBe(true);
    expect(first.engine.getEvents()).toEqual(second.engine.getEvents());
    expect(first.engine.getSnapshot()).toEqual(second.engine.getSnapshot());
    expect(first.engine.getSnapshot()).toMatchObject({
      cashMinor: 100_092n,
      positionQuantity: 0,
      feesPaidMinor: 187n,
      realizedPnlMinor: 92n,
      unrealizedPnlMinor: 0n,
      equityMinor: 100_092n,
    });
  });

  it("deduplicates replayed market and fill events and rejects conflicting identities without ledger changes", () => {
    const harness = createHarness({ target: 2 });
    const firstQuote = quote("replay-0", 0);
    expect(send(harness, firstQuote).status).toBe("accepted");
    const afterFirst = harness.engine.getSnapshot();
    const eventCount = harness.engine.getEvents().length;
    expect(send(harness, firstQuote).status).toBe("duplicate");
    expect(send(harness, quote("replay-0", 0, 1_001n))).toMatchObject({
      status: "rejected",
      reasonCode: "EVENT_ID_CONFLICT",
    });
    expect(harness.engine.getEvents()).toHaveLength(eventCount);
    expect(harness.engine.getSnapshot()).toEqual(afterFirst);

    send(harness, quote("replay-1", 1));
    const fill = harness.engine.getFills()[0];
    expect(fill).toBeDefined();
    const afterFill = harness.engine.getSnapshot();
    const afterFillEvents = harness.engine.getEvents().length;
    expect(harness.engine.acceptExecutionReport(fill!).status).toBe("duplicate");
    expect(harness.engine.acceptExecutionReport({ ...fill!, quantity: 1 })).toMatchObject({
      status: "rejected",
      reasonCode: "FILL_ID_CONFLICT",
    });
    expect(harness.engine.getEvents()).toHaveLength(afterFillEvents);
    expect(harness.engine.getSnapshot()).toEqual(afterFill);
  });

  it("rejects an overfill report without changing cash, position, or fill history", () => {
    const harness = createHarness({ target: 1, fillRule: () => ({ kind: "no-fill" }) });
    send(harness, quote("overfill-0", 0));
    send(harness, quote("overfill-1", 1));
    const order = harness.engine.getSnapshot().activeOrder!;
    const report: ExecutionReport = {
      fillId: "too-large",
      clientOrderId: order.clientOrderId,
      marketEventId: "overfill-1",
      timestamp: 1,
      quantity: 2,
      executionPriceMinor: 1_000n,
      feeMinor: 0n,
    };
    const before = harness.engine.getSnapshot();
    const eventCount = harness.engine.getEvents().length;
    expect(harness.engine.acceptExecutionReport(report)).toMatchObject({
      status: "rejected",
      reasonCode: "FILL_EXCEEDS_REMAINING",
    });
    expect(harness.engine.getSnapshot()).toEqual(before);
    expect(harness.engine.getFills()).toHaveLength(0);
    expect(harness.engine.getEvents()).toHaveLength(eventCount);
    expect(harness.engine.acceptExecutionReport({ ...report, quantity: 1 })).toMatchObject({
      status: "rejected",
      reasonCode: "FILL_ID_CONFLICT",
    });
    expect(harness.engine.getSnapshot()).toEqual(before);
    expect(harness.engine.getFills()).toHaveLength(0);
    expect(harness.engine.getEvents()).toHaveLength(eventCount);
  });

  it("updates partial fills and cancellation remaining quantity and releases the reserve", () => {
    const harness = createHarness({
      target: 3,
      initialCashMinor: 10_000n,
      feeBps: 100,
      fillRule: ({ market }) => market.eventId === "partial-1"
        ? { kind: "fill", fillId: "partial-fill-1", quantity: 1 }
        : { kind: "no-fill" },
    });
    send(harness, quote("partial-0", 0));
    send(harness, quote("partial-1", 1));
    const partial = harness.engine.getOrders()[0]!;
    expect(partial).toMatchObject({ status: "partially-filled", filledQuantity: 1, remainingQuantity: 2 });
    expect(harness.engine.getSnapshot()).toMatchObject({ positionQuantity: 1, reservedCashMinor: 2_020n, feesPaidMinor: 10n });

    harness.clock.set(1);
    const cancel = { eventId: "cancel-partial", timestamp: 1, clientOrderId: partial.clientOrderId };
    expect(harness.engine.cancelOrder(cancel).status).toBe("accepted");
    const cancelled = harness.engine.getOrders()[0]!;
    expect(cancelled).toMatchObject({ status: "cancelled", filledQuantity: 1, remainingQuantity: 2 });
    expect(harness.engine.getSnapshot()).toMatchObject({ reservedCashMinor: 0n, feesPaidMinor: 10n });
    const eventCount = harness.engine.getEvents().length;
    expect(harness.engine.cancelOrder(cancel).status).toBe("duplicate");
    expect(harness.engine.getEvents()).toHaveLength(eventCount);
  });

  it("records simulated rejection and releases the unfilled order reserve", () => {
    const harness = createHarness({
      strategy: makeSequenceStrategy([2, 0]),
      fillRule: () => ({ kind: "reject", reasonCode: "SYNTHETIC_VENUE_REJECT" }),
    });
    send(harness, quote("reject-0", 0));
    expect(harness.engine.getSnapshot().reservedCashMinor).toBe(2_000n);
    send(harness, quote("reject-1", 1));
    expect(harness.engine.getOrders()[0]).toMatchObject({
      status: "rejected",
      filledQuantity: 0,
      remainingQuantity: 2,
      rejectionReason: "SYNTHETIC_VENUE_REJECT",
    });
    expect(harness.engine.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 0n });
  });

  it("rejects stale quotes before strategy or execution and validates available funds and position caps", () => {
    let calls = 0;
    const strategy: PaperStrategy = {
      strategyVersion: "stale-check-v1",
      decide: () => {
        calls += 1;
        return 1;
      },
    };
    const staleHarness = createHarness({ strategy, maxMarketAgeMs: 10, fillRule: () => ({ kind: "fill", fillId: "should-not-fill", quantity: 1 }) });
    send(staleHarness, quote("fresh-0", 0));
    expect(send(staleHarness, quote("stale-1", 100), 1_000)).toMatchObject({
      status: "stale",
      reasonCode: "STALE_MARKET",
    });
    expect(calls).toBe(1);
    expect(staleHarness.engine.getFills()).toHaveLength(0);
    expect(staleHarness.engine.getSnapshot().activeOrder?.status).toBe("pending");

    const cashHarness = createHarness({ target: 1, initialCashMinor: 999n });
    send(cashHarness, quote("cash-0", 0));
    expect(cashHarness.engine.getOrders()[0]).toMatchObject({ status: "rejected", rejectionReason: "INSUFFICIENT_FUNDS" });
    expect(cashHarness.engine.getSnapshot()).toMatchObject({ cashMinor: 999n, positionQuantity: 0, reservedCashMinor: 0n });

    const positionHarness = createHarness({ target: 3, maxPositionQuantity: 2 });
    send(positionHarness, quote("position-0", 0));
    expect(positionHarness.engine.getOrders()[0]).toMatchObject({ status: "rejected", rejectionReason: "MAX_POSITION_EXCEEDED" });
  });

  it("cancels a pending buy when marked pending exposure exceeds the cap", () => {
    const harness = createHarness({
      target: 3,
      maxPositionQuantity: 4,
      maxExposureMinor: 3_000n,
      fillRule: () => ({ kind: "no-fill" }),
    });
    send(harness, quote("exposure-0", 0, 1_000n));
    expect(harness.engine.getSnapshot().reservedCashMinor).toBe(3_000n);
    send(harness, quote("exposure-1", 1, 1_100n));
    expect(harness.engine.getOrders()).toMatchObject([
      { status: "cancelled", rejectionReason: "PENDING_EXPOSURE_LIMIT", remainingQuantity: 3 },
      { status: "rejected", rejectionReason: "MAX_EXPOSURE_EXCEEDED" },
    ]);
    expect(harness.engine.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 0n });
  });

  it("includes configured buy slippage in exposure checks before creating an order", () => {
    const harness = createHarness({
      target: 1,
      maxExposureMinor: 1_005n,
      slippageBps: 100,
    });
    send(harness, quote("slippage-exposure", 0, 1_000n));
    expect(harness.engine.getOrders()[0]).toMatchObject({
      status: "rejected",
      rejectionReason: "MAX_EXPOSURE_EXCEEDED",
    });
    expect(harness.engine.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 0n });
  });

  it("HALT cancels pending buys, blocks new exposure, stays latched, and allows a reduction", () => {
    const pending = createHarness({ target: 2, fillRule: () => ({ kind: "no-fill" }) });
    send(pending, quote("halt-buy-0", 0));
    pending.clock.set(0);
    expect(pending.engine.halt({ eventId: "halt-buy", timestamp: 0, reason: "test halt" }).status).toBe("accepted");
    expect(pending.engine.getOrders()[0]).toMatchObject({ status: "cancelled", remainingQuantity: 2 });
    expect(pending.engine.getSnapshot()).toMatchObject({ halted: true, reservedCashMinor: 0n });
    send(pending, quote("halt-buy-1", 1));
    expect(pending.engine.getOrders()[1]).toMatchObject({ status: "rejected", rejectionReason: "HALTED" });
    expect(pending.engine.getSnapshot().halted).toBe(true);

    const reducing = createHarness({
      strategy: makeSequenceStrategy([2, 2, 0, 0]),
      feeBps: 0,
      slippageBps: 0,
    });
    send(reducing, quote("halt-reduce-0", 0));
    send(reducing, quote("halt-reduce-1", 1));
    reducing.clock.set(1);
    expect(reducing.engine.halt({ eventId: "halt-reduce", timestamp: 1, reason: "test halt" }).status).toBe("accepted");
    send(reducing, quote("halt-reduce-2", 2));
    expect(reducing.engine.getOrders()[1]).toMatchObject({ side: "sell", status: "pending", quantity: 2 });
    send(reducing, quote("halt-reduce-3", 3));
    expect(reducing.engine.getSnapshot()).toMatchObject({ halted: true, positionQuantity: 0, activeOrder: null });
    expect(reducing.engine.getFills().map((fill) => fill.quantity)).toEqual([2, 2]);
  });

  it("reconciles integer fees, slippage, FIFO basis, realized and unrealized P&L, and equity", () => {
    const harness = createHarness({
      strategy: makeSequenceStrategy([2, 1, 1]),
      initialCashMinor: 100_000n,
      maxPositionQuantity: 4,
      maxExposureMinor: 50_000n,
      feeBps: 100,
      slippageBps: 100,
    });
    send(harness, quote("account-0", 0, 10_000n));
    send(harness, quote("account-1", 1, 11_000n));
    send(harness, quote("account-2", 2, 12_000n));
    const account = harness.engine.getSnapshot();
    expect(harness.engine.getFills().map((fill) => [fill.executionPriceMinor, fill.feeMinor])).toEqual([
      [11_110n, 223n],
      [11_880n, 119n],
    ]);
    expect(account).toMatchObject({
      cashMinor: 89_318n,
      reservedCashMinor: 0n,
      positionQuantity: 1,
      positionCostBasisMinor: 11_222n,
      realizedPnlMinor: 540n,
      unrealizedPnlMinor: 778n,
      feesPaidMinor: 342n,
      equityMinor: 101_318n,
    });
    expect(account.equityMinor - 100_000n).toBe(account.realizedPnlMinor + account.unrealizedPnlMinor);
  });

  it("does not expose or allow mutation of the independent risk configuration through strategy input", () => {
    let sawRisk = true;
    const strategy: PaperStrategy = {
      strategyVersion: "isolated-risk-v1",
      decide: (input) => {
        sawRisk = "risk" in input || "riskLimits" in input;
        return 2;
      },
    };
    const harness = createHarness({ strategy, maxPositionQuantity: 1 });
    send(harness, quote("risk-isolation", 0));
    expect(sawRisk).toBe(false);
    expect(Object.isFrozen(harness.engine.riskLimits)).toBe(true);
    expect(harness.engine.getOrders()[0]).toMatchObject({ status: "rejected", rejectionReason: "MAX_POSITION_EXCEEDED" });
  });

  it("uses explicit minor-unit rounding for execution price and per-fill fees", () => {
    expect(executionPriceMinor("buy", 10_001n, 1)).toBe(10_003n);
    expect(executionPriceMinor("sell", 10_001n, 1)).toBe(9_999n);
    expect(feeMinorForFill(10_001n, 1, 1)).toBe(2n);
  });

  it("rejects malformed or non-monotonic market input without adding ledger events", () => {
    const harness = createHarness({ target: 0 });
    const countBefore = harness.engine.getEvents().length;
    expect(send(harness, quote("bad-price", 0, 0n))).toMatchObject({ status: "rejected", reasonCode: "INVALID_PRICE" });
    expect(send(harness, quote("valid", 1)).status).toBe("accepted");
    const countAfterValid = harness.engine.getEvents().length;
    expect(send(harness, quote("out-of-order", 1))).toMatchObject({ status: "rejected", reasonCode: "NON_MONOTONIC_MARKET_EVENT" });
    expect(harness.engine.getEvents()).toHaveLength(countAfterValid);
    expect(countAfterValid).toBeGreaterThan(countBefore);
  });
});
