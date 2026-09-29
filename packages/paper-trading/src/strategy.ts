import type { PaperStrategy, StrategyInput } from "./types.js";

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
