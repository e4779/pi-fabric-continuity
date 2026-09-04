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
  if (rec.scope !== undefined && rec.scope !== "project" && rec.scope !== "global") {
    return "scope must be project|global";
  }
  if (rec.op === "move") {
    if (typeof rec.id !== "string" || !rec.id) return "move.id required";
    if (rec.to !== "project" && rec.to !== "global") return "move.to must be project|global";
    return null;
  }
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

/** Apply one delta to the fold state. Returns the touched item id, when resolvable.
 *  'target' is the recorded id from the journal line: folds MUST reuse it, or
 *  ids would be regenerated on every read and updates/deletes would miss. */
function applyDelta(items: Map<string, HarnessItem>, delta: Delta, ts: number, scope: Scope, target?: string): string | null {
  if (delta.op === "create") {
    const explicit = target ?? (typeof (delta as { id?: unknown }).id === "string" && (delta as { id?: string }).id ? (delta as { id?: string }).id : undefined);
    const id = explicit ?? genId();
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

/** Group deltas by their target scope for routing across journals. */
export function splitByScope(deltas: Delta[], defaultScope: Scope): Map<Scope, Delta[]> {
  const out = new Map<Scope, Delta[]>([
    ["project", []],
    ["global", []],
  ]);
  for (const d of deltas) {
    const scope = (d as { scope?: Scope }).scope ?? defaultScope;
    out.get(scope)!.push(d);
  }
  return out;
}
/** Move an item between scopes: delete from the source journal, recreate with
 *  the same id in the target journal. Both transitions are journaled. */
export async function moveItem(opts: {
  cwd?: string;
  id: string;
  to: Scope;
  actor: string;
  reason?: string;
}): Promise<{ from: Scope | null; to: Scope; moved: boolean; item: HarnessItem | null }> {
  let from: Scope | null = null;
  let item: HarnessItem | null = null;
  for (const s of ["project", "global"] as Scope[]) {
    const snap = await currentSnapshot(s, opts.cwd);
    const found = snap.items.find((i) => i.id === opts.id);
    if (found) {
      from = s;
      item = found;
      break;
    }
  }
  if (!from || !item) return { from: null, to: opts.to, moved: false, item: null };
  if (from === opts.to) return { from, to: opts.to, moved: false, item };
  await appendDeltas({
    scope: from,
    cwd: opts.cwd,
    actor: opts.actor,
    source: "manual",
    deltas: [{ op: "delete", id: opts.id, reason: opts.reason ?? `moved to ${opts.to}` }],
    note: `move to ${opts.to}`,
  });
  const destDeltas: Delta[] = [
    {
      op: "create",
      kind: item.kind,
      content: item.content,
      evidence: item.evidence,
      importance: item.importance,
      ...(item.models ? { models: item.models } : {}),
      id: item.id,
    },
  ];
  if (!item.active) destDeltas.push({ op: "update", id: item.id, active: false });
  await appendDeltas({ scope: opts.to, cwd: opts.cwd, actor: opts.actor, source: "manual", deltas: destDeltas, note: `moved from ${from}` });
  return { from, to: opts.to, moved: true, item };
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
    applyDelta(items, t.delta, t.ts, scope, t.target);
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
  note?: string;
}): Promise<AppendOutcome> {
  for (const d of opts.deltas) {
    const err = validateDelta(d);
    if (err) throw new Error(err);
  }
  const path = journalPath(opts.scope, opts.cwd);
  const existing = await readTransitions(path);
  let version = existing.reduce((m, t) => Math.max(m, t.version), 0);
  const items = new Map<string, HarnessItem>();
  for (const t of existing) applyDelta(items, t.delta, t.ts, opts.scope, t.target);

  const transitions: Transition[] = [];
  const lines: string[] = [];
  for (const delta of opts.deltas) {
    const ts = Date.now();
    const target = applyDelta(items, delta, ts, opts.scope);
    version += 1;
    const transition: Transition = {
      version,
      ts,
      actor: opts.actor,
      source: opts.source,
      delta,
      ...(target ? { target } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    };
    transitions.push(transition);
    lines.push(JSON.stringify(transition));
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.map((l) => l + "\n").join(""), "utf8");
  return { transitions, snapshot: { version, items: sortItems([...items.values()]) } };
}

/** Revert to a journal version by appending compensating deltas.
 *  The journal is append-only: revert never rewrites history, it emits the
 *  diff between the current fold and the fold at 'version' as new deltas. */
export async function revertToVersion(opts: {
  scope: Scope;
  cwd?: string;
  version: number;
  actor: string;
}): Promise<AppendOutcome> {
  const path = journalPath(opts.scope, opts.cwd);
  const transitions = await readTransitions(path);
  const latest = transitions.reduce((m, t) => Math.max(m, t.version), 0);
  const targetVersion = Math.min(Math.max(0, Math.floor(opts.version)), latest);
  if (targetVersion >= latest) {
    const snap = await currentSnapshot(opts.scope, opts.cwd);
    return { transitions: [], snapshot: snap };
  }

  const target = new Map<string, HarnessItem>();
  const current = new Map<string, HarnessItem>();
  for (const t of transitions) {
    applyDelta(current, t.delta, t.ts, opts.scope, t.target);
    if (t.version <= targetVersion) applyDelta(target, t.delta, t.ts, opts.scope, t.target);
  }

  const deltas: Delta[] = [];
  for (const [id, it] of target) {
    const cur = current.get(id);
    if (!cur) {
      deltas.push({
        op: "create",
        kind: it.kind,
        content: it.content,
        evidence: it.evidence,
        importance: it.importance,
        ...(it.models ? { models: it.models } : {}),
      });
      if (!it.active) deltas.push({ op: "update", id, active: false });
      continue;
    }
    const upd: { op: "update"; id: string; content?: string; evidence?: string; importance?: number; active?: boolean; models?: string[] } = { op: "update", id };
    if (cur.content !== it.content) upd.content = it.content;
    if (cur.evidence !== it.evidence) upd.evidence = it.evidence;
    if (cur.importance !== it.importance) upd.importance = it.importance;
    if (cur.active !== it.active) upd.active = it.active;
    if ((cur.models ?? undefined) !== (it.models ?? undefined)) upd.models = it.models;
    if (Object.keys(upd).length > 2) deltas.push(upd);
  }
  for (const id of current.keys()) {
    if (!target.has(id)) deltas.push({ op: "delete", id, reason: `reverted: absent at v${targetVersion}` });
  }

  if (deltas.length === 0) {
    const snap = await currentSnapshot(opts.scope, opts.cwd);
    return { transitions: [], snapshot: snap };
  }
  return appendDeltas({
    scope: opts.scope,
    cwd: opts.cwd,
    actor: opts.actor,
    source: "manual",
    deltas,
    note: `revert to v${targetVersion}`,
  });
}
export async function history(scope: Scope, cwd?: string, limit = 20): Promise<Transition[]> {
  const transitions = await readTransitions(journalPath(scope, cwd));
  return transitions.slice(-limit).reverse();
}
