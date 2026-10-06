import { buildStockFundamentalSnapshot, type FundamentalObservation } from "./fundamentalSnapshots.js";
import { buildFinancialStructurePeerComparison } from "./fundamentalPeerComparison.js";

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
}

export function buildFundamentalOfflineDiagnostic(input: FundamentalOfflineInput) {
  if (!input || input.schemaVersion !== 1 || typeof input.datasetId !== "string" || !input.datasetId.trim()
    || !["SYNTHETIC", "PUBLIC_ARCHIVE"].includes(input.dataKind) || typeof input.reuseBasis !== "string" || !input.reuseBasis.trim()) {
    throw new TypeError("offline input requires schemaVersion=1, dataset identity, SYNTHETIC/PUBLIC_ARCHIVE kind and declared reuse basis");
  }
  return {
    schemaVersion: "MMS_OFFLINE_FUNDAMENTALS_V1", classification: "DIAGNOSTIC_ONLY", datasetId: input.datasetId,
    dataKind: input.dataKind, declaredReuseBasis: input.reuseBasis, sourceAccess: "LOCAL_INPUT_ONLY_NO_NETWORK",
    snapshot: buildStockFundamentalSnapshot({ symbol: input.symbol, kind: input.kind, asOf: input.asOf, observations: input.observations }),
    peerComparison: buildFinancialStructurePeerComparison({ targetSymbol: input.symbol, kind: input.kind, asOf: input.asOf, basis: input.peerBasis, observations: input.observations }),
    supportsTradingExecution: false, profitabilityEvidence: "NOT_EVALUATED",
  } as const;
}
