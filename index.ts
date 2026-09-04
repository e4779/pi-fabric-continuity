// Auto-discovery entry point: pi loads ~/.pi/agent/extensions/*/index.ts.
// The implementation lives in src/; see docs/requirements.md for architecture.
export { default } from "./src/index.js";
export {
  appendDeltas,
  currentSnapshot,
  history,
  journalPath,
  readTransitions,
  validateDelta,
} from "./src/index.js";
export type { ComponentKind, Delta, HarnessItem, JournalSnapshot, Scope, Transition } from "./src/index.js";
