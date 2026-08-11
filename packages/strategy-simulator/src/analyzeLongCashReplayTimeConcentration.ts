import type { LongCashReplayResult, LongCashReplayWindow } from "./types.js";

const SCHEMA_VERSION = "MMS_LONG_CASH_REPLAY_TIME_CONCENTRATION_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const DECIMAL_PLACES = 8;

export type LongCashReplayTimeConcentrationStatus = "candidate" | "no_candidate";

export interface LongCashReplayTimeCohortContribution {
  readonly cohortKey: string;
  readonly entryDateRange: string;
  readonly exitDateRange: string;
  readonly entryDates: readonly string[];
  readonly exitDates: readonly string[];
  readonly tradeCount: number;
  readonly tradeShare: number;
  readonly winCount: number;
  readonly hitRate: number;
  readonly averageProbabilityUp: number;
  readonly averageForwardReturnGross: number;
  readonly averageNetReturnAfterCost: number;
  readonly cumulativeNetContributionApprox: number;
  readonly bestTradeForwardReturn: number;
  readonly worstTradeForwardReturn: number;
}

export interface LongCashReplayTimeConcentration {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly status: LongCashReplayTimeConcentrationStatus;
  readonly symbol: string;
  readonly validationThreshold: number;
  readonly longWindowCount: number;
  readonly cohortCount: number;
  readonly dominantCohortKey: string | null;
  readonly dominantTradeShare: number | null;
  readonly isTimeConcentrated: boolean;
  readonly rows: readonly LongCashReplayTimeCohortContribution[];
  readonly caveats: readonly string[];
  readonly reason: string;
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function dateRange(dates: readonly string[]): string {
  const first = dates[0] ?? "";
  const last = dates.at(-1) ?? first;
  return first === last ? first : `${first} -> ${last}`;
}

function cohortKey(window: LongCashReplayWindow): string {
  return window.entryDate.slice(0, 7);
}

function buildCaveats(
  tradeCount: number,
  cohortCount: number,
  isTimeConcentrated: boolean,
): readonly string[] {
  return Object.freeze([
    "Calendar-month cohort contribution is descriptive sample attribution from completed replay windows and is approximate.",
    ...(tradeCount < 10
      ? ["Small sample: selected LONG window count is below 10; concentration can dominate sample results."]
      : []),
    ...(cohortCount <= 2
      ? ["Date concentration warning: selected LONG windows occur in two or fewer calendar-month cohorts."]
      : []),
    ...(isTimeConcentrated
      ? ["Concentration warning: selected LONG windows are dominated by one calendar-month cohort or a small number of cohorts."]
      : []),
    "Research-only time-cohort analysis; not investment advice.",
    "Completed replay outcomes are used downstream only; this analysis cannot change historical positions or threshold selection.",
  ]);
}

function emptyCaveats(): readonly string[] {
  return Object.freeze([
    "No LONG replay windows are available for time-cohort attribution.",
    "Research-only time-cohort analysis; not investment advice.",
    "Completed replay outcomes are used downstream only; this analysis cannot change historical positions or threshold selection.",
  ]);
}

function buildRow(
  cohort: string,
  windows: readonly LongCashReplayWindow[],
  totalTradeCount: number,
): LongCashReplayTimeCohortContribution {
  const entryDates = uniqueSorted(windows.map((window) => window.entryDate));
  const exitDates = uniqueSorted(windows.map((window) => window.exitDate));
  const forwardReturns = windows.map((window) => window.realizedForwardReturn);
  const netReturns = windows.map((window) => window.strategyNetReturn);
  const winCount = windows.filter((window) => window.realizedForwardReturn > 0).length;

  return Object.freeze({
    cohortKey: cohort,
    entryDateRange: dateRange(entryDates),
    exitDateRange: dateRange(exitDates),
    entryDates,
    exitDates,
    tradeCount: windows.length,
    tradeShare: round(windows.length / totalTradeCount),
    winCount,
    hitRate: round(winCount / windows.length),
    averageProbabilityUp: round(mean(windows.map((window) => window.probabilityUp))),
    averageForwardReturnGross: round(mean(forwardReturns)),
    averageNetReturnAfterCost: round(mean(netReturns)),
    cumulativeNetContributionApprox: round(
      netReturns.reduce((total, value) => total + value, 0) / totalTradeCount,
    ),
    bestTradeForwardReturn: round(Math.max(...forwardReturns)),
    worstTradeForwardReturn: round(Math.min(...forwardReturns)),
  });
}

export function analyzeLongCashReplayTimeConcentration(
  replay: LongCashReplayResult,
): LongCashReplayTimeConcentration {
  const longWindows = replay.windows.filter((window) => window.strategyPosition === "LONG");
  if (longWindows.length === 0) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      researchMode: RESEARCH_MODE,
      status: "no_candidate",
      symbol: replay.symbol,
      validationThreshold: replay.validationThreshold,
      longWindowCount: 0,
      cohortCount: 0,
      dominantCohortKey: null,
      dominantTradeShare: null,
      isTimeConcentrated: false,
      rows: Object.freeze([]),
      caveats: emptyCaveats(),
      reason: "No LONG replay windows are available for time-cohort attribution.",
    });
  }

  const byCohort = new Map<string, LongCashReplayWindow[]>();
  for (const window of longWindows) {
    const key = cohortKey(window);
    byCohort.set(key, [...(byCohort.get(key) ?? []), window]);
  }

  const totalTradeCount = longWindows.length;
  const rows = [...byCohort.entries()]
    .map(([key, windows]) => buildRow(key, windows, totalTradeCount))
    .sort((left, right) =>
      right.tradeCount - left.tradeCount
      || right.cumulativeNetContributionApprox - left.cumulativeNetContributionApprox
      || compareText(left.cohortKey, right.cohortKey));
  const frozenRows = Object.freeze(rows);
  const dominant = frozenRows[0] ?? null;
  const dominantTradeShare = dominant?.tradeShare ?? null;
  const cohortCount = frozenRows.length;
  const isTimeConcentrated = (dominantTradeShare ?? 0) >= 0.5 || cohortCount <= 2;

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    status: "candidate",
    symbol: replay.symbol,
    validationThreshold: replay.validationThreshold,
    longWindowCount: totalTradeCount,
    cohortCount,
    dominantCohortKey: dominant?.cohortKey ?? null,
    dominantTradeShare,
    isTimeConcentrated,
    rows: frozenRows,
    caveats: buildCaveats(totalTradeCount, cohortCount, isTimeConcentrated),
    reason: "Grouped completed LONG replay windows by entry calendar month for approximate time attribution.",
  });
}
