// refine — the LLM runner: trajectory evidence → proposer → journaled deltas.
// Inline execution (turn context). The durable variant is a fabric_exec recipe
// that spawns an agent calling continuity.mutate — same journal, same discipline.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { sessionCwdOf } from "./session-cwd.js";
import type { Delta, Scope } from "./types.js";

export interface RefineOptions {
  lookback?: number;
  scope?: Scope;
  /** Free-text focus from the operator, prepended to the proposer's user message. */
  instructions?: string;
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

/** Bump when refine behavior changes; appears in last-refine.log. */
const REFINE_LOG_VERSION = 3;

/** Best-effort debug log of the last refine run: never breaks refine itself. */
async function writeRefineDebugLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = join(homedir(), ".pi", "agent", "continuity");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "last-refine.log"), JSON.stringify(entry, null, 2), "utf8");
  } catch {
    // Logging must never break a refine run.
  }
}

export async function runRefine(pi: ExtensionAPI, ctx: ExtensionContext, opts: RefineOptions = {}): Promise<RefineResult> {
  const scope = opts.scope ?? "project";
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK_TURNS;
  const base = { scope, lookback };
  const cwd = sessionCwdOf(ctx);

  await ctx.ui.notify("continuity refine: proposing (real model call, may take ~30s)…", "info");
  const snap = await currentSnapshot(scope, cwd);
  const branch = (ctx.sessionManager as unknown as { getBranch(): Iterable<unknown> }).getBranch();
  const evidence = gatherEvidence(branch, lookback);
  if (!evidence.trim()) {
    await ctx.ui.notify("continuity refine: skipped — no trajectory evidence found", "info");
    return { ...base, evidenceBytes: 0, proposed: 0, applied: 0, summary: "", version: snap.version, skipped: "no trajectory evidence" };
  }
  const registry = ctx.modelRegistry;
  const model = (ctx as unknown as { model?: unknown }).model as Parameters<typeof registry.complete>[0] | undefined;
  if (!registry || !model) {
    await ctx.ui.notify("continuity refine: skipped — no model registry or active model", "info");
    return { ...base, evidenceBytes: evidence.length, proposed: 0, applied: 0, summary: "", version: snap.version, skipped: "no model registry or active model" };
  }

  const context = {
    systemPrompt: PROPOSER_SYSTEM,
    messages: [{ role: "user", content: buildUserText(snap.items, evidence, opts.instructions), timestamp: Date.now() }],
  } as unknown as Parameters<typeof registry.complete>[1];
  const msg = (await registry.complete(model, context, {
    maxTokens: 4096,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })) as unknown as { content: unknown; stopReason?: unknown; error?: unknown; usage?: unknown; responseModel?: unknown };
  const replyText = textOf(msg.content).trim();
  const parsed = parseProposerOutput(replyText);
  const deltas = (parsed?.deltas ?? []).filter((d): d is Delta => validateDelta(d) === null);
  const modelId = model as unknown as { provider: string; id: string };
  await writeRefineDebugLog({
    logVersion: REFINE_LOG_VERSION,
    ts: new Date().toISOString(),
    scope,
    cwd,
    lookback,
    instructions: opts.instructions ?? null,
    model: `${modelId.provider}/${modelId.id}`,
    evidenceChars: evidence.length,
    replyChars: replyText.length,
    reply: replyText.slice(0, 4000),
    stopReason: typeof msg.stopReason === "string" ? msg.stopReason : null,
    error: msg.error === undefined ? null : String(msg.error).slice(0, 500),
    responseModel: typeof msg.responseModel === "string" ? msg.responseModel : null,
    usage: msg.usage === undefined ? null : msg.usage,
    msgKeys: Object.keys(msg),
    parsedOk: parsed !== null,
    proposedCount: parsed?.deltas.length ?? 0,
    appliedCount: deltas.length,
  });

  let applied = 0;
  let version = snap.version;
  if (deltas.length > 0) {
    const actor = `model:${(model as unknown as { provider: string; id: string }).provider}/${(model as unknown as { provider: string; id: string }).id}`;
    const out = await appendDeltas({ scope, cwd, actor, source: "refine", deltas });
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
  const unparseable = replyText.length > 0 && parsed === null;
  const empty = replyText.length === 0;
  const summary = empty
    ? "proposer returned an empty reply (model produced no text)"
    : unparseable
      ? "proposer output unparseable — no deltas applied"
      : parsed?.summary || (applied === 0 ? "no changes warranted" : "");
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
