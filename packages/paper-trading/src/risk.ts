import { executionPriceMinor, reservedBuyCashMinor } from "./money.js";
import type { RiskLimits, SyntheticTradingTerms } from "./types.js";

export type RiskReasonCode =
  | "HALTED"
  | "MAX_POSITION_EXCEEDED"
  | "MAX_EXPOSURE_EXCEEDED"
  | "INSUFFICIENT_FUNDS"
  | "PENDING_POSITION_LIMIT"
  | "PENDING_EXPOSURE_LIMIT"
  | "PENDING_FUNDS_LIMIT"
  | "INSUFFICIENT_FUNDS_AT_FILL"
  | "FILL_POSITION_LIMIT"
  | "FILL_EXPOSURE_LIMIT";

export function validateRiskLimits(limits: RiskLimits): void {
  if (!Number.isSafeInteger(limits.maxPositionQuantity) || limits.maxPositionQuantity < 0) {
    throw new RangeError("maxPositionQuantity must be a non-negative safe integer");
  }
  if (limits.maxExposureMinor < 0n) {
    throw new RangeError("maxExposureMinor must be non-negative");
  }
  if (!Number.isSafeInteger(limits.maxMarketAgeMs) || limits.maxMarketAgeMs < 0) {
    throw new RangeError("maxMarketAgeMs must be a non-negative safe integer");
  }
}

export function targetRiskReason(input: {
  readonly targetQuantity: number;
  readonly currentPosition: number;
  readonly markPriceMinor: bigint;
  readonly cashMinor: bigint;
  readonly reservedCashMinor: bigint;
  readonly halted: boolean;
  readonly limits: RiskLimits;
  readonly terms: SyntheticTradingTerms;
}): RiskReasonCode | null {
  const { targetQuantity, currentPosition, markPriceMinor, limits } = input;
  if (input.halted && targetQuantity > currentPosition) return "HALTED";
  if (targetQuantity > limits.maxPositionQuantity) return "MAX_POSITION_EXCEEDED";
  if (targetQuantity > currentPosition) {
    const buyQuantity = targetQuantity - currentPosition;
    const expectedBuyPrice = executionPriceMinor("buy", markPriceMinor, input.terms.slippageBps);
    const expectedExposure = BigInt(currentPosition) * markPriceMinor + BigInt(buyQuantity) * expectedBuyPrice;
    if (expectedExposure > limits.maxExposureMinor) {
      return "MAX_EXPOSURE_EXCEEDED";
    }
    const needed = reservedBuyCashMinor(
      buyQuantity,
      markPriceMinor,
      input.terms.slippageBps,
      input.terms.feeBps,
    );
    if (input.cashMinor - input.reservedCashMinor < needed) return "INSUFFICIENT_FUNDS";
  }
  return null;
}

export function pendingBuyRiskReason(input: {
  readonly positionQuantity: number;
  readonly pendingQuantity: number;
  readonly markPriceMinor: bigint;
  readonly cashMinor: bigint;
  readonly limits: RiskLimits;
  readonly terms: SyntheticTradingTerms;
}): RiskReasonCode | null {
  if (input.positionQuantity + input.pendingQuantity > input.limits.maxPositionQuantity) {
    return "PENDING_POSITION_LIMIT";
  }
  const expectedBuyPrice = executionPriceMinor("buy", input.markPriceMinor, input.terms.slippageBps);
  const expectedExposure = BigInt(input.positionQuantity) * input.markPriceMinor
    + BigInt(input.pendingQuantity) * expectedBuyPrice;
  if (expectedExposure > input.limits.maxExposureMinor) {
    return "PENDING_EXPOSURE_LIMIT";
  }
  const reserve = reservedBuyCashMinor(
    input.pendingQuantity,
    input.markPriceMinor,
    input.terms.slippageBps,
    input.terms.feeBps,
  );
  if (reserve > input.cashMinor) return "PENDING_FUNDS_LIMIT";
  return null;
}

export function buyFillRiskReason(input: {
  readonly postFillPosition: number;
  readonly fillQuantity: number;
  readonly remainingPendingQuantity: number;
  readonly markPriceMinor: bigint;
  readonly executionPriceMinor: bigint;
  readonly cashAfterFillMinor: bigint;
  readonly limits: RiskLimits;
  readonly terms: SyntheticTradingTerms;
}): RiskReasonCode | null {
  const projectedQuantity = input.postFillPosition + input.remainingPendingQuantity;
  if (projectedQuantity > input.limits.maxPositionQuantity) return "FILL_POSITION_LIMIT";
  const preFillPosition = input.postFillPosition - input.fillQuantity;
  const expectedPendingPrice = executionPriceMinor("buy", input.markPriceMinor, input.terms.slippageBps);
  const expectedExposure = BigInt(preFillPosition) * input.markPriceMinor
    + BigInt(input.fillQuantity) * input.executionPriceMinor
    + BigInt(input.remainingPendingQuantity) * expectedPendingPrice;
  if (expectedExposure > input.limits.maxExposureMinor) {
    return "FILL_EXPOSURE_LIMIT";
  }
  const reserveAfter = reservedBuyCashMinor(
    input.remainingPendingQuantity,
    input.markPriceMinor,
    input.terms.slippageBps,
    input.terms.feeBps,
  );
  if (input.cashAfterFillMinor < reserveAfter) return "INSUFFICIENT_FUNDS_AT_FILL";
  return null;
}
