import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import { isCanonicalIsoDate } from "./twStrategyTemporalRobustness.js";
import { type TwseT86FlowRecord } from "./twseT86InstitutionalFlows.js";
import {
  fail,
  type FeatureRow,
  type MarketDataRow,
  type PerSymbolLogisticChallengerFeatureFamily,
} from "./types.js";

export const TWSE_T86_FEATURE_FAMILY_NAME = "0056_TWSE_T86_INSTITUTIONAL_FLOWS_V1" as const;
export const TWSE_T86_FEATURE_FIELDS = Object.freeze([
  "foreign_flow_ratio_20d",
  "trust_flow_ratio_20d",
  "institutional_net_surge_5d",
] as const);

export const TWSE_T86_FEATURE_TARGET_SYMBOL = "0056" as const;
export const TWSE_T86_FEATURE_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_T86_FEATURE_LOOKBACK_DAYS = 20 as const;
export const TWSE_T86_FEATURE_SURGE_DAYS = 5 as const;

export const TWSE_T86_FEATURE_FAMILY: PerSymbolLogisticChallengerFeatureFamily = Object.freeze({
  featureFamilyName: TWSE_T86_FEATURE_FAMILY_NAME,
  legacySourcePath: "outputs/retraining/p196_0056_twse_t86_institutional_flows.csv",
  legacySourceSymbolOrFormula:
    "foreign_flow_ratio_20d = sum(foreignNetShares[T-20:T]) / sum(volume[T-20:T]); " +
    "trust_flow_ratio_20d = sum(investmentTrustNetShares[T-20:T]) / sum(volume[T-20:T]); " +
    "institutional_net_surge_5d = (sum(institutionalTotalNetShares[T-5:T]) / sum(volume[T-5:T])) - (sum(institutionalTotalNetShares[T-20:T]) / sum(volume[T-20:T])) " +
    "where all T86 tradeDates strictly satisfy tradeDate < T",
  newFeatureFields: Object.freeze([...TWSE_T86_FEATURE_FIELDS]),
  currentIncumbentFeatureFields: Object.freeze([...RESEARCH_FEATURE_NAMES]),
  whyNotDuplicative:
    "The live incumbent features capture single-asset 0056 price and volume technical dynamics; T86 institutional flow features capture lagged institutional buying/selling pressure from foreign investors and local investment trusts.",
  lookbackRowsRequired: TWSE_T86_FEATURE_LOOKBACK_DAYS,
  availableAtRule:
    "At featureDate T, use T86 records strictly satisfying tradeDate < T; same-day T86 observations (tradeDate === T) are strictly forbidden.",
  missingValueRule:
    "If fewer than 20 eligible prior T86 records exist strictly before featureDate, or volume is zero/missing, exclude that row; no missing-value imputation is permitted.",
});

function compareMarketDate(left: MarketDataRow, right: MarketDataRow): number {
  if (left.date < right.date) return -1;
  if (left.date > right.date) return 1;
  return 0;
}

function compareT86Date(left: TwseT86FlowRecord, right: TwseT86FlowRecord): number {
  if (left.tradeDate < right.tradeDate) return -1;
  if (left.tradeDate > right.tradeDate) return 1;
  return 0;
}

export interface T86InstitutionalFlowValues {
  readonly foreign_flow_ratio_20d: number;
  readonly trust_flow_ratio_20d: number;
  readonly institutional_net_surge_5d: number;
  readonly asOfT86TradeDate: string;
  readonly trailingT86RowCount: number;
}

/**
 * Pure, deterministic calculation of the 3 T86 institutional flow features
 * as of a specific target featureDate.
 *
 * Strict PIT constraint: only records strictly before targetFeatureDate
 * (tradeDate < targetFeatureDate and date < targetFeatureDate) are consumed.
 */
export function computeT86InstitutionalFlowValues(
  targetMarketRows: readonly MarketDataRow[],
  t86Records: readonly TwseT86FlowRecord[],
  targetFeatureDate: string,
): T86InstitutionalFlowValues {
  if (!isCanonicalIsoDate(targetFeatureDate)) {
    fail(`invalid canonical feature date: ${targetFeatureDate}`);
  }

  // Filter strictly prior records (PIT invariant)
  const trailingMarket = targetMarketRows
    .filter((row) => row.date < targetFeatureDate)
    .sort(compareMarketDate);
  const trailingT86 = t86Records
    .filter((rec) => rec.tradeDate < targetFeatureDate)
    .sort(compareT86Date);

  if (trailingMarket.some((row) => row.date >= targetFeatureDate)) {
    fail(`market row violates point-in-time guard at ${targetFeatureDate}`);
  }
  if (trailingT86.some((rec) => rec.tradeDate >= targetFeatureDate)) {
    fail(`T86 record violates point-in-time guard at ${targetFeatureDate}`);
  }

  if (trailingMarket.length < TWSE_T86_FEATURE_LOOKBACK_DAYS) {
    fail(
      `insufficient trailing market rows for T86 feature calculation at ${targetFeatureDate}: found ${trailingMarket.length}, required ${TWSE_T86_FEATURE_LOOKBACK_DAYS}`,
    );
  }
  if (trailingT86.length < TWSE_T86_FEATURE_LOOKBACK_DAYS) {
    fail(
      `insufficient trailing T86 records for T86 feature calculation at ${targetFeatureDate}: found ${trailingT86.length}, required ${TWSE_T86_FEATURE_LOOKBACK_DAYS}`,
    );
  }

  const market20 = trailingMarket.slice(-TWSE_T86_FEATURE_LOOKBACK_DAYS);
  const market5 = trailingMarket.slice(-TWSE_T86_FEATURE_SURGE_DAYS);
  const t86_20 = trailingT86.slice(-TWSE_T86_FEATURE_LOOKBACK_DAYS);
  const t86_5 = trailingT86.slice(-TWSE_T86_FEATURE_SURGE_DAYS);

  // Validate date alignment across the 20-day lookback window
  for (let i = 0; i < TWSE_T86_FEATURE_LOOKBACK_DAYS; i += 1) {
    const marketRow = market20[i]!;
    const t86Record = t86_20[i]!;
    if (marketRow.date !== t86Record.tradeDate) {
      fail(
        `date alignment mismatch at offset ${i} for featureDate ${targetFeatureDate}: market date ${marketRow.date} !== T86 tradeDate ${t86Record.tradeDate}`,
      );
    }
  }

  const volume20 = market20.reduce((sum, row) => sum + row.volume, 0);
  if (volume20 <= 0) {
    fail(`zero or negative 20-day historical volume at ${targetFeatureDate}`);
  }

  const volume5 = market5.reduce((sum, row) => sum + row.volume, 0);
  if (volume5 <= 0) {
    fail(`zero or negative 5-day historical volume at ${targetFeatureDate}`);
  }

  const foreignNet20 = t86_20.reduce((sum, rec) => sum + rec.foreignNetShares, 0);
  const trustNet20 = t86_20.reduce((sum, rec) => sum + rec.investmentTrustNetShares, 0);
  const instTotalNet20 = t86_20.reduce((sum, rec) => sum + rec.institutionalTotalNetShares, 0);
  const instTotalNet5 = t86_5.reduce((sum, rec) => sum + rec.institutionalTotalNetShares, 0);

  const foreign_flow_ratio_20d = foreignNet20 / volume20;
  const trust_flow_ratio_20d = trustNet20 / volume20;
  const intensity5d = instTotalNet5 / volume5;
  const intensity20d = instTotalNet20 / volume20;
  const institutional_net_surge_5d = intensity5d - intensity20d;

  const latestT86 = t86_20[t86_20.length - 1]!;

  return Object.freeze({
    foreign_flow_ratio_20d,
    trust_flow_ratio_20d,
    institutional_net_surge_5d,
    asOfT86TradeDate: latestT86.tradeDate,
    trailingT86RowCount: trailingT86.length,
  });
}

export interface BuildT86InstitutionalFlowFeatureRowsInput {
  readonly targetRows: readonly MarketDataRow[];
  readonly t86Records: readonly TwseT86FlowRecord[];
}

export interface T86InstitutionalFlowFeatureBuildResult {
  readonly featureRows: readonly FeatureRow[];
  readonly controlFeatureRows: readonly FeatureRow[];
  readonly eligibleRowsRemovedForT86Context: number;
  readonly missingContextRows: number;
  readonly earliestEligibleDate: string;
}

/**
 * Builds aligned feature rows for the 0056 T86 institutional flow challenger.
 *
 * Emits both controlFeatureRows (5 incumbent features) and featureRows
 * (5 incumbent features + 3 T86 flow features) evaluated on the exact same
 * population of eligible trading observations.
 */
export function buildT86InstitutionalFlowFeatureRows(
  input: BuildT86InstitutionalFlowFeatureRowsInput,
): T86InstitutionalFlowFeatureBuildResult {
  const { targetRows, t86Records } = input;
  if (targetRows.length === 0) fail("target rows cannot be empty");
  if (t86Records.length === 0) fail("T86 records cannot be empty");

  if (targetRows.some((row) => row.symbol !== TWSE_T86_FEATURE_TARGET_SYMBOL)) {
    fail(`target rows must have symbol ${TWSE_T86_FEATURE_TARGET_SYMBOL}`);
  }
  if (t86Records.some((rec) => rec.symbol !== TWSE_T86_FEATURE_TARGET_SYMBOL)) {
    fail(`T86 records must have symbol ${TWSE_T86_FEATURE_TARGET_SYMBOL}`);
  }

  const base0056FeatureRows = buildHistoricalFeatureRows(targetRows);
  const sortedMarketRows = [...targetRows].sort(compareMarketDate);
  const sortedT86Records = [...t86Records].sort(compareT86Date);

  const eligibleControlRows: FeatureRow[] = [];
  const eligibleChallengerRows: FeatureRow[] = [];
  let eligibleRowsRemovedForT86Context = 0;
  let missingContextRows = 0;

  for (const baseRow of base0056FeatureRows) {
    const trailingT86 = sortedT86Records.filter((rec) => rec.tradeDate < baseRow.featureDate);
    const trailingMarket = sortedMarketRows.filter((row) => row.date < baseRow.featureDate);
    if (
      trailingT86.length < TWSE_T86_FEATURE_LOOKBACK_DAYS ||
      trailingMarket.length < TWSE_T86_FEATURE_LOOKBACK_DAYS
    ) {
      eligibleRowsRemovedForT86Context += 1;
      missingContextRows += 1;
      continue;
    }

    const t86Values = computeT86InstitutionalFlowValues(
      sortedMarketRows,
      sortedT86Records,
      baseRow.featureDate,
    );

    eligibleControlRows.push(baseRow);
    eligibleChallengerRows.push(
      Object.freeze({
        ...baseRow,
        features: Object.freeze([
          ...baseRow.features,
          t86Values.foreign_flow_ratio_20d,
          t86Values.trust_flow_ratio_20d,
          t86Values.institutional_net_surge_5d,
        ]),
      }),
    );
  }

  if (eligibleControlRows.length === 0 || eligibleChallengerRows.length === 0) {
    fail("no eligible feature rows produced after T86 flow alignment");
  }

  const earliestEligibleDate = eligibleControlRows[0]!.featureDate;

  return Object.freeze({
    featureRows: Object.freeze(eligibleChallengerRows),
    controlFeatureRows: Object.freeze(eligibleControlRows),
    eligibleRowsRemovedForT86Context,
    missingContextRows,
    earliestEligibleDate,
  });
}
