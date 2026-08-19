import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildPredictionRetrainingResultV1,
} from "@mms/contracts";
import {
  runResearchEvidenceKernel,
} from "@mms/research-kernel";
import {
  buildFinalTestPerSymbolEconomicEdge,
  simulateLongCashReplay,
} from "@mms/strategy-simulator";

import {
  formatPredictionRetrainingResult,
  inspectPredictionRetrainingResultFile,
  parseArgs,
} from "./inspectPredictionRetrainingResult.mjs";

function syntheticMarketRows(count = 120) {
  const rows = [];
  const start = Date.UTC(2024, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const cycle = Math.sin((index * Math.PI) / 9);
    const close = 100 + cycle * 12 + index * 0.03;
    rows.push({
      symbol: "SYNTH",
      date,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 1000 + (index % 13) * 17,
      source: "test-owned/in-memory",
    });
  }
  return rows;
}

function buildValidTestArtifact() {
  const kernelResult = runResearchEvidenceKernel({
    datasetVersion: {
      datasetId: "synthetic-cycle",
      version: "v1",
      source: "test-owned/in-memory",
    },
    marketRows: syntheticMarketRows(),
    logisticRegression: {
      iterations: 500,
      learningRate: 0.08,
      l2: 0.01,
    },
  });

  const simulation = simulateLongCashReplay({
    symbol: "SYNTH",
    validationThreshold: 0.6,
    roundTripCostBps: 10,
    initialCapital: 1_000,
    rows: [
      {
        entryDate: "2024-04-24",
        exitDate: "2024-04-25",
        probabilityUp: 0.7,
        realizedForwardReturn: 0.01,
      },
      {
        entryDate: "2024-04-26",
        exitDate: "2024-04-29",
        probabilityUp: 0.4,
        realizedForwardReturn: -0.01,
      },
    ],
  });

  const finalTestEconomicEdge = kernelResult.finalTestEconomicEvidence === undefined
    ? undefined
    : buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: kernelResult.finalTestEconomicEvidence,
      roundTripCostBps: 10,
      initialCapital: 1_000,
    });

  return buildPredictionRetrainingResultV1({
    runId: "inspector-test-run-001",
    generatedAt: "2026-08-12T00:00:00.000Z",
    dataAsOf: "2024-04-29",
    researchVersion: "MMS_TW_STRATEGY_RESEARCH_RUNNER_V1",
    modelAlgorithm: "binary_logistic_regression",
    evidence: kernelResult.evidence,
    promotionDecision: kernelResult.promotionDecision,
    ...(kernelResult.finalTestReliability === undefined
      ? {}
      : { finalTestReliability: kernelResult.finalTestReliability }),
    ...(finalTestEconomicEdge === undefined ? {} : { finalTestEconomicEdge }),
    latestPredictions: [
      {
        scenario: "SYNTH_SCENARIO",
        symbol: "SYNTH",
        featureDate: "2024-04-29",
        probabilityUp: 0.58,
        predictedDirection: "up",
        operativeThreshold: 0.55,
        position: "LONG",
        targetDate: "2024-05-06",
        predictionRole: "resolved_historical",
        resolutionStatus: "resolved",
      },
    ],
    currentUnresolvedPredictions: [
      {
        scenario: "SYNTH_SCENARIO",
        symbol: "SYNTH",
        featureDate: "2024-04-29",
        probabilityUp: 0.62,
        predictedDirection: "up",
        operativeThreshold: 0.55,
        position: "LONG",
        targetDate: "2024-05-06",
        predictionRole: "current_unresolved",
        resolutionStatus: "unresolved",
        predictionHorizon: { unit: "trading_rows", rows: 5 },
      },
    ],
    simulation,
    warnings: [
      "Test warning 1: Diagnostic research inspection only.",
    ],
    provenanceReferences: [
      {
        kind: "dataset",
        reference: "synthetic-cycle@v1",
        sha256: "0".repeat(64),
      },
    ],
  });
}

function runInspectorCli(args, options = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/inspectPredictionRetrainingResult.mjs", ...args],
      {
        cwd: "/Users/kelvin/VibeCoding-WorkSpace/MoneyMarketStrategies",
        encoding: "utf8",
        timeout: 30_000,
        ...options,
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

test("parseArgs parses valid --artifact flags and rejects invalid arguments", () => {
  assert.deepEqual(parseArgs(["--artifact", "path/to/file.json"]), {
    artifactPath: "path/to/file.json",
  });
  assert.deepEqual(parseArgs(["--artifact=path/to/file.json"]), {
    artifactPath: "path/to/file.json",
  });

  assert.throws(() => parseArgs([]), /missing required argument: --artifact/);
  assert.throws(() => parseArgs(["--artifact"]), /missing required value for --artifact/);
  assert.throws(() => parseArgs(["--artifact="]), /missing required value for --artifact/);
  assert.throws(() => parseArgs(["--unknown-flag"]), /unrecognized flag/);
  assert.throws(() => parseArgs(["positional"]), /unexpected positional argument/);
});

test("formats valid PredictionRetrainingResultV1 artifact deterministically", () => {
  const artifact = buildValidTestArtifact();
  const output1 = formatPredictionRetrainingResult(artifact);
  const output2 = formatPredictionRetrainingResult(artifact);

  assert.equal(output1, output2);
  assert.equal(output1.includes("MMS PREDICTION & RETRAINING RESULT INSPECTION"), true);
  assert.equal(output1.includes("Schema Version:       MMS_PREDICTION_RETRAINING_RESULT_V1"), true);
  assert.equal(output1.includes("Run ID:               inspector-test-run-001"), true);
  assert.equal(output1.includes("Data As Of:           2024-04-29"), true);
  assert.equal(output1.includes("DATASET PROVENANCE"), true);
  assert.equal(output1.includes("MODEL & RETRAINING PROVENANCE"), true);
  assert.equal(output1.includes("PARTITIONS & THRESHOLD SELECTION"), true);
  assert.equal(output1.includes("FINAL-TEST RELIABILITY & CALIBRATION"), true);
  assert.equal(output1.includes("ECONOMIC EVIDENCE & SIMULATION"), true);
  assert.equal(output1.includes("PREDICTIONS SUMMARY"), true);
  assert.equal(output1.includes("RESEARCH GOVERNANCE & PROMOTION GUARDRAILS"), true);
  assert.equal(output1.includes("Provides Investment Recommendation: false"), true);
  assert.equal(output1.includes("Supports Order Execution:          false"), true);
  assert.equal(output1.includes("Supports Automatic Promotion:      false"), true);
});

test("inspectPredictionRetrainingResultFile reads and formats artifact from file", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-inspector-test-"));
  try {
    const artifact = buildValidTestArtifact();
    const artifactPath = path.join(tempDir, "valid_artifact.json");
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

    const formatted = inspectPredictionRetrainingResultFile(artifactPath);
    assert.equal(formatted.includes("inspector-test-run-001"), true);
    assert.equal(formatted.includes("MMS_PREDICTION_RETRAINING_RESULT_V1"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI inspects valid serialized artifact with exit 0 and deterministic stdout", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-inspector-test-"));
  try {
    const artifact = buildValidTestArtifact();
    const artifactPath = path.join(tempDir, "valid_artifact.json");
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

    const result1 = runInspectorCli(["--artifact", artifactPath]);
    const result2 = runInspectorCli(["--artifact", artifactPath]);

    assert.equal(result1.status, 0);
    assert.equal(result2.status, 0);
    assert.equal(result1.stderr, "");
    assert.equal(result2.stderr, "");
    assert.equal(result1.stdout, result2.stdout);
    assert.equal(result1.stdout.includes("inspector-test-run-001"), true);
    assert.equal(result1.stdout.includes("MMS_PREDICTION_RETRAINING_RESULT_V1"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI fails closed on malformed JSON input", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-inspector-test-"));
  try {
    const artifactPath = path.join(tempDir, "malformed.json");
    writeFileSync(artifactPath, "{ this is not valid json");

    const result = runInspectorCli(["--artifact", artifactPath]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("malformed JSON input"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI fails closed on contract-invalid artifact (tampered schemaVersion)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-inspector-test-"));
  try {
    const artifact = buildValidTestArtifact();
    const tampered = { ...artifact, schemaVersion: "INVALID_SCHEMA_VERSION" };
    const artifactPath = path.join(tempDir, "tampered_schema.json");
    writeFileSync(artifactPath, JSON.stringify(tampered, null, 2));

    const result = runInspectorCli(["--artifact", artifactPath]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("schemaVersion must be MMS_PREDICTION_RETRAINING_RESULT_V1"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI fails closed on contract-invalid artifact (tampered guardrails)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "mms-inspector-test-"));
  try {
    const artifact = buildValidTestArtifact();
    const tampered = {
      ...artifact,
      guardrails: {
        ...artifact.guardrails,
        providesInvestmentRecommendation: true,
      },
    };
    const artifactPath = path.join(tempDir, "tampered_guardrails.json");
    writeFileSync(artifactPath, JSON.stringify(tampered, null, 2));

    const result = runInspectorCli(["--artifact", artifactPath]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.includes("guardrails.providesInvestmentRecommendation must be false"),
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI fails closed on non-existent input file", () => {
  const result = runInspectorCli(["--artifact", "non/existent/path/artifact.json"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("failed to read artifact file"), true);
});

test("CLI fails closed on missing --artifact flag", () => {
  const result = runInspectorCli([]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("missing required argument: --artifact"), true);
});

test("Inspection output preserves research evidence without introducing investment advice semantics", () => {
  const artifact = buildValidTestArtifact();
  const output = formatPredictionRetrainingResult(artifact);

  // Forbidden newly-invented investment advice terms as recommendations
  const forbiddenPatterns = [
    /\bBUY\b/,
    /\bSELL\b/,
    /\bHOLD\b/,
    /target price/i,
    /entry price/i,
    /stop price/i,
    /portfolio weight/i,
    /trade now/i,
    /investment recommendation/i, // except in the guardrails line where it states false
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.source.includes("investment recommendation")) {
      const matches = output.split("\n").filter((line) => pattern.test(line));
      // Only allowed in the explicit guardrail statement: Provides Investment Recommendation: false
      for (const line of matches) {
        assert.equal(line.includes("Provides Investment Recommendation: false"), true);
      }
    } else {
      // Must not appear in output
      assert.equal(pattern.test(output), false, `Output should not match forbidden pattern: ${pattern}`);
    }
  }

  // Research governance and evidence values must be present
  assert.equal(output.includes("Promotion Verdict:        research_only"), true);
  assert.equal(output.includes("Automatic Promotion:      false"), true);
  assert.equal(output.includes("Manual Approval Required: true"), true);
  assert.equal(output.includes("Strategy Net Return:"), true);
  assert.equal(output.includes("Benchmark Net Return:"), true);
  assert.equal(output.includes("Excess Return:"), true);
});
