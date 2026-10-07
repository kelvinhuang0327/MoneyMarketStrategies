import type { OrderSide, PaperCostModelV2 } from "./types.js";

const RATE_DENOMINATOR = 1_000_000n;

export function freezePaperCostModelV2(model: PaperCostModelV2): PaperCostModelV2 {
  if (model.version !== "paper-cost-model-v2" || model.currency !== "TWD"
    || model.minorUnitsPerMajor !== 100 || model.minimumScope !== "PER_EXECUTION_REPORT"
    || model.notionalRounding !== "EXACT_MINOR_UNITS"
    || !model.scenarioLabel?.trim() || !["stock", "equity-etf"].includes(model.instrumentType)
    || !["ceil", "floor", "nearest-half-up"].includes(model.roundingMode)) {
    throw new TypeError("unsupported paper cost model definition");
  }
  for (const rate of [model.commissionRateMillionths, model.stockSellTaxRateMillionths, model.equityEtfSellTaxRateMillionths]) {
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 1_000_000) throw new RangeError("rates must be integer millionths from 0 through 1000000");
  }
  if (typeof model.roundingIncrementMinor !== "bigint" || model.roundingIncrementMinor <= 0n
    || typeof model.minimumCommissionMinor !== "bigint" || model.minimumCommissionMinor < 0n
    || model.minimumCommissionMinor % model.roundingIncrementMinor !== 0n) {
    throw new RangeError("minimum and rounding increment must be valid aligned minor-unit amounts");
  }
  return Object.freeze({ ...model });
}

/** Separately round commission and sell tax; minimum applies to commission only.
 * Every partial execution report is independently charged, never per order/day.
 */
export function paperFillCostsV2(side: OrderSide, executionPriceMinor: bigint, quantity: number, model: PaperCostModelV2) {
  if ((side !== "buy" && side !== "sell") || typeof executionPriceMinor !== "bigint" || executionPriceMinor <= 0n
    || !Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("invalid paper fill");
  model = freezePaperCostModelV2(model);
  const notionalMinor = executionPriceMinor * BigInt(quantity);
  const rounded = (rate: number): bigint => {
    const numerator = notionalMinor * BigInt(rate), denominator = RATE_DENOMINATOR * model.roundingIncrementMinor;
    const units = model.roundingMode === "ceil" ? (numerator + denominator - 1n) / denominator
      : model.roundingMode === "floor" ? numerator / denominator
      : (2n * numerator + denominator) / (2n * denominator);
    return units * model.roundingIncrementMinor;
  };
  const percentageCommissionMinor = rounded(model.commissionRateMillionths);
  const commissionMinor = quantity === 0 ? 0n : percentageCommissionMinor > model.minimumCommissionMinor
    ? percentageCommissionMinor : model.minimumCommissionMinor;
  const taxRate = model.instrumentType === "stock" ? model.stockSellTaxRateMillionths : model.equityEtfSellTaxRateMillionths;
  const sellTaxMinor = side === "sell" ? rounded(taxRate) : 0n;
  return Object.freeze({ notionalMinor, commissionMinor, sellTaxMinor, totalFeeMinor: commissionMinor + sellTaxMinor });
}

export function publicTwCostScenarioV2(instrumentType: PaperCostModelV2["instrumentType"]): PaperCostModelV2 {
  return freezePaperCostModelV2({
    version: "paper-cost-model-v2", scenarioLabel: "PUBLIC_POSTED_RATE_MIN20_SCENARIO_NOT_USER_BROKER",
    currency: "TWD", minorUnitsPerMajor: 100, instrumentType,
    commissionRateMillionths: 1425, minimumCommissionMinor: 2000n,
    stockSellTaxRateMillionths: 3000, equityEtfSellTaxRateMillionths: 1000,
    minimumScope: "PER_EXECUTION_REPORT", notionalRounding: "EXACT_MINOR_UNITS",
    roundingIncrementMinor: 100n, roundingMode: "ceil",
  });
}
