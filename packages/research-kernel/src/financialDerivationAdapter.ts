import { fundamentalTimestamp, type FundamentalObservation, type FundamentalUnit } from "./fundamentalSnapshots.js";

export type FinancialField = "revenue" | "netIncome" | "operatingIncome" | "operatingCashFlow" | "capitalExpenditure" | "interestExpense"
  | "totalAssets" | "totalLiabilities" | "equity" | "currentAssets" | "currentLiabilities" | "inventory"
  | "totalDebt" | "shortTermDebt" | "longTermDebt" | "openingTotalAssets" | "openingEquity";
export interface FinancialAmount {
  readonly value: number | null;
  readonly unit: "CURRENCY" | null;
  readonly scale: 1 | 1000 | 1000000 | null;
  readonly currencyCode: string | null;
}
export interface FinancialStatementInput {
  /** Identifies this exact revision, never an issuer/quarter alone. */
  readonly reportId: string;
  readonly symbol: string;
  readonly period: string;
  readonly currencyCode: string;
  /** All amounts, including income and both equity balances, cover the TOTAL entity.
   * Parent-attributable earnings/equity cannot be substituted without reconciliation. */
  readonly accountingBasis: { readonly kind: "CONSOLIDATED_TOTAL_ENTITY" | "SEPARATE_TOTAL_ENTITY" | null; readonly evidenceUri: string | null };
  readonly source: { readonly id: string; readonly uri: string | null; readonly sha256: string | null };
  readonly publication: { readonly at: string | null; readonly evidenceUri: string | null };
  readonly availability: { readonly at: string | null; readonly evidenceUri: string | null };
  readonly balanceDate: string | null;
  readonly openingBalanceDate: string | null;
  readonly flowStartDate: string | null;
  readonly flowEndDate: string | null;
  readonly flowBasis: "SINGLE_QUARTER" | "CUMULATIVE_YTD" | null;
  /** Same accounting scope AND restatement cohort; equality is caller-evidenced, not inferred. */
  readonly comparability: { readonly key: string | null; readonly evidenceUri: string | null };
  readonly priorCumulativeReportId?: string;
  readonly expenseSign: "POSITIVE_EXPENSE" | "NEGATIVE_CASH_OUTFLOW" | null;
  readonly amounts: Readonly<Partial<Record<FinancialField, FinancialAmount>>>;
  readonly group?: FundamentalObservation["group"];
}
interface Operand {
  readonly reportId: string; readonly field: FinancialField; readonly value: number | null;
  readonly sourceScale: number | null; readonly currencyCode: string | null; readonly reason: string | null;
}
export interface FinancialDerivation {
  readonly value: number | null; readonly unit: FundamentalUnit; readonly currencyCode: string | null;
  readonly formula: string; readonly basis: string; readonly numerator: number | null; readonly denominator: number | null;
  readonly reason: string | null; readonly operands: readonly Operand[];
}
const FLOW_FIELDS = ["revenue", "netIncome", "operatingIncome", "operatingCashFlow", "capitalExpenditure", "interestExpense"] as const;
const METRICS = ["debtRatio", "liabilitiesRatio", "currentRatio", "quickRatio", "roe", "roa", "assetTurnover", "cashflowConversion"] as const;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function uri(v: unknown): v is string { return nonempty(v) && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v); }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}
function dates(period: string) {
  const match = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!match || Number(match[1]) < 1900) return null;
  const year = Number(match[1]); const quarter = Number(match[2]);
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3, 0));
  return { year, quarter, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    opening: new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10), ytdStart: `${match[1]}-01-01` };
}
function amount(report: FinancialStatementInput, field: FinancialField, gate: string | null = null): Operand {
  const a = report.amounts[field];
  let reason = gate;
  if (!reason && (!a || a.value === null || a.value === undefined)) reason = "MISSING_AMOUNT";
  if (!reason && (typeof a?.value !== "number" || !Number.isFinite(a.value))) reason = "NON_FINITE_AMOUNT";
  if (!reason && a?.unit !== "CURRENCY") reason = "UNKNOWN_OR_INCOMPATIBLE_UNIT";
  if (!reason && ![1, 1000, 1000000].includes(a?.scale ?? 0)) reason = "UNKNOWN_OR_INCOMPATIBLE_SCALE";
  if (!reason && a?.currencyCode !== report.currencyCode) reason = "UNKNOWN_OR_INCOMPATIBLE_CURRENCY";
  const normalized = !reason ? a!.value! * a!.scale! : null;
  if (!reason && Math.abs(normalized!) > Number.MAX_SAFE_INTEGER) reason = "UNSAFE_MAGNITUDE";
  return { reportId: report.reportId, field, value: reason ? null : normalized, sourceScale: a?.scale ?? null,
    currencyCode: a?.currencyCode ?? null, reason };
}
function derive(formula: string, basis: string, unit: FundamentalUnit, operands: readonly Operand[],
  compute: (values: number[]) => { numerator: number; denominator?: number; value?: number }, currencyCode: string, gate: string | null = null): FinancialDerivation {
  let reason = gate ?? operands.find((o) => o.reason)?.reason ?? null;
  let numerator: number | null = null; let denominator: number | null = null; let value: number | null = null;
  if (!reason) {
    const result = compute(operands.map((o) => o.value!));
    numerator = result.numerator; denominator = result.denominator ?? null;
    if (denominator !== null && denominator <= 0) reason = "NON_POSITIVE_DENOMINATOR";
    else value = result.value ?? (denominator === null ? numerator : numerator / denominator * (unit === "PERCENT_POINTS" ? 100 : 1));
    if (!reason && (!Number.isFinite(value) || Math.abs(value!) > Number.MAX_SAFE_INTEGER)) reason = "UNSAFE_DERIVED_MAGNITUDE";
  }
  return { value: reason ? null : value, unit, currencyCode: unit === "CURRENCY" ? currencyCode : null,
    formula, basis, numerator, denominator, reason, operands };
}
function reference(report: FinancialStatementInput) {
  return { reportId: report.reportId, symbol: report.symbol, period: report.period, source: { ...report.source },
    publication: { ...report.publication }, availability: { ...report.availability }, comparability: { ...report.comparability },
    accountingBasis: { ...report.accountingBasis }, expenseSign: report.expenseSign,
    flowBasis: report.flowBasis, flowStartDate: report.flowStartDate, flowEndDate: report.flowEndDate,
    balanceDate: report.balanceDate, openingBalanceDate: report.openingBalanceDate };
}

/** Pure offline adapter. Hash/evidence fields are declarations supplied with archived bytes,
 * not proof that a remote filing has been independently authenticated. No date/FX/zero imputation. */
export function deriveFinancialStatements(reports: readonly FinancialStatementInput[], asOf: string) {
  const cutoff = fundamentalTimestamp(asOf);
  if (cutoff === null) throw new TypeError("asOf requires an ISO timestamp with explicit timezone");
  if (!Array.isArray(reports)) throw new TypeError("financialStatements must be an array");
  const findings: { reportId: string; code: string }[] = [];
  const byId = new Map<string, FinancialStatementInput>(); const conflicts = new Set<string>();
  for (const r of reports) {
    if (!r || !nonempty(r.reportId) || !nonempty(r.symbol) || !r.amounts || typeof r.amounts !== "object" || Array.isArray(r.amounts)) {
      throw new TypeError("financial statement requires a version ID, symbol and amounts object");
    }
    const d = typeof r.period === "string" ? dates(r.period) : null;
    const pub = fundamentalTimestamp(r.publication?.at); const available = fundamentalTimestamp(r.availability?.at);
    const code = !d ? "INVALID_CALENDAR_QUARTER"
      : !/^[A-Z]{3}$/.test(r.currencyCode) ? "UNKNOWN_CURRENCY"
      : !nonempty(r.source?.id) || !uri(r.source?.uri) || !/^[a-f0-9]{64}$/i.test(r.source?.sha256 ?? "") ? "SOURCE_EVIDENCE_MISSING"
      : pub === null || !uri(r.publication?.evidenceUri) ? "PUBLICATION_EVIDENCE_MISSING"
      : available === null || !uri(r.availability?.evidenceUri) ? "AVAILABILITY_EVIDENCE_MISSING"
      : available < pub ? "AVAILABILITY_BEFORE_PUBLICATION"
      : pub > cutoff || available > cutoff ? "NOT_AVAILABLE_AS_OF"
      : pub < Date.parse(`${d.end}T00:00:00Z`) + 86_400_000 ? "PERIOD_NOT_COMPLETED_AT_PUBLICATION" : null;
    if (code) { findings.push({ reportId: r.reportId, code }); continue; }
    const prior = byId.get(r.reportId);
    if (prior && canonical(prior) !== canonical(r)) { conflicts.add(r.reportId); findings.push({ reportId: r.reportId, code: "CONFLICTING_REPORT_ID" }); }
    else if (prior) findings.push({ reportId: r.reportId, code: "DUPLICATE_REPORT" });
    else byId.set(r.reportId, r);
  }
  for (const id of conflicts) byId.delete(id);
  const periods = new Map<string, FinancialStatementInput[]>();
  for (const r of byId.values()) { const key = `${r.symbol}|${r.period}`; periods.set(key, [...(periods.get(key) ?? []), r]); }
  const selected: FinancialStatementInput[] = [];
  for (const rows of periods.values()) {
    rows.sort((a, b) => fundamentalTimestamp(b.publication.at)! - fundamentalTimestamp(a.publication.at)!
      || fundamentalTimestamp(b.availability.at)! - fundamentalTimestamp(a.availability.at)! || a.reportId.localeCompare(b.reportId));
    const latest = rows[0]!;
    const tied = rows.filter((r) => fundamentalTimestamp(r.publication.at) === fundamentalTimestamp(latest.publication.at)
      && fundamentalTimestamp(r.availability.at) === fundamentalTimestamp(latest.availability.at));
    if (tied.length > 1) { tied.forEach((r) => findings.push({ reportId: r.reportId, code: "AMBIGUOUS_PERIOD_REVISION" })); continue; }
    selected.push(latest);
  }
  selected.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.period.localeCompare(b.period));
  const observations: FundamentalObservation[] = [];
  const derivations = selected.map((r) => {
    const d = dates(r.period)!;
    const accountingGate = !["CONSOLIDATED_TOTAL_ENTITY", "SEPARATE_TOTAL_ENTITY"].includes(r.accountingBasis?.kind ?? "")
      || !uri(r.accountingBasis?.evidenceUri) ? "ACCOUNTING_BASIS_EVIDENCE_MISSING" : null;
    const balanceGate = accountingGate ?? (r.balanceDate !== d.end ? "BALANCE_DATE_MISMATCH" : null);
    const openingGate = balanceGate ?? (r.openingBalanceDate !== d.opening ? "OPENING_BALANCE_DATE_MISMATCH" : null);
    let flowGate = accountingGate ?? (r.flowEndDate !== d.end || !["SINGLE_QUARTER", "CUMULATIVE_YTD"].includes(r.flowBasis ?? "")
      || r.flowStartDate !== (r.flowBasis === "SINGLE_QUARTER" ? d.start : d.ytdStart) ? "FLOW_PERIOD_OR_BASIS_UNKNOWN" : null);
    let previous: FinancialStatementInput | undefined;
    if (!flowGate && r.flowBasis === "CUMULATIVE_YTD" && d.quarter > 1) {
      previous = r.priorCumulativeReportId ? byId.get(r.priorCumulativeReportId) : undefined;
      const p = previous ? dates(previous.period) : null;
      if (!previous || !p || !selected.some((s) => s.reportId === previous!.reportId) || previous.symbol !== r.symbol || previous.currencyCode !== r.currencyCode
        || p.year !== d.year || p.quarter !== d.quarter - 1 || previous.flowBasis !== "CUMULATIVE_YTD"
        || previous.flowStartDate !== d.ytdStart || previous.flowEndDate !== p.end
        || previous.accountingBasis?.kind !== r.accountingBasis.kind || !uri(previous.accountingBasis?.evidenceUri)
        || !nonempty(r.comparability?.key) || r.comparability.key !== previous.comparability?.key
        || !uri(r.comparability.evidenceUri) || !uri(previous.comparability?.evidenceUri)) flowGate = "COMPARABLE_PRIOR_YTD_EVIDENCE_MISSING";
    }
    const b = (field: FinancialField) => amount(r, field, field.startsWith("opening") ? openingGate : balanceGate);
    const flows = Object.fromEntries(FLOW_FIELDS.map((field) => {
      const fieldGate = flowGate ?? ((field === "capitalExpenditure" || field === "interestExpense") && previous
        && previous.expenseSign !== r.expenseSign ? "EXPENSE_SIGN_CONFLICT" : null);
      const operands = [amount(r, field, fieldGate), ...(previous && !flowGate ? [amount(previous, field)] : [])];
      return [field, derive(previous && !flowGate ? `currentYTD.${field} - priorYTD.${field}` : field,
        "SINGLE_QUARTER_FLOW_NO_ANNUALIZATION", "CURRENCY", operands, (v) => ({ numerator: v[0]! - (v[1] ?? 0) }), r.currencyCode, fieldGate)];
    })) as Record<typeof FLOW_FIELDS[number], FinancialDerivation>;
    const flowOps = (field: typeof FLOW_FIELDS[number]) => flows[field].operands;
    const flowValue = (field: typeof FLOW_FIELDS[number]) => flows[field].value!;
    const equityOps = r.amounts.equity?.value != null ? [b("equity")] : [b("totalAssets"), b("totalLiabilities")];
    const equity = derive(equityOps.length === 1 ? "equity" : "totalAssets - totalLiabilities", "ENDING_BALANCE", "CURRENCY", equityOps,
      (v) => ({ numerator: v[0]! - (v[1] ?? 0) }), r.currencyCode);
    const debtOps = r.amounts.totalDebt?.value != null ? [b("totalDebt")] : [b("shortTermDebt"), b("longTermDebt")];
    const totalDebt = derive(debtOps.length === 1 ? "totalDebt" : "shortTermDebt + longTermDebt", "ENDING_BALANCE", "CURRENCY", debtOps,
      (v) => ({ numerator: v.reduce((a, n) => a + n, 0) }), r.currencyCode);
    const signGate = r.expenseSign === "POSITIVE_EXPENSE" || r.expenseSign === "NEGATIVE_CASH_OUTFLOW" ? null : "EXPENSE_SIGN_UNKNOWN";
    const signedExpense = (field: "capitalExpenditure" | "interestExpense") => flowValue(field) * (r.expenseSign === "NEGATIVE_CASH_OUTFLOW" ? -1 : 1);
    const expenseGate = (field: "capitalExpenditure" | "interestExpense") => signGate ?? flows[field].reason
      ?? (previous && !flowGate && previous.expenseSign !== r.expenseSign ? "EXPENSE_SIGN_CONFLICT" : null)
      ?? (signedExpense(field) < 0 ? "EXPENSE_SIGN_CONFLICT" : null);
    const freeCashFlow = derive("quarterOCF - declaredPositiveQuarterCapEx", "SINGLE_QUARTER_FLOW_NO_ANNUALIZATION", "CURRENCY",
      [...flowOps("operatingCashFlow"), ...flowOps("capitalExpenditure")], () => ({ numerator: flowValue("operatingCashFlow") - signedExpense("capitalExpenditure") }),
      r.currencyCode, flows.operatingCashFlow.reason ?? expenseGate("capitalExpenditure"));
    const interestCoverage = derive("quarterOperatingIncome / declaredPositiveQuarterInterestExpense", "SINGLE_QUARTER_FLOW_NO_ANNUALIZATION", "MULTIPLE",
      [...flowOps("operatingIncome"), ...flowOps("interestExpense")], () => ({ numerator: flowValue("operatingIncome"), denominator: signedExpense("interestExpense") }),
      r.currencyCode, flows.operatingIncome.reason ?? expenseGate("interestExpense"));
    const averageBalanceGate = (opening: Operand, ending: number | null) => opening.reason
      ?? (opening.value! <= 0 || (ending !== null && ending <= 0) ? "NON_POSITIVE_BALANCE" : null);
    const metrics = {
      debtRatio: derive("totalDebt / endingTotalAssets * 100", "ENDING_BALANCE", "PERCENT_POINTS", [...debtOps, b("totalAssets")],
        (v) => ({ numerator: totalDebt.value!, denominator: v.at(-1)! }), r.currencyCode, totalDebt.reason),
      liabilitiesRatio: derive("totalLiabilities / endingTotalAssets * 100", "ENDING_BALANCE", "PERCENT_POINTS", [b("totalLiabilities"), b("totalAssets")],
        (v) => ({ numerator: v[0]!, denominator: v[1]! }), r.currencyCode),
      currentRatio: derive("currentAssets / currentLiabilities", "ENDING_BALANCE", "MULTIPLE", [b("currentAssets"), b("currentLiabilities")],
        (v) => ({ numerator: v[0]!, denominator: v[1]! }), r.currencyCode),
      quickRatio: derive("(currentAssets - inventory) / currentLiabilities", "ENDING_BALANCE", "MULTIPLE", [b("currentAssets"), b("inventory"), b("currentLiabilities")],
        (v) => ({ numerator: v[0]! - v[1]!, denominator: v[2]! }), r.currencyCode),
      roe: derive("quarterNetIncome / ((openingEquity + endingEquity) / 2) * 100", "SINGLE_QUARTER_FLOW_AVERAGE_BALANCE_NO_ANNUALIZATION", "PERCENT_POINTS",
        [...flowOps("netIncome"), b("openingEquity"), ...equityOps], () => ({ numerator: flowValue("netIncome"), denominator: (b("openingEquity").value! + equity.value!) / 2 }),
        r.currencyCode, flows.netIncome.reason ?? equity.reason ?? averageBalanceGate(b("openingEquity"), equity.value)),
      roa: derive("quarterNetIncome / ((openingTotalAssets + endingTotalAssets) / 2) * 100", "SINGLE_QUARTER_FLOW_AVERAGE_BALANCE_NO_ANNUALIZATION", "PERCENT_POINTS",
        [...flowOps("netIncome"), b("openingTotalAssets"), b("totalAssets")], () => ({ numerator: flowValue("netIncome"), denominator: (b("openingTotalAssets").value! + b("totalAssets").value!) / 2 }),
        r.currencyCode, flows.netIncome.reason ?? averageBalanceGate(b("openingTotalAssets"), b("totalAssets").value)),
      assetTurnover: derive("quarterRevenue / ((openingTotalAssets + endingTotalAssets) / 2)", "SINGLE_QUARTER_FLOW_AVERAGE_BALANCE_NO_ANNUALIZATION", "MULTIPLE",
        [...flowOps("revenue"), b("openingTotalAssets"), b("totalAssets")], () => ({ numerator: flowValue("revenue"), denominator: (b("openingTotalAssets").value! + b("totalAssets").value!) / 2 }),
        r.currencyCode, flows.revenue.reason ?? averageBalanceGate(b("openingTotalAssets"), b("totalAssets").value)),
      cashflowConversion: derive("quarterOCF / quarterNetIncome", "SINGLE_QUARTER_FLOW_NO_ANNUALIZATION", "MULTIPLE", [...flowOps("operatingCashFlow"), ...flowOps("netIncome")],
        () => ({ numerator: flowValue("operatingCashFlow"), denominator: flowValue("netIncome") }), r.currencyCode, flows.operatingCashFlow.reason ?? flows.netIncome.reason),
    };
    // All contributing versions gate the entire derived observation conservatively.
    const contributors = [r, ...(previous && !flowGate ? [previous] : [])];
    const maxTime = (key: "publication" | "availability") => new Date(Math.max(...contributors.map((c) => fundamentalTimestamp(c[key].at)!))).toISOString();
    observations.push({ recordId: `financial-derived:${r.reportId}`, symbol: r.symbol, family: "FINANCIAL_STRUCTURE", period: r.period,
      publishedAt: maxTime("publication"), observedAt: maxTime("availability"), source: { id: r.source.id, uri: r.source.uri },
      currencyCode: r.currencyCode, reportingBasis: "SINGLE_QUARTER", ...(r.group ? { group: { ...r.group } } : {}),
      metricBases: Object.fromEntries(METRICS.map((key) => [key, `${metrics[key].basis}:${r.accountingBasis?.kind ?? "UNKNOWN_ACCOUNTING_BASIS"}`])),
      values: Object.fromEntries(METRICS.map((key) => [key, { value: metrics[key].value, unit: metrics[key].unit, scale: 1 }])) });
    return { reportId: r.reportId, symbol: r.symbol, period: r.period, sourceRecords: contributors.map(reference),
      quarterFlows: flows, equity, totalDebt, freeCashFlow, interestCoverage, metrics,
      validMetricCount: METRICS.filter((key) => metrics[key].value !== null).length, metricCount: METRICS.length };
  });
  findings.sort((a, b) => a.reportId.localeCompare(b.reportId) || a.code.localeCompare(b.code));
  return { schemaVersion: "MMS_FINANCIAL_DERIVATION_V1", classification: "DIAGNOSTIC_ONLY", asOf: new Date(cutoff).toISOString(),
    inputReportCount: reports.length, selectedReportCount: selected.length, derivations, observations, findings,
    limitations: ["Source hashes and evidence URIs are caller declarations; archived bytes must be independently verified by the input owner.",
      "Calendar quarters only. Flows are single-quarter, never annualized or mislabeled TTM; returns use average explicitly dated opening/closing balances.",
      "YTD differences require an explicitly pinned available prior revision and evidenced matching accounting/restatement scope. Missing data stays unknown.",
      "No fetching, database writes, quality score, forecasting or trading. This diagnostic does not establish profitability."],
    supportsTradingExecution: false } as const;
}
