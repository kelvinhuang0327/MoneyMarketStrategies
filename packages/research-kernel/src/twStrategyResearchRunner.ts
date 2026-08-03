import { findPriceDiscontinuities, validateAndNormalizeMarketRows } from "./dataQuality.js";
import { hashFeatureRows } from "./evidence.js";
import { buildHistoricalFeatureRows } from "./features.js";
import { fitLogisticRegression, predictProbability } from "./logisticRegression.js";
import { fitStandardScaler } from "./scaler.js";
import type { FeatureRow, MarketDataRow } from "./types.js";

/**
 * Research-kernel-only half of the TW strategy research runner: pure string
 * and value transforms, with no `node:*` import (matching every other
 * module in this package) and no import of `@mms/strategy-simulator`
 * (which already depends on `@mms/research-kernel`, so the reverse import
 * would create a circular package/project-reference graph). Reading the
 * pinned CSV bytes, verifying its SHA-256 pin, and composing
 * {@link buildScenarioFoldInputs}'s `foldInputs` with
 * `@mms/strategy-simulator`'s walk-forward evaluation are all the CLI's
 * job.
 */

export type TwStrategyResearchRunnerErrorCode =
  | "MALFORMED_CSV_HEADER"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_OHLCV"
  | "DUPLICATE_OHLCV_ROW"
  | "MISSING_REQUIRED_SYMBOL"
  | "FUTURE_ROW"
  | "INVALID_DATA_END_DATE";

export class TwStrategyResearchRunnerError extends Error {
  readonly code: TwStrategyResearchRunnerErrorCode;

  constructor(code: TwStrategyResearchRunnerErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwStrategyResearchRunnerError";
    this.code = code;
  }
}

function fail(code: TwStrategyResearchRunnerErrorCode, detail?: string): never {
  throw new TwStrategyResearchRunnerError(code, detail);
}

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCanonicalIsoDate(value: string): boolean {
  if (!CANONICAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface RawTwStrategyResearchRow {
  readonly symbol: string;
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly source: string;
  readonly fetched_at_utc: string;
}

const REQUIRED_CSV_HEADER_FIELDS = Object.freeze([
  "symbol",
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "source",
]);

function parseRequiredCsvNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) fail("INVALID_OHLCV", `${field}=${value}`);
  return parsed;
}

/**
 * Parses the pinned OHLCV export CSV text into raw rows, validating field
 * presence and per-row numeric/date domain. Cross-row concerns (duplicates,
 * required symbols, the data-end-date boundary) are
 * {@link validateTwStrategyResearchRows}'s job. Pure: operates on an
 * already-decoded `string`, never a `Buffer` (reading the file and
 * verifying its SHA-256 pin is the CLI's job).
 */
export function parseTwStrategyResearchCsvText(text: string): readonly RawTwStrategyResearchRow[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) fail("MALFORMED_CSV_HEADER", "empty file");
  const header = lines[0]!.split(",");
  for (const field of REQUIRED_CSV_HEADER_FIELDS) {
    if (!header.includes(field)) fail("MALFORMED_CSV_HEADER", field);
  }
  const rows: RawTwStrategyResearchRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index]!.split(",");
    const record: Record<string, string> = {};
    header.forEach((key, fieldIndex) => {
      record[key] = fields[fieldIndex] ?? "";
    });
    const symbol = (record["symbol"] ?? "").trim();
    const date = (record["date"] ?? "").trim();
    const source = (record["source"] ?? "").trim();
    if (symbol.length === 0) fail("MISSING_REQUIRED_FIELD", `row ${index}: symbol`);
    if (!isCanonicalIsoDate(date)) fail("MISSING_REQUIRED_FIELD", `row ${index}: date=${date}`);
    if (source.length === 0) fail("MISSING_REQUIRED_FIELD", `row ${index}: source`);
    const open = parseRequiredCsvNumber(record["open"] ?? "", `row ${index}: open`);
    const high = parseRequiredCsvNumber(record["high"] ?? "", `row ${index}: high`);
    const low = parseRequiredCsvNumber(record["low"] ?? "", `row ${index}: low`);
    const close = parseRequiredCsvNumber(record["close"] ?? "", `row ${index}: close`);
    const volume = parseRequiredCsvNumber(record["volume"] ?? "", `row ${index}: volume`);
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < low) {
      fail("INVALID_OHLCV", `row ${index}: ${symbol}:${date}`);
    }
    rows.push({
      symbol,
      date,
      open,
      high,
      low,
      close,
      volume,
      source,
      fetched_at_utc: (record["fetched_at_utc"] ?? "").trim(),
    });
  }
  return rows;
}

export interface TwStrategyResearchRowValidationOptions {
  readonly dataEndDate: string;
  readonly requiredSymbols: readonly string[];
}

export interface ValidatedTwStrategyResearchRows {
  readonly rows: readonly RawTwStrategyResearchRow[];
  readonly dateRange: { readonly min: string; readonly max: string };
  readonly symbolsPresent: readonly string[];
}

/**
 * Fail-closed cross-row validation: duplicate (symbol,date) rows, required
 * symbols present, and no row dated after `dataEndDate` (a row past the
 * declared boundary is treated as a data-integrity failure, never silently
 * filtered away).
 */
export function validateTwStrategyResearchRows(
  rows: readonly RawTwStrategyResearchRow[],
  options: TwStrategyResearchRowValidationOptions,
): ValidatedTwStrategyResearchRows {
  if (!isCanonicalIsoDate(options.dataEndDate)) fail("INVALID_DATA_END_DATE", options.dataEndDate);

  const seen = new Set<string>();
  for (const row of rows) {
    const identity = `${row.symbol}:${row.date}`;
    if (seen.has(identity)) fail("DUPLICATE_OHLCV_ROW", identity);
    seen.add(identity);
    if (row.date > options.dataEndDate) fail("FUTURE_ROW", identity);
  }

  const symbolsPresent = [...new Set(rows.map((row) => row.symbol))].sort();
  for (const requiredSymbol of options.requiredSymbols) {
    if (!symbolsPresent.includes(requiredSymbol)) fail("MISSING_REQUIRED_SYMBOL", requiredSymbol);
  }

  const dates = rows.map((row) => row.date).sort();
  return {
    rows,
    dateRange: { min: dates[0] ?? options.dataEndDate, max: dates.at(-1) ?? options.dataEndDate },
    symbolsPresent,
  };
}

export function toMarketRows(
  rawRows: readonly RawTwStrategyResearchRow[],
  symbol: string,
): MarketDataRow[] {
  return rawRows
    .filter((row) => row.symbol === symbol)
    .map((row) => ({
      symbol: row.symbol,
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      source: row.source,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export const ADJUSTMENT_COVERAGE = "BOUNDED_EVENT_ONLY" as const;
export const VOLUME_ADJUSTMENT_STATUS = "NOT_APPLIED" as const;

/**
 * Applies a bounded, source-qualified split-adjustment factor to OHLC (not
 * volume) for every row strictly before `effectiveDate`. Volume is left raw
 * ({@link VOLUME_ADJUSTMENT_STATUS}): the qualification evidence covers the
 * price reference only, so volume-derived features may still show a step
 * change around the split date ({@link ADJUSTMENT_COVERAGE}).
 */
export function applyBoundedAdjustment(
  rows: readonly MarketDataRow[],
  effectiveDate: string,
  adjustmentFactor: number,
): MarketDataRow[] {
  if (!Number.isFinite(adjustmentFactor) || adjustmentFactor <= 0) {
    fail("INVALID_OHLCV", `adjustmentFactor=${adjustmentFactor}`);
  }
  return rows.map((row) => {
    if (row.date >= effectiveDate) return row;
    return {
      ...row,
      open: row.open * adjustmentFactor,
      high: row.high * adjustmentFactor,
      low: row.low * adjustmentFactor,
      close: row.close * adjustmentFactor,
    };
  });
}

export const CANDIDATE_THRESHOLDS: readonly number[] = Object.freeze([0.5, 0.55, 0.6, 0.65, 0.7]);
export const ROUND_TRIP_COST_BPS = 10;
export const INITIAL_CAPITAL = 100;
export const DEFAULT_FOLD_COUNT = 3;
export const DEFAULT_TRAIN_FRACTION = 0.5;

export interface FoldBoundary {
  readonly foldId: string;
  readonly trainRows: readonly FeatureRow[];
  readonly calibrationRows: readonly FeatureRow[];
  readonly validationRows: readonly FeatureRow[];
}

/**
 * Deterministic, decided-a-priori expanding-window walk-forward scheme: the
 * first `trainFraction` of unique feature dates seeds fold 1's training set;
 * the remainder is split into `foldCount` equal blocks, each block split
 * 60/40 into calibration/validation; a fold's training set is every feature
 * row whose targetDate is strictly before that fold's calibration start
 * (expanding window, purged so no label crosses into training).
 */
export function buildWalkForwardFolds(
  rows: readonly FeatureRow[],
  options: { readonly foldCount?: number | undefined; readonly trainFraction?: number | undefined } = {},
): FoldBoundary[] {
  const foldCount = options.foldCount ?? DEFAULT_FOLD_COUNT;
  const trainFraction = options.trainFraction ?? DEFAULT_TRAIN_FRACTION;
  const uniqueFeatureDates = [...new Set(rows.map((row) => row.featureDate))].sort();
  const trainSeedEndIndex = Math.floor(uniqueFeatureDates.length * trainFraction) - 1;
  const remaining = uniqueFeatureDates.slice(trainSeedEndIndex + 1);
  const blockSize = Math.floor(remaining.length / foldCount);
  if (blockSize < 10) fail("MISSING_REQUIRED_FIELD", "insufficient remaining dates for the requested fold count");

  const folds: FoldBoundary[] = [];
  for (let f = 0; f < foldCount; f += 1) {
    const blockStart = f * blockSize;
    const blockEnd = f === foldCount - 1 ? remaining.length : blockStart + blockSize;
    const block = remaining.slice(blockStart, blockEnd);
    const calibSplit = Math.floor(block.length * 0.6);
    const calibDates = new Set(block.slice(0, calibSplit));
    const validDates = new Set(block.slice(calibSplit));
    const calibrationStart = block[0]!;
    const validationStart = block[calibSplit]!;

    const trainRows = rows.filter((row) => row.targetDate < calibrationStart);
    const calibrationRows = rows.filter(
      (row) => calibDates.has(row.featureDate) && row.targetDate < validationStart,
    );
    const validationRows = rows.filter((row) => validDates.has(row.featureDate));

    if (trainRows.length === 0 || calibrationRows.length === 0 || validationRows.length === 0) {
      fail("MISSING_REQUIRED_FIELD", `fold ${f} produced an empty partition`);
    }
    folds.push({
      foldId: `fold-${f + 1}`,
      trainRows: Object.freeze(trainRows),
      calibrationRows: Object.freeze(calibrationRows),
      validationRows: Object.freeze(validationRows),
    });
  }
  return folds;
}

/**
 * Structurally compatible with `@mms/strategy-simulator`'s
 * `LongCashReplayRow`, without importing that package (see module doc).
 */
export interface ProbabilityScoredForwardReturnRow {
  readonly entryDate: string;
  readonly exitDate: string;
  readonly probabilityUp: number;
  readonly realizedForwardReturn: number;
}

function trainingPartition(rows: readonly FeatureRow[]) {
  return {
    kind: "TRAINING" as const,
    rows: Object.freeze([...rows]),
    rowIdentitySha256: hashFeatureRows(rows),
  };
}

export function fitModelOnFeatureRows(rows: readonly FeatureRow[]) {
  const partition = trainingPartition(rows);
  const scaler = fitStandardScaler(partition);
  const model = fitLogisticRegression(partition, scaler);
  return { scaler, model };
}

function toScoredRow(
  row: FeatureRow,
  scaler: ReturnType<typeof fitStandardScaler>,
  model: ReturnType<typeof fitLogisticRegression>,
): ProbabilityScoredForwardReturnRow {
  return {
    entryDate: row.featureDate,
    exitDate: row.targetDate,
    probabilityUp: predictProbability(row.features, scaler, model),
    realizedForwardReturn: row.forwardReturn,
  };
}

export interface FoldEvaluationInput {
  readonly foldId: string;
  readonly candidateThresholds: readonly number[];
  readonly calibrationRows: readonly ProbabilityScoredForwardReturnRow[];
  readonly validationRows: readonly ProbabilityScoredForwardReturnRow[];
}

export interface ScenarioFoldPreparation {
  readonly dataQualityFindings: ReturnType<typeof findPriceDiscontinuities>;
  readonly featureRowCount: number;
  readonly foldBoundaries: ReadonlyArray<{
    readonly foldId: string;
    readonly trainRowCount: number;
    readonly calibrationRowCount: number;
    readonly validationRowCount: number;
    readonly trainMaxTargetDate: string;
    readonly calibrationStartDate: string;
    readonly calibrationEndDate: string;
    readonly validationStartDate: string;
    readonly validationEndDate: string;
  }>;
  readonly foldInputs: readonly FoldEvaluationInput[];
  readonly latestSignal: {
    readonly signalAsOfFeatureDate: string;
    readonly signalAsOfTargetDate: string;
    readonly probabilityUp: number;
    readonly trainedOnRowCount: number;
  };
}

/**
 * Builds every research-kernel-only artifact a scenario needs: data-quality
 * findings, walk-forward fold boundaries scored into
 * {@link ProbabilityScoredForwardReturnRow} inputs, and a historical
 * "latest signal" probability (never a current-date prediction: it is
 * scored strictly from rows on or before `marketRows`' own last date, using
 * a model trained only on strictly earlier rows). The caller (a CLI/script
 * that also imports `@mms/strategy-simulator`) combines `foldInputs` with
 * `runWalkForwardThresholdEvaluation` to obtain returns, drawdowns, and the
 * calibration-selected operative threshold.
 */
export function buildScenarioFoldInputs(
  marketRows: readonly MarketDataRow[],
  options: {
    readonly candidateThresholds?: readonly number[];
    readonly discontinuityThreshold?: number;
    readonly foldCount?: number;
    readonly trainFraction?: number;
  } = {},
): ScenarioFoldPreparation {
  const candidateThresholds = options.candidateThresholds ?? CANDIDATE_THRESHOLDS;
  const normalized = validateAndNormalizeMarketRows(marketRows);
  const dataQualityFindings = findPriceDiscontinuities(normalized, options.discontinuityThreshold);

  const featureRows = buildHistoricalFeatureRows(normalized);
  const folds = buildWalkForwardFolds(featureRows, {
    foldCount: options.foldCount,
    trainFraction: options.trainFraction,
  });

  const foldInputs: FoldEvaluationInput[] = folds.map((fold) => {
    const { scaler, model } = fitModelOnFeatureRows(fold.trainRows);
    return {
      foldId: fold.foldId,
      candidateThresholds,
      calibrationRows: fold.calibrationRows.map((row) => toScoredRow(row, scaler, model)),
      validationRows: fold.validationRows.map((row) => toScoredRow(row, scaler, model)),
    };
  });

  const foldBoundaries = folds.map((fold) => ({
    foldId: fold.foldId,
    trainRowCount: fold.trainRows.length,
    calibrationRowCount: fold.calibrationRows.length,
    validationRowCount: fold.validationRows.length,
    trainMaxTargetDate: fold.trainRows.reduce(
      (max, row) => (row.targetDate > max ? row.targetDate : max),
      fold.trainRows[0]!.targetDate,
    ),
    calibrationStartDate: fold.calibrationRows.reduce(
      (min, row) => (row.featureDate < min ? row.featureDate : min),
      fold.calibrationRows[0]!.featureDate,
    ),
    calibrationEndDate: fold.calibrationRows.reduce(
      (max, row) => (row.featureDate > max ? row.featureDate : max),
      fold.calibrationRows[0]!.featureDate,
    ),
    validationStartDate: fold.validationRows.reduce(
      (min, row) => (row.featureDate < min ? row.featureDate : min),
      fold.validationRows[0]!.featureDate,
    ),
    validationEndDate: fold.validationRows.reduce(
      (max, row) => (row.featureDate > max ? row.featureDate : max),
      fold.validationRows[0]!.featureDate,
    ),
  }));

  // Historical-only latest signal: score the single most recent feature row
  // (last row whose forward-return target already resolved within the
  // pinned dataset) using a model trained only on strictly earlier rows
  // (same expanding-window, no-leakage discipline as the walk-forward
  // folds). This is never a "today" prediction: signalAsOfFeatureDate and
  // signalAsOfTargetDate are always historical dates drawn from the pinned
  // input, disclosed explicitly by the caller alongside this value.
  const sortedFeatureRows = [...featureRows].sort((a, b) =>
    a.featureDate < b.featureDate ? -1 : a.featureDate > b.featureDate ? 1 : 0);
  const lastFeatureRow = sortedFeatureRows.at(-1)!;
  const latestTrainRows = sortedFeatureRows.filter((row) => row.targetDate < lastFeatureRow.featureDate);
  const { scaler: latestScaler, model: latestModel } = fitModelOnFeatureRows(latestTrainRows);
  const latestProbabilityUp = predictProbability(lastFeatureRow.features, latestScaler, latestModel);

  return {
    dataQualityFindings,
    featureRowCount: featureRows.length,
    foldBoundaries,
    foldInputs,
    latestSignal: {
      signalAsOfFeatureDate: lastFeatureRow.featureDate,
      signalAsOfTargetDate: lastFeatureRow.targetDate,
      probabilityUp: latestProbabilityUp,
      trainedOnRowCount: latestTrainRows.length,
    },
  };
}

export const LEGACY_ML_RETRAINING_STATUS = "NEGATIVE_HISTORICAL_EVIDENCE" as const;
export const PROMOTION_DECISION = "WITHHELD" as const;
export const PROMOTION_REASON = "STABILITY_GATE_EVIDENCE_ONLY_MANUAL_RESEARCH_REVIEW_REQUIRED" as const;
export const CURRENT_DATE_PREDICTION_CLAIM = false as const;
