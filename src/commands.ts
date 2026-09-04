// /harness — thin inspection surface over the journal.
// v0: status | list | history [n]. Mutations go through the provider
// (continuity.mutate) so every change is journaled with an actor.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendDeltas, currentSnapshot, history, revertToVersion } from "./journal.js";
import { runRefine } from "./refine.js";

export function registerHarnessCommand(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description: "continuity: status | list | history [n] | refine [lookback] — inspect and refine the harness journal",
    // TUI contract: applyCompletion replaces the ENTIRE argument text with the
    // accepted item's value, so multi-word suggestions must repeat the
    // subcommand in value ("keep <id>", "list <kind>", "revert <version>").
    getArgumentCompletions: (argumentPrefix: string) => {
      const arg = argumentPrefix.trimStart();
      if (!arg.includes(" ")) {
        const subs = ["status", "list", "history", "refine", "keep", "drop", "revert"]
          .filter((s) => s.startsWith(arg))
          .map((s) => ({ value: s, label: s }));
        return subs.length > 0 ? subs : null;
      }
      const spaceAt = arg.indexOf(" ");
      const sub = arg.slice(0, spaceAt);
      const rest = arg.slice(spaceAt + 1).trimStart();
      if (sub === "list") {
        const kinds = ["prompt", "memory", "skill", "subagent"]
          .filter((k) => k.startsWith(rest))
          .map((k) => ({ value: `list ${k}`, label: k }));
        return kinds.length > 0 ? kinds : null;
      }
      if (sub === "keep" || sub === "drop") {
        return currentSnapshot("project", process.cwd()).then((snap) => {
          const items = snap.items
            .filter((i) => i.id.startsWith(rest))
            .map((i) => ({
              value: `${sub} ${i.id}`,
              label: `${i.id} — ${i.content.slice(0, 40)}`,
              description: i.kind,
            }));
          return items.length > 0 ? items : null;
        });
      }
      if (sub === "revert") {
        return history("project", process.cwd(), 15).then((transitions) => {
          const versions = transitions
            .map((t) => String(t.version))
            .filter((v) => v.startsWith(rest))
            .map((v) => ({ value: `revert ${v}`, label: `v${v}` }));
          return versions.length > 0 ? versions : null;
        });
      }
      return null;
    },
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      const cwd = process.cwd();
      if (sub === "refine") {
        await runRefineCommand(pi, ctx, parts.slice(1));
        return;
      }
      if (sub === "keep" || sub === "drop") {
        const idPrefix = parts[1] ?? "";
        if (!idPrefix) {
          await ctx.ui.notify("usage: /harness keep|drop <id>", "info");
          return;
        }
        const snap = await currentSnapshot("project", cwd);
        const item = snap.items.find((i) => i.id === idPrefix) ?? snap.items.find((i) => i.id.startsWith(idPrefix));
        if (!item) {
          await ctx.ui.notify(`continuity: no item matching ${idPrefix}`, "warning");
          return;
        }
        const bump = sub === "keep" ? 0.1 : -0.1;
        const importance = Math.round(Math.min(1, Math.max(0, item.importance + bump)) * 100) / 100;
        await appendDeltas({ scope: "project", cwd, actor: "command:harness", source: "manual", deltas: [{ op: "update", id: item.id, importance }] });
        await ctx.ui.notify(`continuity: ${item.id} importance ${item.importance.toFixed(2)} -> ${importance.toFixed(2)}`, "info");
        return;
      }
      if (sub === "revert") {
        const version = Number(parts[1]);
        if (!Number.isFinite(version) || version < 0) {
          await ctx.ui.notify("usage: /harness revert <version>", "info");
          return;
        }
        try {
          const out = await revertToVersion({ scope: "project", cwd, version, actor: "command:harness" });
          await ctx.ui.notify(`continuity: reverted to v${version} (${out.transitions.length} compensating delta(s), journal v${out.snapshot.version})`, "info");
        } catch (err) {
          await ctx.ui.notify(`continuity revert failed: ${String(err)}`, "warning");
        }
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

  // Muscle-memory alias for the old continual-harness command name.
  pi.registerCommand("refine", {
    description: "continuity: alias for /harness refine [lookback] [instructions]",
    handler: async (args: string, ctx) => {
      await runRefineCommand(pi, ctx, args.trim().split(/\s+/).filter(Boolean));
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
