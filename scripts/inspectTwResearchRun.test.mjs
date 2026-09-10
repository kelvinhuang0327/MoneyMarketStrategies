import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildPredictionRetrainingResultV1 } from "@mms/contracts";

import {
  CANONICAL_ARTIFACT_FILENAMES,
  formatTwResearchRunComparison,
  formatTwResearchRunInspection,
  inspectTwResearchRun,
  parseArgs,
} from "./inspectTwResearchRun.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function buildTestPredictionResult(runId = "research-run-inspector-test-001") {
  return buildPredictionRetrainingResultV1({
    runId,
    generatedAt: "2026-08-12T00:00:00.000Z",
  });
}

function buildRunContents({ runId } = {}) {
  return new Map([
    [CANONICAL_ARTIFACT_FILENAMES[0], Buffer.from('{"artifact":"study"}\n')],
    [CANONICAL_ARTIFACT_FILENAMES[1], Buffer.from("# study artifact\n")],
    [CANONICAL_ARTIFACT_FILENAMES[2], Buffer.from('{"artifact":"challenger"}\n')],
    [
      CANONICAL_ARTIFACT_FILENAMES[3],
      Buffer.from(`${JSON.stringify(buildTestPredictionResult(runId), null, 2)}\n`),
    ],
  ]);
}

function createRunDirectory({ omit = [], extraFiles = [], runId } = {}) {
  const runDir = mkdtempSync(path.join(tmpdir(), "mms-research-run-inspector-"));
  try {
    const contents = buildRunContents({ runId });
    for (const [filename, bytes] of contents) {
      if (!omit.includes(filename)) {
        writeFileSync(path.join(runDir, filename), bytes);
      }
    }
    for (const [filename, bytes] of extraFiles) {
      writeFileSync(path.join(runDir, filename), bytes);
    }
    return { runDir, contents };
  } catch (error) {
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

function runInspectorCli(args) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/inspectTwResearchRun.mjs", ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotDirectory(runDir) {
  const filenames = readdirSync(runDir).sort();
  return {
    filenames,
    contents: new Map(filenames.map((filename) => [
      filename,
      readFileSync(path.join(runDir, filename)),
    ])),
  };
}

function comparisonArtifactBlock(output, filename) {
  const start = output.indexOf(`Filename: ${filename}`);
  const next = output.indexOf("Filename: ", start + 1);
  const end = next === -1
    ? output.indexOf("PRIMARY PREDICTION-RESULT SUMMARY")
    : next;
  return output.slice(start, end);
}

function writeContractInvalidPredictionResult(runDir) {
  const predictionFilename = CANONICAL_ARTIFACT_FILENAMES[3];
  const invalid = JSON.parse(JSON.stringify(buildTestPredictionResult()));
  invalid.schemaVersion = "MMS_NOT_A_PREDICTION_RESULT_V1";
  writeFileSync(path.join(runDir, predictionFilename), Buffer.from(JSON.stringify(invalid)));
}

test("parseArgs supports both run-directory forms and rejects invalid arguments", () => {
  assert.deepEqual(parseArgs(["--run-dir", "path/to/run"]), {
    runDir: "path/to/run",
  });
  assert.deepEqual(parseArgs(["--run-dir=path/to/run"]), {
    runDir: "path/to/run",
  });
  assert.deepEqual(parseArgs(["--run-dir", "primary", "--compare-to", "comparison"]), {
    runDir: "primary",
    compareTo: "comparison",
  });
  assert.deepEqual(parseArgs(["--compare-to=comparison", "--run-dir=primary"]), {
    runDir: "primary",
    compareTo: "comparison",
  });

  assert.throws(() => parseArgs([]), /missing required argument: --run-dir/);
  assert.throws(() => parseArgs(["--run-dir"]), /missing required value for --run-dir/);
  assert.throws(() => parseArgs(["--run-dir="]), /missing required value for --run-dir/);
  assert.throws(() => parseArgs(["--run-dir", "primary", "--compare-to"]), /missing required value for --compare-to/);
  assert.throws(() => parseArgs(["--run-dir", "primary", "--compare-to="]), /missing required value for --compare-to/);
  assert.throws(() => parseArgs(["--unknown-flag", "run"]), /unrecognized flag/);
  assert.throws(() => parseArgs(["positional"]), /unexpected positional argument/);
  assert.throws(
    () => parseArgs(["--run-dir", "first", "--run-dir=second"]),
    /duplicate --run-dir/,
  );
  assert.throws(
    () => parseArgs(["--run-dir", "primary", "--compare-to", "first", "--compare-to=second"]),
    /duplicate --compare-to/,
  );
});

test("inspects canonical artifacts in fixed order with exact byte counts and hashes", () => {
  const { runDir, contents } = createRunDirectory();
  try {
    const inspection = inspectTwResearchRun(runDir);

    assert.deepEqual(
      inspection.artifacts.map(({ filename }) => filename),
      CANONICAL_ARTIFACT_FILENAMES,
    );
    assert.deepEqual(
      inspection.artifacts.map(({ byteCount }) => byteCount),
      CANONICAL_ARTIFACT_FILENAMES.map((filename) => contents.get(filename).byteLength),
    );
    assert.equal(
      inspection.artifacts[0].sha256,
      "d5cf328727be716cd2777f9e69dd263724774b0dd2bd8874e8fb9300252e08fa",
    );
    assert.equal(
      inspection.artifacts[1].sha256,
      "c87bd4ba394eed69824d56acb6f24fff3d1e347d8db02de949214efef6d98c94",
    );
    assert.equal(
      inspection.artifacts[2].sha256,
      "9ad7fdc0c6136a59c0d1785e4b8abe290ccdb1578c7053f7a7f464d3655dd223",
    );
    assert.deepEqual(inspection.predictionResult.runId, "research-run-inspector-test-001");

    const output = formatTwResearchRunInspection(inspection);
    const repeatedOutput = formatTwResearchRunInspection(inspection);
    assert.equal(repeatedOutput, output);
    assert.equal(output.includes("Computed SHA-256:"), true);
    for (const filename of CANONICAL_ARTIFACT_FILENAMES) {
      assert.equal(output.includes(filename), true);
    }
    assert.equal(output.indexOf(CANONICAL_ARTIFACT_FILENAMES[0]) < output.indexOf(CANONICAL_ARTIFACT_FILENAMES[1]), true);
    assert.equal(output.indexOf(CANONICAL_ARTIFACT_FILENAMES[1]) < output.indexOf(CANONICAL_ARTIFACT_FILENAMES[2]), true);
    assert.equal(output.indexOf(CANONICAL_ARTIFACT_FILENAMES[2]) < output.indexOf(CANONICAL_ARTIFACT_FILENAMES[3]), true);
    assert.equal(output.includes("MMS PREDICTION & RETRAINING RESULT SUMMARY"), true);
    assert.equal(output.includes("Run ID: research-run-inspector-test-001"), true);
    assert.equal(output.includes("Dataset: unavailable:"), true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("valid completed run supports both CLI argument forms and returns exit 0", () => {
  const { runDir } = createRunDirectory();
  try {
    const separateValue = runInspectorCli(["--run-dir", runDir]);
    const equalsValue = runInspectorCli([`--run-dir=${runDir}`]);

    assert.equal(separateValue.status, 0);
    assert.equal(equalsValue.status, 0);
    assert.equal(separateValue.stderr, "");
    assert.equal(equalsValue.stderr, "");
    assert.equal(separateValue.stdout, equalsValue.stdout);
    assert.equal(
      separateValue.stdout,
      formatTwResearchRunInspection(inspectTwResearchRun(runDir)),
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("comparison emits canonical artifacts in fixed order and both validated summaries", () => {
  let primary;
  let comparison;
  try {
    primary = createRunDirectory({ runId: "primary-summary-run" });
    comparison = createRunDirectory({ runId: "comparison-summary-run" });
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      formatTwResearchRunComparison({
        primary: inspectTwResearchRun(primary.runDir),
        comparison: inspectTwResearchRun(comparison.runDir),
      }),
    );
    assert.match(result.stdout, /^MMS TW RESEARCH RUN COMPARISON\n/);
    for (let index = 0; index < CANONICAL_ARTIFACT_FILENAMES.length; index += 1) {
      const filename = CANONICAL_ARTIFACT_FILENAMES[index];
      assert.equal(result.stdout.includes(`Filename: ${filename}`), true);
      if (index > 0) {
        assert.equal(
          result.stdout.indexOf(`Filename: ${CANONICAL_ARTIFACT_FILENAMES[index - 1]}`)
            < result.stdout.indexOf(`Filename: ${filename}`),
          true,
        );
      }
    }
    assert.equal(result.stdout.includes("PRIMARY PREDICTION-RESULT SUMMARY"), true);
    assert.equal(result.stdout.includes("COMPARISON PREDICTION-RESULT SUMMARY"), true);
    assert.equal(result.stdout.includes("Run ID: primary-summary-run"), true);
    assert.equal(result.stdout.includes("Run ID: comparison-summary-run"), true);
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("identical artifact bytes produce SAME for every canonical artifact", () => {
  let primary;
  let comparison;
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory();
    const result = runInspectorCli([
      `--run-dir=${primary.runDir}`,
      `--compare-to=${comparison.runDir}`,
    ]);

    assert.equal(result.status, 0);
    assert.equal((result.stdout.match(/Content Status: SAME/g) ?? []).length, 4);
    assert.equal((result.stdout.match(/Content Status: DIFFERENT/g) ?? []).length, 0);
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("one changed opaque artifact produces DIFFERENT only for that artifact", () => {
  let primary;
  let comparison;
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory();
    const changedFilename = CANONICAL_ARTIFACT_FILENAMES[1];
    writeFileSync(path.join(comparison.runDir, changedFilename), Buffer.from("# changed artifact\n"));

    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.equal(result.status, 0);
    assert.equal((result.stdout.match(/Content Status: SAME/g) ?? []).length, 3);
    assert.equal((result.stdout.match(/Content Status: DIFFERENT/g) ?? []).length, 1);
    assert.match(comparisonArtifactBlock(result.stdout, changedFilename), /Content Status: DIFFERENT/);
    for (const filename of CANONICAL_ARTIFACT_FILENAMES.filter(
      (candidate) => candidate !== changedFilename,
    )) {
      assert.match(comparisonArtifactBlock(result.stdout, filename), /Content Status: SAME/);
    }
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("comparison reports exact byte counts and locally computed hashes for both sides", () => {
  let primary;
  let comparison;
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory();
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.equal(result.status, 0);
    for (const filename of CANONICAL_ARTIFACT_FILENAMES) {
      const primaryBytes = primary.contents.get(filename);
      const comparisonBytes = comparison.contents.get(filename);
      const block = comparisonArtifactBlock(result.stdout, filename);
      assert.match(block, new RegExp(`Primary Byte Count: ${primaryBytes.byteLength}\\n`));
      assert.match(block, new RegExp(`Comparison Byte Count: ${comparisonBytes.byteLength}\\n`));
      assert.match(block, new RegExp(`Primary Computed SHA-256: ${sha256(primaryBytes)}\\n`));
      assert.match(block, new RegExp(`Comparison Computed SHA-256: ${sha256(comparisonBytes)}\\n`));
    }
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("comparison output is byte-identical when absolute directory roots are swapped", () => {
  let first;
  let second;
  try {
    first = createRunDirectory();
    second = createRunDirectory();
    const primaryFirst = runInspectorCli([
      "--run-dir",
      first.runDir,
      "--compare-to",
      second.runDir,
    ]);
    const primarySecond = runInspectorCli([
      "--run-dir",
      second.runDir,
      "--compare-to",
      first.runDir,
    ]);

    assert.equal(primaryFirst.status, 0);
    assert.equal(primarySecond.status, 0);
    assert.equal(primaryFirst.stdout, primarySecond.stdout);
    assert.equal(primaryFirst.stdout.includes(first.runDir), false);
    assert.equal(primaryFirst.stdout.includes(second.runDir), false);
  } finally {
    if (first) rmSync(first.runDir, { recursive: true, force: true });
    if (second) rmSync(second.runDir, { recursive: true, force: true });
  }
});

test("identical artifact contents produce byte-identical stdout across directories", () => {
  let first;
  let second;
  try {
    first = createRunDirectory();
    second = createRunDirectory();
    const firstResult = runInspectorCli(["--run-dir", first.runDir]);
    const secondResult = runInspectorCli(["--run-dir", second.runDir]);

    assert.equal(firstResult.status, 0);
    assert.equal(secondResult.status, 0);
    assert.equal(firstResult.stdout, secondResult.stdout);
    assert.equal(firstResult.stdout.includes(first.runDir), false);
    assert.equal(firstResult.stdout.includes(second.runDir), false);
  } finally {
    if (first) rmSync(first.runDir, { recursive: true, force: true });
    if (second) rmSync(second.runDir, { recursive: true, force: true });
  }
});

test("missing canonical artifact fails closed with empty stdout", () => {
  const missingFilename = CANONICAL_ARTIFACT_FILENAMES[1];
  const { runDir } = createRunDirectory({ omit: [missingFilename] });
  try {
    const result = runInspectorCli(["--run-dir", runDir]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(missingFilename));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("missing canonical artifact on PRIMARY fails closed with empty stdout", () => {
  let primary;
  let comparison;
  const missingFilename = CANONICAL_ARTIFACT_FILENAMES[0];
  try {
    primary = createRunDirectory({ omit: [missingFilename] });
    comparison = createRunDirectory();
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(missingFilename));
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("missing canonical artifact on COMPARISON fails closed with empty stdout", () => {
  let primary;
  let comparison;
  const missingFilename = CANONICAL_ARTIFACT_FILENAMES[2];
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory({ omit: [missingFilename] });
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(missingFilename));
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("missing run directory fails closed with empty stdout", () => {
  const parentDir = mkdtempSync(path.join(tmpdir(), "mms-research-run-inspector-parent-"));
  const missingRunDir = path.join(parentDir, "missing-run");
  try {
    const result = runInspectorCli(["--run-dir", missingRunDir]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /failed to access run directory/);
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
  }
});

test("non-file canonical path fails closed with empty stdout", () => {
  const nonFileFilename = CANONICAL_ARTIFACT_FILENAMES[2];
  const { runDir } = createRunDirectory({ omit: [nonFileFilename] });
  try {
    mkdirSync(path.join(runDir, nonFileFilename));
    const result = runInspectorCli(["--run-dir", runDir]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not a regular file/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("malformed prediction-result JSON fails closed with empty stdout", () => {
  const predictionFilename = CANONICAL_ARTIFACT_FILENAMES[3];
  const { runDir } = createRunDirectory();
  try {
    writeFileSync(path.join(runDir, predictionFilename), Buffer.from("{ malformed json\n"));
    const result = runInspectorCli(["--run-dir", runDir]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prediction-result artifact validation failed/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("malformed PRIMARY prediction-result fails closed with empty stdout", () => {
  let primary;
  let comparison;
  const predictionFilename = CANONICAL_ARTIFACT_FILENAMES[3];
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory();
    writeFileSync(path.join(primary.runDir, predictionFilename), Buffer.from("{ malformed json\n"));
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prediction-result artifact validation failed/);
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("malformed COMPARISON prediction-result fails closed with empty stdout", () => {
  let primary;
  let comparison;
  const predictionFilename = CANONICAL_ARTIFACT_FILENAMES[3];
  try {
    primary = createRunDirectory();
    comparison = createRunDirectory();
    writeFileSync(path.join(comparison.runDir, predictionFilename), Buffer.from("{ malformed json\n"));
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prediction-result artifact validation failed/);
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("contract-invalid prediction-result fails closed with empty stdout", () => {
  const predictionFilename = CANONICAL_ARTIFACT_FILENAMES[3];
  const { runDir } = createRunDirectory();
  try {
    const invalid = JSON.parse(JSON.stringify(buildTestPredictionResult()));
    invalid.schemaVersion = "MMS_NOT_A_PREDICTION_RESULT_V1";
    writeFileSync(path.join(runDir, predictionFilename), Buffer.from(JSON.stringify(invalid)));
    const result = runInspectorCli(["--run-dir", runDir]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prediction-result artifact validation failed/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

for (const invalidSide of ["PRIMARY", "COMPARISON"]) {
  test(`contract-invalid ${invalidSide} prediction result fails closed with empty stdout`, () => {
    let primary;
    let comparison;
    try {
      primary = createRunDirectory();
      comparison = createRunDirectory();
      writeContractInvalidPredictionResult(
        invalidSide === "PRIMARY" ? primary.runDir : comparison.runDir,
      );
      const result = runInspectorCli([
        "--run-dir",
        primary.runDir,
        "--compare-to",
        comparison.runDir,
      ]);

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /prediction-result artifact validation failed/);
    } finally {
      if (primary) rmSync(primary.runDir, { recursive: true, force: true });
      if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
    }
  });
}

test("successful execution does not modify input files or add runtime artifacts", () => {
  const { runDir, contents } = createRunDirectory({
    extraFiles: [["unrelated-artifact.txt", Buffer.from("ignored\n")]],
  });
  try {
    const beforeNames = readdirSync(runDir).sort();
    const beforeContents = new Map(
      [...contents.keys(), "unrelated-artifact.txt"].map((filename) => [
        filename,
        readFileSync(path.join(runDir, filename)),
      ]),
    );
    const result = runInspectorCli(["--run-dir", runDir]);
    const afterNames = readdirSync(runDir).sort();

    assert.equal(result.status, 0);
    assert.deepEqual(afterNames, beforeNames);
    for (const [filename, before] of beforeContents) {
      assert.deepEqual(readFileSync(path.join(runDir, filename)), before);
    }
    assert.equal(result.stdout.includes("unrelated-artifact.txt"), false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("comparison is read-only and emits no advice, execution, or better/worse verdict", () => {
  let primary;
  let comparison;
  try {
    primary = createRunDirectory({
      extraFiles: [["primary-unrelated.txt", Buffer.from("ignored\n")]],
    });
    comparison = createRunDirectory({
      extraFiles: [["comparison-unrelated.txt", Buffer.from("ignored\n")]],
    });
    const beforePrimary = snapshotDirectory(primary.runDir);
    const beforeComparison = snapshotDirectory(comparison.runDir);
    const result = runInspectorCli([
      "--run-dir",
      primary.runDir,
      "--compare-to",
      comparison.runDir,
    ]);
    const summaryStart = result.stdout.indexOf("PRIMARY PREDICTION-RESULT SUMMARY");
    const comparisonInventory = result.stdout.slice(0, summaryStart);

    assert.equal(result.status, 0);
    assert.doesNotMatch(comparisonInventory, /\b(BUY|SELL|HOLD)\b/i);
    assert.doesNotMatch(comparisonInventory, /recommendation|advice|execution/i);
    assert.doesNotMatch(result.stdout, /\b(better|improved|regressed|winner)\b/i);
    assert.deepEqual(snapshotDirectory(primary.runDir), beforePrimary);
    assert.deepEqual(snapshotDirectory(comparison.runDir), beforeComparison);
  } finally {
    if (primary) rmSync(primary.runDir, { recursive: true, force: true });
    if (comparison) rmSync(comparison.runDir, { recursive: true, force: true });
  }
});

test("inventory surface introduces no new advice or execution terminology", () => {
  const { runDir } = createRunDirectory();
  try {
    const result = runInspectorCli(["--run-dir", runDir]);
    const summaryStart = result.stdout.indexOf("PREDICTION-RESULT SUMMARY");
    const inventory = result.stdout.slice(0, summaryStart);

    assert.equal(result.status, 0);
    assert.doesNotMatch(inventory, /\b(BUY|SELL|HOLD)\b/i);
    assert.doesNotMatch(inventory, /investment advice|portfolio allocation|order execution/i);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("formatted artifact hashes match the exact bytes supplied to the inspector", () => {
  const { runDir, contents } = createRunDirectory();
  try {
    const inspection = inspectTwResearchRun(runDir);
    for (const artifact of inspection.artifacts) {
      const bytes = contents.get(artifact.filename);
      assert.equal(artifact.byteCount, bytes.byteLength);
      assert.equal(artifact.sha256, sha256(bytes));
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
