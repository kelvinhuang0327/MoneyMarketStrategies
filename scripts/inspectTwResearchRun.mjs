#!/usr/bin/env node
// Read-only CLI inspector for one completed research:tw output directory.
// Inventories only the four canonical artifacts and delegates prediction-result
// validation and concise summary formatting to the existing implementations.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPredictionRetrainingResultArtifact } from "@mms/contracts";

import { formatPredictionRetrainingResultSummary } from "./inspectPredictionRetrainingResult.mjs";

export const CANONICAL_ARTIFACT_FILENAMES = Object.freeze([
  "tw_strategy_research_study_v1.json",
  "tw_strategy_research_study_v1.md",
  "mms_per_symbol_logistic_challenger_v1.json",
  "mms_prediction_retraining_result_v1.json",
]);

const PREDICTION_RESULT_FILENAME = CANONICAL_ARTIFACT_FILENAMES.at(-1);

/**
 * Parses CLI arguments. Requires exactly one --run-dir value.
 */
export function parseArgs(argv) {
  let runDir = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run-dir") {
      if (runDir !== null) {
        throw new Error("duplicate --run-dir argument");
      }
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error("missing required value for --run-dir <path>");
      }
      runDir = value;
      index += 1;
    } else if (flag.startsWith("--run-dir=")) {
      if (runDir !== null) {
        throw new Error("duplicate --run-dir argument");
      }
      const value = flag.slice("--run-dir=".length);
      if (value.length === 0) {
        throw new Error("missing required value for --run-dir <path>");
      }
      runDir = value;
    } else if (flag.startsWith("--")) {
      throw new Error(`unrecognized flag ${flag}`);
    } else {
      throw new Error(`unexpected positional argument: ${flag}`);
    }
  }

  if (runDir === null) {
    throw new Error("missing required argument: --run-dir <path>");
  }

  return { runDir };
}

function resolveRunDirectory(runDir) {
  const resolvedRunDir = path.resolve(runDir);
  let stats;
  try {
    stats = lstatSync(resolvedRunDir);
  } catch (error) {
    throw new Error(`failed to access run directory "${runDir}": ${error.message}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`run directory is not a directory: "${runDir}"`);
  }
  return resolvedRunDir;
}

function readCanonicalArtifact(runDir, filename) {
  const filePath = path.join(runDir, filename);
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    throw new Error(`failed to access required artifact "${filename}": ${error.message}`);
  }
  if (!stats.isFile()) {
    throw new Error(`required artifact is not a regular file: "${filename}"`);
  }

  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new Error(`failed to read required artifact "${filename}": ${error.message}`);
  }

  return {
    filename,
    byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

/**
 * Reads and validates one completed research:tw output directory.
 */
export function inspectTwResearchRun(runDir) {
  const resolvedRunDir = resolveRunDirectory(runDir);
  const artifacts = CANONICAL_ARTIFACT_FILENAMES.map((filename) => (
    readCanonicalArtifact(resolvedRunDir, filename)
  ));
  const predictionArtifact = artifacts.find(
    ({ filename }) => filename === PREDICTION_RESULT_FILENAME,
  );

  let predictionResult;
  try {
    predictionResult = readPredictionRetrainingResultArtifact(
      predictionArtifact.bytes.toString("utf8"),
    );
  } catch (error) {
    throw new Error(`prediction-result artifact validation failed: ${error.message}`);
  }

  return { artifacts, predictionResult };
}

/**
 * Formats a deterministic human-readable research-run inventory and summary.
 */
export function formatTwResearchRunInspection({ artifacts, predictionResult }) {
  const lines = [
    "MMS TW RESEARCH RUN INSPECTION",
    "",
    "CANONICAL ARTIFACTS",
  ];

  for (const artifact of artifacts) {
    lines.push(`Filename: ${artifact.filename}`);
    lines.push(`Byte Count: ${artifact.byteCount}`);
    lines.push(`Computed SHA-256: ${artifact.sha256}`);
    lines.push("");
  }

  lines.push("PREDICTION-RESULT SUMMARY");
  lines.push(formatPredictionRetrainingResultSummary(predictionResult).trimEnd());

  return `${lines.join("\n")}\n`;
}

/**
 * CLI main entrypoint.
 */
export async function main(argv = process.argv.slice(2)) {
  const { runDir } = parseArgs(argv);
  const inspection = inspectTwResearchRun(runDir);
  process.stdout.write(formatTwResearchRunInspection(inspection));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}
