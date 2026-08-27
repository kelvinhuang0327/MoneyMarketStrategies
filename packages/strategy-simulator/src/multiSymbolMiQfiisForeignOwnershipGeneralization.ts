import type { MiQfiisDecision } from "./perSymbolMiQfiisForeignOwnershipLogisticChallengerTemporal.js";

export const MI_QFIIS_GENERALIZATION_OOS_SYMBOLS = Object.freeze([
  "0050",
  "2317",
  "2330",
  "2454",
] as const);

export const MI_QFIIS_GENERALIZATION_EQUITY_SYMBOLS = Object.freeze([
  "2317",
  "2330",
  "2454",
] as const);

export type MultiSymbolMiQfiisOosSymbol = (typeof MI_QFIIS_GENERALIZATION_OOS_SYMBOLS)[number];
export type MultiSymbolMiQfiisEquitySymbol = (typeof MI_QFIIS_GENERALIZATION_EQUITY_SYMBOLS)[number];

export type MultiSymbolMiQfiisSymbolVerdict = "KEEP" | "REJECT" | "NEED_ONE_CONFIRMATION";

export type MultiSymbolMiQfiisGeneralizationLabel =
  | "KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION"
  | "REJECT_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION";

export const MI_QFIIS_GENERALIZATION_POOLED_METRICS_ROLE =
  "DIAGNOSTIC_CONTEXT_ONLY_NOT_A_GATE_DEPENDENCY" as const;

export interface MultiSymbolMiQfiisGeneralizationGateInput {
  readonly symbolVerdicts: Readonly<Record<MultiSymbolMiQfiisOosSymbol, MultiSymbolMiQfiisSymbolVerdict>>;
}

export interface MultiSymbolMiQfiisGeneralizationGateResult {
  readonly symbolVerdicts: Readonly<Record<MultiSymbolMiQfiisOosSymbol, MultiSymbolMiQfiisSymbolVerdict>>;
  readonly etf0050Verdict: MultiSymbolMiQfiisSymbolVerdict;
  readonly equityKeepCountOutOf3: number;
  readonly oosKeepCountOutOf4: number;
  readonly pooledMetricsRole: typeof MI_QFIIS_GENERALIZATION_POOLED_METRICS_ROLE;
  readonly aggregateLabel: MultiSymbolMiQfiisGeneralizationLabel;
}

function isSymbolVerdict(value: unknown): value is MultiSymbolMiQfiisSymbolVerdict {
  return value === "KEEP" || value === "REJECT" || value === "NEED_ONE_CONFIRMATION";
}

function requireSymbolVerdict(
  symbolVerdicts: Readonly<Record<string, unknown>>,
  symbol: MultiSymbolMiQfiisOosSymbol,
): MultiSymbolMiQfiisSymbolVerdict {
  const verdict = symbolVerdicts[symbol];
  if (!isSymbolVerdict(verdict)) {
    throw new Error(`INVALID_MI_QFIIS_GENERALIZATION_VERDICT:${symbol}:${String(verdict)}`);
  }
  return verdict;
}

export function toMultiSymbolMiQfiisSymbolVerdict(
  decision: MiQfiisDecision,
): MultiSymbolMiQfiisSymbolVerdict {
  if (decision === "KEEP_MI_QFIIS_FEATURE_SLICE") return "KEEP";
  if (decision === "REJECT_MI_QFIIS_FEATURE_SLICE") return "REJECT";
  return "NEED_ONE_CONFIRMATION";
}

/**
 * Frozen V1 aggregate gate. Its decision surface contains exactly the four OOS
 * symbols: 0050 is mandatory and at least two of the three equities must KEEP.
 * Discovery symbol 0056 and pooled metrics are intentionally absent from the
 * input contract and cannot affect the result.
 */
export function evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(
  input: MultiSymbolMiQfiisGeneralizationGateInput,
): MultiSymbolMiQfiisGeneralizationGateResult {
  const inputVerdicts = input.symbolVerdicts as Readonly<Record<string, unknown>>;
  const symbolVerdicts = Object.freeze({
    "0050": requireSymbolVerdict(inputVerdicts, "0050"),
    "2317": requireSymbolVerdict(inputVerdicts, "2317"),
    "2330": requireSymbolVerdict(inputVerdicts, "2330"),
    "2454": requireSymbolVerdict(inputVerdicts, "2454"),
  });
  const equityKeepCountOutOf3 = MI_QFIIS_GENERALIZATION_EQUITY_SYMBOLS
    .filter((symbol) => symbolVerdicts[symbol] === "KEEP").length;
  const oosKeepCountOutOf4 = MI_QFIIS_GENERALIZATION_OOS_SYMBOLS
    .filter((symbol) => symbolVerdicts[symbol] === "KEEP").length;
  const aggregateLabel: MultiSymbolMiQfiisGeneralizationLabel =
    symbolVerdicts["0050"] === "KEEP" && equityKeepCountOutOf3 >= 2
      ? "KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION"
      : "REJECT_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION";

  return Object.freeze({
    symbolVerdicts,
    etf0050Verdict: symbolVerdicts["0050"],
    equityKeepCountOutOf3,
    oosKeepCountOutOf4,
    pooledMetricsRole: MI_QFIIS_GENERALIZATION_POOLED_METRICS_ROLE,
    aggregateLabel,
  });
}
