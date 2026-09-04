// refine-core — pure, LLM-free parts of the refine pipeline.
// Kept import-clean (no pi-ai, no pi imports) so behavioral probes can run
// the emitted module standalone.

import type { HarnessItem } from "./types.js";

export const DEFAULT_LOOKBACK_TURNS = 25;
export const DEFAULT_EVIDENCE_BYTES = 16000;
const PER_ENTRY_CHAR_CAP = 2000;

export const PROPOSER_SYSTEM = `You are the continuity refiner for a coding agent. You receive the agent's current harness items and recent trajectory evidence. Propose small, evidence-backed improvements as structured CRUD deltas.

Item kinds: prompt (behavioral note to the agent itself), memory (durable fact), skill (how to use a capability well), subagent (reusable delegation spec).

Delta JSON shapes:
- {"op":"create","kind":"prompt|memory|skill|subagent","content":"...","evidence":"...","importance":0.0-1.0}
- {"op":"update","id":"...","content":"...","evidence":"...","importance":0.0-1.0,"active":true}
- {"op":"delete","id":"...","reason":"..."}

Rules (ACE-style, strictly):
- Itemized deltas only; never rewrite or expand whole items.
- Every create cites evidence: quote or precisely reference the trajectory.
- Prefer updating an existing item over creating a near-duplicate; delete only with a concrete reason (stale, wrong, superseded).
- importance in [0,1] estimates future usefulness; keep nudges small.
- If nothing is clearly warranted, return an empty deltas array.
- "Operator instructions" in the user message come from the human operator: when they ask to record or change something, do it via deltas unless it clearly contradicts the evidence.

Respond with STRICT JSON only: {"summary":"one line","deltas":[...]}`;

/** Extract joinable text from a message content (string or block array). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const r = b as { type?: unknown; text?: unknown };
      // Only text blocks: thinking/tool blocks also carry .text and must stay out.
      if ((r.type === "text" || r.type === undefined) && typeof r.text === "string") return r.text;
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Parse the proposer's reply: strips fences, slices the outermost JSON object. */
export function parseProposerOutput(text: string): { summary: string; deltas: unknown[] } | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as { summary?: unknown; deltas?: unknown };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      deltas: Array.isArray(parsed.deltas) ? parsed.deltas : [],
    };
  } catch {
    return null;
  }
}

/** Extract the speaker role from a session entry.
 *  Real pi session entries are { type: "message", message: { role, content } };
 *  the bare { type: "user"|"assistant", content } shape is tolerated too. */
function roleOf(rec: Record<string, unknown>): "user" | "assistant" | undefined {
  const msg = rec.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.role === "string") {
    return msg.role === "user" || msg.role === "assistant" ? msg.role : undefined;
  }
  return rec.type === "user" || rec.type === "assistant" ? rec.type : undefined;
}

function contentOf(rec: Record<string, unknown>): unknown {
  const msg = rec.message as Record<string, unknown> | undefined;
  return msg && msg.content !== undefined ? msg.content : rec.content;
}

/** Render recent trajectory evidence from a session branch (user/assistant text only). */
export function gatherEvidence(
  branch: Iterable<unknown>,
  lookback: number,
  maxBytes: number = DEFAULT_EVIDENCE_BYTES,
): string {
  const lines: string[] = [];
  for (const entry of branch) {
    const rec = entry as Record<string, unknown>;
    const role = roleOf(rec);
    if (!role) continue;
    const text = textOf(contentOf(rec));
    if (!text) continue;
    const capped = text.length > PER_ENTRY_CHAR_CAP ? text.slice(0, PER_ENTRY_CHAR_CAP) + " …" : text;
    lines.push(`${role}: ${capped}`);
  }
  const tail = lines.slice(-lookback * 2);
  let out = tail.join("\n");
  if (out.length > maxBytes) out = "…\n" + out.slice(-maxBytes);
  return out;
}

/** Build the proposer's user message: current store + evidence. */
export function buildUserText(items: HarnessItem[], evidence: string, instructions?: string): string {
  const listing = items.length
    ? items.map((i) => `- [${i.id}] ${i.kind} ${i.importance.toFixed(2)}${i.active ? "" : " (inactive)"}: ${i.content}`).join("\n")
    : "(empty store)";
  return [
    ...(instructions ? ["Operator instructions (focus the refinement):", instructions, ""] : []),
    "Current harness items:",
    listing,
    "",
    "Recent trajectory evidence:",
    evidence,
    "",
    "Propose deltas per the system rules. STRICT JSON only.",
  ].join("\n");
}

/** Pure cadence decision (unit-testable). lastTurn < 0 means unseen. */
export function evaluateCadence(
  auto: { enabled: boolean; everyTurns: number },
  turnIndex: number,
  lastTurn: number,
): { fire: boolean; next: number } {
  if (!auto.enabled || auto.everyTurns <= 0) return { fire: false, next: lastTurn };
  if (lastTurn < 0) return { fire: false, next: turnIndex };
  if (turnIndex - lastTurn >= auto.everyTurns) return { fire: true, next: turnIndex };
  return { fire: false, next: lastTurn };
}
