// vcc evidence for refine (spec F2) — bounded vcc_recall output fed to the
// proposer as extra evidence about the project's session history.
//
// Strictly optional by construction: the config flag defaults to false
// (F2.1); when pi-vcc is absent, unloadable, or the recall call fails,
// collection returns undefined and refine proceeds unchanged — silent
// fallback, never an error (F2.3).
//
// Loading: the pi SDK exposes no cross-extension tool call, so we import the
// installed @monotykamary/pi-vcc package (sibling of this package under
// ~/.pi/agent/npm/node_modules), run its extension factory against a capturing
// stub, and drive the registered vcc_recall tool with the live context (the
// tool only reads ctx.sessionManager). A failed import or a factory that never
// registers vcc_recall reads as "absent".

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VCC_MAX_QUERIES, projectQueries, textOf } from "./refine-core.js";

// Dynamic specifier on purpose: pi-vcc is an optional runtime dependency and
// must stay invisible to tsc (no type declarations in the dev clone).
const VCC_PACKAGE: string = "@monotykamary/pi-vcc";

/** Structural shape of the registered vcc_recall tool we need. */
interface VccTool {
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<unknown>;
}

/** One vcc_recall invocation: query + scope in, recall text (or none) out. */
export type VccRecall = (args: { query: string; scope: string }) => Promise<string | undefined>;

export interface VccEvidenceOptions {
  /** F2.1 config flag — collection never runs when false. */
  enabled: boolean;
  /** Session cwd; project-relevant recall queries derive from it. */
  cwd: string;
  /** Live pi context forwarded to the tool's execute (session file access). */
  ctx?: ExtensionContext;
  /** Injection seam for probes; defaults to the real pi-vcc loader. */
  recall?: VccRecall;
}

/**
 * Import @monotykamary/pi-vcc, run its extension factory against a capturing
 * stub, and return a recall fn bound to the registered vcc_recall tool.
 * Undefined (never throws) when the package is absent or exposes no tool.
 */
export async function loadVccRecall(ctx?: ExtensionContext): Promise<VccRecall | undefined> {
  try {
    const mod = (await import(VCC_PACKAGE)) as { default?: unknown };
    if (typeof mod?.default !== "function") return undefined;
    const tools = new Map<string, VccTool>();
    // Tolerant stub: the factory also registers hooks and commands — capture
    // the tools, no-op everything else, never touch the real event bus.
    const capture = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "registerTool"
            ? (tool: { name?: unknown; execute?: unknown }) => {
                if (tool && typeof tool.name === "string" && typeof tool.execute === "function") {
                  tools.set(tool.name, tool as VccTool);
                }
              }
            : () => undefined,
        set: () => true,
      },
    );
    (mod.default as (api: unknown) => void)(capture);
    const tool = tools.get("vcc_recall");
    if (!tool) return undefined;
    return async ({ query, scope }) => {
      const res = await tool.execute("continuity-refine-vcc", { query, scope }, undefined, undefined, ctx);
      const text = textOf((res as { content?: unknown } | undefined)?.content).trim();
      return text || undefined;
    };
  } catch {
    return undefined; // F2.3: absent or unloadable — silent fallback
  }
}

/**
 * F2.2: bounded vcc_recall evidence for project-relevant queries.
 * Undefined unless the flag is on AND pi-vcc is present AND the recall call
 * succeeds with non-empty output (F2.3).
 */
export async function collectVccEvidence(opts: VccEvidenceOptions): Promise<string | undefined> {
  if (!opts.enabled) return undefined;
  const queries = projectQueries(opts.cwd).slice(0, VCC_MAX_QUERIES);
  if (queries.length === 0) return undefined;
  const recall = opts.recall ?? (await loadVccRecall(opts.ctx));
  if (!recall) return undefined;
  const parts: string[] = [];
  try {
    for (const query of queries) {
      const out = await recall({ query, scope: "all" });
      const text = out?.trim();
      if (text) parts.push(`query "${query}":\n${text}`);
    }
  } catch {
    return undefined; // F2.3: a failed call must never fail refine
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
