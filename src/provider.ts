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
import { appendDeltas, currentSnapshot, history, journalPath, validateDelta } from "./journal.js";
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
      name: "history",
      description: "Recent journal transitions (who/when/why) for audit.",
      risk: "read",
      inputSchema: { type: "object", properties: { scope: scopeSchema, cwd: str, limit: { type: "number", default: 20 } }, additionalProperties: false },
    },
    {
      name: "mutate",
      description: "Apply a batch of structured CRUD deltas (create/update/delete) to the harness journal. Atomic: the whole batch is validated before anything is appended. Evidence required on create; reason required on delete.",
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
        case "history": {
          const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
          return { scope, transitions: await history(scope, cwd, limit) };
        }
        case "mutate": {
          if (!Array.isArray(args.deltas)) throw new Error("deltas must be an array");
          const deltas = args.deltas as Delta[];
          for (const d of deltas) {
            const err = validateDelta(d);
            if (err) throw new Error(err);
          }
          const source = args.source === "refine" || args.source === "migrate" ? args.source : "manual";
          const out = await appendDeltas({ scope, cwd, actor, source, deltas });
          return {
            applied: out.transitions.map((t) => ({ op: t.delta.op, id: t.target ?? null, version: t.version })),
            version: out.snapshot.version,
          };
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
