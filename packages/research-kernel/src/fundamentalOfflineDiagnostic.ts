import { buildStockFundamentalSnapshot, type FundamentalObservation } from "./fundamentalSnapshots.js";
import { buildFinancialStructurePeerComparison } from "./fundamentalPeerComparison.js";
import { deriveFinancialStatements, type FinancialStatementInput } from "./financialDerivationAdapter.js";

export interface FundamentalOfflineInput {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly dataKind: "SYNTHETIC" | "PUBLIC_ARCHIVE";
  /** A declaration by the input owner, not an independent licensing attestation. */
  readonly reuseBasis: string;
  readonly symbol: string;
  readonly kind: "stock" | "etf";
  readonly asOf: string;
  readonly peerBasis: "industry" | "sector";
  readonly observations: readonly FundamentalObservation[];
  readonly financialStatements?: readonly FinancialStatementInput[];
}

export function buildFundamentalOfflineDiagnostic(input: FundamentalOfflineInput) {
  if (!input || input.schemaVersion !== 1 || typeof input.datasetId !== "string" || !input.datasetId.trim()
    || !["SYNTHETIC", "PUBLIC_ARCHIVE"].includes(input.dataKind) || typeof input.reuseBasis !== "string" || !input.reuseBasis.trim()) {
    throw new TypeError("offline input requires schemaVersion=1, dataset identity, SYNTHETIC/PUBLIC_ARCHIVE kind and declared reuse basis");
  }
  const financialDerivation = input.financialStatements === undefined ? undefined : deriveFinancialStatements(input.financialStatements, input.asOf);
  if (!Array.isArray(input.observations)) throw new TypeError("observations must be an array");
  // A second source for the same period must be reconciled by the owner, never silently overridden.
  if (financialDerivation?.observations.some((derived) => input.observations.some((row) => row.symbol === derived.symbol
    && row.period === derived.period && row.family === derived.family))) throw new TypeError("derived and supplied FINANCIAL_STRUCTURE periods overlap; reconcile source selection explicitly");
  const observations = [...input.observations, ...(financialDerivation?.observations ?? [])];
  return {
    schemaVersion: "MMS_OFFLINE_FUNDAMENTALS_V1", classification: "DIAGNOSTIC_ONLY", datasetId: input.datasetId,
    dataKind: input.dataKind, declaredReuseBasis: input.reuseBasis, sourceAccess: "LOCAL_INPUT_ONLY_NO_NETWORK",
    ...(financialDerivation ? { financialDerivation } : {}),
    snapshot: buildStockFundamentalSnapshot({ symbol: input.symbol, kind: input.kind, asOf: input.asOf, observations }),
    peerComparison: buildFinancialStructurePeerComparison({ targetSymbol: input.symbol, kind: input.kind, asOf: input.asOf, basis: input.peerBasis, observations }),
    supportsTradingExecution: false, profitabilityEvidence: "NOT_EVALUATED",
  } as const;
}
