import { paperFillCostsV2 } from "./paperCostModelV2.js";
import type { PaperCostModelV2, OrderSide } from "./types.js";

const BPS_DENOMINATOR = 10_000n;

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError("ceilDiv requires a non-negative numerator and positive denominator");
  }
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function executionPriceMinor(
  side: OrderSide,
  referencePriceMinor: bigint,
  slippageBps: number,
): bigint {
  const factor = BigInt(slippageBps);
  const scaled = side === "buy"
    ? referencePriceMinor * (BPS_DENOMINATOR + factor)
    : referencePriceMinor * (BPS_DENOMINATOR - factor);
  const price = side === "buy"
    ? ceilDiv(scaled, BPS_DENOMINATOR)
    : scaled / BPS_DENOMINATOR;
  if (price <= 0n) throw new RangeError("synthetic execution price must be positive");
  return price;
}

export function feeMinorForFill(
  executionPrice: bigint,
  quantity: number,
  feeBps: number,
): bigint {
  const notional = executionPrice * BigInt(quantity);
  return ceilDiv(notional * BigInt(feeBps), BPS_DENOMINATOR);
}

/**
 * Conservative buy reservation. It rounds the fee up separately per share,
 * so any sequence of partial fills at this price remains covered. For v2,
 * reserve uses ceiling-rounding as an upper bound even if actual fees round
 * down or to nearest (nearest per-share fees alone need not bound partitions).
 */
export function reservedBuyCashMinor(
  quantity: number,
  referencePriceMinor: bigint,
  slippageBps: number,
  feeBps: number,
  costModel?: PaperCostModelV2,
): bigint {
  if (quantity <= 0) return 0n;
  const price = executionPriceMinor("buy", referencePriceMinor, slippageBps);
  const reservationModel = costModel ? { ...costModel, roundingMode: "ceil" as const } : undefined;
  const perShareFee = reservationModel ? paperFillCostsV2("buy", price, 1, reservationModel).totalFeeMinor
    : ceilDiv(price * BigInt(feeBps), BPS_DENOMINATOR);
  return BigInt(quantity) * (price + perShareFee);
}

export function allocateCostBasisMinor(
  totalCostMinor: bigint,
  lotQuantity: number,
  soldQuantity: number,
): bigint {
  if (soldQuantity <= 0 || soldQuantity > lotQuantity || lotQuantity <= 0) {
    throw new RangeError("cost basis allocation quantity is invalid");
  }
  if (soldQuantity === lotQuantity) return totalCostMinor;
  return (totalCostMinor * BigInt(soldQuantity)) / BigInt(lotQuantity);
}
