// /refine — the single human entry point (operator decision, 2026-10-21:
// the /harness TUI subcommands were never used; curation happens by asking
// the agent, which goes through the journaled provider seam).
// Everything else is agent-driven via continuity.* provider actions from
// fabric_exec: status, list, read, search, history, audit, stats, certify,
// revert, mutate — same journal, same actors, same provenance.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runRefine } from "./refine.js";

export function registerRefineCommand(pi: ExtensionAPI): void {
  pi.registerCommand("refine", {
    description: "continuity: refine [lookback] [instructions] — trajectory evidence -> journaled deltas",
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      await runRefineCommand(pi, ctx, parts);
    },
  });
}

async function runRefineCommand(pi: ExtensionAPI, ctx: ExtensionContext, parts: string[]): Promise<void> {
  const lookback = Number(parts[0]) > 0 ? Number(parts[0]) : undefined;
  const instructions = (lookback !== undefined ? parts.slice(1) : parts).join(" ").trim() || undefined;
  try {
    await runRefine(pi, ctx, { lookback, ...(instructions ? { instructions } : {}) });
  } catch (err) {
    await ctx.ui.notify(`continuity refine failed: ${String(err)}`, "warning");
  }
}
