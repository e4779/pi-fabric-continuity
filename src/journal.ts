// Provider-owned harness-state journal: append-only JSONL of transitions.
// One authority (the journal); snapshots are derived by folding, never primary.
// Storage layout: ~/.pi/agent/continuity/global/journal.jsonl and
// ~/.pi/agent/continuity/projects/<slug>/journal.jsonl (slug from cwd).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentKind, Delta, HarnessItem, JournalSnapshot, Scope, Transition } from "./types.js";

const ROOT = join(homedir(), ".pi", "agent", "continuity");

export const KINDS: readonly ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

export function projectSlug(cwd: string): string {
  const base = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "default";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "default";
}

export function journalPath(scope: Scope, cwd?: string): string {
  if (scope === "global") return join(ROOT, "global", "journal.jsonl");
  return join(ROOT, "projects", projectSlug(cwd ?? process.cwd()), "journal.jsonl");
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
}

function genId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Validate one delta; returns an error string or null. */
export function validateDelta(d: unknown): string | null {
  if (typeof d !== "object" || d === null) return "delta must be an object";
  const rec = d as Record<string, unknown>;
  if (rec.op === "create") {
    if (!KINDS.includes(rec.kind as ComponentKind)) return "create.kind must be one of prompt|memory|skill|subagent";
    if (typeof rec.content !== "string" || !rec.content.trim()) return "create.content required";
    if (typeof rec.evidence !== "string" || !rec.evidence.trim()) return "create.evidence required";
    return null;
  }
  if (rec.op === "update") {
    if (typeof rec.id !== "string" || !rec.id) return "update.id required";
    const has = ["content", "evidence", "importance", "active", "models"].some((k) => rec[k] !== undefined);
    if (!has) return "update needs at least one of content|evidence|importance|active|models";
    return null;
  }
  if (rec.op === "delete") {
    if (typeof rec.id !== "string" || !rec.id) return "delete.id required";
    if (typeof rec.reason !== "string" || !rec.reason.trim()) return "delete.reason required";
    return null;
  }
  return "delta.op must be create|update|delete";
}

/** Apply one delta to the fold state. Returns the touched item id, when resolvable. */
function applyDelta(items: Map<string, HarnessItem>, delta: Delta, ts: number, scope: Scope): string | null {
  if (delta.op === "create") {
    const id = genId();
    items.set(id, {
      id,
      kind: delta.kind,
      content: delta.content,
      evidence: delta.evidence,
      importance: clamp01(delta.importance, 0.6),
      active: true,
      scope,
      ...(delta.models ? { models: delta.models } : {}),
      createdAt: ts,
      updatedAt: ts,
    });
    return id;
  }
  if (delta.op === "update") {
    const it = items.get(delta.id);
    if (!it) return null;
    if (delta.content !== undefined) it.content = delta.content;
    if (delta.evidence !== undefined) it.evidence = delta.evidence;
    if (delta.importance !== undefined) it.importance = clamp01(delta.importance, it.importance);
    if (delta.active !== undefined) it.active = delta.active;
    if (delta.models !== undefined) it.models = delta.models;
    it.updatedAt = ts;
    return it.id;
  }
  return items.delete(delta.id) ? delta.id : null;
}

export function sortItems(items: HarnessItem[]): HarnessItem[] {
  return [...items].sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt);
}

export async function readTransitions(path: string): Promise<Transition[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Transition[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = JSON.parse(s) as Transition;
      if (t && typeof t.version === "number" && t.delta) out.push(t);
    } catch {
      // Journal discipline: reads never crash on a corrupt line; it is skipped.
    }
  }
  return out;
}

export async function currentSnapshot(scope: Scope, cwd?: string): Promise<JournalSnapshot> {
  const transitions = await readTransitions(journalPath(scope, cwd));
  const items = new Map<string, HarnessItem>();
  let version = 0;
  for (const t of transitions) {
    version = Math.max(version, t.version);
    applyDelta(items, t.delta, t.ts, scope);
  }
  return { version, items: sortItems([...items.values()]) };
}

export interface AppendOutcome {
  transitions: Transition[];
  snapshot: JournalSnapshot;
}

/** Atomic batch append: every delta is validated before anything is written. */
export async function appendDeltas(opts: {
  scope: Scope;
  cwd?: string;
  actor: string;
  source: Transition["source"];
  deltas: Delta[];
}): Promise<AppendOutcome> {
  for (const d of opts.deltas) {
    const err = validateDelta(d);
    if (err) throw new Error(err);
  }
  const path = journalPath(opts.scope, opts.cwd);
  const existing = await readTransitions(path);
  let version = existing.reduce((m, t) => Math.max(m, t.version), 0);
  const items = new Map<string, HarnessItem>();
  for (const t of existing) applyDelta(items, t.delta, t.ts, opts.scope);

  const transitions: Transition[] = [];
  const lines: string[] = [];
  for (const delta of opts.deltas) {
    const ts = Date.now();
    const target = applyDelta(items, delta, ts, opts.scope);
    version += 1;
    const transition: Transition = { version, ts, actor: opts.actor, source: opts.source, delta, ...(target ? { target } : {}) };
    transitions.push(transition);
    lines.push(JSON.stringify(transition));
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.map((l) => l + "\n").join(""), "utf8");
  return { transitions, snapshot: { version, items: sortItems([...items.values()]) } };
}

export async function history(scope: Scope, cwd?: string, limit = 20): Promise<Transition[]> {
  const transitions = await readTransitions(journalPath(scope, cwd));
  return transitions.slice(-limit).reverse();
}
