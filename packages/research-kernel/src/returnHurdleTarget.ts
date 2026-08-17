import { buildHistoricalFeatureRows } from "./features.js";
import { fail, type FeatureRow, type MarketDataRow } from "./types.js";

export const CANONICAL_TRANSACTION_COST_BPS = 10 as const;
export const CANONICAL_ROUND_TRIP_COST_FRACTION = 0.001 as const;
export const TARGET_CONTROL_RULE = "forwardReturn > 0" as const;
export const TARGET_CHALLENGER_RULE = "forwardReturn > canonicalRoundTripCostFraction" as const;

export function deriveRoundTripCostFraction(roundTripCostBps: number): number {
  if (!Number.isFinite(roundTripCostBps) || roundTripCostBps < 0 || roundTripCostBps > 10_000) {
    fail(`roundTripCostBps must be a finite number in [0, 10000]: ${roundTripCostBps}`);
  }
  return roundTripCostBps / 10_000;
}

export function buildReturnHurdleFeatureRows(
  rows: readonly FeatureRow[],
  hurdleFraction: number = CANONICAL_ROUND_TRIP_COST_FRACTION,
): readonly FeatureRow[] {
  if (!Number.isFinite(hurdleFraction)) {
    fail(`hurdleFraction must be a finite number: ${hurdleFraction}`);
  }
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        symbol: row.symbol,
        featureDate: row.featureDate,
        targetDate: row.targetDate,
        featureSourceStartDate: row.featureSourceStartDate,
        featureSourceEndDate: row.featureSourceEndDate,
        features: row.features,
        target: row.forwardReturn > hurdleFraction ? (1 as const) : (0 as const),
        forwardReturn: row.forwardReturn,
      }),
    ),
  );
}

export function buildHistoricalReturnHurdleFeatureRows(
  rows: readonly MarketDataRow[],
  hurdleFraction: number = CANONICAL_ROUND_TRIP_COST_FRACTION,
): readonly FeatureRow[] {
  const baseFeatureRows = buildHistoricalFeatureRows(rows);
  return buildReturnHurdleFeatureRows(baseFeatureRows, hurdleFraction);
}
