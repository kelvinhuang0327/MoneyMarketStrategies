import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import { evaluateHistoricalWindow, HISTORICAL_ACTION_COST_CONFIG, HISTORICAL_ACTION_COST_OUTPUT, type HistoricalDividend, type HistoricalDiagnosticWindow } from "./historicalActionCostDiagnostic.js";
import { executionPriceMinor, reservedBuyCashMinor } from "./money.js";
import { targetRiskReason } from "./risk.js";
import { calculateTenMonthSmaSignals, type MonthEndTrendSignal } from "./trendVsHoldDiagnostic.js";

export const HISTORICAL_EXPOSURE_AUDIT_OUTPUT = "packages/paper-trading/historical-exposure-audit-v1.json";
const INITIAL = 100_000n;
type Json = Record<string, unknown>;
function record(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("audit record missing");
  return value as Json;
}
function minor(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) throw new TypeError("audit integer amount missing");
  return BigInt(value);
}
function countDirections(results: readonly Json[]): Json {
  return {
    denominator: results.length,
    candidateHigher: results.filter((r) => record(r["relativeOutcome"])["directionAcrossModeledTaxBounds"] === "CANDIDATE_HIGHER").length,
    benchmarkHigher: results.filter((r) => record(r["relativeOutcome"])["directionAcrossModeledTaxBounds"] === "BENCHMARK_HIGHER").length,
    tiedOrTaxIndeterminate: results.filter((r) => record(r["relativeOutcome"])["directionAcrossModeledTaxBounds"] === "INDETERMINATE").length,
  };
}
function auditArm(arm: Json, includeRejectionDetails: boolean): Json {
  const fields = ["startingEquityMinor", "endingEquityMinor", "netReturnBeforePersonalDividendTaxFraction",
    "maximumDrawdownBeforePersonalDividendTaxFraction", "completedTradeCount", "completedTradeWinRateBeforePersonalDividendTax",
    "openPositionQuantity", "fillCount", "firstInvestedDate", "investedSessionCount", "evaluatedSessionCount",
    "decisions", "reasonCodeCounts", "pnlAttribution"];
  const exposure = { ...record(arm["exposureAudit"]) };
  if (!includeRejectionDetails) delete exposure["rejectedDecisions"];
  return { ...Object.fromEntries(fields.map((field) => [field, arm[field]])), exposureAudit: exposure };
}
function auditControl(result: Json): Json {
  return {
    id: result["id"], startDate: result["startDate"], endDate: result["endDate"], rowCount: result["rowCount"],
    candidate: auditArm(record(result["candidate"]), false), costMatchedBenchmark: auditArm(record(result["costMatchedBenchmark"]), false),
    relativeOutcome: result["relativeOutcome"],
  };
}

/** Both arms start after the first completed 10-month signal is available.
 * Calendar resets later in the archive retain their previously known signal. */
export function commonEligibilityWindow(
  window: HistoricalDiagnosticWindow,
  signals: readonly MonthEndTrendSignal[],
  observedDates: readonly string[],
): HistoricalDiagnosticWindow {
  const first = signals[0]?.signalDate;
  if (!first) throw new TypeError("no completed signal; a fair common-eligibility comparison is unavailable");
  const startDate = window.startDate < first ? first : window.startDate;
  if (startDate > window.endDate) throw new TypeError("window ends before common eligibility");
  const selected = observedDates.filter((date) => date >= startDate && date <= window.endDate);
  if (selected[0] !== startDate || selected.at(-1) !== window.endDate) throw new TypeError("common eligibility endpoints missing");
  return { ...window, startDate, rowCount: selected.length };
}

export function relativePnlAttribution(candidate: Json, benchmark: Json): Json {
  const c = record(candidate["pnlAttribution"]);
  const b = record(benchmark["pnlAttribution"]);
  const price = minor(c["priceMovementMinor"]) - minor(b["priceMovementMinor"]);
  const dividend = minor(c["grossDistributionMinor"]) - minor(b["grossDistributionMinor"]);
  const commission = minor(b["feesMinor"]) - minor(c["feesMinor"]);
  const slippage = minor(b["slippageMinor"]) - minor(c["slippageMinor"]);
  const tax = minor(b["sellTaxMinor"]) - minor(c["sellTaxMinor"]);
  const net = minor(candidate["endingEquityMinor"]) - minor(benchmark["endingEquityMinor"]);
  if (price + dividend + commission + slippage + tax !== net) throw new TypeError("relative exposure attribution does not reconcile");
  return {
    differentHoldingDatesPriceEffectMinor: price.toString(), dividendEffectMinor: dividend.toString(),
    commissionEffectMinor: commission.toString(), slippageEffectMinor: slippage.toString(), sellTaxEffectMinor: tax.toString(),
    endingEquityDeltaMinor: net.toString(),
    interpretation: "Exact journal identity. Different holding dates measure changed market exposure; they do not establish predictive signal skill or risk-adjusted alpha.",
  };
}

export async function runHistoricalExposureAuditFiles(root = process.cwd()): Promise<Json> {
  const inputPath = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv";
  const [input, configBytes, reportBytes, dividendBytes] = await Promise.all([
    readFile(resolve(root, inputPath)), readFile(resolve(root, HISTORICAL_ACTION_COST_CONFIG)),
    readFile(resolve(root, HISTORICAL_ACTION_COST_OUTPUT)), readFile(resolve(root, "data/market/0050-corporate-actions-v2/dividends.json")),
  ]);
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const config = record(JSON.parse(configBytes.toString()));
  const sourceReport = record(JSON.parse(reportBytes.toString()));
  if (sha(configBytes) !== "311344de3ef252035fcd9d91a49d2af1ad098e0c6b0a11621d9aa4d3a4b8bd6e"
    || sourceReport["configSha256"] !== sha(configBytes) || sourceReport["sourceSha256"] !== sha(input)
    || sourceReport["corporateActionsSha256"] !== sha(dividendBytes)) throw new TypeError("frozen source contract or report inputs mismatch");
  const parsed = parseHistoricalCsv(input.toString(), "0050", inputPath, "twse-daily-ohlcv-close-v1");
  if (parsed.rowCount !== config["sourceRowCount"] || parsed.startDate !== config["sourceStartDate"] || parsed.endDate !== config["sourceEndDate"]
    || config["sourceSha256"] !== sha(input) || config["dividendsSha256"] !== sha(dividendBytes)) throw new TypeError("source coverage mismatch");
  const dividends = record(JSON.parse(dividendBytes.toString()))["events"] as HistoricalDividend[];
  const windows = config["windows"] as HistoricalDiagnosticWindow[];
  const sourceResults = sourceReport["results"] as Json[];
  if (!Array.isArray(windows) || windows.length !== 8 || !Array.isArray(sourceResults) || sourceResults.length !== windows.length) throw new TypeError("frozen chronological coverage missing");
  const rows = parsed.session.events.map((e) => ({ date: e.eventId.slice(-10), closeMinor: e.priceMinor }));
  const signals = calculateTenMonthSmaSignals(rows, { evaluationStartDate: "2020-10-01", evaluationEndDate: parsed.endDate, warmupStartDate: parsed.startDate, firstEligibleSignalMonth: "2020-10", lastEligibleSignalMonth: "2026-07", windows: [] });
  const commonResults: Json[] = [];
  const matchedResults: Json[] = [];
  const audits = windows.map((window, index) => {
    const original = evaluateHistoricalWindow(parsed, sha(input), window, signals, dividends, "EVERY_EVENT", true);
    if (original["id"] !== sourceResults[index]?.["id"]) throw new TypeError("frozen result window identity mismatch");
    for (const arm of ["candidate", "costMatchedBenchmark"]) {
      const current = record(original[arm]);
      const frozen = record(sourceResults[index]![arm]);
      for (const field of ["endingEquityMinor", "netReturnBeforePersonalDividendTaxFraction", "maximumDrawdownBeforePersonalDividendTaxFraction", "completedTradeCount", "openPositionQuantity", "fillCount", "feesPaidMinor", "sellTransactionTaxCeilMinor", "distributionCashMinor", "investedSessionCount"]) {
        if (current[field] !== frozen[field]) throw new TypeError(`frozen result changed: ${window.id}/${arm}/${field}`);
      }
    }
    const commonWindow = commonEligibilityWindow(window, signals, rows.map((r) => r.date));
    const common = commonWindow.startDate === window.startDate ? original : evaluateHistoricalWindow(parsed, sha(input), commonWindow, signals, dividends, "EVERY_EVENT", true);
    const matched = evaluateHistoricalWindow(parsed, sha(input), commonWindow, signals, dividends, "SAME_MONTHLY_OPPORTUNITIES", true);
    commonResults.push(common);
    matchedResults.push(matched);
    const mark = rows.find((r) => r.date === window.startDate)!.closeMinor;
    const startingRisk = targetRiskReason({ targetQuantity: 3, currentPosition: 0, markPriceMinor: mark, cashMinor: INITIAL, reservedCashMinor: 0n, halted: false, limits: parsed.session.simulation.risk, terms: parsed.session.simulation.terms });
    const candidate = record(original["candidate"]);
    const benchmark = record(original["costMatchedBenchmark"]);
    const startingExposure = executionPriceMinor("buy", mark, 100) * 3n;
    return {
      ...window, initialCapitalMinor: INITIAL.toString(), targetQuantity: 3, startingRawPriceMinor: mark.toString(),
      startingRawTargetNotionalMinor: (mark * 3n).toString(), projectedInitialBuyExposureMinor: startingExposure.toString(),
      projectedInitialBuyReservationMinor: reservedBuyCashMinor(3, mark, 100, 30).toString(),
      sameExecutableRiskAndCostConstraints: true,
      constraints: { maxPositionQuantity: 4, maxIncreasedPositionExposureMinor: "50000", feeBps: 30, slippageBps: 100, initialCapitalMinor: INITIAL.toString() },
      startDateTargetExecutable: startingRisk === null, startDateRiskReason: startingRisk,
      benchmarkInterpretation: startingRisk === null ? "START_DATE_ORDER_NEXT_EVENT_HOLDING" : "RISK_TIMED_DELAYED_ENTRY; NOT_START_DATE_BUY_AND_HOLD",
      purchaseOpportunityDifference: "Original hold benchmark retries daily; frozen SMA candidate requests increased exposure at first event or monthly signal dates. Diagnostic comparator below matches these opportunities.",
      candidate: auditArm(candidate, true), costMatchedBenchmark: auditArm(benchmark, true), relativePnlAttribution: relativePnlAttribution(candidate, benchmark),
      commonEligibilityControl: { ...auditControl(common), classification: "DIAGNOSTIC_ONLY_COMMON_COMPLETED_SIGNAL_ELIGIBILITY" },
      sameMonthlyOpportunityControl: {
        ...auditControl(matched), classification: "DIAGNOSTIC_ONLY_SAME_MONTHLY_PURCHASE_OPPORTUNITIES",
        evaluationStatus: record(matched["costMatchedBenchmark"])["fillCount"] === 0 ? "INCONCLUSIVE_BENCHMARK_NOT_INVESTABLE" : "DESCRIPTIVE_ONLY",
      },
      zeroYieldCashControl: { endingEquityMinor: INITIAL.toString(), netReturnFraction: "0.00000000", classification: "DIAGNOSTIC_ZERO_YIELD_CASH; NOT_A_SELECTED_STRATEGY" },
    };
  });
  const evaluable = matchedResults.filter((r) => record(r["costMatchedBenchmark"])["fillCount"] !== 0);
  const positiveAndExcess = evaluable.filter((r) => minor(record(r["candidate"])["endingEquityMinor"]) > INITIAL
    && record(r["relativeOutcome"])["directionAcrossModeledTaxBounds"] === "CANDIDATE_HIGHER");
  const output: Json = {
    schemaVersion: 1, artifactId: "0050-historical-exposure-audit-v1", classification: "RETROSPECTIVE_DIAGNOSTIC_ONLY",
    frozenConfigSha256: sha(configBytes), sourceReportSha256: sha(reportBytes), sourceSha256: sha(input), corporateActionsSha256: sha(dividendBytes),
    parameterSearch: false, frozenStrategyAndRiskUnchanged: true, sourceReportReconciledWithoutOverwrite: true,
    originalEvaluationRowCount: sourceReport["evaluationRowCount"],
    commonEligibilityEvaluationRowCount: commonResults.reduce((n, r) => n + Number(r["rowCount"]), 0),
    extraInitialWarmupRowCount: Number(sourceReport["evaluationRowCount"]) - commonResults.reduce((n, r) => n + Number(r["rowCount"]), 0),
    originalWindowCounts: sourceReport["descriptiveWindowCounts"], commonEligibilityWindowCounts: countDirections(commonResults),
    sameMonthlyOpportunityCounts: { ...countDirections(evaluable), configuredWindowCount: windows.length, inconclusiveBenchmarkWindowCount: windows.length - evaluable.length },
    positiveAbsoluteAndBenchmarkExcessWindowCount: positiveAndExcess.length,
    researchDisposition: "REJECT_AS_PROFIT_IMPROVEMENT_CANDIDATE; RETAIN_FIXED_DIAGNOSTIC_CODE; NO_PARAMETER_SEARCH",
    conclusion: "The original two relative advantages are startup eligibility/entry timing in 2020 and much lower market exposure in 2022. The common-start 2020 advantage vanishes; 2022 still loses to zero-yield cash. No evaluable segment has both positive return and excess over the opportunity-matched holding control.",
    audits,
    interpretationLimits: [
      "This is a diagnostic attribution, not causal proof that a signal has or lacks universal predictive value.",
      "Same raw 3-share stake is not the same economic stake across the 4:1 split. No pooled success rate or risk-adjusted alpha across eight independent portfolios is claimed.",
      "Monthly-opportunity control is an explicit comparator; it does not replace the frozen daily-retrying hold benchmark or change live/paper risk.",
      "Exposure means are actual marked capital per observed session, not executable fractional-share counterfactual portfolios.",
      "Personal distribution taxes, broker minimum fees, source session completeness and live execution remain unverified as in the frozen source report.",
    ],
  };
  await writeFile(resolve(root, HISTORICAL_EXPOSURE_AUDIT_OUTPUT), `${JSON.stringify(output, null, 2)}\n`);
  return output;
}
