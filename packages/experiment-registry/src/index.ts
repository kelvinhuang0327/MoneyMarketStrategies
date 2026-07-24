export {
  applyExperimentEvent,
  attachRunEvidence,
  createExperiment,
  createExperimentRegistry,
  exportCanonicalLedger,
  getExperimentSnapshot,
  hashLedgerEvent,
  hashStrategyVersion,
  rebuildExperimentSnapshot,
  recordPromotionReview,
  registerStrategyVersion,
  transitionExperiment,
  verifyLedgerIntegrity,
} from "./experimentRegistry.js";

export { TERMINAL_STATUSES, TRANSITION_MATRIX, isTerminalStatus, isValidTransition } from "./stateMachine.js";

export { ExperimentRegistryError } from "./types.js";
export type {
  AttachRunEvidenceInput,
  CreateExperimentInput,
  RecordPromotionReviewInput,
  RegisterStrategyVersionInput,
  TransitionExperimentInput,
} from "./types.js";
