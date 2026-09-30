import type { PaperStrategy, StrategyInput } from "./types.js";

export const ROLLING_MEAN_REVERSION_V1 = "ROLLING_MEAN_REVERSION_V1" as const;
export const ROLLING_MEAN_REVERSION_V1_STRATEGY_VERSION = "rolling-mean-reversion-v1" as const;
export const ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY = 3 as const;
const BASIS_POINTS = 10_000n;

export interface PriceBandStrategyConfig {
  readonly strategyVersion: string;
  readonly entryAtOrBelowMinor: bigint;
  readonly exitAtOrAboveMinor: bigint;
  readonly targetQuantity: number;
}

/** Fixed, transparent test strategy. It receives only current/past prices and current holdings. */
export class PriceBandStrategy implements PaperStrategy {
  readonly strategyVersion: string;
  private readonly entryAtOrBelowMinor: bigint;
  private readonly exitAtOrAboveMinor: bigint;
  private readonly targetQuantity: number;

  constructor(config: PriceBandStrategyConfig) {
    if (config.strategyVersion.trim() === "") throw new TypeError("strategyVersion is required");
    if (config.entryAtOrBelowMinor <= 0n || config.exitAtOrAboveMinor <= config.entryAtOrBelowMinor) {
      throw new RangeError("price bands must be positive and exit must be above entry");
    }
    if (!Number.isSafeInteger(config.targetQuantity) || config.targetQuantity < 0) {
      throw new RangeError("targetQuantity must be a non-negative safe integer");
    }
    this.strategyVersion = config.strategyVersion;
    this.entryAtOrBelowMinor = config.entryAtOrBelowMinor;
    this.exitAtOrAboveMinor = config.exitAtOrAboveMinor;
    this.targetQuantity = config.targetQuantity;
    Object.freeze(this);
  }

  decide(input: StrategyInput): number {
    if (input.current.priceMinor <= this.entryAtOrBelowMinor) return this.targetQuantity;
    if (input.current.priceMinor >= this.exitAtOrAboveMinor) return 0;
    return input.positionQuantity;
  }
}

export interface RollingMeanReversionV1Config {
  readonly lookback: number;
  readonly entryDiscountBps: number;
  readonly takeProfitBps: number;
  readonly maxHoldBars: number;
  readonly activeFromTimestamp?: number;
}

/** Causal close-only long/cash strategy with one fixed-size position at a time. */
export class RollingMeanReversionV1Strategy implements PaperStrategy {
  readonly strategyVersion = ROLLING_MEAN_REVERSION_V1_STRATEGY_VERSION;
  readonly strategyParameters: Readonly<Record<string, string | number | boolean>>;
  private readonly lookback: number;
  private readonly entryDiscountBps: number;
  private readonly takeProfitBps: number;
  private readonly maxHoldBars: number;
  private readonly activeFromTimestamp: number;
  private heldTradingBars = 0;
  private wasLong = false;

  constructor(config: RollingMeanReversionV1Config) {
    if (!Number.isSafeInteger(config.lookback) || config.lookback <= 0) {
      throw new RangeError("lookback must be a positive safe integer");
    }
    if (!Number.isSafeInteger(config.entryDiscountBps) || config.entryDiscountBps <= 0 || config.entryDiscountBps >= 10_000) {
      throw new RangeError("entryDiscountBps must be an integer between 1 and 9999");
    }
    if (!Number.isSafeInteger(config.takeProfitBps) || config.takeProfitBps <= 0 || config.takeProfitBps >= 10_000) {
      throw new RangeError("takeProfitBps must be an integer between 1 and 9999");
    }
    if (!Number.isSafeInteger(config.maxHoldBars) || config.maxHoldBars <= 0) {
      throw new RangeError("maxHoldBars must be a positive safe integer");
    }
    const activeFromTimestamp = config.activeFromTimestamp ?? Number.MIN_SAFE_INTEGER;
    if (!Number.isSafeInteger(activeFromTimestamp)) {
      throw new RangeError("activeFromTimestamp must be a safe integer");
    }

    this.lookback = config.lookback;
    this.entryDiscountBps = config.entryDiscountBps;
    this.takeProfitBps = config.takeProfitBps;
    this.maxHoldBars = config.maxHoldBars;
    this.activeFromTimestamp = activeFromTimestamp;
    this.strategyParameters = Object.freeze({
      lookback: config.lookback,
      entryDiscount: config.entryDiscountBps / Number(BASIS_POINTS),
      takeProfit: config.takeProfitBps / Number(BASIS_POINTS),
      maxHoldBars: config.maxHoldBars,
      targetQuantity: ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY,
    });
  }

  decide(input: StrategyInput): number {
    if (input.current.timestamp < this.activeFromTimestamp) {
      this.resetPositionState();
      return 0;
    }

    if (input.positionQuantity <= 0) {
      this.resetPositionState();
      const trailing = this.lookback === 1 ? [] : input.history.slice(-(this.lookback - 1));
      if (trailing.length + 1 < this.lookback) return 0;
      const closeSum = trailing.reduce((sum, event) => sum + event.priceMinor, input.current.priceMinor);
      const scaledCurrent = input.current.priceMinor * BigInt(this.lookback) * BASIS_POINTS;
      const discountedAverage = closeSum * (BASIS_POINTS - BigInt(this.entryDiscountBps));
      return scaledCurrent <= discountedAverage ? ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY : 0;
    }

    this.heldTradingBars = this.wasLong ? this.heldTradingBars + 1 : 1;
    this.wasLong = true;
    if (input.positionEntryExecutionNotionalMinor <= 0n) {
      throw new Error("an open position must have positive entry execution notional");
    }
    const takeProfitReached = input.current.priceMinor * BigInt(input.positionQuantity) * BASIS_POINTS
      >= input.positionEntryExecutionNotionalMinor * (BASIS_POINTS + BigInt(this.takeProfitBps));
    if (takeProfitReached || this.heldTradingBars >= this.maxHoldBars) return 0;
    return input.positionQuantity;
  }

  private resetPositionState(): void {
    this.heldTradingBars = 0;
    this.wasLong = false;
  }
}

export function alwaysFillNextEvent(input: {
  readonly order: { readonly clientOrderId: string; readonly remainingQuantity: number };
  readonly market: { readonly eventId: string };
}): { readonly kind: "fill"; readonly fillId: string; readonly quantity: number } {
  return {
    kind: "fill",
    fillId: `${input.order.clientOrderId}:fill:${encodeURIComponent(input.market.eventId)}`,
    quantity: input.order.remainingQuantity,
  };
}
