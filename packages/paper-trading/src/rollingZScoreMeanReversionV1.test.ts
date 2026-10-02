import { describe, expect, it } from "vitest";
import { PaperTradingEngine, RollingZScoreMeanReversionV1Strategy, alwaysFillNextEvent, rollingCloseZScore } from "./index.js";
import type { Clock, MarketEvent, PaperStrategy, StrategyInput } from "./types.js";

class TestClock implements Clock {
  private timestamp = 0;

  now(): number {
    return this.timestamp;
  }

  set(timestamp: number): void {
    this.timestamp = timestamp;
  }
}

function input(
  currentPriceMinor: bigint,
  historyPricesMinor: readonly bigint[],
  positionQuantity = 0,
  timestamp = historyPricesMinor.length + 1,
): StrategyInput {
  const history = historyPricesMinor.map((priceMinor, index) => Object.freeze({
    eventId: `history-${index}`,
    timestamp: index + 1,
    symbol: "SYNTH",
    priceMinor,
  }));
  return Object.freeze({
    current: Object.freeze({ eventId: `current-${timestamp}`, timestamp, symbol: "SYNTH", priceMinor: currentPriceMinor }),
    history: Object.freeze(history),
    positionQuantity,
    positionEntryExecutionNotionalMinor: 0n,
  });
}

function makeStrategy(overrides: Partial<ConstructorParameters<typeof RollingZScoreMeanReversionV1Strategy>[0]> = {}) {
  return new RollingZScoreMeanReversionV1Strategy({
    lookback: 2,
    entryZ: 0.75,
    exitZ: 0,
    maxHoldBars: 10,
    ...overrides,
  });
}

function engineWith(strategy: PaperStrategy) {
  const clock = new TestClock();
  const engine = new PaperTradingEngine({
    symbol: "SYNTH",
    initialCashMinor: 1_000_000n,
    risk: { maxPositionQuantity: 4, maxExposureMinor: 1_000_000n, maxMarketAgeMs: 1_000_000 },
    terms: { label: "SYNTHETIC_ONLY", feeBps: 0, slippageBps: 0 },
    clock,
    strategy,
    fillRule: (value) => alwaysFillNextEvent(value),
  });
  return { clock, engine };
}

function send(harness: ReturnType<typeof engineWith>, index: number, priceMinor: bigint): void {
  const event: MarketEvent = { eventId: `event-${index}`, timestamp: index + 1, symbol: "SYNTH", priceMinor };
  harness.clock.set(event.timestamp);
  expect(harness.engine.processMarketEvent(event).status).toBe("accepted");
}

describe("ROLLING_ZSCORE_MEAN_REVERSION_V1", () => {
  it("uses exactly the trailing closes through t and population standard deviation", () => {
    const withOlderHistory = rollingCloseZScore(input(8_000n, [99_999n, 10_000n, 10_000n]).history, 8_000n, 3);
    const withoutOlderHistory = rollingCloseZScore(input(8_000n, [10_000n, 10_000n]).history, 8_000n, 3);
    expect(withOlderHistory).toBeCloseTo(-Math.sqrt(2), 12);
    expect(withoutOlderHistory).toBe(withOlderHistory);
  });

  it("returns no entry signal before lookback observations or when standard deviation is zero", () => {
    expect(makeStrategy({ lookback: 3 }).decide(input(8_000n, [10_000n]))).toBe(0);
    expect(rollingCloseZScore(input(10_000n, [10_000n]).history, 10_000n, 2)).toBeNull();
    expect(makeStrategy().decide(input(10_000n, [10_000n]))).toBe(0);
  });

  it("does not let later closes change earlier decisions", () => {
    const decisionsFor = (later: readonly bigint[]) => {
      const harness = engineWith(makeStrategy());
      send(harness, 0, 10_000n);
      send(harness, 1, 8_000n);
      later.forEach((price, index) => send(harness, index + 2, price));
      return harness.engine.getDecisions().slice(0, 2);
    };
    expect(decisionsFor([8_000n, 5_000n])).toEqual(decisionsFor([50_000n, 1_000n]));
  });

  it("keeps a triggered order pending until the next market event", () => {
    const harness = engineWith(makeStrategy());
    send(harness, 0, 10_000n);
    send(harness, 1, 8_000n);
    expect(harness.engine.getDecisions().at(-1)).toMatchObject({ targetPositionQuantity: 3, status: "order-submitted" });
    expect(harness.engine.getFills()).toHaveLength(0);
    send(harness, 2, 8_000n);
    expect(harness.engine.getFills()).toHaveLength(1);
    expect(harness.engine.getFills()[0]?.timestamp).toBeGreaterThan(harness.engine.getOrders()[0]!.createdAt);
  });

  it("exits at the configured z-score or held-bar limit", () => {
    const zExit = engineWith(makeStrategy({ exitZ: 0, maxHoldBars: 10 }));
    send(zExit, 0, 10_000n);
    send(zExit, 1, 8_000n);
    send(zExit, 2, 8_000n);
    send(zExit, 3, 9_500n);
    expect(zExit.engine.getOrders().at(-1)).toMatchObject({ side: "sell", createdAt: 4 });
    send(zExit, 4, 9_500n);
    expect(zExit.engine.getSnapshot().positionQuantity).toBe(0);

    const holdExit = engineWith(makeStrategy({ exitZ: -10, maxHoldBars: 2 }));
    send(holdExit, 0, 10_000n);
    send(holdExit, 1, 8_000n);
    send(holdExit, 2, 8_000n);
    send(holdExit, 3, 8_000n);
    expect(holdExit.engine.getOrders().at(-1)).toMatchObject({ side: "sell", createdAt: 4 });
    send(holdExit, 4, 8_000n);
    expect(holdExit.engine.getFills().map(({ timestamp }) => timestamp)).toEqual([3, 5]);
  });
});
