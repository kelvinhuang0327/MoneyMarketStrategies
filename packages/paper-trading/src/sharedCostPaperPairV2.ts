import { PaperTradingEngine } from "./engine.js";
import { CostCoveredZScoreExitV2Strategy } from "./costCoveredZScoreExitV2.js";
import { freezePaperCostModelV2 } from "./paperCostModelV2.js";
import { RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import type { RollingZScoreMeanReversionV1Config } from "./zscoreStrategy.js";
import type { PaperCostModelV2, PaperTradingEngineConfig, SyntheticTradingTerms } from "./types.js";

/** Offline paper engines only. Both arms receive the exact same immutable costs,
 * slippage, initial cash and risk limits; candidate reads terms from its engine.
 * Does not open a durable journal, execute a gateway or fetch market data.
 */
export function createSharedCostPaperPairV2(config: Omit<PaperTradingEngineConfig, "strategy" | "terms"> & {
  readonly strategyConfig: RollingZScoreMeanReversionV1Config;
  readonly costModel: PaperCostModelV2;
  readonly slippageBps: number;
}) {
  const terms: SyntheticTradingTerms = Object.freeze({ label: "SYNTHETIC_ONLY", feeBps: 0,
    slippageBps: config.slippageBps, costModel: freezePaperCostModelV2(config.costModel) });
  const common = { symbol: config.symbol, initialCashMinor: config.initialCashMinor,
    risk: config.risk, clock: config.clock, fillRule: config.fillRule, terms };
  return Object.freeze({
    baseline: new PaperTradingEngine({ ...common, strategy: new RollingZScoreMeanReversionV1Strategy(config.strategyConfig) }),
    candidate: new PaperTradingEngine({ ...common, strategy: new CostCoveredZScoreExitV2Strategy(config.strategyConfig) }),
    terms,
  });
}
