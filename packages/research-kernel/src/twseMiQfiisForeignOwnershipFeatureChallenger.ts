import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  filterEligibleMiQfiisRecords,
  isMiQfiisRecordEligibleForFeatureDate,
  TWSE_MI_QFIIS_SUPPORTED_SYMBOLS,
  type TwseMiQfiisRecord,
  type TwseMiQfiisSupportedSymbol,
} from "./twseMiQfiisForeignOwnership.js";
import { isCanonicalIsoDate } from "./twStrategyTemporalRobustness.js";
import {
  fail,
  type FeatureRow,
  type MarketDataRow,
  type PerSymbolLogisticChallengerFeatureFamily,
} from "./types.js";

export const TWSE_MI_QFIIS_FEATURE_FAMILY_NAME = "TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_V1" as const;
export const TWSE_MI_QFIIS_FEATURE_FIELDS = Object.freeze([
  "foreign_holding_ratio_lag1",
  "foreign_holding_ratio_change_5d",
  "foreign_holding_ratio_change_20d",
] as const);

export const TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL = "0056" as const;
export const TWSE_MI_QFIIS_FEATURE_STRICT_PIT_RULE = "tradeDate < featureDate" as const;
export const TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS = 21 as const;
export const TWSE_MI_QFIIS_FEATURE_CHANGE_5D_OBSERVATIONS = 6 as const;
export const TWSE_MI_QFIIS_FEATURE_CHANGE_20D_OBSERVATIONS = 21 as const;

export const TWSE_MI_QFIIS_FEATURE_FAMILY: PerSymbolLogisticChallengerFeatureFamily = Object.freeze({
  featureFamilyName: TWSE_MI_QFIIS_FEATURE_FAMILY_NAME,
  legacySourcePath: "outputs/retraining/p198_0056_twse_mi_qfiis_foreign_ownership.csv",
  legacySourceSymbolOrFormula:
    "foreign_holding_ratio_lag1 = latest foreignHoldingRatio; "
    + "foreign_holding_ratio_change_5d = latest foreignHoldingRatio - foreignHoldingRatio 5 observations earlier; "
    + "foreign_holding_ratio_change_20d = latest foreignHoldingRatio - foreignHoldingRatio 20 observations earlier "
    + "where all MI_QFIIS tradeDates strictly satisfy tradeDate < featureDate",
  newFeatureFields: TWSE_MI_QFIIS_FEATURE_FIELDS,
  currentIncumbentFeatureFields: Object.freeze([...RESEARCH_FEATURE_NAMES]),
  whyNotDuplicative:
    "The incumbent features capture single-asset price and volume technical dynamics; MI_QFIIS features capture lagged official foreign & mainland investor holding level and percentage-point changes.",
  lookbackRowsRequired: TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS,
  availableAtRule:
    "At featureDate T, use MI_QFIIS records strictly satisfying tradeDate < T; same-day MI_QFIIS observations are forbidden.",
  missingValueRule:
    "If fewer than 21 eligible prior MI_QFIIS observations exist strictly before featureDate, omit the row; no imputation or shortened lookback is permitted.",
});

export interface MiQfiisForeignOwnershipFeatureValues {
  readonly foreign_holding_ratio_lag1: number;
  readonly foreign_holding_ratio_change_5d: number;
  readonly foreign_holding_ratio_change_20d: number;
  readonly asOfMiQfiisTradeDate: string;
  readonly trailingMiQfiisRowCount: number;
}

function compareTradeDate(left: TwseMiQfiisRecord, right: TwseMiQfiisRecord): number {
  if (left.tradeDate < right.tradeDate) return -1;
  if (left.tradeDate > right.tradeDate) return 1;
  return 0;
}

function validateTargetSymbol(targetSymbol: string): asserts targetSymbol is TwseMiQfiisSupportedSymbol {
  if (!TWSE_MI_QFIIS_SUPPORTED_SYMBOLS.includes(targetSymbol as TwseMiQfiisSupportedSymbol)) {
    fail(`unsupported MI_QFIIS feature target symbol: ${targetSymbol}`);
  }
}

export function computeMiQfiisForeignOwnershipFeatureValues(
  miQfiisRecords: readonly TwseMiQfiisRecord[],
  featureDate: string,
  targetSymbol: string = TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL,
): MiQfiisForeignOwnershipFeatureValues {
  validateTargetSymbol(targetSymbol);
  if (!isCanonicalIsoDate(featureDate)) {
    fail(`invalid canonical feature date: ${featureDate}`);
  }
  if (miQfiisRecords.some((record) => record.symbol !== targetSymbol)) {
    fail(`MI_QFIIS records must have symbol ${targetSymbol}`);
  }

  const eligible = [...filterEligibleMiQfiisRecords(miQfiisRecords, featureDate)].sort(compareTradeDate);
  if (eligible.length < TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS) {
    fail(
      `insufficient eligible MI_QFIIS observations at ${featureDate}: found ${eligible.length}, required ${TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS}`,
    );
  }

  const latest21 = eligible.slice(-TWSE_MI_QFIIS_FEATURE_CHANGE_20D_OBSERVATIONS);
  const obs20Earlier = latest21[0];
  const latest = latest21.at(-1);
  if (obs20Earlier === undefined || latest === undefined) {
    fail(`MI_QFIIS 20-observation change window is incomplete at ${featureDate}`);
  }

  const latest6 = eligible.slice(-TWSE_MI_QFIIS_FEATURE_CHANGE_5D_OBSERVATIONS);
  const obs5Earlier = latest6[0];
  if (obs5Earlier === undefined) {
    fail(`MI_QFIIS 5-observation change window is incomplete at ${featureDate}`);
  }

  return Object.freeze({
    foreign_holding_ratio_lag1: latest.foreignHoldingRatio,
    foreign_holding_ratio_change_5d: latest.foreignHoldingRatio - obs5Earlier.foreignHoldingRatio,
    foreign_holding_ratio_change_20d: latest.foreignHoldingRatio - obs20Earlier.foreignHoldingRatio,
    asOfMiQfiisTradeDate: latest.tradeDate,
    trailingMiQfiisRowCount: eligible.length,
  });
}

export interface BuildMiQfiisForeignOwnershipFeatureRowsInput {
  readonly targetSymbol?: TwseMiQfiisSupportedSymbol;
  readonly targetRows: readonly MarketDataRow[];
  readonly miQfiisRecords: readonly TwseMiQfiisRecord[];
}

export interface MiQfiisForeignOwnershipFeatureBuildResult {
  readonly featureRows: readonly FeatureRow[];
  readonly controlFeatureRows: readonly FeatureRow[];
  readonly eligibleRowsRemovedForMiQfiisContext: number;
  readonly missingContextRows: number;
  readonly earliestEligibleDate: string;
}

export function buildMiQfiisForeignOwnershipFeatureRows(
  input: BuildMiQfiisForeignOwnershipFeatureRowsInput,
): MiQfiisForeignOwnershipFeatureBuildResult {
  const { targetRows, miQfiisRecords } = input;
  const targetSymbol = input.targetSymbol ?? TWSE_MI_QFIIS_FEATURE_TARGET_SYMBOL;
  validateTargetSymbol(targetSymbol);
  if (targetRows.length === 0) fail("target rows cannot be empty");
  if (miQfiisRecords.length === 0) fail("MI_QFIIS records cannot be empty");
  if (targetRows.some((row) => row.symbol !== targetSymbol)) {
    fail(`target rows must have symbol ${targetSymbol}`);
  }
  if (miQfiisRecords.some((record) => record.symbol !== targetSymbol)) {
    fail(`MI_QFIIS records must have symbol ${targetSymbol}`);
  }

  const sortedTargetRows = [...targetRows].sort((left, right) => left.date.localeCompare(right.date));
  const sortedMiQfiisRecords = [...miQfiisRecords].sort(compareTradeDate);
  const baseFeatureRows = buildHistoricalFeatureRows(sortedTargetRows);
  const controlFeatureRows: FeatureRow[] = [];
  const featureRows: FeatureRow[] = [];
  let eligibleRowsRemovedForMiQfiisContext = 0;

  for (const baseRow of baseFeatureRows) {
    const eligible = sortedMiQfiisRecords.filter((record) =>
      isMiQfiisRecordEligibleForFeatureDate(record, baseRow.featureDate));
    if (eligible.length < TWSE_MI_QFIIS_FEATURE_LOOKBACK_OBSERVATIONS) {
      eligibleRowsRemovedForMiQfiisContext += 1;
      continue;
    }

    const values = computeMiQfiisForeignOwnershipFeatureValues(
      sortedMiQfiisRecords,
      baseRow.featureDate,
      targetSymbol,
    );
    controlFeatureRows.push(baseRow);
    featureRows.push(Object.freeze({
      ...baseRow,
      features: Object.freeze([
        ...baseRow.features,
        values.foreign_holding_ratio_lag1,
        values.foreign_holding_ratio_change_5d,
        values.foreign_holding_ratio_change_20d,
      ]),
    }));
  }

  if (controlFeatureRows.length === 0 || featureRows.length === 0) {
    fail("no eligible feature rows produced after MI_QFIIS context alignment");
  }

  return Object.freeze({
    featureRows: Object.freeze(featureRows),
    controlFeatureRows: Object.freeze(controlFeatureRows),
    eligibleRowsRemovedForMiQfiisContext,
    missingContextRows: eligibleRowsRemovedForMiQfiisContext,
    earliestEligibleDate: controlFeatureRows[0]!.featureDate,
  });
}
