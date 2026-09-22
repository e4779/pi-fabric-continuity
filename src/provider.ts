// The `continuity` FabricProvider — the sanctioned integration seam.
// Registered over the pi event bus (pi-fabric/protocol); actions become
// first-class `continuity.*` calls inside fabric_exec with fabric-side
// validation, risk policy, nested-call audit, and cancellation.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricActionDescriptor,
  type FabricInvocationContext,
  type FabricProvider,
  type FabricProviderDiscovery,
  type FabricProviderListRequest,
  type FabricProviderRegistration,
} from "pi-fabric/protocol";
import { appendDeltas, currentSnapshot, history, journalPath, moveItem, revertToVersion, splitByScope, validateDelta } from "./journal.js";
import { auditItems, proposedDeltas } from "./audit.js";
import { searchItems } from "./search.js";
import { loadConfig } from "./config.js";
import { readCounters, recordTouches, statsForItems } from "./counters.js";
import type { ComponentKind, Delta, Scope } from "./types.js";

const scopeSchema = { type: "string", enum: ["project", "global"], default: "project" };
const kindSchema = { type: "string", enum: ["prompt", "memory", "skill", "subagent"] };
const str = { type: "string" };

function descriptors(): FabricActionDescriptor[] {
  return [
    {
      name: "status",
      description: "Continuity snapshot summary: journal version, item counts by kind, journal path.",
      risk: "read",
      inputSchema: { type: "object", properties: { scope: scopeSchema, cwd: str }, additionalProperties: false },
    },
    {
      name: "list",
      description: "List harness items (self-improving notes/principles/skills/subagent specs).",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, cwd: str, kind: kindSchema, activeOnly: { type: "boolean", default: true } },
        additionalProperties: false,
      },
    },
    {
      name: "read",
      description: "Read one harness item by id (full content + evidence).",
      risk: "read",
      inputSchema: { type: "object", properties: { id: { type: "string" }, scope: scopeSchema, cwd: str }, required: ["id"], additionalProperties: false },
    },
    {
      name: "search",
      description: "Case-insensitive literal search over current harness items and historical journal text (superseded versions, deleted items). Each hit: id, version/ts, bounded snippet. No LLM.",
      risk: "read",
      inputSchema: { type: "object", properties: { query: { type: "string" }, scope: scopeSchema, cwd: str }, required: ["query"], additionalProperties: false },
    },
    {
      name: "history",
      description: "Recent journal transitions (who/when/why) for audit.",
      risk: "read",
      inputSchema: { type: "object", properties: { scope: scopeSchema, cwd: str, limit: { type: "number", default: 20 } }, additionalProperties: false },
    },
    {
      name: "audit",
      description: "Deterministic staleness check: verify active items' path and package references against the live machine. Read-only proposals; apply deletes via mutate.",
      risk: "read",
      inputSchema: { type: "object", properties: { scope: scopeSchema, cwd: str }, additionalProperties: false },
    },
    {
      name: "stats",
      description: "Attribution counters per item: injections into the system prompt, touches (continuity.mutate transition or /harness keep), last injection time; decay-eligible items flagged.",
      risk: "read",
      inputSchema: { type: "object", properties: { scope: scopeSchema, cwd: str }, additionalProperties: false },
    },
    {
      name: "revert",
      description: "Revert the harness state to a given journal version by appending compensating deltas (the journal is append-only; history is never rewritten).",
      risk: "write",
      inputSchema: { type: "object", properties: { version: { type: "number" }, scope: scopeSchema, cwd: str }, required: ["version"], additionalProperties: false },
    },
    {
      name: "mutate",
      description: "Apply a batch of structured deltas (create/update/delete/move) to the harness journals. Atomic validation; evidence on create; reason on delete; move relocates an item between scopes preserving its id.",
      risk: "write",
      inputSchema: {
        type: "object",
        properties: { deltas: { type: "array", items: { type: "object" } }, scope: scopeSchema, cwd: str, source: { type: "string", enum: ["manual", "refine", "migrate"] } },
        required: ["deltas"],
        additionalProperties: false,
      },
    },
  ];
}

function resolveScope(args: Record<string, unknown>): { scope: Scope; cwd?: string } {
  const scope: Scope = args.scope === "global" ? "global" : "project";
  const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : undefined;
  return { scope, cwd };
}

function makeProvider(): FabricProvider {
  return {
    name: "continuity",
    description: "Continual harness journal: self-improving prompt notes, principles, skill descriptions, sub-agent specs. Append-only deltas, one authority, derived snapshots.",
    async list(request: FabricProviderListRequest, _context: FabricInvocationContext) {
      const all = descriptors();
      if (request.limit && request.limit > 0) return all.slice(0, request.limit);
      return all;
    },
    async describe(actionName: string, _context: FabricInvocationContext) {
      return descriptors().find((d) => d.name === actionName);
    },
    async invoke(actionName: string, args: Record<string, unknown>, context: FabricInvocationContext) {
      const actor = `provider:continuity.${actionName}`;
      const { scope } = resolveScope(args);
      const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : context.cwd;
      switch (actionName) {
        case "status": {
          const snap = await currentSnapshot(scope, cwd);
          const byKind: Record<string, number> = {};
          for (const it of snap.items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
          return {
            scope,
            version: snap.version,
            total: snap.items.length,
            active: snap.items.filter((i) => i.active).length,
            byKind,
            journal: journalPath(scope, cwd),
          };
        }
        case "list": {
          const snap = await currentSnapshot(scope, cwd);
          let items = snap.items;
          const kind = args.kind as ComponentKind | undefined;
          if (kind) items = items.filter((i) => i.kind === kind);
          if (args.activeOnly !== false) items = items.filter((i) => i.active);
          return { scope, version: snap.version, items };
        }
        case "read": {
          const id = args.id as string;
          const snap = await currentSnapshot(scope, cwd);
          return snap.items.find((i) => i.id === id) ?? null;
        }
        case "search": {
          // F3.1: scope omitted searches both journals; each hit is tagged.
          const query = typeof args.query === "string" ? args.query : "";
          const scopeArg = args.scope === "global" || args.scope === "project" ? args.scope : undefined;
          return searchItems({ query, ...(scopeArg ? { scope: scopeArg } : {}), cwd });
        }
        case "history": {
          const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
          return { scope, transitions: await history(scope, cwd, limit) };
        }
        case "audit": {
          const snap = await currentSnapshot(scope, cwd);
          const globalSnap = await currentSnapshot("global", cwd);
          const findings = auditItems([...globalSnap.items, ...snap.items], { cwd });
          return { findings, proposed: proposedDeltas(findings) };
        }
        case "stats": {
          const snap = await currentSnapshot(scope, cwd);
          const counters = await readCounters();
          const config = await loadConfig();
          return {
            scope,
            version: snap.version,
            decayAfterInjections: config.decayAfterInjections,
            stats: statsForItems(snap.items, counters, config.decayAfterInjections),
          };
        }
        case "revert": {
          const version = typeof args.version === "number" ? Math.floor(args.version) : NaN;
          if (!Number.isFinite(version) || version < 0) throw new Error("version must be a non-negative number");
          const out = await revertToVersion({ scope, cwd, version, actor });
          return {
            revertedTo: version,
            applied: out.transitions.length,
            version: out.snapshot.version,
          };
        }
        case "mutate": {
          if (!Array.isArray(args.deltas)) throw new Error("deltas must be an array");
          const deltas = args.deltas as Delta[];
          for (const d of deltas) {
            const err = validateDelta(d);
            if (err) throw new Error(err);
          }
          const source = args.source === "refine" || args.source === "migrate" ? args.source : "manual";
          const moves = deltas.filter((d) => (d as { op?: string }).op === "move");
          const rest = deltas.filter((d) => (d as { op?: string }).op !== "move");
          const moved = [] as Array<{ id: string; from: string | null; to: string; moved: boolean }>;
          const touched: string[] = [];
          for (const m of moves) {
            const mv = m as { id: string; to: Scope };
            const r = await moveItem({ cwd, id: mv.id, to: mv.to, actor });
            moved.push({ id: mv.id, from: r.from, to: mv.to, moved: r.moved });
            if (r.moved) touched.push(mv.id);
          }
          let applied = 0;
          let version = (await currentSnapshot(scope, cwd)).version;
          const routed: string[] = [];
          for (const [targetScope, group] of splitByScope(rest, scope)) {
            if (group.length === 0) continue;
            const out = await appendDeltas({ scope: targetScope, cwd, actor, source, deltas: group });
            applied += out.transitions.length;
            touched.push(...out.transitions.map((t) => t.target).filter((t): t is string => typeof t === "string"));
            if (targetScope === scope) version = out.snapshot.version;
            routed.push(`${group.length}->${targetScope}`);
          }
          // F1.2: acting on an item through mutate counts as a touch. The
          // counters file is derived state — never fail a journaled mutate.
          try {
            await recordTouches(touched);
          } catch {
            // Counters unavailable — the journal write stands.
          }
          return { applied, version, routed, moved };
        }
        default:
          throw new Error(`unknown continuity action: ${actionName}`);
      }
    },
  };
}

export function registerContinuityProvider(pi: ExtensionAPI): void {
  const provider = makeProvider();
  const registration: FabricProviderRegistration = { version: 1, provider, overwrite: true };
  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, registration);
  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: unknown) => {
    // The pi event bus delivers unknown; validate the discovery shape before using it.
    const ev = event as FabricProviderDiscovery | undefined;
    if (ev && typeof ev.register === "function") ev.register(provider, { overwrite: true });
  });
}
