import { createHash } from "node:crypto";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  evaluateZScoreCrossSymbolForward,
  validateRiskNormalizedFrozenSelection,
  ZSCORE_FORWARD_SYMBOLS,
} from "./zscoreCrossSymbolForwardEvaluator.js";
import {
  createFrozenMeanReversionStrategy,
  loadFrozenCrossSymbolChallenger,
} from "./crossSymbolWinRateValidationV1.js";
import { RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import { ZSCORE_HISTORICAL_CUTOFF } from "./zscoreWinRateSelector.js";
import type { MarketObservation, PaperStrategy, StrategyInput } from "./types.js";

/** Only seeds indicator history. No warmup orders, positions, fees or PnL. */
export function withPriorHistoryV2(
  strategy: PaperStrategy,
  seed: readonly MarketObservation[],
  cutoff: number,
  symbol: string,
): PaperStrategy {
  let previous = -Infinity;
  const history = seed.map((event) => {
    if (
      event.symbol !== symbol ||
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp > cutoff ||
      event.timestamp <= previous ||
      event.priceMinor <= 0n
    ) {
      throw new TypeError(
        "warmup must be strictly ordered, same-symbol and at/before cutoff",
      );
    }
    previous = event.timestamp;
    return Object.freeze({ ...event });
  });
  return {
    strategyVersion: `${strategy.strategyVersion}-prior-history-v2`,
    ...(strategy.strategyParameters === undefined ? {} : { strategyParameters: strategy.strategyParameters }),
    decide(input: StrategyInput): number {
      if (input.current.timestamp <= cutoff || input.current.symbol !== symbol) {
        throw new TypeError("evaluation must be after cutoff and same-symbol");
      }
      let last = cutoff;
      for (const event of input.history) {
        if (
          event.symbol !== symbol ||
          event.timestamp <= last ||
          event.timestamp >= input.current.timestamp
        ) {
          throw new TypeError("non-causal evaluation history");
        }
        last = event.timestamp;
      }
      return strategy.decide({ ...input, history: [...history, ...input.history] });
    },
  };
}

/** Retrospective protocol-v2 diagnostic, never overwrites or replaces frozen v1 evidence. */
export function evaluateZScoreForwardWarmupV2(
  input: Parameters<typeof evaluateZScoreCrossSymbolForward>[0] & {
    readonly warmupCsv: string;
  },
) {
  const frozenV1 = evaluateZScoreCrossSymbolForward(input); // Preserve all v1 input/provenance checks.
  const selection = validateRiskNormalizedFrozenSelection(input.frozenSelectionArtifact);
  const legacy = loadFrozenCrossSymbolChallenger(input.legacyReferenceArtifact);
  const cutoff = Date.parse(`${ZSCORE_HISTORICAL_CUTOFF}T13:30:00+08:00`);
  const freshCsv = new TextDecoder("utf-8", { fatal: true }).decode(input.freshDataBytes);
  const warmupHash = createHash("sha256").update(input.warmupCsv).digest("hex");
  const inputHash = createHash("sha256").update(input.freshDataBytes).update(warmupHash).digest("hex");
  const perSymbol = ZSCORE_FORWARD_SYMBOLS.map((symbol) => {
    const warmup = parseHistoricalCsv(
      input.warmupCsv,
      symbol,
      "warmup-v2",
      "twse-daily-ohlcv-close-v1",
    );
    const fresh = parseHistoricalCsv(
      freshCsv,
      symbol,
      "fresh-v2",
      "twse-daily-ohlcv-close-v1",
    );
    const seed = warmup.session.events;
    if (seed.length < selection.parameters.lookback - 1) {
      throw new TypeError(`insufficient warmup for ${symbol}`);
    }
    const evaluate = (strategy: PaperStrategy) =>
      runPaperSession(
        fresh.session,
        inputHash,
        undefined,
        withPriorHistoryV2(strategy, seed, cutoff, symbol),
        input.researchRiskProfile,
      );
    return {
      symbol,
      warmupRows: seed.length,
      freshRows: fresh.rowCount,
      legacy: evaluate(createFrozenMeanReversionStrategy(legacy)),
      challenger: evaluate(
        new RollingZScoreMeanReversionV1Strategy(selection.parameters),
      ),
    };
  });
  return {
    evaluatorVersion: "PRIOR_HISTORY_V2_DIAGNOSTIC",
    evidenceStatus: "RETROSPECTIVE_PROTOCOL_CHANGE_NOT_NEW_FORWARD_EVIDENCE",
    tradingWinRateImprovement: "NOT_ESTABLISHED",
    warmupSha256: warmupHash,
    frozenV1,
    perSymbol,
  };
}
