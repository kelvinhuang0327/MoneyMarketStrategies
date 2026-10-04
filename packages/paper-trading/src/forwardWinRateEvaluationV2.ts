import { stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoForwardCliOverrides,
  forwardWinRateCliFailure,
  runForwardWinRateEvaluationV2Files,
} from "./forwardWinRateEvaluator.js";

async function main(args: readonly string[]): Promise<void> {
  assertNoForwardCliOverrides(args);
  stdout.write(`${JSON.stringify(await runForwardWinRateEvaluationV2Files())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    stdout.write(`${JSON.stringify(forwardWinRateCliFailure(error))}\n`);
    process.exitCode = 1;
  });
}
