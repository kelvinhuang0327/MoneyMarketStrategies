import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runRiskNormalizedZScoreCrossSymbolForwardEvaluation,
  ZSCORE_RISK_NORMALIZED_FORWARD_RESULT_PATH,
} from "./zscoreCrossSymbolForwardEvaluator.js";

async function main(args: readonly string[]): Promise<void> {
  if (args.length > 0) throw new TypeError("risk-normalized forward evaluator accepts no symbol, data, strategy, or tuning overrides");
  const result = await runRiskNormalizedZScoreCrossSymbolForwardEvaluation();
  stdout.write(`${JSON.stringify({
    resultPath: ZSCORE_RISK_NORMALIZED_FORWARD_RESULT_PATH,
    freshDataSha256: result["freshDataSha256"],
    freshDateRange: result["freshDateRange"],
    comparisonStatus: result["comparisonStatus"],
    tradingWinRateImprovement: result["tradingWinRateImprovement"],
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown risk-normalized forward evaluation error";
    stderr.write(`paper:evaluate-risk-normalized-zscore-forward: ${message}\n`);
    process.exitCode = 1;
  });
}
