import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { deriveFinancialStatements, type FinancialStatementInput, type FinancialField } from "./financialDerivationAdapter.js";
import { buildFundamentalOfflineDiagnostic, type FundamentalOfflineInput } from "./fundamentalOfflineDiagnostic.js";
import { buildFinancialStructurePeerComparison } from "./fundamentalPeerComparison.js";

const fixtures = resolve(import.meta.dirname, "../fixtures/fundamentals");
const input: FundamentalOfflineInput = JSON.parse(await readFile(resolve(fixtures, "financial-derivation-synthetic.json"), "utf8"));
const expected = JSON.parse(await readFile(resolve(fixtures, "financial-derivation-synthetic.expected.json"), "utf8"));
const reports = input.financialStatements!;
const q1 = reports.find((r) => r.reportId === "SYNTH-TARGET-2026-Q1-v1")!;
const q2 = reports.find((r) => r.reportId === "SYNTH-TARGET-2026-Q2-v1")!;
const adapt = (rows: readonly FinancialStatementInput[], asOf = input.asOf) => deriveFinancialStatements(rows, asOf);
const target = (rows: readonly FinancialStatementInput[]) => adapt(rows).derivations.find((r) => r.reportId === q2.reportId)!;
function change(report: FinancialStatementInput, field: FinancialField, value: number | null): FinancialStatementInput {
  return { ...report, amounts: { ...report.amounts, [field]: { ...report.amounts[field]!, value } } };
}
function assertExample(result: ReturnType<typeof buildFundamentalOfflineDiagnostic>) {
  const adapter = result.financialDerivation!;
  const report = adapter.derivations.find((r) => r.reportId === q2.reportId)!;
  expect(adapter.inputReportCount).toBe(expected.inputReportCount);
  expect(adapter.selectedReportCount).toBe(expected.selectedReportCount);
  expect(adapter.findings).toEqual([]);
  expect(report.quarterFlows.netIncome.value).toBe(expected.targetQuarterNetIncome);
  expect(report.quarterFlows.revenue.value).toBe(expected.targetQuarterRevenue);
  expect(report.freeCashFlow.value).toBe(expected.targetFreeCashFlow);
  expect(report.interestCoverage.value).toBe(expected.targetInterestCoverage);
  for (const [key, value] of Object.entries(expected.targetMetrics)) {
    const metric = report.metrics[key as keyof typeof report.metrics];
    expect(metric.value).toBeCloseTo(value as number, 10);
    expect(result.peerComparison.metrics[key as keyof typeof report.metrics].validPeerCount).toBe(expected.peerValidCount);
  }
  expect(report.metrics.roe.numerator).toBe(expected.roeNumerator);
  expect(report.metrics.roe.denominator).toBe(expected.roeDenominator);
  expect(report.metrics.roa.denominator).toBe(expected.roaDenominator);
  expect(result.profitabilityEvidence).toBe(expected.profitabilityEvidence);
  expect(result.supportsTradingExecution).toBe(false);
}

describe("evidenced financial statement derivation", () => {
  it("derives quarter flows, average-balance returns and ending-balance liquidity with actual operands", () => {
    assertExample(buildFundamentalOfflineDiagnostic(input));
    const result = target([q1, q2]);
    expect(result.validMetricCount).toBe(8);
    expect(result.metrics.roe.operands.map((o) => [o.reportId, o.field, o.sourceScale])).toEqual([
      [q2.reportId, "netIncome", 1000], [q1.reportId, "netIncome", 1000], [q2.reportId, "openingEquity", 1000],
      [q2.reportId, "totalAssets", 1000], [q2.reportId, "totalLiabilities", 1000],
    ]);
    expect(result.metrics.assetTurnover.basis).toBe("SINGLE_QUARTER_FLOW_AVERAGE_BALANCE_NO_ANNUALIZATION");
    expect(result.sourceRecords.map((r) => r.reportId)).toEqual([q2.reportId, q1.reportId]);
  });
  it("verifies preserved synthetic archive bytes and source metadata without claiming public filings", async () => {
    for (const report of reports) {
      const bytes = await readFile(resolve(fixtures, report.source.uri!.replace("fixture://", "")));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(report.source.sha256);
      const { source, ...contents } = report;
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(contents);
      expect(source.id).toBe("TASK_SYNTHETIC_FINANCIAL_STATEMENT");
    }
    expect(input.dataKind).toBe("SYNTHETIC");
  });
  it("does not invent source, publication or independently known availability evidence", () => {
    const cases: [FinancialStatementInput, string][] = [
      [{ ...q2, source: { ...q2.source, sha256: null } }, "SOURCE_EVIDENCE_MISSING"],
      [{ ...q2, publication: { ...q2.publication, at: "2026-08-15" } }, "PUBLICATION_EVIDENCE_MISSING"],
      [{ ...q2, publication: { ...q2.publication, evidenceUri: null } }, "PUBLICATION_EVIDENCE_MISSING"],
      [{ ...q2, availability: { at: null, evidenceUri: null } }, "AVAILABILITY_EVIDENCE_MISSING"],
      [{ ...q2, availability: { ...q2.availability, at: "2026-08-14T00:00:00Z" } }, "AVAILABILITY_BEFORE_PUBLICATION"],
      [{ ...q2, publication: { ...q2.publication, at: "2026-06-30T12:00:00Z" } }, "PERIOD_NOT_COMPLETED_AT_PUBLICATION"],
    ];
    for (const [report, code] of cases) {
      expect(adapt([report]).observations).toEqual([]);
      expect(adapt([report]).findings).toEqual([{ reportId: q2.reportId, code }]);
    }
  });
  it("preserves as-of values before a restatement becomes available and gates all contributors", () => {
    const revised = { ...change(q2, "netIncome", 350), reportId: "restated", publication: { ...q2.publication, at: "2026-09-30T00:00:00Z" },
      availability: { ...q2.availability, at: "2026-10-02T00:00:00Z" } };
    expect(target([q1, q2, revised]).metrics).toEqual(target([q1, q2]).metrics);
    const later = adapt([q1, q2, revised], "2026-10-02T08:00:00+08:00");
    expect(later.derivations.find((r) => r.reportId === "restated")?.quarterFlows.netIncome.value).toBe(250000);
    expect(later.observations.find((r) => r.period === q2.period)?.observedAt).toBe("2026-10-02T00:00:00.000Z");
    const latePrior = { ...q1, publication: { ...q1.publication, at: "2026-09-20T00:00:00Z" }, availability: { ...q1.availability, at: "2026-09-21T00:00:00Z" } };
    expect(adapt([latePrior, q2]).observations.find((r) => r.period === q2.period)?.observedAt).toBe("2026-09-21T00:00:00.000Z");
    expect(target([q2]).metrics.roe.reason).toBe("COMPARABLE_PRIOR_YTD_EVIDENCE_MISSING");
  });
  it("requires explicit pinned adjacent YTD revision, currency, accounting and restatement comparability", () => {
    const variants = [
      { ...q1, comparability: { ...q1.comparability, key: "restated-scope" } },
      { ...q1, comparability: { ...q1.comparability, evidenceUri: null } },
      { ...q1, currencyCode: "USD" },
      { ...q1, flowBasis: "SINGLE_QUARTER" as const },
      { ...q1, flowEndDate: "2026-02-28" },
    ];
    for (const previous of variants) {
      const result = target([previous, q2]);
      expect(result.quarterFlows.netIncome.reason).toBe("COMPARABLE_PRIOR_YTD_EVIDENCE_MISSING");
      expect(result.metrics.roe.value).toBeNull();
      expect(result.metrics.currentRatio.value).toBe(2);
    }
    expect(target([q1, { ...q2, priorCumulativeReportId: "unknown" }]).metrics.roa.value).toBeNull();
    const newQ1 = { ...q1, reportId: "new-q1", publication: { ...q1.publication, at: "2026-09-01T00:00:00Z" }, availability: { ...q1.availability, at: "2026-09-01T01:00:00Z" } };
    expect(target([q1, newQ1, q2]).quarterFlows.netIncome.reason).toBe("COMPARABLE_PRIOR_YTD_EVIDENCE_MISSING");
  });
  it("supports direct single-quarter flows and Q1 YTD without annualizing", () => {
    const single = { ...q2, flowBasis: "SINGLE_QUARTER" as const, flowStartDate: "2026-04-01" };
    expect(target([single]).quarterFlows.netIncome.value).toBe(220000);
    expect(target([single]).metrics.roa.value).toBeCloseTo(220 / 2400 * 100);
    expect(adapt([q1]).derivations[0]?.quarterFlows.netIncome.value).toBe(100000);
    expect(target([q1, { ...q2, flowStartDate: null }]).metrics.roa.reason).toBe("FLOW_PERIOD_OR_BASIS_UNKNOWN");
    expect(target([q1, { ...q2, openingBalanceDate: "2025-12-31" }]).metrics.roa.reason).toBe("OPENING_BALANCE_DATE_MISMATCH");
    expect(target([q1, { ...q2, balanceDate: null }]).validMetricCount).toBe(1); // cashflow conversion needs no balance
  });
  it("retains missing inventory/debt and zero, never substituting absent amounts", () => {
    expect(target([q1, change(q2, "inventory", null)]).metrics.quickRatio).toMatchObject({ value: null, reason: "MISSING_AMOUNT" });
    expect(target([q1, change(q2, "shortTermDebt", null)]).metrics.debtRatio).toMatchObject({ value: null, reason: "MISSING_AMOUNT" });
    const debtZero = change(change(q2, "shortTermDebt", 0), "longTermDebt", 0);
    expect(target([q1, debtZero]).metrics.debtRatio.value).toBe(0);
    const zeroIncome = change(q2, "netIncome", 100); // 100 YTD - 100 prior = zero quarter
    expect(target([q1, zeroIncome]).metrics.roe.value).toBe(0);
    expect(target([q1, zeroIncome]).metrics.cashflowConversion.reason).toBe("NON_POSITIVE_DENOMINATOR");
    expect(target([q1, change(q2, "currentLiabilities", -1)]).metrics.currentRatio.value).toBeNull();
    expect(target([q1, change(q2, "currentLiabilities", 0)]).metrics.currentRatio.denominator).toBe(0);
    expect(target([q1, change(q2, "openingEquity", -10)]).metrics.roe.reason).toBe("NON_POSITIVE_BALANCE");
  });
  it("requires an evidenced total-entity accounting basis and keeps separate/consolidated peers apart", () => {
    const missing = { ...q2, accountingBasis: { kind: null, evidenceUri: null } };
    expect(target([q1, missing]).validMetricCount).toBe(0);
    expect(target([q1, missing]).metrics.roa.reason).toBe("ACCOUNTING_BASIS_EVIDENCE_MISSING");
    const observations = adapt(reports.map((r) => r.symbol === "SYNTH-P1" ? { ...r, accountingBasis: { ...r.accountingBasis, kind: "SEPARATE_TOTAL_ENTITY" as const } } : r)).observations;
    const comparison = buildFinancialStructurePeerComparison({ targetSymbol: q2.symbol, kind: "stock", asOf: input.asOf, basis: "industry", observations });
    expect(comparison.metrics.roe.validPeerCount).toBe(2);
    expect(comparison.metrics.currentRatio.validPeerCount).toBe(2);
  });
  it("normalizes each operand scale and rejects incompatible currency, unit and unsafe amounts", () => {
    const sameAmount = { ...q2, amounts: { ...q2.amounts, totalAssets: { ...q2.amounts.totalAssets!, value: 2600000, scale: 1 as const } } };
    expect(target([q1, sameAmount]).metrics.roa.value).toBe(5);
    for (const bad of [{ ...q2.amounts.totalAssets!, currencyCode: "USD" }, { ...q2.amounts.totalAssets!, unit: null },
      { ...q2.amounts.totalAssets!, scale: null }, { ...q2.amounts.totalAssets!, value: Number.MAX_SAFE_INTEGER }]) {
      expect(target([q1, { ...q2, amounts: { ...q2.amounts, totalAssets: bad } }]).metrics.roa.value).toBeNull();
    }
  });
  it("requires explicit expense signs rather than abs() and does not hide sign conflicts", () => {
    expect(target([q1, { ...q2, expenseSign: null }]).freeCashFlow.reason).toBe("EXPENSE_SIGN_UNKNOWN");
    const negative = (r: FinancialStatementInput): FinancialStatementInput => ({ ...change(change(r, "capitalExpenditure", -r.amounts.capitalExpenditure!.value!),
      "interestExpense", -r.amounts.interestExpense!.value!), expenseSign: "NEGATIVE_CASH_OUTFLOW" });
    expect(target([negative(q1), negative(q2)]).freeCashFlow.value).toBe(100000);
    expect(target([negative(q1), negative(q2)]).interestCoverage.value).toBe(20);
    expect(target([q1, negative(q2)]).freeCashFlow.reason).toBe("EXPENSE_SIGN_CONFLICT");
    expect(target([q1, negative(q2)]).quarterFlows.capitalExpenditure).toMatchObject({ value: null, reason: "EXPENSE_SIGN_CONFLICT" });
    expect(target([q1, change(q2, "capitalExpenditure", -80)]).freeCashFlow.reason).toBe("EXPENSE_SIGN_CONFLICT");
  });
  it("deduplicates without mutating inputs and fails closed for conflicts and tied revisions", () => {
    expect(adapt(Object.freeze([q1, q2, q2])).selectedReportCount).toBe(2);
    expect(adapt([q1, q2, change(q2, "inventory", 999)]).observations).toHaveLength(1);
    expect(adapt([q1, q2, { ...q2, reportId: "ambiguous" }]).findings.map((r) => r.code)).toEqual(["AMBIGUOUS_PERIOD_REVISION", "AMBIGUOUS_PERIOD_REVISION"]);
    expect(target([q1, { ...q1, reportId: "ambiguous-prior" }, q2]).metrics.roe.reason).toBe("COMPARABLE_PRIOR_YTD_EVIDENCE_MISSING");
    expect(() => adapt([q1], "2026-10-01")).toThrow("explicit timezone");
  });
  it("rejects mixed measurement bases in per-metric peer denominators", () => {
    const observations = [...adapt(reports).observations];
    const index = observations.findIndex((r) => r.symbol === "SYNTH-P1" && r.period === q2.period);
    const peer = observations[index]!;
    observations[index] = { ...peer, metricBases: { ...peer.metricBases, assetTurnover: "TTM_FLOW_ENDING_BALANCE" } };
    const comparison = buildFinancialStructurePeerComparison({ targetSymbol: q2.symbol, kind: "stock", asOf: input.asOf, basis: "industry", observations });
    expect(comparison.metrics.assetTurnover).toMatchObject({ eligiblePeerCount: 3, validPeerCount: 2, missingPeerCount: 1, favorableRankPercentile: null });
    expect(comparison.metrics.assetTurnover.missingPeers).toEqual([{ symbol: "SYNTH-P1", reason: "MEASUREMENT_BASIS_MISMATCH" }]);
    expect(comparison.metrics.currentRatio.validPeerCount).toBe(3);
  });
  it("requires explicit source reconciliation instead of overriding existing financial observations", () => {
    const overlap = adapt([q1, q2]).observations.find((r) => r.period === q2.period)!;
    expect(() => buildFundamentalOfflineDiagnostic({ ...input, observations: [overlap] })).toThrow("overlap");
  });
  it("preserves the old artificial fixture and refuses its placeholder evidence", async () => {
    const legacy = JSON.parse(await readFile(resolve(fixtures, "legacy-financial-availability.synthetic.json"), "utf8"));
    const mapped = legacy.reports.map((r: { reportId: string; symbol: string; fiscalYear: string; fiscalQuarter: string; source: string; sourceHash: string; filingDate: string | null; announcementDate: string | null; ingestedAt: string | null }) => ({
      ...q1, reportId: r.reportId, symbol: r.symbol, period: `${r.fiscalYear}-${r.fiscalQuarter}`,
      source: { id: r.source, uri: null, sha256: r.sourceHash }, publication: { at: r.filingDate ?? r.announcementDate, evidenceUri: null },
      availability: { at: r.ingestedAt, evidenceUri: null }, amounts: {},
    }));
    const result = adapt(mapped);
    expect(result.inputReportCount).toBe(8);
    expect(result.selectedReportCount).toBe(0);
    expect(result.observations).toEqual([]);
    expect(result.findings.every((r) => r.code === "SOURCE_EVIDENCE_MISSING")).toBe(true);
  });
  it("runs the actual offline CLI from another cwd and preserves prior fixture output", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [resolve(root, "scripts/runFundamentalsOffline.mjs"), "--input", resolve(fixtures, "financial-derivation-synthetic.json")], { cwd: "/tmp", maxBuffer: 4 * 1024 * 1024 });
    assertExample(JSON.parse(stdout));
    const old: FundamentalOfflineInput = JSON.parse(await readFile(resolve(fixtures, "offline-synthetic.json"), "utf8"));
    const oldExpected = JSON.parse(await readFile(resolve(fixtures, "offline-synthetic.expected.json"), "utf8"));
    const result = buildFundamentalOfflineDiagnostic(old);
    // Old expected CLI output also contains an input hash.
    const diagnostic = { ...oldExpected };
    delete diagnostic.inputSha256;
    expect(result).toEqual(diagnostic);
  });
});
