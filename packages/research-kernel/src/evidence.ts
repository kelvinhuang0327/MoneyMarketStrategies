import {
  fail,
  type DataQualityFinding,
  type DatasetVersion,
  type ExperimentRunEvidence,
  type FeatureRow,
  type FinalTestEvidence,
  type LogisticRegressionFit,
  type MarketDataRow,
  type PromotionDecision,
  type StandardScalerFit,
  type ThreeWayChronologicalSplit,
  type ThresholdSelectionEvidence,
} from "./types.js";

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) fail("cannot encode an incomplete string");
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >>> 12));
      bytes.push(0x80 | ((codePoint >>> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >>> 18));
      bytes.push(0x80 | ((codePoint >>> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >>> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }
  return bytes;
}

function sha256(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const highLength = Math.floor(bitLength / 0x1_0000_0000);
  const lowLength = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highLength >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowLength >>> shift) & 0xff);

  const hash = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] = (
        ((bytes[byteOffset] ?? 0) << 24)
        | ((bytes[byteOffset + 1] ?? 0) << 16)
        | ((bytes[byteOffset + 2] ?? 0) << 8)
        | (bytes[byteOffset + 3] ?? 0)
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const word16 = words[index - 16];
      const word7 = words[index - 7];
      if (
        word15 === undefined
        || word2 === undefined
        || word16 === undefined
        || word7 === undefined
      ) {
        fail("SHA-256 message schedule is incomplete");
      }
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (word16 + sigma0 + word7 + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    if (
      a === undefined || b === undefined || c === undefined || d === undefined
      || e === undefined || f === undefined || g === undefined || h === undefined
    ) {
      fail("SHA-256 state is incomplete");
    }
    for (let index = 0; index < 64; index += 1) {
      const roundConstant = SHA256_ROUND_CONSTANTS[index];
      const word = words[index];
      if (roundConstant === undefined || word === undefined) fail("SHA-256 round is incomplete");
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1: number = (h + sum1 + choice + roundConstant + word) >>> 0;
      const sum0: number = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2: number = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const state = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < hash.length; index += 1) {
      const current = hash[index];
      const addition = state[index];
      if (current === undefined || addition === undefined) fail("SHA-256 state update is incomplete");
      hash[index] = (current + addition) >>> 0;
    }
  }
  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function canonicalize(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("cannot hash a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  fail(`cannot canonicalize ${typeof value}`);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashValue(value: unknown): string {
  return sha256(canonicalStringify(value));
}

export function hashMarketRows(rows: readonly MarketDataRow[]): string {
  return hashValue(rows);
}

export function hashFeatureRows(rows: readonly FeatureRow[]): string {
  return hashValue(rows);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function buildExperimentRunEvidence(input: {
  readonly datasetVersion: DatasetVersion;
  readonly datasetSha256: string;
  readonly featureRowsSha256: string;
  readonly featureNames: readonly string[];
  readonly dataQualityFindings: readonly DataQualityFinding[];
  readonly split: ThreeWayChronologicalSplit;
  readonly scaler: StandardScalerFit;
  readonly model: LogisticRegressionFit;
  readonly thresholdSelection: ThresholdSelectionEvidence;
  readonly finalTest: FinalTestEvidence;
}): ExperimentRunEvidence {
  if (
    input.scaler.fitRowIdentitySha256 !== input.split.training.rowIdentitySha256
    || input.model.fitRowIdentitySha256 !== input.split.training.rowIdentitySha256
  ) {
    fail("fit evidence does not reference exactly the training partition");
  }
  if (input.thresholdSelection.validationRowsSha256 !== input.split.validation.rowIdentitySha256) {
    fail("threshold evidence does not reference exactly the validation partition");
  }
  if (input.finalTest.finalTestRowsSha256 !== input.split.finalTest.rowIdentitySha256) {
    fail("final-test evidence does not reference exactly the final-test partition");
  }
  const normalized = {
    schemaVersion: "MMS_RESEARCH_EVIDENCE_V1" as const,
    researchMode: "diagnostic-only" as const,
    datasetVersion: input.datasetVersion,
    datasetSha256: input.datasetSha256,
    featureRowsSha256: input.featureRowsSha256,
    featureNames: input.featureNames,
    dataQualityFindings: input.dataQualityFindings,
    split: {
      trainEndDate: input.split.trainEndDate,
      validationStartDate: input.split.validationStartDate,
      validationEndDate: input.split.validationEndDate,
      finalTestStartDate: input.split.finalTestStartDate,
      trainingRowCount: input.split.training.rows.length,
      trainValidationPurgeRowCount: input.split.trainValidationPurge.rows.length,
      validationRowCount: input.split.validation.rows.length,
      validationFinalPurgeRowCount: input.split.validationFinalPurge.rows.length,
      finalTestRowCount: input.split.finalTest.rows.length,
      trainingRowsSha256: input.split.training.rowIdentitySha256,
    },
    fit: {
      fitPartition: "TRAINING" as const,
      trainingRowsSha256: input.split.training.rowIdentitySha256,
      scalerFitRowCount: input.scaler.fitRowCount,
      modelFitRowCount: input.model.fitRowCount,
      scalerStateSha256: input.scaler.stateSha256,
      modelStateSha256: input.model.stateSha256,
      iterations: input.model.config.iterations,
      learningRate: input.model.config.learningRate,
      l2: input.model.config.l2,
      initialRegularizedLoss: input.model.initialRegularizedLoss,
      finalRegularizedLoss: input.model.finalRegularizedLoss,
    },
    thresholdSelection: input.thresholdSelection,
    finalTest: input.finalTest,
  };
  return deepFreeze({
    ...normalized,
    normalizedEvidenceSha256: hashValue(normalized),
  });
}

export function decidePromotion(
  evidence: ExperimentRunEvidence,
): PromotionDecision {
  const common = {
    automaticPromotion: false as const,
    manualApprovalRequired: true as const,
    requiredBaseline: "FINAL_TEST_MAJORITY_CLASS_ACCURACY" as const,
  };
  if (evidence.dataQualityFindings.length > 0) {
    return deepFreeze({
      ...common,
      status: "BLOCKED_DATA_QUALITY",
      reasons: ["Blocking data-quality findings are present."],
    });
  }
  const hashes = [
    evidence.datasetSha256,
    evidence.featureRowsSha256,
    evidence.split.trainingRowsSha256,
    evidence.fit.scalerStateSha256,
    evidence.fit.modelStateSha256,
    evidence.thresholdSelection.validationCandidateStateSha256,
    evidence.finalTest.finalTestScoredRowsSha256,
    evidence.normalizedEvidenceSha256,
  ];
  if (
    hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    || evidence.finalTest.evaluatorExecutionCount !== 1
    || evidence.fit.scalerFitRowCount !== evidence.split.trainingRowCount
    || evidence.fit.modelFitRowCount !== evidence.split.trainingRowCount
  ) {
    return deepFreeze({
      ...common,
      status: "BLOCKED_INSUFFICIENT_EVIDENCE",
      reasons: ["Required deterministic identities or isolation evidence are incomplete."],
    });
  }
  if (evidence.finalTest.metrics.accuracy <= evidence.finalTest.metrics.majorityBaseline) {
    return deepFreeze({
      ...common,
      status: "BLOCKED_UNDERPERFORMS_BASELINE",
      reasons: ["Final-test accuracy does not exceed its majority-class baseline."],
    });
  }
  return deepFreeze({
    ...common,
    status: "RESEARCH_CANDIDATE",
    reasons: [
      "Final-test accuracy exceeds its majority-class baseline.",
      "Manual research review remains required; automatic promotion is disabled.",
    ],
  });
}
