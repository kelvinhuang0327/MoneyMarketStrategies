import { executionPriceMinor, feeMinorForFill } from "./money.js";
import { RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import type { RollingZScoreMeanReversionV1Config } from "./zscoreStrategy.js";
import type { PaperStrategy, StrategyInput } from "./types.js";

export interface CostCoveredZScoreExitV1Config extends RollingZScoreMeanReversionV1Config {
  readonly feeBps: number;
  readonly slippageBps: number;
}

/** One change to the frozen z-score baseline: gate discretionary exits on known cost.
 * Quote-time full-fill proceeds are an estimate, never a promise about the next fill.
 * No dividend/tax credit is assumed. Max-hold exits remain unconditional.
 */
export class CostCoveredZScoreExitV1Strategy implements PaperStrategy {
  readonly strategyVersion = "cost-covered-zscore-exit-v1";
  readonly strategyParameters: Readonly<Record<string, string | number | boolean>>;
  private readonly baseline: RollingZScoreMeanReversionV1Strategy;
  private heldBars = 0;
  private readonly counts = { discretionarySignals: 0, costCovered: 0, belowCost: 0, unknownCost: 0, forcedExits: 0 };

  constructor(private readonly config: CostCoveredZScoreExitV1Config) {
    this.baseline = new RollingZScoreMeanReversionV1Strategy(config);
    if (!Number.isSafeInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 10_000
      || !Number.isSafeInteger(config.slippageBps) || config.slippageBps < 0 || config.slippageBps >= 10_000) {
      throw new RangeError("fee/slippage must be valid integer basis points");
    }
    this.config = Object.freeze({ ...config });
    this.strategyParameters = Object.freeze({
      ...this.baseline.strategyParameters, feeBps: config.feeBps, slippageBps: config.slippageBps,
      discretionaryExitRequiresEstimatedCostCoverage: true,
    });
  }

  getDiagnostics(): Readonly<typeof this.counts> { return Object.freeze({ ...this.counts }); }

  decide(input: StrategyInput): number {
    const target = this.baseline.decide(input);
    if (input.current.timestamp < (this.config.activeFromTimestamp ?? Number.MIN_SAFE_INTEGER)
      || input.positionQuantity <= 0) {
      this.heldBars = 0;
      return target;
    }
    this.heldBars += 1;
    if (target !== 0) return target;
    if (this.heldBars >= this.config.maxHoldBars) {
      this.counts.forcedExits += 1;
      return 0;
    }
    this.counts.discretionarySignals += 1;
    const basis = input.positionCostBasisMinor;
    if (basis === undefined || typeof basis !== "bigint" || basis <= 0n) {
      this.counts.unknownCost += 1;
      return input.positionQuantity;
    }
    const price = executionPriceMinor("sell", input.current.priceMinor, this.config.slippageBps);
    const net = price * BigInt(input.positionQuantity) - feeMinorForFill(price, input.positionQuantity, this.config.feeBps);
    if (net < basis) {
      this.counts.belowCost += 1;
      return input.positionQuantity;
    }
    this.counts.costCovered += 1;
    return 0;
  }
}
