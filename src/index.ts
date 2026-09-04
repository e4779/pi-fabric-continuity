// pi-fabric-continuity — entry point.
//
// Architecture (docs/requirements.md):
//   - FabricProvider "continuity" over the pi event bus (sanctioned seam)
//   - provider-owned append-only journal; snapshots derived by folding
//   - before_agent_start injection, importance-ordered and token-budgeted
//   - /harness inspection command; mutations only via journaled deltas

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHarnessCommand } from "./commands.js";
import { registerInjection } from "./inject.js";
import { currentSnapshot } from "./journal.js";
import { registerAutoRefine, resetCadence } from "./refine.js";
import { registerContinuityProvider } from "./provider.js";

export default function piFabricContinuity(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    resetCadence();
    try {
      const snap = await currentSnapshot("project", process.cwd());
      if (snap.items.length > 0) {
        ctx.ui.notify(`continuity: ${snap.items.length} harness item(s) restored (journal v${snap.version})`, "info");
      }
    } catch {
      // Journal reads must never break session start.
    }
  });

  registerInjection(pi);
  registerContinuityProvider(pi);
  registerHarnessCommand(pi);
  registerAutoRefine(pi);
}

export { appendDeltas, currentSnapshot, history, journalPath, readTransitions, validateDelta } from "./journal.js";
export type { ComponentKind, Delta, HarnessItem, JournalSnapshot, Scope, Transition } from "./types.js";
