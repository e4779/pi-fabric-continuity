// /harness — thin inspection surface over the journal.
// v0: status | list | history [n]. Mutations go through the provider
// (continuity.mutate) so every change is journaled with an actor.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentSnapshot, history } from "./journal.js";
import { runRefine } from "./refine.js";

export function registerHarnessCommand(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description: "continuity: status | list | history [n] | refine [lookback] — inspect and refine the harness journal",
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      const cwd = process.cwd();
      if (sub === "refine") {
        const lookback = Number(parts[1]) > 0 ? Number(parts[1]) : undefined;
        await runRefine(pi, ctx, { lookback });
        return;
      }
      if (sub === "list") {
        const snap = await currentSnapshot("project", cwd);
        const lines = snap.items.map(
          (i) => `[${i.id}] (${i.kind}, imp ${i.importance.toFixed(2)}${i.active ? "" : ", inactive"}) ${i.content.slice(0, 100)}`,
        );
        await ctx.ui.notify(lines.length ? lines.join("\n") : "continuity: no items yet", "info");
        return;
      }
      if (sub === "history") {
        const limit = Number(parts[1]) || 10;
        const transitions = await history("project", cwd, limit);
        const lines = transitions.map(
          (t) => `v${t.version} ${new Date(t.ts).toISOString().slice(0, 19)} ${t.actor} ${t.delta.op}${t.target ? " " + t.target : ""}`,
        );
        await ctx.ui.notify(lines.length ? lines.join("\n") : "continuity: journal empty", "info");
        return;
      }
      const snap = await currentSnapshot("project", cwd);
      const global = await currentSnapshot("global", cwd);
      await ctx.ui.notify(
        `continuity — project: v${snap.version}, ${snap.items.length} item(s); global: v${global.version}, ${global.items.length} item(s)`,
        "info",
      );
    },
  });
}
