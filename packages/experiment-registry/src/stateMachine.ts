import type { ExperimentStatus } from "@mms/contracts";

export const TRANSITION_MATRIX: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = Object.freeze({
  IDEA: Object.freeze<ExperimentStatus[]>(["READY"]),
  READY: Object.freeze<ExperimentStatus[]>(["RUNNING", "DEFERRED", "REJECTED"]),
  RUNNING: Object.freeze<ExperimentStatus[]>(["PARTIAL", "BLOCKED", "VALIDATED", "DEFERRED", "REJECTED"]),
  BLOCKED: Object.freeze<ExperimentStatus[]>(["READY", "REJECTED"]),
  PARTIAL: Object.freeze<ExperimentStatus[]>(["RUNNING", "BLOCKED", "VALIDATED", "DEFERRED", "REJECTED"]),
  VALIDATED: Object.freeze<ExperimentStatus[]>([]),
  REJECTED: Object.freeze<ExperimentStatus[]>([]),
  DEFERRED: Object.freeze<ExperimentStatus[]>([]),
});

export const TERMINAL_STATUSES: ReadonlySet<ExperimentStatus> = new Set([
  "VALIDATED",
  "REJECTED",
  "DEFERRED",
]);

export function isTerminalStatus(status: ExperimentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isValidTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return TRANSITION_MATRIX[from].includes(to);
}

export function requiresValidatedGates(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return to === "VALIDATED" && (from === "RUNNING" || from === "PARTIAL");
}

export function requiresBlockerResolution(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return from === "BLOCKED" && to === "READY";
}
