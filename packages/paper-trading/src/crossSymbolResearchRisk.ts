/** Fixed simulation risk profile for bounded cross-symbol research only. */
export interface CrossSymbolResearchRiskProfile {
  readonly id: "CROSS_SYMBOL_RESEARCH_RISK_V1";
  readonly initialCapitalMinor: bigint;
  readonly maxExposureMinor: bigint;
  readonly maxExposureFractionOfInitialCapital: number;
  readonly currency: "TWD";
  readonly minorUnitsPerMajor: 100;
}

export const CROSS_SYMBOL_RESEARCH_RISK_V1: CrossSymbolResearchRiskProfile = Object.freeze({
  id: "CROSS_SYMBOL_RESEARCH_RISK_V1",
  initialCapitalMinor: 10_000_000n,
  maxExposureMinor: 2_000_000n,
  maxExposureFractionOfInitialCapital: 0.20,
  currency: "TWD",
  minorUnitsPerMajor: 100,
});
