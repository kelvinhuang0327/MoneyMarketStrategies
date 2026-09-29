import { PaperTradingEngine } from "./engine.js";
import { alwaysFillNextEvent, PriceBandStrategy } from "./strategy.js";
import type { Clock, MarketEvent, OperationResult } from "./types.js";

class FixtureClock implements Clock {
  private timestamp = 0;

  now(): number {
    return this.timestamp;
  }

  set(timestamp: number): void {
    this.timestamp = timestamp;
  }
}

export const PAPER_TRADING_FIXTURE: readonly MarketEvent[] = Object.freeze([
  Object.freeze({ eventId: "fixture-001", timestamp: 1_000, symbol: "SYNTH", priceMinor: 10_000n }),
  Object.freeze({ eventId: "fixture-002", timestamp: 2_000, symbol: "SYNTH", priceMinor: 10_200n }),
  Object.freeze({ eventId: "fixture-003", timestamp: 3_000, symbol: "SYNTH", priceMinor: 11_000n }),
  Object.freeze({ eventId: "fixture-004", timestamp: 4_000, symbol: "SYNTH", priceMinor: 10_500n }),
]);

export function runDemoFixture(): {
  readonly engine: PaperTradingEngine;
  readonly outcomes: readonly OperationResult[];
} {
  const clock = new FixtureClock();
  const engine = new PaperTradingEngine({
    symbol: "SYNTH",
    initialCashMinor: 100_000n,
    risk: {
      maxPositionQuantity: 4,
      maxExposureMinor: 50_000n,
      maxMarketAgeMs: 5_000,
    },
    terms: {
      label: "SYNTHETIC_ONLY",
      feeBps: 30,
      slippageBps: 100,
    },
    clock,
    strategy: new PriceBandStrategy({
      strategyVersion: "price-band-fixed-v1",
      entryAtOrBelowMinor: 10_000n,
      exitAtOrAboveMinor: 11_000n,
      targetQuantity: 3,
    }),
    fillRule: (input) => alwaysFillNextEvent(input),
  });

  const outcomes = PAPER_TRADING_FIXTURE.map((event) => {
    clock.set(event.timestamp);
    return engine.processMarketEvent(event);
  });
  return { engine, outcomes: Object.freeze(outcomes) };
}
