// /harness — thin inspection surface over the journal.
// v0: status | list | history [n]. Mutations go through the provider
// (continuity.mutate) so every change is journaled with an actor.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendDeltas, currentSnapshot, history, moveItem, revertToVersion } from "./journal.js";
import { runRefine } from "./refine.js";
import { lastKnownSessionCwd, sessionCwdOf } from "./session-cwd.js";
import { auditItems, proposedDeltas } from "./audit.js";
import { searchItems } from "./search.js";
import { loadConfig } from "./config.js";
import { readCounters, recordTouches, statsForItems } from "./counters.js";
import type { Delta, HarnessItem, Scope } from "./types.js";

export function registerHarnessCommand(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description: "continuity: status | list | search <query> | stats | history [n] | refine [lookback] | audit [--apply] | keep/drop <id> | move <id> <scope> | revert <version>",
    // TUI contract: applyCompletion replaces the ENTIRE argument text with the
    // accepted item's value, so multi-word suggestions must repeat the
    // subcommand in value ("keep <id>", "list <kind>", "revert <version>").
    getArgumentCompletions: (argumentPrefix: string) => {
      const arg = argumentPrefix.trimStart();
      if (!arg.includes(" ")) {
        const subs = ["status", "list", "search", "stats", "history", "refine", "audit", "keep", "drop", "move", "revert"]
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
        return currentSnapshot("project", lastKnownSessionCwd()).then((snap) =>
          currentSnapshot("global", lastKnownSessionCwd()).then((gsnap) => {
            const items = [...snap.items, ...gsnap.items]
              .filter((i) => i.id.startsWith(rest))
              .map((i) => ({
                value: `${sub} ${i.id}`,
                label: `${i.id} — ${i.content.slice(0, 40)}`,
                description: i.scope,
              }));
            return items.length > 0 ? items : null;
          }),
        );
      }
      if (sub === "move") {
        const stage = /^\S+\s+\S*$/.test(rest);
        if (!stage) {
          return currentSnapshot("project", lastKnownSessionCwd()).then((snap) =>
            currentSnapshot("global", lastKnownSessionCwd()).then((gsnap) => {
              const items = [...snap.items, ...gsnap.items]
                .filter((i) => i.id.startsWith(rest.trim()))
                .map((i) => ({
                  value: `move ${i.id}`,
                  label: `${i.id} — ${i.content.slice(0, 40)}`,
                  description: `${i.scope} -> ?`,
                }));
              return items.length > 0 ? items : null;
            }),
          );
        }
        const [idPart, scopePart] = rest.split(/\s+/);
        const targets = ["global", "project"].filter((s) => s.startsWith(scopePart));
        const items = targets.map((s) => ({ value: `move ${idPart} ${s}`, label: s }));
        return items.length > 0 ? items : null;
      }
      if (sub === "revert") {
        return history("project", lastKnownSessionCwd(), 15).then((transitions) => {
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
      const cwd = sessionCwdOf(ctx);
      if (sub === "move") {
        const idPrefix = parts[1] ?? "";
        const to = parts[2];
        if (!idPrefix || (to !== "global" && to !== "project")) {
          await ctx.ui.notify("usage: /harness move <id> global|project", "info");
          return;
        }
        const snap = await currentSnapshot("project", cwd);
        const gsnap = await currentSnapshot("global", cwd);
        const pool = [...snap.items, ...gsnap.items];
        const item = pool.find((i) => i.id === idPrefix) ?? pool.find((i) => i.id.startsWith(idPrefix));
        if (!item) {
          await ctx.ui.notify(`continuity: no item matching ${idPrefix}`, "warning");
          return;
        }
        const r = await moveItem({ cwd, id: item.id, to, actor: "command:harness" });
        await ctx.ui.notify(
          r.moved ? `continuity: moved ${item.id} ${r.from} -> ${to}` : `continuity: ${item.id} already in ${to}`,
          "info",
        );
        return;
      }
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
        const gsnap = await currentSnapshot("global", cwd);
        const pool = [...snap.items, ...gsnap.items];
        const item = pool.find((i) => i.id === idPrefix) ?? pool.find((i) => i.id.startsWith(idPrefix));
        if (!item) {
          await ctx.ui.notify(`continuity: no item matching ${idPrefix}`, "warning");
          return;
        }
        const bump = sub === "keep" ? 0.1 : -0.1;
        const importance = Math.round(Math.min(1, Math.max(0, item.importance + bump)) * 100) / 100;
        await appendDeltas({ scope: item.scope, cwd, actor: "command:harness", source: "manual", deltas: [{ op: "update", id: item.id, importance }] });
        // F1.2: keep is an explicit touch — the note earned its tokens.
        try {
          await recordTouches([item.id]);
        } catch {
          // Counters unavailable — the journaled keep stands.
        }
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
      if (sub === "audit") {
        const apply = parts.includes("--apply");
        const snap = await currentSnapshot("project", cwd);
        const gsnap = await currentSnapshot("global", cwd);
        const findings = auditItems([...gsnap.items, ...snap.items]);
        if (findings.length === 0) {
          await ctx.ui.notify("continuity audit: all active items check out", "info");
          return;
        }
        if (!apply) {
          const lines = findings.map((f) => `[${f.id}] (${f.kind}) ${f.reason}: ${f.detail}`);
          const body = [`continuity audit — ${findings.length} finding(s):`, ...lines, "", "/harness audit --apply to retire flagged item(s)"].join("\n");
          await ctx.ui.notify(body, "info");
          return;
        }
        const deltas = proposedDeltas(findings);
        const all = [...snap.items, ...gsnap.items];
        const byScope = new Map<Scope, Delta[]>();
        for (const d of deltas) {
          const scope: Scope = all.find((i) => i.id === d.id)?.scope ?? "project";
          byScope.set(scope, [...(byScope.get(scope) ?? []), d]);
        }
        let applied = 0;
        for (const [scope, group] of byScope) {
          const out = await appendDeltas({ scope, cwd, actor: "command:harness", source: "manual", deltas: group });
          applied += out.transitions.length;
        }
        await ctx.ui.notify(`continuity audit: retired ${applied} item(s) (revert via /harness history)`, "info");
        return;
      }
      if (sub === "list") {
        const snap = await currentSnapshot("project", cwd);
        const gsnap = await currentSnapshot("global", cwd);
        const lines = [
          ...snap.items.map(
            (i) => `[${i.id}] (${i.kind}, imp ${i.importance.toFixed(2)}${i.active ? "" : ", inactive"}) ${i.content.slice(0, 100)}`,
          ),
          ...gsnap.items.map(
            (i) => `[${i.id}] (global, ${i.kind}, imp ${i.importance.toFixed(2)}${i.active ? "" : ", inactive"}) ${i.content.slice(0, 100)}`,
          ),
        ];
        await ctx.ui.notify(lines.length ? lines.join("\n") : "continuity: no items yet", "info");
        return;
      }
      if (sub === "search") {
        // F3.2: same hits as continuity.search, rendered for the human.
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          await ctx.ui.notify("usage: /harness search <query>", "info");
          return;
        }
        const res = await searchItems({ query, cwd });
        if (res.hits.length === 0) {
          await ctx.ui.notify(`continuity search: no matches for "${query}"`, "info");
          return;
        }
        const lines = res.hits.map((h) => {
          const meta = [h.scope, h.kind, h.current ? "current" : "historical", `v${h.version}`].filter(Boolean).join(", ");
          return `[${h.id}] (${meta}) ${h.field}: ${h.snippet}`;
        });
        const cap = res.total > res.hits.length ? ` (of ${res.total}, showing first ${res.hits.length})` : "";
        await ctx.ui.notify([`continuity search "${query}" — ${res.hits.length} hit(s)${cap}:`, ...lines].join("\n"), "info");
        return;
      }
      if (sub === "stats") {
        const config = await loadConfig();
        const counters = await readCounters();
        const snap = await currentSnapshot("project", cwd);
        const gsnap = await currentSnapshot("global", cwd);
        const line = (prefix: string, i: HarnessItem) => {
          const s = statsForItems([i], counters, config.decayAfterInjections)[0];
          const last = s.lastInjectedAt === null ? "never" : new Date(s.lastInjectedAt).toISOString().slice(0, 19);
          return `${prefix}[${i.id}] inj ${s.injections} touch ${s.touches} last ${last}${s.decayEligible ? "  <- decay candidate" : ""}`;
        };
        const lines = [...snap.items.map((i) => line("", i)), ...gsnap.items.map((i) => line("(global) ", i))];
        const header = `continuity stats — decay after ${config.decayAfterInjections} zero-touch injection(s):`;
        await ctx.ui.notify(lines.length ? [header, ...lines].join("\n") : "continuity: no items yet", "info");
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
