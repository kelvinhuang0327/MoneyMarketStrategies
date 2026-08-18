import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  fail,
  type FeatureRow,
  type MarketDataRow,
  type PerSymbolLogisticChallengerFeatureFamily,
} from "./types.js";

export const MARKET_REGIME_FEATURE_FAMILY_NAME = "0050_ADJUSTED_MARKET_REGIME_CONTEXT_V1" as const;
export const MARKET_REGIME_FEATURE_FIELDS = Object.freeze([
  "market_return_20d",
  "market_volatility_10d",
] as const);

export const MARKET_REGIME_CONTEXT_SOURCE_SYMBOL = "0050" as const;
export const MARKET_REGIME_CONTEXT_SOURCE_SERIES = "SOURCE_QUALIFIED_ADJUSTED" as const;
export const MARKET_REGIME_TARGET_SYMBOL = "0056" as const;

export const MARKET_REGIME_ALIGNMENT_RULE =
  "point_in_time_as_of_latest_source_date_on_or_before_target_feature_date" as const;
export const MARKET_REGIME_MISSING_CONTEXT_RULE =
  "require_at_least_21_trailing_source_observations_else_exclude_from_both_control_and_challenger" as const;

export const MARKET_REGIME_CONTEXT_FEATURE_FAMILY: PerSymbolLogisticChallengerFeatureFamily = Object.freeze({
  featureFamilyName: MARKET_REGIME_FEATURE_FAMILY_NAME,
  legacySourcePath: "features/market_regime_context.ts",
  legacySourceSymbolOrFormula:
    "market_return_20d = close0050[T]/close0050[T-20]-1; market_volatility_10d = std(returns0050[T-9:T]) using adjusted 0050 closes with date <= T",
  newFeatureFields: Object.freeze([...MARKET_REGIME_FEATURE_FIELDS]),
  currentIncumbentFeatureFields: Object.freeze([...RESEARCH_FEATURE_NAMES]),
  whyNotDuplicative:
    "The live incumbent features capture single-asset 0056 technical dynamics; 0050 adjusted market regime features capture contemporaneously available broad-market trend and volatility context.",
  lookbackRowsRequired: 20,
  availableAtRule:
    "At featureDate T, use adjusted 0050 closes available on or before date T only; never use a future 0050 observation.",
  missingValueRule:
    "If fewer than 21 trailing 0050 observations exist on or before featureDate, exclude that target row from both control and challenger comparison.",
});

function compareDate(left: MarketDataRow, right: MarketDataRow): number {
  if (left.date < right.date) return -1;
  if (left.date > right.date) return 1;
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute a mean from zero values");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface MarketRegimeContextValues {
  readonly market_return_20d: number;
  readonly market_volatility_10d: number;
  readonly asOf0050Date: string;
  readonly trailing0050RowCount: number;
}

export function computeMarketRegimeContextValues(
  source0050AdjustedRows: readonly MarketDataRow[],
  targetFeatureDate: string,
): MarketRegimeContextValues {
  const sorted0050 = [...source0050AdjustedRows].sort(compareDate);
  const trailing0050 = sorted0050.filter((row) => row.date <= targetFeatureDate);
  if (trailing0050.length < 21) {
    fail(
      `insufficient trailing 0050 history for market regime context at ${targetFeatureDate}: found ${trailing0050.length}, required at least 21`,
    );
  }
  if (trailing0050.some((row) => row.date > targetFeatureDate)) {
    fail(`market regime context violates point-in-time guard at ${targetFeatureDate}`);
  }
  const lastIndex = trailing0050.length - 1;
  const current0050 = trailing0050[lastIndex]!;
  const row20 = trailing0050[lastIndex - 20]!;

  const market_return_20d = current0050.close / row20.close - 1;

  const returns10: number[] = [];
  for (let offset = lastIndex - 9; offset <= lastIndex; offset += 1) {
    const row = trailing0050[offset]!;
    const previous = trailing0050[offset - 1]!;
    returns10.push(row.close / previous.close - 1);
  }
  const avgReturn = mean(returns10);
  const variance = mean(returns10.map((value) => (value - avgReturn) ** 2));
  const market_volatility_10d = Math.sqrt(variance);

  return Object.freeze({
    market_return_20d,
    market_volatility_10d,
    asOf0050Date: current0050.date,
    trailing0050RowCount: trailing0050.length,
  });
}

export interface BuildMarketRegimeFeatureRowsInput {
  readonly targetRows: readonly MarketDataRow[];
  readonly source0050AdjustedRows: readonly MarketDataRow[];
}

export interface MarketRegimeFeatureBuildResult {
  readonly featureRows: readonly FeatureRow[];
  readonly controlFeatureRows: readonly FeatureRow[];
  readonly eligibleRowsRemovedForMarketContext: number;
  readonly missingContextRows: number;
  readonly earliestEligibleDate: string;
}

export function buildMarketRegimeContextFeatureRows(
  input: BuildMarketRegimeFeatureRowsInput,
): MarketRegimeFeatureBuildResult {
  const { targetRows, source0050AdjustedRows } = input;
  if (targetRows.length === 0) fail("target rows cannot be empty");
  if (source0050AdjustedRows.length === 0) fail("source 0050 adjusted rows cannot be empty");

  // Validate that source0050AdjustedRows are indeed 0050 rows
  if (source0050AdjustedRows.some((row) => row.symbol !== MARKET_REGIME_CONTEXT_SOURCE_SYMBOL)) {
    fail("source rows for market regime context must have symbol 0050");
  }

  const base0056FeatureRows = buildHistoricalFeatureRows(targetRows);
  const sorted0050 = [...source0050AdjustedRows].sort(compareDate);

  const eligibleControlRows: FeatureRow[] = [];
  const eligibleChallengerRows: FeatureRow[] = [];
  let eligibleRowsRemovedForMarketContext = 0;
  let missingContextRows = 0;

  for (const baseRow of base0056FeatureRows) {
    const trailing0050 = sorted0050.filter((row) => row.date <= baseRow.featureDate);
    if (trailing0050.length < 21) {
      eligibleRowsRemovedForMarketContext += 1;
      missingContextRows += 1;
      continue;
    }
    const context = computeMarketRegimeContextValues(sorted0050, baseRow.featureDate);
    eligibleControlRows.push(baseRow);
    eligibleChallengerRows.push(
      Object.freeze({
        ...baseRow,
        features: Object.freeze([
          ...baseRow.features,
          context.market_return_20d,
          context.market_volatility_10d,
        ]),
      }),
    );
  }

  if (eligibleControlRows.length === 0 || eligibleChallengerRows.length === 0) {
    fail("no eligible feature rows produced after market context alignment");
  }

  const earliestEligibleDate = eligibleControlRows[0]!.featureDate;

  return Object.freeze({
    featureRows: Object.freeze(eligibleChallengerRows),
    controlFeatureRows: Object.freeze(eligibleControlRows),
    eligibleRowsRemovedForMarketContext,
    missingContextRows,
    earliestEligibleDate,
  });
}
