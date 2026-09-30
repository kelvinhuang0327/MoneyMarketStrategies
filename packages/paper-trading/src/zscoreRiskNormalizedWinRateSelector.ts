import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runRiskNormalizedZScoreWinRateSelection,
  ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
} from "./zscoreWinRateSelector.js";

async function main(args: readonly string[]): Promise<void> {
  if (args.length > 0) throw new TypeError("risk-normalized z-score selector accepts no data, candidate-grid, or risk overrides");
  const artifact = await runRiskNormalizedZScoreWinRateSelection();
  stdout.write(`${JSON.stringify({
    artifactPath: ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
    selectionStatus: artifact["selectionStatus"],
    selectedFutureCandidate: artifact["selectedFutureCandidate"],
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown normalized z-score selection error";
    stderr.write(`paper:select-zscore-risk-normalized-win-rate: ${message}\n`);
    process.exitCode = 1;
  });
}
