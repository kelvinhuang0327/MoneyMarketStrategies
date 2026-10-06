/** Offline diagnostic adaptation of legacy StockFundamentalSnapshot.ts.
 * Availability is caller-declared, never inferred from a fiscal period. */
export type FundamentalFamily = "REVENUE" | "PROFITABILITY" | "VALUATION" | "FINANCIAL_STRUCTURE";
export type FundamentalUnit = "CURRENCY" | "CURRENCY_PER_SHARE" | "PERCENT_POINTS" | "MULTIPLE";
export type FundamentalMetric = "revenue" | "yoyGrowth" | "momGrowth" | "eps" | "grossMargin" | "operatingMargin"
  | "pe" | "pb" | "dividendYield" | "debtRatio" | "liabilitiesRatio" | "currentRatio" | "quickRatio"
  | "roe" | "roa" | "assetTurnover" | "cashflowConversion";
export interface FundamentalValue {
  readonly value: number | null;
  readonly unit: FundamentalUnit | null;
  readonly scale: number | null;
}
export interface FundamentalObservation {
  readonly recordId: string;
  readonly symbol: string;
  readonly family: FundamentalFamily;
  /** Calendar YYYY-MM for revenue, calendar YYYY-Qn for reports, YYYY-MM-DD for valuation. */
  readonly period: string;
  readonly publishedAt: string | null;
  /** First independently known availability of THIS version, not today's fetch date backdated. */
  readonly observedAt: string | null;
  readonly source: { readonly id: string; readonly uri: string | null };
  readonly currencyCode: string;
  readonly reportingBasis?: "SINGLE_QUARTER" | "CUMULATIVE_YTD";
  /** Explicit formula/measurement conventions for derived ratios. Missing is unknown. */
  readonly metricBases?: Readonly<Partial<Record<FundamentalMetric, string>>>;
  readonly values: Readonly<Partial<Record<FundamentalMetric, FundamentalValue>>>;
  /** Membership must also have been known by this record's availability time. */
  readonly group?: { readonly industry?: string | null; readonly sector?: string | null };
}
export interface FundamentalFinding {
  readonly recordId: string;
  readonly code: string;
  readonly metric?: FundamentalMetric;
}
export interface NormalizedFundamentalValue {
  readonly value: number | null;
  readonly unit: FundamentalUnit;
  readonly currencyCode: string | null;
  readonly sourceScale: number | null;
  readonly missingReason: string | null;
}
export const FUNDAMENTAL_UNITS: Readonly<Record<FundamentalMetric, FundamentalUnit>> = {
  revenue: "CURRENCY", yoyGrowth: "PERCENT_POINTS", momGrowth: "PERCENT_POINTS", eps: "CURRENCY_PER_SHARE",
  grossMargin: "PERCENT_POINTS", operatingMargin: "PERCENT_POINTS", pe: "MULTIPLE", pb: "MULTIPLE",
  dividendYield: "PERCENT_POINTS", debtRatio: "PERCENT_POINTS", liabilitiesRatio: "PERCENT_POINTS",
  currentRatio: "MULTIPLE", quickRatio: "MULTIPLE", roe: "PERCENT_POINTS", roa: "PERCENT_POINTS",
  assetTurnover: "MULTIPLE", cashflowConversion: "MULTIPLE",
};
const FAMILIES = ["REVENUE", "PROFITABILITY", "VALUATION", "FINANCIAL_STRUCTURE"] as const;

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function fundamentalTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:[0-5]\d)$/.test(value)
    || !validDate(value.slice(0, 10))) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}
function periodEnd(row: FundamentalObservation): string | null {
  if (row.family === "VALUATION") return validDate(row.period) ? row.period : null;
  const match = row.family === "REVENUE" ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(row.period) : /^(\d{4})-Q([1-4])$/.exec(row.period);
  if (!match) return null;
  const month = Number(match[2]) * (row.family === "REVENUE" ? 1 : 3);
  const result = new Date(0);
  result.setUTCFullYear(Number(match[1]), month, 0);
  return result.toISOString().slice(0, 10);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? "undefined";
}

/** Filter first; deduplicate version IDs; select latest available revision per period.
 * A tied, conflicting revision makes that whole period unavailable. */
export function selectFundamentalObservations(observations: readonly FundamentalObservation[], asOf: string) {
  const cutoff = fundamentalTimestamp(asOf);
  if (cutoff === null) throw new TypeError("asOf must be an ISO timestamp with explicit timezone");
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const findings: FundamentalFinding[] = [];
  const byId = new Map<string, FundamentalObservation>();
  const conflictingIds = new Set<string>();
  for (const row of observations) {
    if (!row || typeof row !== "object" || typeof row.recordId !== "string" || row.recordId.trim() === ""
      || typeof row.symbol !== "string" || row.symbol.trim() === "" || !FAMILIES.includes(row.family)
      || !row.source || typeof row.source.id !== "string" || row.source.id.trim() === ""
      || !(row.source.uri === null || typeof row.source.uri === "string") || !/^[A-Z]{3}$/.test(row.currencyCode)
      || typeof row.values !== "object" || row.values === null || Array.isArray(row.values)) throw new TypeError("malformed fundamental record identity, source, currency or values");
    if (row.group !== undefined && (row.group === null || typeof row.group !== "object" || Array.isArray(row.group)
      || [row.group.industry, row.group.sector].some((group) => group !== undefined && group !== null && (typeof group !== "string" || group.trim() === "")))) {
      throw new TypeError("group membership must be explicit non-empty identifiers or null");
    }
    if (row.reportingBasis !== undefined && !["SINGLE_QUARTER", "CUMULATIVE_YTD"].includes(row.reportingBasis)) throw new TypeError("unknown reporting basis");
    if (row.metricBases !== undefined && (row.metricBases === null || typeof row.metricBases !== "object" || Array.isArray(row.metricBases)
      || Object.entries(row.metricBases).some(([key, value]) => !Object.hasOwn(FUNDAMENTAL_UNITS, key) || typeof value !== "string" || !value.trim()))) throw new TypeError("invalid metric measurement basis");
    const publication = fundamentalTimestamp(row.publishedAt);
    const observed = fundamentalTimestamp(row.observedAt);
    const end = typeof row.period === "string" ? periodEnd(row) : null;
    let code: string | null = null;
    if (publication === null) code = "UNKNOWN_OR_INVALID_PUBLICATION";
    else if (observed === null) code = "UNKNOWN_OR_INVALID_AVAILABILITY";
    else if (observed < publication) code = "AVAILABILITY_BEFORE_PUBLICATION";
    else if (publication > cutoff || observed > cutoff) code = "NOT_AVAILABLE_AS_OF";
    else if (end === null) code = "INVALID_PERIOD";
    else if (Date.parse(`${end}T00:00:00Z`) + (row.family === "VALUATION" ? 0 : 86_400_000) > publication) code = "PERIOD_NOT_COMPLETED_AT_PUBLICATION";
    if (code) { findings.push({ recordId: row.recordId, code }); continue; }
    const key = `${row.symbol}|${row.family}|${row.recordId}`;
    const prior = byId.get(key);
    if (prior && stable(prior) !== stable(row)) {
      conflictingIds.add(key); findings.push({ recordId: row.recordId, code: "CONFLICTING_RECORD_ID" });
    } else if (prior) findings.push({ recordId: row.recordId, code: "DUPLICATE_RECORD" });
    else byId.set(key, row);
  }
  const byPeriod = new Map<string, FundamentalObservation[]>();
  for (const [key, row] of byId) {
    if (conflictingIds.has(key)) continue;
    const periodKey = `${row.symbol}|${row.family}|${row.period}`;
    byPeriod.set(periodKey, [...(byPeriod.get(periodKey) ?? []), row]);
  }
  const selected: FundamentalObservation[] = [];
  for (const rows of byPeriod.values()) {
    const sorted = [...rows].sort((a, b) => fundamentalTimestamp(b.publishedAt)! - fundamentalTimestamp(a.publishedAt)!
      || fundamentalTimestamp(b.observedAt)! - fundamentalTimestamp(a.observedAt)! || a.recordId.localeCompare(b.recordId));
    const latest = sorted[0]!;
    const ties = sorted.filter((row) => row.publishedAt !== null && fundamentalTimestamp(row.publishedAt) === fundamentalTimestamp(latest.publishedAt)
      && fundamentalTimestamp(row.observedAt) === fundamentalTimestamp(latest.observedAt));
    const content = (row: FundamentalObservation) => stable({ values: row.values, currencyCode: row.currencyCode, reportingBasis: row.reportingBasis, metricBases: row.metricBases, group: row.group });
    if (ties.some((row) => content(row) !== content(latest))) {
      for (const row of ties) findings.push({ recordId: row.recordId, code: "AMBIGUOUS_PERIOD_REVISION" });
      continue;
    }
    selected.push(latest);
    for (const row of sorted.slice(1)) findings.push({ recordId: row.recordId, code: "SUPERSEDED_OR_REDUNDANT_REVISION" });
  }
  selected.sort((a, b) => b.period.localeCompare(a.period) || a.symbol.localeCompare(b.symbol) || a.family.localeCompare(b.family));
  findings.sort((a, b) => a.recordId.localeCompare(b.recordId) || a.code.localeCompare(b.code));
  return { asOf: new Date(cutoff).toISOString(), selected, findings, inputRecordCount: observations.length, selectedPeriodRecordCount: selected.length };
}

export function normalizeFundamentalValue(row: FundamentalObservation | null, metric: FundamentalMetric): NormalizedFundamentalValue {
  const unit = FUNDAMENTAL_UNITS[metric];
  const raw = row?.values[metric];
  let missingReason: string | null = null;
  if (!raw || raw.value === null || raw.value === undefined) missingReason = "MISSING_VALUE";
  else if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) missingReason = "NON_FINITE_VALUE";
  else if (raw.unit !== unit) missingReason = "UNKNOWN_OR_INCOMPATIBLE_UNIT";
  else if (unit === "CURRENCY" ? ![1, 1000, 1_000_000].includes(raw.scale ?? 0) : raw.scale !== 1) missingReason = "UNKNOWN_OR_INCOMPATIBLE_SCALE";
  const normalized = missingReason === null ? raw!.value! * raw!.scale! : null;
  if (normalized !== null && (!Number.isFinite(normalized) || Math.abs(normalized) > Number.MAX_SAFE_INTEGER)) missingReason = "UNSAFE_MAGNITUDE";
  return {
    value: missingReason === null ? normalized : null, unit,
    currencyCode: unit === "CURRENCY" || unit === "CURRENCY_PER_SHARE" ? row?.currencyCode ?? null : null,
    sourceScale: typeof raw?.scale === "number" && Number.isFinite(raw.scale) ? raw.scale : null, missingReason,
  };
}
export function fundamentalReference(row: FundamentalObservation | null) {
  return row === null ? null : { recordId: row.recordId, symbol: row.symbol, period: row.period,
    publishedAt: row.publishedAt, observedAt: row.observedAt, currencyCode: row.currencyCode, reportingBasis: row.reportingBasis ?? null,
    ...(row.metricBases ? { metricBases: { ...row.metricBases } } : {}), source: { ...row.source } };
}
function monthOrdinal(period: string): number { return Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1; }
function quarterOrdinal(period: string): number { return Number(period.slice(0, 4)) * 4 + Number(period.slice(6)) - 1; }
function difference(a: NormalizedFundamentalValue, b: NormalizedFundamentalValue, comparable: boolean): number | null {
  return !comparable || a.value === null || b.value === null ? null : Math.round((a.value - b.value) * 1e8) / 1e8;
}

export function buildStockFundamentalSnapshot(input: {
  readonly symbol: string; readonly kind: "stock" | "etf"; readonly asOf: string; readonly observations: readonly FundamentalObservation[];
}) {
  if (!input || typeof input.symbol !== "string" || !input.symbol.trim() || !["stock", "etf"].includes(input.kind)) throw new TypeError("snapshot requires symbol and explicit stock/etf kind");
  const selection = selectFundamentalObservations(input.observations, input.asOf);
  const rows = selection.selected.filter((row) => row.symbol === input.symbol);
  const companyApplicable = input.kind === "stock";
  const revenues = companyApplicable ? rows.filter((row) => row.family === "REVENUE") : [];
  const reports = companyApplicable ? rows.filter((row) => row.family === "PROFITABILITY") : [];
  const revenueRow = revenues[0] ?? null;
  const report = reports[0] ?? null;
  const previous = reports[1] ?? null;
  const valuationRow = rows.find((row) => row.family === "VALUATION") ?? null;
  const yoy = revenues.slice(0, 3).map((row) => normalizeFundamentalValue(row, "yoyGrowth").value);
  const contiguous = revenues.length >= 2 && monthOrdinal(revenues[0]!.period) - monthOrdinal(revenues[1]!.period) === 1;
  const three = contiguous && revenues.length >= 3 && monthOrdinal(revenues[1]!.period) - monthOrdinal(revenues[2]!.period) === 1;
  const trend = !contiguous || yoy[0] === null || yoy[1] === null ? "insufficient"
    : three && yoy[2] !== null && yoy[0]! > yoy[1]! && yoy[1]! > yoy[2]! ? "accelerating"
    : yoy[0]! > yoy[1]! && yoy[0]! > 0 ? "improving" : yoy[0]! < yoy[1]! ? "weakening" : "stable";
  let positiveMonths = 0;
  for (let i = 0; i < revenues.length; i++) {
    if (i > 0 && monthOrdinal(revenues[i - 1]!.period) - monthOrdinal(revenues[i]!.period) !== 1) break;
    if ((normalizeFundamentalValue(revenues[i]!, "yoyGrowth").value ?? -Infinity) <= 0) break;
    positiveMonths++;
  }
  const adjacent = report !== null && previous !== null && quarterOrdinal(report.period) - quarterOrdinal(previous.period) === 1;
  const sameCurrency = report !== null && previous !== null && report.currencyCode === previous.currencyCode;
  const singleQuarter = report?.reportingBasis === "SINGLE_QUARTER" && previous?.reportingBasis === "SINGLE_QUARTER";
  const eps = normalizeFundamentalValue(report, "eps");
  const previousEps = normalizeFundamentalValue(previous, "eps");
  const grossMargin = normalizeFundamentalValue(report, "grossMargin");
  const operatingMargin = normalizeFundamentalValue(report, "operatingMargin");
  const revenue = { applicable: companyApplicable, sourceRecord: fundamentalReference(revenueRow), revenue: normalizeFundamentalValue(revenueRow, "revenue"),
    yoyGrowth: normalizeFundamentalValue(revenueRow, "yoyGrowth"), momGrowth: normalizeFundamentalValue(revenueRow, "momGrowth"), trend, consecutivePositiveYoYMonths: positiveMonths };
  const profitability = { applicable: companyApplicable, sourceRecord: fundamentalReference(report), previousSourceRecord: fundamentalReference(previous),
    eps, previousEps, grossMargin, operatingMargin,
    epsQoQDelta: difference(eps, previousEps, adjacent && sameCurrency && singleQuarter),
    grossMarginDeltaPercentagePoints: difference(grossMargin, normalizeFundamentalValue(previous, "grossMargin"), adjacent && sameCurrency && singleQuarter),
    operatingMarginDeltaPercentagePoints: difference(operatingMargin, normalizeFundamentalValue(previous, "operatingMargin"), adjacent && sameCurrency && singleQuarter),
    deltaUnavailableReason: !report || !previous ? "MISSING_REPORT" : !adjacent ? "NON_CONSECUTIVE_QUARTER" : !sameCurrency ? "CURRENCY_MISMATCH" : !singleQuarter ? "REPORTING_BASIS_NOT_SINGLE_QUARTER" : null };
  const valuation = { sourceRecord: fundamentalReference(valuationRow), pe: normalizeFundamentalValue(valuationRow, "pe"), pb: normalizeFundamentalValue(valuationRow, "pb"), dividendYield: normalizeFundamentalValue(valuationRow, "dividendYield") };
  const familiesAvailable = Number(revenue.revenue.value !== null) + Number(eps.value !== null || grossMargin.value !== null || operatingMargin.value !== null)
    + Number(valuation.pe.value !== null || valuation.pb.value !== null || valuation.dividendYield.value !== null);
  return {
    schemaVersion: "MMS_FUNDAMENTAL_SNAPSHOT_V1", classification: "DIAGNOSTIC_ONLY", symbol: input.symbol, kind: input.kind, asOf: selection.asOf,
    dataCoverage: companyApplicable ? familiesAvailable === 3 ? "full" : familiesAvailable === 2 ? "limited" : "insufficient"
      : valuation.pe.value !== null || valuation.pb.value !== null || valuation.dividendYield.value !== null ? "limited" : "insufficient",
    dataCoverageMeaning: "Availability of fields, not freshness, audited accuracy or accounting completeness.",
    revenue, profitability, valuation,
    availabilityAudit: { inputRecordCount: selection.inputRecordCount, selectedPeriodRecordCount: selection.selectedPeriodRecordCount, findings: selection.findings },
    limitations: [
      "Publication, version availability, fiscal periods, currency and source are input declarations; this function does not independently verify them.",
      "Unknown publication/availability is excluded; future/restated versions are not backdated. Calendar month/quarter periods must finish on the UTC calendar before publication; same-day valuation quotes use explicit publication time.",
      "Money scales normalize to major currency units; currencies are never converted. Missing values stay null; audit counts are not predictive features.",
      "Quarter changes require declared single-quarter reporting. Share-basis adjustments, fiscal-calendar remapping and accounting-definition verification are not performed.",
      ...(companyApplicable ? [] : ["ETF company revenue/EPS/margins are not applicable and remain empty."]),
      "This snapshot is descriptive. It provides no trading signal, profitability claim or execution capability.",
    ],
  } as const;
}
