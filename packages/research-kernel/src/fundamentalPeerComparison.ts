/** Minimal diagnostic adaptation of legacy FinancialStructurePeerComparisonEngine.ts. */
import { fundamentalReference, normalizeFundamentalValue, selectFundamentalObservations, type FundamentalObservation, type FundamentalMetric } from "./fundamentalSnapshots.js";

export const FINANCIAL_STRUCTURE_METRICS = ["debtRatio", "liabilitiesRatio", "currentRatio", "quickRatio", "roe", "roa", "assetTurnover", "cashflowConversion"] as const;
export type FinancialStructureMetric = typeof FINANCIAL_STRUCTURE_METRICS[number];
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildFinancialStructurePeerComparison(input: {
  readonly targetSymbol: string; readonly kind: "stock" | "etf"; readonly asOf: string;
  readonly basis: "industry" | "sector"; readonly observations: readonly FundamentalObservation[];
}) {
  if (!input || typeof input.targetSymbol !== "string" || !input.targetSymbol.trim() || !["stock", "etf"].includes(input.kind)
    || !["industry", "sector"].includes(input.basis)) throw new TypeError("peer comparison requires target, kind and explicit industry/sector basis");
  const selection = selectFundamentalObservations(input.observations, input.asOf);
  const financial = selection.selected.filter((row) => row.family === "FINANCIAL_STRUCTURE");
  const target = input.kind === "stock" ? financial.find((row) => row.symbol === input.targetSymbol) ?? null : null;
  const groupId = target?.group?.[input.basis] ?? null;
  const eligible = target === null || !groupId ? [] : financial.filter((row) => row.symbol !== input.targetSymbol && row.period === target.period && row.group?.[input.basis] === groupId);
  const candidateSymbols = [...new Set(input.observations.filter((row) => row.family === "FINANCIAL_STRUCTURE" && row.symbol !== input.targetSymbol).map((row) => row.symbol))].sort();
  const excludedPeers = candidateSymbols.filter((symbol) => !eligible.some((row) => row.symbol === symbol)).map((symbol) => ({ symbol, reason: input.kind === "etf" ? "ETF_NOT_APPLICABLE" : !target ? "TARGET_UNAVAILABLE" : !groupId ? "TARGET_GROUP_UNKNOWN" : "NO_AVAILABLE_MATCHING_PERIOD_AND_GROUP" }));
  const metrics = Object.fromEntries(FINANCIAL_STRUCTURE_METRICS.map((key) => {
    const targetValue = normalizeFundamentalValue(target, key);
    const validPeers: { symbol: string; value: number; sourceRecord: ReturnType<typeof fundamentalReference> }[] = [];
    const missingPeers: { symbol: string; reason: string }[] = [];
    for (const row of eligible) {
      const value = normalizeFundamentalValue(row, key);
      const basisMismatch = row.metricBases?.[key] !== target?.metricBases?.[key]
        || (["roe", "roa", "assetTurnover", "cashflowConversion"].includes(key) && row.reportingBasis !== target?.reportingBasis);
      if (basisMismatch) missingPeers.push({ symbol: row.symbol, reason: "MEASUREMENT_BASIS_MISMATCH" });
      else if (value.value === null) missingPeers.push({ symbol: row.symbol, reason: value.missingReason ?? "MISSING_VALUE" });
      else validPeers.push({ symbol: row.symbol, value: value.value, sourceRecord: fundamentalReference(row) });
    }
    validPeers.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const direction = key === "debtRatio" || key === "liabilitiesRatio" ? "lower" : "higher";
    const values = validPeers.map((row) => row.value);
    const canCompare = targetValue.value !== null && values.length >= 3;
    const better = targetValue.value === null ? 0 : values.filter((value) => direction === "higher" ? targetValue.value! > value : targetValue.value! < value).length;
    const ties = targetValue.value === null ? 0 : values.filter((value) => value === targetValue.value).length;
    const percentile = canCompare ? Math.round((better + ties / 2) / values.length * 10_000) / 100 : null;
    return [key, { target: targetValue, unit: targetValue.unit, direction, median: median(values), favorableRankPercentile: percentile,
      status: input.kind === "etf" ? "NOT_APPLICABLE" : canCompare ? "DESCRIPTIVE_COMPARISON" : targetValue.value === null ? "TARGET_VALUE_UNAVAILABLE" : "INSUFFICIENT_VALID_PEERS",
      validPeerCount: values.length, eligiblePeerCount: eligible.length, missingPeerCount: missingPeers.length,
      validPeers, missingPeers, tieCount: ties, method: "100 * (strictly less favorable peers + 0.5 * tied peers) / valid unique peers; target excluded" }];
  })) as Record<FinancialStructureMetric, {
    target: ReturnType<typeof normalizeFundamentalValue>; unit: string; direction: string; median: number | null; favorableRankPercentile: number | null;
    status: string; validPeerCount: number; eligiblePeerCount: number; missingPeerCount: number;
    validPeers: { symbol: string; value: number; sourceRecord: ReturnType<typeof fundamentalReference> }[];
    missingPeers: { symbol: string; reason: string }[]; tieCount: number; method: string;
  }>;
  const assessable = FINANCIAL_STRUCTURE_METRICS.filter((key) => metrics[key].favorableRankPercentile !== null);
  const strengths = assessable.filter((key) => metrics[key].favorableRankPercentile! > 80);
  const pressures = assessable.filter((key) => metrics[key].favorableRankPercentile! < 40);
  const fullCoverageMetrics = assessable.filter((key) => metrics[key].validPeerCount >= 5);
  return {
    schemaVersion: "MMS_FINANCIAL_STRUCTURE_PEERS_V1", classification: "DIAGNOSTIC_ONLY", asOf: selection.asOf,
    targetSymbol: input.targetSymbol, targetSourceRecord: fundamentalReference(target), basis: input.kind === "etf" ? "none" : input.basis, groupId,
    matchedReportPeriod: target?.period ?? null, inputPeerSymbolCount: candidateSymbols.length, eligiblePeerCount: eligible.length,
    excludedPeers, assessableMetricCount: assessable.length, fullCoverageMetricCount: fullCoverageMetrics.length,
    dataCoverage: fullCoverageMetrics.length >= 6 ? "full" : assessable.length >= 3 ? "limited" : "insufficient",
    metrics, strengths: strengths as readonly FundamentalMetric[], pressures: pressures as readonly FundamentalMetric[], availabilityFindings: selection.findings,
    limitations: [
      "Only available versions with the target's exact fiscal quarter and declared group are compared; target/self and duplicate versions are excluded from peer denominators.",
      "Each metric requires at least three valid distinct peers; null or incompatible units do not become zero. Identical values have a neutral 50th midrank.",
      "Financial ratios use declared percentage points or multiples. Filing currencies remain in provenance; no currency conversion is performed.",
      "Group membership, definitions and accounting comparability are caller declarations, not independently validated. Higher/lower directions are descriptive legacy heuristics, not universal financial-health rules.",
      "ETF company peer comparison is not applicable. This function is not connected to prediction, trading or promotion.",
    ],
  } as const;
}
