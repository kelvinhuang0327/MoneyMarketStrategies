import type { PaperStrategy, StrategyInput } from "./types.js";
import { ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY } from "./strategy.js";

export const ROLLING_ZSCORE_MEAN_REVERSION_V1 = "ROLLING_ZSCORE_MEAN_REVERSION_V1" as const;
export const ROLLING_ZSCORE_MEAN_REVERSION_V1_STRATEGY_VERSION = "rolling-zscore-mean-reversion-v1" as const;

export interface RollingZScoreMeanReversionV1Config {
  readonly lookback: number;
  readonly entryZ: number;
  readonly exitZ: number;
  readonly maxHoldBars: number;
  readonly activeFromTimestamp?: number;
}

/** Population z-score for the trailing closes ending at the current event. */
export function rollingCloseZScore(
  history: StrategyInput["history"],
  currentPriceMinor: bigint,
  lookback: number,
): number | null {
  if (!Number.isSafeInteger(lookback) || lookback <= 0) {
    throw new RangeError("lookback must be a positive safe integer");
  }
  if (typeof currentPriceMinor !== "bigint" || currentPriceMinor <= 0n) {
    throw new RangeError("current close must be a positive integer in minor units");
  }

  const trailing = lookback === 1 ? [] : history.slice(-(lookback - 1));
  if (trailing.length + 1 < lookback) return null;

  const closes = [...trailing.map(({ priceMinor }) => Number(priceMinor)), Number(currentPriceMinor)];
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) {
    throw new RangeError("trailing closes must be positive finite numbers in minor units");
  }
  const mean = closes.reduce((sum, close) => sum + close, 0) / lookback;
  const squaredDeviationSum = closes.reduce((sum, close) => sum + (close - mean) ** 2, 0);
  const standardDeviation = Math.sqrt(squaredDeviationSum / lookback);
  if (standardDeviation === 0) return null;
  return (closes.at(-1)! - mean) / standardDeviation;
}

/** Close-only long/cash strategy using causal rolling population z-scores. */
export class RollingZScoreMeanReversionV1Strategy implements PaperStrategy {
  readonly strategyVersion = ROLLING_ZSCORE_MEAN_REVERSION_V1_STRATEGY_VERSION;
  readonly strategyParameters: Readonly<Record<string, string | number | boolean>>;
  private readonly lookback: number;
  private readonly entryZ: number;
  private readonly exitZ: number;
  private readonly maxHoldBars: number;
  private readonly activeFromTimestamp: number;
  private heldTradingBars = 0;
  private wasLong = false;

  constructor(config: RollingZScoreMeanReversionV1Config) {
    if (!Number.isSafeInteger(config.lookback) || config.lookback <= 0) {
      throw new RangeError("lookback must be a positive safe integer");
    }
    if (!Number.isFinite(config.entryZ) || config.entryZ <= 0) {
      throw new RangeError("entryZ must be a positive finite number");
    }
    if (!Number.isFinite(config.exitZ) || config.exitZ >= config.entryZ) {
      throw new RangeError("exitZ must be a finite number below entryZ");
    }
    if (!Number.isSafeInteger(config.maxHoldBars) || config.maxHoldBars <= 0) {
      throw new RangeError("maxHoldBars must be a positive safe integer");
    }
    const activeFromTimestamp = config.activeFromTimestamp ?? Number.MIN_SAFE_INTEGER;
    if (!Number.isSafeInteger(activeFromTimestamp)) {
      throw new RangeError("activeFromTimestamp must be a safe integer");
    }

    this.lookback = config.lookback;
    this.entryZ = config.entryZ;
    this.exitZ = config.exitZ;
    this.maxHoldBars = config.maxHoldBars;
    this.activeFromTimestamp = activeFromTimestamp;
    this.strategyParameters = Object.freeze({
      lookback: config.lookback,
      entryZ: config.entryZ,
      exitZ: config.exitZ,
      maxHoldBars: config.maxHoldBars,
      targetQuantity: ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY,
    });
  }

  decide(input: StrategyInput): number {
    if (input.current.timestamp < this.activeFromTimestamp) {
      this.resetPositionState();
      return 0;
    }

    const zScore = rollingCloseZScore(input.history, input.current.priceMinor, this.lookback);
    if (input.positionQuantity <= 0) {
      this.resetPositionState();
      return zScore !== null && zScore <= -this.entryZ
        ? ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY
        : 0;
    }

    this.heldTradingBars = this.wasLong ? this.heldTradingBars + 1 : 1;
    this.wasLong = true;
    if (this.heldTradingBars >= this.maxHoldBars || (zScore !== null && zScore >= this.exitZ)) return 0;
    return input.positionQuantity;
  }

  private resetPositionState(): void {
    this.heldTradingBars = 0;
    this.wasLong = false;
  }
}
