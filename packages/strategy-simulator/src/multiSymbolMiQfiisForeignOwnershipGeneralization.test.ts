import { describe, expect, it } from "vitest";

import {
  evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate,
  toMultiSymbolMiQfiisSymbolVerdict,
  type MultiSymbolMiQfiisGeneralizationGateInput,
  type MultiSymbolMiQfiisSymbolVerdict,
} from "./multiSymbolMiQfiisForeignOwnershipGeneralization.js";

const K: MultiSymbolMiQfiisSymbolVerdict = "KEEP";
const R: MultiSymbolMiQfiisSymbolVerdict = "REJECT";
const N: MultiSymbolMiQfiisSymbolVerdict = "NEED_ONE_CONFIRMATION";

function gate(
  etf0050: MultiSymbolMiQfiisSymbolVerdict,
  equity2317: MultiSymbolMiQfiisSymbolVerdict,
  equity2330: MultiSymbolMiQfiisSymbolVerdict,
  equity2454: MultiSymbolMiQfiisSymbolVerdict,
) {
  return evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate({
    symbolVerdicts: {
      "0050": etf0050,
      "2317": equity2317,
      "2330": equity2330,
      "2454": equity2454,
    },
  });
}

describe("frozen MI_QFIIS multi-symbol generalization gate", () => {
  it("case 1: 0050 K and equities K,K,R => KEEP", () => {
    const result = gate(K, K, K, R);
    expect(result.aggregateLabel).toBe("KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.equityKeepCountOutOf3).toBe(2);
    expect(result.oosKeepCountOutOf4).toBe(3);
  });

  it("case 2: 0050 K and equities K,K,N => KEEP", () => {
    const result = gate(K, K, K, N);
    expect(result.aggregateLabel).toBe("KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.equityKeepCountOutOf3).toBe(2);
  });

  it("case 3: 0050 R and equities K,K,K => REJECT", () => {
    const result = gate(R, K, K, K);
    expect(result.aggregateLabel).toBe("REJECT_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.equityKeepCountOutOf3).toBe(3);
  });

  it("case 4: 0050 N and equities K,K,K => REJECT", () => {
    const result = gate(N, K, K, K);
    expect(result.aggregateLabel).toBe("REJECT_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.oosKeepCountOutOf4).toBe(3);
  });

  it("case 5: 0050 K and equities K,R,R => REJECT", () => {
    const result = gate(K, K, R, R);
    expect(result.aggregateLabel).toBe("REJECT_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.equityKeepCountOutOf3).toBe(1);
  });

  it("case 6: 0050 K and equities N,K,K => KEEP", () => {
    const result = gate(K, N, K, K);
    expect(result.aggregateLabel).toBe("KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
    expect(result.equityKeepCountOutOf3).toBe(2);
  });

  it("case 7: adding or changing 0056 never changes the aggregate result", () => {
    const baselineInput: MultiSymbolMiQfiisGeneralizationGateInput = {
      symbolVerdicts: { "0050": K, "2317": K, "2330": K, "2454": R },
    };
    const with0056Keep = {
      symbolVerdicts: { ...baselineInput.symbolVerdicts, "0056": K },
    } as unknown as MultiSymbolMiQfiisGeneralizationGateInput;
    const with0056Reject = {
      symbolVerdicts: { ...baselineInput.symbolVerdicts, "0056": R },
    } as unknown as MultiSymbolMiQfiisGeneralizationGateInput;

    const baseline = evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(baselineInput);
    expect(evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(with0056Keep)).toEqual(baseline);
    expect(evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(with0056Reject)).toEqual(baseline);
  });

  it("case 8: changing pooled diagnostic metrics never changes the aggregate result", () => {
    const base = {
      symbolVerdicts: { "0050": K, "2317": N, "2330": K, "2454": K },
    };
    const optimisticPooled = {
      ...base,
      pooledMetrics: { accuracyDelta: 1, excessReturnDelta: 1 },
    } as unknown as MultiSymbolMiQfiisGeneralizationGateInput;
    const pessimisticPooled = {
      ...base,
      pooledMetrics: { accuracyDelta: -1, excessReturnDelta: -1 },
    } as unknown as MultiSymbolMiQfiisGeneralizationGateInput;

    const optimistic = evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(optimisticPooled);
    const pessimistic = evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate(pessimisticPooled);
    expect(pessimistic).toEqual(optimistic);
    expect(optimistic.aggregateLabel).toBe("KEEP_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION");
  });

  it("maps the frozen per-symbol temporal decisions without treating NEED as KEEP", () => {
    expect(toMultiSymbolMiQfiisSymbolVerdict("KEEP_MI_QFIIS_FEATURE_SLICE")).toBe(K);
    expect(toMultiSymbolMiQfiisSymbolVerdict("REJECT_MI_QFIIS_FEATURE_SLICE")).toBe(R);
    expect(toMultiSymbolMiQfiisSymbolVerdict("NEED_ONE_CONFIRMATION")).toBe(N);
  });
});
