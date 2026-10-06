import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildStockFundamentalSnapshot, selectFundamentalObservations, normalizeFundamentalValue, type FundamentalObservation, type FundamentalMetric, type FundamentalValue } from "./fundamentalSnapshots.js";
import { buildFinancialStructurePeerComparison, FINANCIAL_STRUCTURE_METRICS } from "./fundamentalPeerComparison.js";
import { buildFundamentalOfflineDiagnostic, type FundamentalOfflineInput } from "./fundamentalOfflineDiagnostic.js";

const AS_OF = "2026-10-01T00:00:00Z";
const value = (number: number | null, unit: FundamentalValue["unit"], scale = 1): FundamentalValue => ({ value: number, unit, scale });
function row(id: string, family: FundamentalObservation["family"], period: string, values: FundamentalObservation["values"], symbol = "TARGET"): FundamentalObservation {
  return { recordId: id, family, period, symbol, values, publishedAt: "2026-08-15T00:00:00Z", observedAt: "2026-08-15T00:00:00Z",
    ...(family === "PROFITABILITY" ? { reportingBasis: "SINGLE_QUARTER" as const } : {}),
    source: { id: "synthetic-test", uri: "fixture://fundamentals/tests" }, currencyCode: "TWD", group: { industry: "same", sector: "same-sector" } };
}
const snapshot = (observations: readonly FundamentalObservation[], kind: "stock" | "etf" = "stock") => buildStockFundamentalSnapshot({ symbol: "TARGET", kind, asOf: AS_OF, observations });
const profit = (id: string, period: string, eps: number) => row(id, "PROFITABILITY", period, { eps: value(eps, "CURRENCY_PER_SHARE") });
function structure(symbol: string, val = 10, missing: readonly FundamentalMetric[] = []): FundamentalObservation {
  return row(symbol, "FINANCIAL_STRUCTURE", "2026-Q2", Object.fromEntries(FINANCIAL_STRUCTURE_METRICS.map((key) => [key,
    value(missing.includes(key) ? null : val, ["debtRatio", "liabilitiesRatio", "roe", "roa"].includes(key) ? "PERCENT_POINTS" : "MULTIPLE")])), symbol);
}
const peers = (observations: readonly FundamentalObservation[], kind: "stock" | "etf" = "stock") => buildFinancialStructurePeerComparison({ targetSymbol: "TARGET", kind, asOf: AS_OF, basis: "industry", observations });

describe("point-in-time offline fundamental snapshot", () => {
  it("excludes future publication, later-discovered revisions and unknown publication without backdating", () => {
    const q1 = profit("q1", "2026-Q1", 1);
    const q2 = profit("q2", "2026-Q2", 2);
    const future = { ...profit("future", "2026-Q3", 999), publishedAt: "2026-10-16T00:00:00Z", observedAt: "2026-10-16T00:00:00Z" };
    const restated = { ...profit("restated", "2026-Q2", 777), publishedAt: "2026-09-30T00:00:00Z", observedAt: "2026-10-02T00:00:00Z" };
    const unknown = { ...profit("unknown", "2026-Q3", 666), publishedAt: null };
    const baseline = snapshot([q1, q2]);
    const result = snapshot([future, q2, restated, unknown, q1]);
    expect(result.profitability).toEqual(baseline.profitability);
    expect(result.profitability.epsQoQDelta).toBe(1);
    expect(result.availabilityAudit.findings.map((f) => f.code)).toEqual(["NOT_AVAILABLE_AS_OF", "NOT_AVAILABLE_AS_OF", "UNKNOWN_OR_INVALID_PUBLICATION"]);
    const later = buildStockFundamentalSnapshot({ symbol: "TARGET", kind: "stock", asOf: "2026-10-03T00:00:00Z", observations: [q1, q2, restated] });
    expect(later.profitability.eps.value).toBe(777);
    expect(later.profitability.sourceRecord?.recordId).toBe("restated");
  });
  it("preserves zero and declared scale/currency, leaves incompatible and non-finite values missing", () => {
    const revenue = row("revenue", "REVENUE", "2026-07", { revenue: value(125, "CURRENCY", 1000), yoyGrowth: value(0, "PERCENT_POINTS") });
    expect(snapshot([revenue]).revenue.revenue).toMatchObject({ value: 125000, unit: "CURRENCY", currencyCode: "TWD", sourceScale: 1000 });
    expect(snapshot([revenue]).revenue.yoyGrowth.value).toBe(0);
    expect(normalizeFundamentalValue(row("unit", "PROFITABILITY", "2026-Q2", { eps: value(2, null) }), "eps")).toMatchObject({ value: null, missingReason: "UNKNOWN_OR_INCOMPATIBLE_UNIT" });
    expect(normalizeFundamentalValue(row("nan", "PROFITABILITY", "2026-Q2", { eps: value(NaN, "CURRENCY_PER_SHARE") }), "eps").value).toBeNull();
    expect(normalizeFundamentalValue(row("scale", "PROFITABILITY", "2026-Q2", { eps: value(2, "CURRENCY_PER_SHARE", 1000) }), "eps").missingReason).toBe("UNKNOWN_OR_INCOMPATIBLE_SCALE");
    expect(normalizeFundamentalValue(row("large", "REVENUE", "2026-07", { revenue: value(Number.MAX_SAFE_INTEGER, "CURRENCY", 1000) }), "revenue").missingReason).toBe("UNSAFE_MAGNITUDE");
  });
  it("does not label non-adjacent periods or different filing currencies as quarter-on-quarter changes", () => {
    expect(snapshot([profit("q2", "2026-Q2", 2), profit("old", "2025-Q4", 1)]).profitability).toMatchObject({ epsQoQDelta: null, deltaUnavailableReason: "NON_CONSECUTIVE_QUARTER" });
    expect(snapshot([profit("q2", "2026-Q2", 2), { ...profit("q1", "2026-Q1", 1), currencyCode: "USD" }]).profitability).toMatchObject({ epsQoQDelta: null, deltaUnavailableReason: "CURRENCY_MISMATCH" });
  });
  it("keeps cumulative or unspecified EPS from being labeled a single-quarter improvement", () => {
    const q1 = profit("q1", "2026-Q1", 1);
    const q2 = { ...profit("q2", "2026-Q2", 5), reportingBasis: "CUMULATIVE_YTD" as const };
    expect(snapshot([q1, q2]).profitability).toMatchObject({ eps: { value: 5 }, epsQoQDelta: null, deltaUnavailableReason: "REPORTING_BASIS_NOT_SINGLE_QUARTER" });
    const unspecified = { ...q2 };
    Reflect.deleteProperty(unspecified, "reportingBasis");
    expect(snapshot([q1, unspecified]).profitability.epsQoQDelta).toBeNull();
  });
  it("does not bridge missing months or missing year-on-year values to claim acceleration", () => {
    const latest = row("jul", "REVENUE", "2026-07", { revenue: value(100, "CURRENCY"), yoyGrowth: value(15, "PERCENT_POINTS") });
    const older = row("may", "REVENUE", "2026-05", { revenue: value(100, "CURRENCY"), yoyGrowth: value(10, "PERCENT_POINTS") });
    expect(snapshot([latest, older]).revenue).toMatchObject({ trend: "insufficient", consecutivePositiveYoYMonths: 1 });
    const missing = row("jun", "REVENUE", "2026-06", { revenue: value(100, "CURRENCY"), yoyGrowth: value(null, "PERCENT_POINTS") });
    expect(snapshot([latest, missing, older]).revenue.trend).toBe("insufficient");
  });
  it("suppresses ETF company data while retaining applicable valuation with units and availability", () => {
    const valuation = { ...row("valuation", "VALUATION", "2026-09-30", { dividendYield: value(3, "PERCENT_POINTS") }), publishedAt: "2026-09-30T08:00:00Z", observedAt: "2026-09-30T08:00:00Z" };
    const result = snapshot([profit("eps", "2026-Q2", 999), row("revenue", "REVENUE", "2026-07", { revenue: value(100, "CURRENCY") }), valuation], "etf");
    expect(result.profitability.eps.value).toBeNull();
    expect(result.revenue.revenue.value).toBeNull();
    expect(result.valuation.dividendYield.value).toBe(3);
    expect(result.dataCoverage).toBe("limited");
  });
  it("accepts an exact timezone-normalized cutoff and rejects unknown or impossible temporal metadata", () => {
    const input = profit("q2", "2026-Q2", 2);
    expect(selectFundamentalObservations([input], "2026-08-15T08:00:00+08:00").selected).toHaveLength(1);
    expect(() => selectFundamentalObservations([input], "2026-08-15")).toThrow("explicit timezone");
    expect(selectFundamentalObservations([{ ...input, observedAt: "2026-08-14T00:00:00Z" }], AS_OF).findings[0]?.code).toBe("AVAILABILITY_BEFORE_PUBLICATION");
    expect(selectFundamentalObservations([{ ...input, period: "2026-Q4" }], AS_OF).findings[0]?.code).toBe("PERIOD_NOT_COMPLETED_AT_PUBLICATION");
    expect(selectFundamentalObservations([{ ...input, publishedAt: "2026-06-30T08:00:00Z", observedAt: "2026-06-30T08:00:00Z" }], AS_OF).findings[0]?.code).toBe("PERIOD_NOT_COMPLETED_AT_PUBLICATION");
    expect(selectFundamentalObservations([{ ...input, publishedAt: "2026-02-30T00:00:00Z" }], AS_OF).findings[0]?.code).toBe("UNKNOWN_OR_INVALID_PUBLICATION");
  });
  it("deduplicates identical records and blocks conflicting IDs and ambiguous period revisions", () => {
    const input = profit("q2", "2026-Q2", 2);
    expect(selectFundamentalObservations([input, input], AS_OF).selected).toHaveLength(1);
    expect(selectFundamentalObservations([input, { ...input, values: { eps: value(999, "CURRENCY_PER_SHARE") } }], AS_OF).selected).toHaveLength(0);
    expect(selectFundamentalObservations([input, { ...profit("different-id", "2026-Q2", 999) }], AS_OF).findings.every((f) => f.code === "AMBIGUOUS_PERIOD_REVISION")).toBe(true);
    expect(selectFundamentalObservations([input, { ...input, recordId: "other-basis", reportingBasis: "CUMULATIVE_YTD" }], AS_OF).selected).toHaveLength(0);
    const frozen = Object.freeze([Object.freeze(input)]);
    expect(snapshot(frozen).profitability.eps.value).toBe(2);
    expect(frozen[0]).toBe(input);
  });
});

describe("point-in-time peer denominators and offline entry", () => {
  it("uses unique same-quarter/group peers, reports missing denominators and leaves fewer than three unranked", () => {
    const p1 = structure("P1"); const p2 = structure("P2"); const p3 = structure("P3", 10, ["roe"]);
    const wrongPeriod = { ...structure("old"), period: "2026-Q1" };
    const wrongGroup = { ...structure("other"), group: { industry: "other" } };
    const future = { ...structure("future"), observedAt: "2026-10-02T00:00:00Z" };
    const result = peers([structure("TARGET"), p1, p1, p2, p3, wrongPeriod, wrongGroup, future]);
    expect(result.eligiblePeerCount).toBe(3);
    expect(result.inputPeerSymbolCount).toBe(6);
    expect(result.metrics.roe).toMatchObject({ eligiblePeerCount: 3, validPeerCount: 2, missingPeerCount: 1, favorableRankPercentile: null, median: 10 });
    expect(result.metrics.currentRatio.validPeerCount).toBe(3);
    expect(result.metrics.currentRatio.validPeers.map((p) => p.symbol)).toEqual(["P1", "P2", "P3"]);
  });
  it("gives ties neutral midranks and preserves the lower/higher metric direction", () => {
    const tied = peers([structure("TARGET"), structure("P1"), structure("P2"), structure("P3")]);
    expect(FINANCIAL_STRUCTURE_METRICS.every((key) => tied.metrics[key].favorableRankPercentile === 50)).toBe(true);
    expect(tied.strengths).toEqual([]);
    const directed = peers([structure("TARGET", 10), structure("P1", 20), structure("P2", 30), structure("P3", 40)]);
    expect(directed.metrics.debtRatio.favorableRankPercentile).toBe(100);
    expect(directed.metrics.currentRatio.favorableRankPercentile).toBe(0);
  });
  it("counts incompatible units as missing and requires five valid peers per metric for full coverage", () => {
    const p1 = structure("P1");
    const wrongUnit = { ...p1, values: { ...p1.values, roe: value(0.1, "MULTIPLE") } };
    expect(peers([structure("TARGET"), wrongUnit, structure("P2"), structure("P3")]).metrics.roe).toMatchObject({ validPeerCount: 2, missingPeerCount: 1, favorableRankPercentile: null });
    const all = [structure("TARGET"), ...[1, 2, 3, 4, 5].map((i) => structure(`P${i}`))];
    expect(peers(all).dataCoverage).toBe("full");
    const thin = [structure("TARGET"), structure("P1"), structure("P2"), structure("P3"), structure("P4", 10, FINANCIAL_STRUCTURE_METRICS), structure("P5", 10, FINANCIAL_STRUCTURE_METRICS)];
    expect(peers(thin)).toMatchObject({ eligiblePeerCount: 5, assessableMetricCount: 8, fullCoverageMetricCount: 0, dataCoverage: "limited" });
  });
  it("makes ETF and unavailable target cohorts explicitly unassessable", () => {
    expect(peers([structure("TARGET"), structure("P1")], "etf")).toMatchObject({ basis: "none", eligiblePeerCount: 0, dataCoverage: "insufficient", targetSourceRecord: null });
    expect(peers([structure("P1"), structure("P2"), structure("P3")]).metrics.roe.favorableRankPercentile).toBeNull();
    expect(peers([{ ...structure("TARGET"), group: {} }, structure("P1")]).eligiblePeerCount).toBe(0);
  });
  it("runs the documented synthetic fixture through both public API and CLI without network or output mutation", async () => {
    const path = "packages/research-kernel/fixtures/fundamentals/offline-synthetic.json";
    const bytes = await readFile(path);
    const input = JSON.parse(bytes.toString()) as FundamentalOfflineInput;
    const result = buildFundamentalOfflineDiagnostic(input);
    expect(result.snapshot).toMatchObject({ dataCoverage: "full", revenue: { trend: "accelerating", revenue: { value: 125000, currencyCode: "TWD" } }, profitability: { epsQoQDelta: 0.4 } });
    expect(result.peerComparison).toMatchObject({ eligiblePeerCount: 3, assessableMetricCount: 8, dataCoverage: "limited" });
    const child = await promisify(execFile)(process.execPath, [resolve("scripts/runFundamentalsOffline.mjs"), "--input", resolve(path)], { cwd: "/tmp", timeout: 10000 });
    expect(child.stderr).toBe("");
    const output = JSON.parse(child.stdout);
    const { inputSha256, ...cli } = output;
    expect(cli).toEqual(result);
    expect(inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path)).toEqual(bytes);
    expect(result.supportsTradingExecution).toBe(false);
    expect(result.profitabilityEvidence).toBe("NOT_EVALUATED");
  });
});
