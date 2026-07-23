import { hashFeatureRows } from "./evidence.js";
import {
  fail,
  type FeatureRow,
  type PartitionKind,
  type RowPartition,
  type ThreeWayChronologicalSplit,
} from "./types.js";

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function partition<K extends PartitionKind>(
  kind: K,
  rows: readonly FeatureRow[],
): RowPartition<K> {
  return Object.freeze({
    kind,
    rows: Object.freeze([...rows]),
    rowIdentitySha256: hashFeatureRows(rows),
  });
}

function minimumDate(rows: readonly FeatureRow[], field: "featureDate" | "targetDate"): string {
  const first = rows[0];
  if (first === undefined) fail(`cannot find ${field} in an empty partition`);
  return rows.reduce((earliest, row) => row[field] < earliest ? row[field] : earliest, first[field]);
}

function maximumDate(rows: readonly FeatureRow[], field: "featureDate" | "targetDate"): string {
  const first = rows[0];
  if (first === undefined) fail(`cannot find ${field} in an empty partition`);
  return rows.reduce((latest, row) => row[field] > latest ? row[field] : latest, first[field]);
}

export function splitChronologically(
  featureRows: readonly FeatureRow[],
): ThreeWayChronologicalSplit {
  if (featureRows.length === 0) fail("cannot split zero feature rows");
  if (featureRows.some((row) => row.targetDate < row.featureDate)) {
    fail("a target date precedes its feature date");
  }
  const uniqueFeatureDates = [...new Set(featureRows.map((row) => row.featureDate))]
    .sort(compareText);
  const trainEndIndex = Math.floor(uniqueFeatureDates.length * 0.6) - 1;
  const validationEndIndex = Math.floor(uniqueFeatureDates.length * 0.8) - 1;
  if (
    trainEndIndex < 0
    || validationEndIndex <= trainEndIndex
    || validationEndIndex >= uniqueFeatureDates.length - 1
  ) {
    fail("unique feature dates are insufficient for non-empty 60/20/20 boundaries");
  }
  const trainEndDate = uniqueFeatureDates[trainEndIndex];
  const validationEndDate = uniqueFeatureDates[validationEndIndex];
  if (trainEndDate === undefined || validationEndDate === undefined) {
    fail("chronological boundary dates are missing");
  }

  const training: FeatureRow[] = [];
  const trainValidationPurge: FeatureRow[] = [];
  const validation: FeatureRow[] = [];
  const validationFinalPurge: FeatureRow[] = [];
  const finalTest: FeatureRow[] = [];

  for (const row of featureRows) {
    const memberships = [
      row.targetDate <= trainEndDate,
      row.featureDate <= trainEndDate && row.targetDate > trainEndDate,
      row.featureDate > trainEndDate && row.targetDate <= validationEndDate,
      row.featureDate > trainEndDate
        && row.featureDate <= validationEndDate
        && row.targetDate > validationEndDate,
      row.featureDate > validationEndDate,
    ];
    if (memberships.filter(Boolean).length !== 1) {
      fail(`feature row does not belong to exactly one partition: ${row.symbol}:${row.featureDate}`);
    }
    if (memberships[0]) training.push(row);
    if (memberships[1]) trainValidationPurge.push(row);
    if (memberships[2]) validation.push(row);
    if (memberships[3]) validationFinalPurge.push(row);
    if (memberships[4]) finalTest.push(row);
  }

  const partitions = [
    training,
    trainValidationPurge,
    validation,
    validationFinalPurge,
    finalTest,
  ];
  if (partitions.some((rows) => rows.length === 0)) {
    fail("three-way split produced an empty partition");
  }
  if (partitions.reduce((sum, rows) => sum + rows.length, 0) !== featureRows.length) {
    fail("three-way split did not account for every feature row exactly once");
  }
  const validationStartDate = minimumDate(validation, "featureDate");
  const finalTestStartDate = minimumDate(finalTest, "featureDate");
  if (maximumDate(training, "targetDate") > trainEndDate) {
    fail("a training label crosses the training boundary");
  }
  if (validationStartDate <= trainEndDate) {
    fail("validation features do not follow the training boundary");
  }
  if (maximumDate(validation, "targetDate") > validationEndDate) {
    fail("a validation label crosses the final-test boundary");
  }
  if (finalTestStartDate <= validationEndDate) {
    fail("final-test features do not follow the validation boundary");
  }

  return Object.freeze({
    uniqueFeatureDates: Object.freeze(uniqueFeatureDates),
    trainEndDate,
    validationStartDate,
    validationEndDate,
    finalTestStartDate,
    training: partition("TRAINING", training),
    trainValidationPurge: partition("TRAIN_VALIDATION_PURGE", trainValidationPurge),
    validation: partition("VALIDATION", validation),
    validationFinalPurge: partition("VALIDATION_FINAL_PURGE", validationFinalPurge),
    finalTest: partition("FINAL_TEST", finalTest),
  });
}
