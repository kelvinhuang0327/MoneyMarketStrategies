import { executionPriceMinor } from "./money.js";
import { paperFillCostsV2 } from "./paperCostModelV2.js";
import { RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import type { RollingZScoreMeanReversionV1Config } from "./zscoreStrategy.js";
import type { PaperStrategy, StrategyInput } from "./types.js";

export type CostCoveredZScoreExitV2Config = RollingZScoreMeanReversionV1Config;

/** One change to the frozen z-score baseline: gate discretionary exits on known cost.
 * Quote-time full-fill proceeds are an estimate, never a promise about the next fill.
 * Sell tax and commission share the engine model. No dividend credit is assumed.
 * A full-fill quote estimate can understate fees if actual fills split into reports.
 * Max-hold exits remain unconditional, including exits below entry cost.
 */
export class CostCoveredZScoreExitV2Strategy implements PaperStrategy {
  readonly strategyVersion = "cost-covered-zscore-exit-shared-cost-v2";
  readonly strategyParameters: Readonly<Record<string, string | number | boolean>>;
  private readonly baseline: RollingZScoreMeanReversionV1Strategy;
  private heldBars = 0;
  private readonly counts = { discretionarySignals: 0, costCovered: 0, belowCost: 0, unknownCost: 0, forcedExits: 0 };

  constructor(private readonly config: CostCoveredZScoreExitV2Config) {
    this.baseline = new RollingZScoreMeanReversionV1Strategy(config);
    this.config = Object.freeze({ ...config });
    this.strategyParameters = Object.freeze({
      ...this.baseline.strategyParameters,
      costSource: "ENGINE_OWNED_SHARED_COST_MODEL_V2",
      exitEstimateFillAssumption: "ONE_FULL_EXECUTION_REPORT",
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
    const terms = input.paperTradingTerms;
    if (basis === undefined || typeof basis !== "bigint" || basis <= 0n || !terms?.costModel) {
      this.counts.unknownCost += 1;
      return input.positionQuantity;
    }
    const price = executionPriceMinor("sell", input.current.priceMinor, terms.slippageBps);
    const net = price * BigInt(input.positionQuantity) - paperFillCostsV2("sell", price, input.positionQuantity, terms.costModel).totalFeeMinor;
    if (net < basis) {
      this.counts.belowCost += 1;
      return input.positionQuantity;
    }
    this.counts.costCovered += 1;
    return 0;
  }
}
