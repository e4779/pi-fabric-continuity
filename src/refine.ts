// refine — the LLM runner: trajectory evidence → proposer → journaled deltas.
// Inline execution (turn context). The durable variant is a fabric_exec recipe
// that spawns an agent calling continuity.mutate — same journal, same discipline.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "./config.js";
import {
  DEFAULT_LOOKBACK_TURNS,
  PROPOSER_SYSTEM,
  buildUserText,
  evaluateCadence,
  gatherEvidence,
  parseProposerOutput,
  textOf,
} from "./refine-core.js";
import { appendDeltas, currentSnapshot, validateDelta } from "./journal.js";
import type { Delta, Scope } from "./types.js";

export interface RefineOptions {
  lookback?: number;
  scope?: Scope;
  /** true when fired by the turn_end cadence (audit tag). */
  auto?: boolean;
}

export interface RefineResult {
  scope: Scope;
  lookback: number;
  evidenceBytes: number;
  proposed: number;
  applied: number;
  summary: string;
  version: number;
  skipped?: string;
}

type AnyModel = Parameters<typeof completeSimple>[0];
type AnyContext = Parameters<typeof completeSimple>[1];

export async function runRefine(pi: ExtensionAPI, ctx: ExtensionContext, opts: RefineOptions = {}): Promise<RefineResult> {
  const scope = opts.scope ?? "project";
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK_TURNS;
  const base = { scope, lookback };

  const snap = await currentSnapshot(scope);
  const branch = (ctx.sessionManager as unknown as { getBranch(): Iterable<unknown> }).getBranch();
  const evidence = gatherEvidence(branch, lookback);
  if (!evidence.trim()) {
    await ctx.ui.notify("continuity refine: skipped — no trajectory evidence found", "info");
    return { ...base, evidenceBytes: 0, proposed: 0, applied: 0, summary: "", version: snap.version, skipped: "no trajectory evidence" };
  }
  const model = (ctx as unknown as { model?: AnyModel }).model;
  if (!model) {
    await ctx.ui.notify("continuity refine: skipped — no active model", "info");
    return { ...base, evidenceBytes: evidence.length, proposed: 0, applied: 0, summary: "", version: snap.version, skipped: "no active model" };
  }

  const context = {
    system: PROPOSER_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: buildUserText(snap.items, evidence) }] }],
  } as unknown as AnyContext;
  const msg = (await completeSimple(model, context)) as unknown as { content: unknown };
  const parsed = parseProposerOutput(textOf(msg.content));
  const deltas = (parsed?.deltas ?? []).filter((d): d is Delta => validateDelta(d) === null);

  let applied = 0;
  let version = snap.version;
  if (deltas.length > 0) {
    const actor = `model:${(model as unknown as { provider: string; id: string }).provider}/${(model as unknown as { provider: string; id: string }).id}`;
    const out = await appendDeltas({ scope, actor, source: "refine", deltas });
    applied = out.transitions.length;
    version = out.snapshot.version;
    pi.appendEntry("continuity-refinement", {
      source: opts.auto ? "auto" : "manual",
      summary: parsed?.summary ?? "",
      applied,
      version,
      ts: Date.now(),
    });
  }
  const summary = parsed?.summary || (applied === 0 ? "no changes warranted" : "");
  await ctx.ui.notify(`continuity refine: ${summary} (${applied} delta(s), journal v${version})`, "info");
  return { ...base, evidenceBytes: evidence.length, proposed: parsed?.deltas.length ?? 0, applied, summary, version };
}

// turn_end cadence — module state, reset on session_start.
let lastTurn = -1;

export function resetCadence(): void {
  lastTurn = -1;
}

export function registerAutoRefine(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    const { fire, next } = evaluateCadence(config.autoRefine, event.turnIndex, lastTurn);
    lastTurn = next;
    if (!fire) return;
    try {
      await ctx.ui.notify("continuity: auto-refine firing this turn", "info");
      await runRefine(pi, ctx, { auto: true });
    } catch (err) {
      await ctx.ui.notify(`continuity auto-refine failed: ${String(err)}`, "warning");
    }
  });
}
