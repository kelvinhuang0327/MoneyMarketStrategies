import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  filterEligibleMiMargnRecords,
  isMiMargnRecordEligibleForFeatureDate,
  type TwseMiMargnBalanceRecord,
} from "./twseMiMargnMarginShortBalances.js";
import { isCanonicalIsoDate } from "./twStrategyTemporalRobustness.js";
import {
  fail,
  type FeatureRow,
  type MarketDataRow,
  type PerSymbolLogisticChallengerFeatureFamily,
} from "./types.js";

export const TWSE_MI_MARGN_FEATURE_FAMILY_NAME = "0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCES_V1" as const;
export const TWSE_MI_MARGN_FEATURE_FIELDS = Object.freeze([
  "margin_balance_change_5d",
  "short_balance_change_5d",
  "short_to_margin_balance_ratio_20d",
] as const);

export const TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL = "0056" as const;
export const TWSE_MI_MARGN_FEATURE_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS = 20 as const;
export const TWSE_MI_MARGN_FEATURE_CHANGE_OBSERVATIONS = 5 as const;

export const TWSE_MI_MARGN_FEATURE_FAMILY: PerSymbolLogisticChallengerFeatureFamily = Object.freeze({
  featureFamilyName: TWSE_MI_MARGN_FEATURE_FAMILY_NAME,
  legacySourcePath: "outputs/retraining/p197_0056_twse_mi_margn_margin_short_balances.csv",
  legacySourceSymbolOrFormula:
    "margin_balance_change_5d = (latest marginPurchaseBalance - marginPurchaseBalance 5 observations earlier) / max(abs(marginPurchaseBalance 5 observations earlier), 1); "
    + "short_balance_change_5d = (latest shortSaleBalance - shortSaleBalance 5 observations earlier) / max(abs(shortSaleBalance 5 observations earlier), 1); "
    + "short_to_margin_balance_ratio_20d = sum(shortSaleBalance over latest 20 eligible observations) / max(sum(marginPurchaseBalance over latest 20 eligible observations), 1)",
  newFeatureFields: TWSE_MI_MARGN_FEATURE_FIELDS,
  currentIncumbentFeatureFields: Object.freeze([...RESEARCH_FEATURE_NAMES]),
  whyNotDuplicative:
    "The live incumbent features capture single-asset 0056 price and volume technical dynamics; MI_MARGN features capture lagged margin-purchase and short-sale positioning balances.",
  lookbackRowsRequired: TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS,
  availableAtRule:
    "At featureDate T, use MI_MARGN records strictly satisfying tradeDate < T; same-day MI_MARGN observations are forbidden.",
  missingValueRule:
    "If fewer than 20 eligible prior MI_MARGN observations exist strictly before featureDate, omit the row; no imputation or shortened lookback is permitted.",
});

export interface MiMargnMarginShortFeatureValues {
  readonly margin_balance_change_5d: number;
  readonly short_balance_change_5d: number;
  readonly short_to_margin_balance_ratio_20d: number;
  readonly asOfMiMargnTradeDate: string;
  readonly trailingMiMargnRowCount: number;
}

function compareTradeDate(left: TwseMiMargnBalanceRecord, right: TwseMiMargnBalanceRecord): number {
  if (left.tradeDate < right.tradeDate) return -1;
  if (left.tradeDate > right.tradeDate) return 1;
  return 0;
}

function relativeChange(current: number, prior: number): number {
  return (current - prior) / Math.max(Math.abs(prior), 1);
}

export function computeMiMargnMarginShortFeatureValues(
  miMargnRecords: readonly TwseMiMargnBalanceRecord[],
  featureDate: string,
): MiMargnMarginShortFeatureValues {
  if (!isCanonicalIsoDate(featureDate)) {
    fail(`invalid canonical feature date: ${featureDate}`);
  }
  if (miMargnRecords.some((record) => record.symbol !== TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL)) {
    fail(`MI_MARGN records must have symbol ${TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL}`);
  }

  const eligible = [...filterEligibleMiMargnRecords(miMargnRecords, featureDate)].sort(compareTradeDate);
  if (eligible.length < TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS) {
    fail(
      `insufficient eligible MI_MARGN observations at ${featureDate}: found ${eligible.length}, required ${TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS}`,
    );
  }

  const latestSix = eligible.slice(-TWSE_MI_MARGN_FEATURE_CHANGE_OBSERVATIONS - 1);
  const changeStart = latestSix[0];
  const latest = latestSix.at(-1);
  if (changeStart === undefined || latest === undefined) {
    fail(`MI_MARGN 5-observation change window is incomplete at ${featureDate}`);
  }

  const latestTwenty = eligible.slice(-TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS);
  const marginBalanceTotal = latestTwenty.reduce((sum, record) => sum + record.marginPurchaseBalance, 0);
  const shortBalanceTotal = latestTwenty.reduce((sum, record) => sum + record.shortSaleBalance, 0);

  return Object.freeze({
    margin_balance_change_5d: relativeChange(
      latest.marginPurchaseBalance,
      changeStart.marginPurchaseBalance,
    ),
    short_balance_change_5d: relativeChange(latest.shortSaleBalance, changeStart.shortSaleBalance),
    short_to_margin_balance_ratio_20d: shortBalanceTotal / Math.max(marginBalanceTotal, 1),
    asOfMiMargnTradeDate: latestTwenty.at(-1)!.tradeDate,
    trailingMiMargnRowCount: eligible.length,
  });
}

export interface BuildMiMargnMarginShortFeatureRowsInput {
  readonly targetRows: readonly MarketDataRow[];
  readonly miMargnRecords: readonly TwseMiMargnBalanceRecord[];
}

export interface MiMargnMarginShortFeatureBuildResult {
  readonly featureRows: readonly FeatureRow[];
  readonly controlFeatureRows: readonly FeatureRow[];
  readonly eligibleRowsRemovedForMiMargnContext: number;
  readonly missingContextRows: number;
  readonly earliestEligibleDate: string;
}

export function buildMiMargnMarginShortFeatureRows(
  input: BuildMiMargnMarginShortFeatureRowsInput,
): MiMargnMarginShortFeatureBuildResult {
  const { targetRows, miMargnRecords } = input;
  if (targetRows.length === 0) fail("target rows cannot be empty");
  if (miMargnRecords.length === 0) fail("MI_MARGN records cannot be empty");
  if (targetRows.some((row) => row.symbol !== TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL)) {
    fail(`target rows must have symbol ${TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL}`);
  }
  if (miMargnRecords.some((record) => record.symbol !== TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL)) {
    fail(`MI_MARGN records must have symbol ${TWSE_MI_MARGN_FEATURE_TARGET_SYMBOL}`);
  }

  const sortedTargetRows = [...targetRows].sort((left, right) => left.date.localeCompare(right.date));
  const sortedMiMargnRecords = [...miMargnRecords].sort(compareTradeDate);
  const baseFeatureRows = buildHistoricalFeatureRows(sortedTargetRows);
  const controlFeatureRows: FeatureRow[] = [];
  const featureRows: FeatureRow[] = [];
  let eligibleRowsRemovedForMiMargnContext = 0;

  for (const baseRow of baseFeatureRows) {
    const eligible = sortedMiMargnRecords.filter((record) =>
      isMiMargnRecordEligibleForFeatureDate(record, baseRow.featureDate));
    if (eligible.length < TWSE_MI_MARGN_FEATURE_LOOKBACK_OBSERVATIONS) {
      eligibleRowsRemovedForMiMargnContext += 1;
      continue;
    }

    const values = computeMiMargnMarginShortFeatureValues(sortedMiMargnRecords, baseRow.featureDate);
    controlFeatureRows.push(baseRow);
    featureRows.push(Object.freeze({
      ...baseRow,
      features: Object.freeze([
        ...baseRow.features,
        values.margin_balance_change_5d,
        values.short_balance_change_5d,
        values.short_to_margin_balance_ratio_20d,
      ]),
    }));
  }

  if (controlFeatureRows.length === 0 || featureRows.length === 0) {
    fail("no eligible feature rows produced after MI_MARGN context alignment");
  }

  return Object.freeze({
    featureRows: Object.freeze(featureRows),
    controlFeatureRows: Object.freeze(controlFeatureRows),
    eligibleRowsRemovedForMiMargnContext,
    missingContextRows: eligibleRowsRemovedForMiMargnContext,
    earliestEligibleDate: controlFeatureRows[0]!.featureDate,
  });
}
