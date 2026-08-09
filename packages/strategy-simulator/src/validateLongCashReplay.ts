import type { LongCashReplayResult, LongCashReplayWindow } from "./types.js";

const MAX_TRUST_SCORE = 100;
const DAY_IN_MILLISECONDS = 86_400_000;

const SUSPICIOUS_WIN_RATE = 0.8;
const SUSPICIOUS_WIN_RATE_MINIMUM_LONG_COUNT = 10;
const INSUFFICIENT_LONG_COUNT = 10;
const LOW_LONG_COUNT = 30;
const SUSPICIOUS_LOW_DRAWDOWN = 0.02;
const SUSPICIOUS_LOW_DRAWDOWN_MINIMUM_LONG_COUNT = 20;
const SUSPICIOUS_LOW_DRAWDOWN_MINIMUM_RETURN = 0.2;
const NO_COST_MINIMUM_LONG_COUNT = 5;
const SHORT_PERIOD_DAYS = 126;
const MODERATE_PERIOD_DAYS = 252;
const LOW_EXPOSURE = 0.1;
const LOW_EXPOSURE_MINIMUM_RETURN = 0.1;
const CONSECUTIVE_LOSSES = 5;

export type LongCashReplayIntegrityWarningCode =
  | "SUSPICIOUS_WIN_RATE"
  | "INSUFFICIENT_TRADES"
  | "LOW_TRADE_COUNT"
  | "SUSPICIOUS_LOW_DD"
  | "NO_COST_DETECTED"
  | "SHORT_PERIOD"
  | "MODERATE_PERIOD"
  | "LOW_EXPOSURE"
  | "CONSECUTIVE_LOSSES";

export type LongCashReplayIntegrityWarningSeverity = "critical" | "warning" | "info";

export interface LongCashReplayIntegrityWarning {
  readonly severity: LongCashReplayIntegrityWarningSeverity;
  readonly code: LongCashReplayIntegrityWarningCode;
  readonly message: string;
}

export interface LongCashReplayIntegrityReport {
  readonly passed: boolean;
  readonly trustScore: number;
  readonly warnings: readonly LongCashReplayIntegrityWarning[];
  readonly summary: string;
}

interface WarningDefinition {
  readonly severity: LongCashReplayIntegrityWarningSeverity;
  readonly code: LongCashReplayIntegrityWarningCode;
  readonly penalty: number;
  readonly message: string;
}

function parseDate(date: string): Date {
  const [yearText, monthText, dayText] = date.split("-");
  const parsed = new Date(0);
  parsed.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
}

function compareWindows(
  left: { readonly window: LongCashReplayWindow; readonly index: number },
  right: { readonly window: LongCashReplayWindow; readonly index: number },
): number {
  if (left.window.entryDate < right.window.entryDate) return -1;
  if (left.window.entryDate > right.window.entryDate) return 1;
  if (left.window.exitDate < right.window.exitDate) return -1;
  if (left.window.exitDate > right.window.exitDate) return 1;
  return left.index - right.index;
}

function chronologicalWindows(replay: LongCashReplayResult): readonly LongCashReplayWindow[] {
  return replay.windows
    .map((window, index) => ({ window, index }))
    .sort(compareWindows)
    .map(({ window }) => window);
}

function evaluationPeriodDays(windows: readonly LongCashReplayWindow[]): number | undefined {
  if (windows.length === 0) return undefined;
  const firstWindow = windows[0]!;
  const lastWindow = windows[windows.length - 1]!;
  return (parseDate(lastWindow.exitDate).getTime() - parseDate(firstWindow.entryDate).getTime())
    / DAY_IN_MILLISECONDS;
}

function maximumConsecutiveLosingLongObservations(
  windows: readonly LongCashReplayWindow[],
): number {
  let current = 0;
  let maximum = 0;
  for (const window of windows) {
    if (window.strategyPosition !== "LONG") continue;
    if (window.strategyNetReturn < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function addWarning(
  warnings: LongCashReplayIntegrityWarning[],
  definition: WarningDefinition,
): number {
  warnings.push(Object.freeze({
    severity: definition.severity,
    code: definition.code,
    message: definition.message,
  }));
  return definition.penalty;
}

export function validateLongCashReplay(
  replay: LongCashReplayResult,
): LongCashReplayIntegrityReport {
  const warnings: LongCashReplayIntegrityWarning[] = [];
  let penalty = 0;
  const windows = chronologicalWindows(replay);
  const longWindowCount = replay.strategy.longWindowCount;
  const windowCount = replay.windows.length;

  const longWinRate = longWindowCount === 0
    ? 0
    : replay.strategy.winningLongTradeCount / longWindowCount;
  if (longWinRate > SUSPICIOUS_WIN_RATE && longWindowCount > SUSPICIOUS_WIN_RATE_MINIMUM_LONG_COUNT) {
    penalty += addWarning(warnings, {
      severity: "critical",
      code: "SUSPICIOUS_WIN_RATE",
      penalty: 25,
      message: `LONG win rate ${(longWinRate * 100).toFixed(1)}% is unusually high`,
    });
  }

  if (longWindowCount < INSUFFICIENT_LONG_COUNT) {
    penalty += addWarning(warnings, {
      severity: "warning",
      code: "INSUFFICIENT_TRADES",
      penalty: 20,
      message: `Only ${longWindowCount} LONG observations are available; the sample is insufficient`,
    });
  } else if (longWindowCount < LOW_LONG_COUNT) {
    penalty += addWarning(warnings, {
      severity: "warning",
      code: "LOW_TRADE_COUNT",
      penalty: 10,
      message: `${longWindowCount} LONG observations provide a limited sample`,
    });
  }

  if (
    replay.strategy.maximumDrawdown < SUSPICIOUS_LOW_DRAWDOWN
    && longWindowCount > SUSPICIOUS_LOW_DRAWDOWN_MINIMUM_LONG_COUNT
    && replay.strategy.totalReturn > SUSPICIOUS_LOW_DRAWDOWN_MINIMUM_RETURN
  ) {
    penalty += addWarning(warnings, {
      severity: "critical",
      code: "SUSPICIOUS_LOW_DD",
      penalty: 25,
      message: `Maximum drawdown is ${(replay.strategy.maximumDrawdown * 100).toFixed(2)}% while LONG return is ${(replay.strategy.totalReturn * 100).toFixed(1)}%`,
    });
  }

  if (replay.roundTripCostBps === 0 && longWindowCount > NO_COST_MINIMUM_LONG_COUNT) {
    penalty += addWarning(warnings, {
      severity: "warning",
      code: "NO_COST_DETECTED",
      penalty: 15,
      message: `No transaction cost is configured for ${longWindowCount} LONG observations`,
    });
  }

  const periodDays = evaluationPeriodDays(windows);
  if (periodDays !== undefined && periodDays < SHORT_PERIOD_DAYS) {
    penalty += addWarning(warnings, {
      severity: "warning",
      code: "SHORT_PERIOD",
      penalty: 15,
      message: `Evaluation period is ${periodDays} days, shorter than ${SHORT_PERIOD_DAYS} days`,
    });
  } else if (periodDays !== undefined && periodDays < MODERATE_PERIOD_DAYS) {
    penalty += addWarning(warnings, {
      severity: "info",
      code: "MODERATE_PERIOD",
      penalty: 5,
      message: `Evaluation period is ${periodDays} days, shorter than ${MODERATE_PERIOD_DAYS} days`,
    });
  }

  const longExposure = windowCount === 0 ? 0 : longWindowCount / windowCount;
  if (longExposure < LOW_EXPOSURE && replay.strategy.totalReturn > LOW_EXPOSURE_MINIMUM_RETURN) {
    penalty += addWarning(warnings, {
      severity: "info",
      code: "LOW_EXPOSURE",
      penalty: 0,
      message: `LONG exposure is ${(longExposure * 100).toFixed(1)}% of replay windows`,
    });
  }

  const maximumConsecutiveLosses = maximumConsecutiveLosingLongObservations(windows);
  if (maximumConsecutiveLosses >= CONSECUTIVE_LOSSES) {
    penalty += addWarning(warnings, {
      severity: "info",
      code: "CONSECUTIVE_LOSSES",
      penalty: 0,
      message: `The replay contains ${maximumConsecutiveLosses} consecutive losing LONG observations`,
    });
  }

  const frozenWarnings = Object.freeze(warnings);
  const trustScore = Math.max(0, Math.min(MAX_TRUST_SCORE, MAX_TRUST_SCORE - penalty));
  const criticalWarningCount = warnings.filter((warning) => warning.severity === "critical").length;
  const report = {
    passed: criticalWarningCount === 0,
    trustScore,
    warnings: frozenWarnings,
    summary: warnings.length === 0
      ? "No mapped replay-integrity warning detected."
      : `${warnings.length} replay-integrity caution${warnings.length === 1 ? "" : "s"} detected before interpreting this result.`,
  } satisfies LongCashReplayIntegrityReport;

  return Object.freeze(report);
}
