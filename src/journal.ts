// journal — v0.6 facade over the atomic note store (src/notes.ts).
// One authority stays, reshaped: a directory of immutable content-addressed
// note files, folded on read (docs/spec-v0.6.md). Legacy JSONL auto-migrates
// on first scope open (src/migrate.ts, marker-guarded), then is ignored.
// Torn tails, per-file version counters and tail healing are gone by
// construction; healJournalTail stays as a deprecated no-op for import
// compatibility. Transition.version = 1-based position in fold order: a
// stable within-fold anchor for search citations and history.

import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { foldDir, listNotes, noteDir, writeNotesDir } from "./notes.js";
import type { NoteRecord } from "./notes.js";
import { migrateLegacyScope } from "./migrate.js";
import type { ComponentKind, Delta, HarnessItem, JournalSnapshot, Scope, Transition } from "./types.js";

const ROOT = join(homedir(), ".pi", "agent", "continuity");

export const KINDS: readonly ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

export function projectSlug(cwd: string): string {
  const base = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "default";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "default";
}

/** Legacy JSONL path — still the migration INPUT and operator display. */
export function journalPath(scope: Scope, cwd?: string): string {
  if (scope === "global") return join(ROOT, "global", "journal.jsonl");
  return join(ROOT, "projects", projectSlug(cwd ?? process.cwd()), "journal.jsonl");
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
}

export function genId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** F4.1: evidenceCmds must be an array of non-empty strings (empty = none). */
function validateEvidenceCmds(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return "evidenceCmds must be an array of strings";
  if (v.some((c) => typeof c !== "string" || !c.trim())) return "evidenceCmds must contain only non-empty strings";
  return null;
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
    const ecErr = validateEvidenceCmds(rec.evidenceCmds);
    if (ecErr) return "create." + ecErr;
    return null;
  }
  if (rec.op === "update") {
    if (typeof rec.id !== "string" || !rec.id) return "update.id required";
    const has = ["content", "evidence", "importance", "active", "models", "evidenceCmds"].some((k) => rec[k] !== undefined);
    if (!has) return "update needs at least one of content|evidence|importance|active|models|evidenceCmds";
    const ecErr2 = validateEvidenceCmds(rec.evidenceCmds);
    if (ecErr2) return "update." + ecErr2;
    return null;
  }
  if (rec.op === "delete") {
    if (typeof rec.id !== "string" || !rec.id) return "delete.id required";
    if (typeof rec.reason !== "string" || !rec.reason.trim()) return "delete.reason required";
    return null;
  }
  if (rec.op === "certify") {
    if (typeof rec.id !== "string" || !rec.id) return "certify.id required";
    if (rec.status !== "certified" && rec.status !== "violated") return "certify.status must be certified|violated";
    return null;
  }
  return "delta.op must be create|update|delete|move|certify";
}

/** Apply one delta to the fold state. Returns the touched item id, when resolvable.
 *  'target' is the recorded id from the note: folds MUST reuse it, or ids
 *  would be regenerated on every read and updates/deletes would miss. */
export function applyDelta(items: Map<string, HarnessItem>, delta: Delta, ts: number, scope: Scope, target?: string): string | null {
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
      ...(delta.evidenceCmds ? { evidenceCmds: delta.evidenceCmds } : {}),
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
    if (delta.evidenceCmds !== undefined) it.evidenceCmds = delta.evidenceCmds;
    it.updatedAt = ts;
    return it.id;
  }
  if (delta.op === "certify") {
    const it = items.get(delta.id);
    if (!it) return null;
    it.cert = { status: delta.status, at: ts, ...(delta.digest ? { digest: delta.digest } : {}) };
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

/** v0.6: ensure the scope's legacy JSONL (if any) has been split into notes.
 *  Marker-guarded and idempotent; never throws — migration must not break
 *  the provider seam (spec F6.6, auto-migrate on first open). */
async function ensureMigrated(scope: Scope, cwd?: string): Promise<void> {
  try {
    await migrateLegacyScope({ scope, cwd });
  } catch {
    // The seam stays usable even when migration hiccups; the legacy journal
    // remains in place for a manual re-run with force.
  }
}

function toTransition(r: NoteRecord, version: number): Transition {
  return {
    version,
    ts: r.ts,
    actor: r.actor,
    source: r.source,
    delta: r.delta,
    ...(r.target !== undefined ? { target: r.target } : {}),
    ...(r.note !== undefined ? { note: r.note } : {}),
  };
}

/** The scope's notes as transitions in fold order; version = 1-based
 *  position — stable within a fold, comparable for search/history. */
export async function readScopeTransitions(scope: Scope, cwd?: string): Promise<Transition[]> {
  await ensureMigrated(scope, cwd);
  const { notes } = await listNotes(await noteDir(scope, cwd));
  return notes.map((ln, i) => toTransition(ln.record, i + 1));
}

export async function history(scope: Scope, cwd?: string, limit = 20): Promise<Transition[]> {
  const all = await readScopeTransitions(scope, cwd);
  return all.slice(-limit);
}

/** Deprecated no-op: note files cannot tear (tmp+rename atomicity, I3). */
export async function healJournalTail(): Promise<{ healed: boolean }> {
  return { healed: false };
}

export async function currentSnapshot(scope: Scope, cwd?: string): Promise<JournalSnapshot> {
  await ensureMigrated(scope, cwd);
  const f = await foldDir(await noteDir(scope, cwd), scope);
  return { digest8: f.digest8, fileCount: f.fileCount, items: f.items };
}

export interface AppendOutcome {
  transitions: Transition[];
  snapshot: JournalSnapshot;
}

export interface AppendOptions {
  scope: Scope;
  cwd?: string;
  actor: string;
  source: Transition["source"];
  deltas: Delta[];
  note?: string;
}

/** Atomic batch append onto the note store: every delta validated before
 *  anything is written; update/delete notes carry supersedesFile pins
 *  resolved from the current fold heads ("pending" when the target has not
 *  arrived yet — orphan-tolerant, spec F6.3). */
export async function appendDeltas(opts: AppendOptions): Promise<AppendOutcome> {
  for (const d of opts.deltas) {
    const err = validateDelta(d);
    if (err) throw new Error(err);
  }
  await ensureMigrated(opts.scope, opts.cwd);
  const dir = await noteDir(opts.scope, opts.cwd);
  const head = await foldDir(dir, opts.scope);
  const writes = opts.deltas.map((d) => ({
    actor: opts.actor,
    source: opts.source,
    delta: d,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...((d.op === "update" || d.op === "delete") ? { supersedesFile: head.headPins.get(d.id) ?? "pending" } : {}),
  }));
  const { metas, records } = await writeNotesDir(dir, writes);
  const fold = await foldDir(dir, opts.scope);
  const { notes: all } = await listNotes(dir);
  const versionByName = new Map(all.map((ln, i) => [ln.meta.name, i + 1] as const));
  const transitions = records.map((r, i) => toTransition(r, versionByName.get(metas[i]!.name) ?? 0));
  return { transitions, snapshot: { digest8: fold.digest8, fileCount: fold.fileCount, items: fold.items } };
}

/** Move an item between scopes: delete from the source store, recreate with
 *  the same id in the target store. Both transitions are journaled. */
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

/** v0.6 revert: undo the LAST mutation of each named item by emitting
 *  inverse deltas (single-note undo, spec F6.4 — version anchors retired). */
export async function revertItems(opts: { scope: Scope; cwd?: string; ids: string[]; actor: string }): Promise<AppendOutcome> {
  const all = await readScopeTransitions(opts.scope, opts.cwd);
  const deltas: Delta[] = [];
  for (const id of opts.ids) {
    const own = all.filter((t) => (t.target ?? (t.delta as { id?: string }).id) === id);
    if (own.length === 0) continue;
    const last = own[own.length - 1]!;
    const items = new Map<string, HarnessItem>();
    for (const t of own.slice(0, -1)) applyDelta(items, t.delta, t.ts, opts.scope, t.target);
    const prev = items.get(id) ?? null;
    if (last.delta.op === "create") {
      if (prev) {
        deltas.push({ op: "update", id, content: prev.content, evidence: prev.evidence, importance: prev.importance, ...(prev.active ? {} : { active: false }) });
      } else {
        deltas.push({ op: "delete", id, reason: "revert: undo create" });
      }
    } else if (last.delta.op === "delete" && prev) {
      deltas.push({ op: "create", kind: prev.kind, content: prev.content, evidence: prev.evidence, importance: prev.importance, ...(prev.models ? { models: prev.models } : {}), id });
      if (!prev.active) deltas.push({ op: "update", id, active: false });
    } else {
      const cur = (await currentSnapshot(opts.scope, opts.cwd)).items.find((i) => i.id === id) ?? null;
      if (prev && cur) {
        const upd: { op: "update"; id: string; content?: string; evidence?: string; importance?: number; active?: boolean } = { op: "update", id };
        if (cur.content !== prev.content) upd.content = prev.content;
        if (cur.evidence !== prev.evidence) upd.evidence = prev.evidence;
        if (cur.importance !== prev.importance) upd.importance = prev.importance;
        if (cur.active !== prev.active) upd.active = prev.active;
        if (Object.keys(upd).length > 2) deltas.push(upd);
      } else if (!prev && cur) {
        deltas.push({ op: "delete", id, reason: "revert: undo to before first record" });
      }
    }
  }
  if (deltas.length === 0) {
    const snap = await currentSnapshot(opts.scope, opts.cwd);
    return { transitions: [], snapshot: snap };
  }
  return appendDeltas({ scope: opts.scope, cwd: opts.cwd, actor: opts.actor, source: "manual", deltas, note: "revert: single-note undo" });
}

/** Inter-process writer lock: exclusive-create with stale takeover.
 *  Serializes note batches and counters read-modify-write across pi
 *  sessions sharing one machine (the cross-machine race is impossible by
 *  I2 — one writer per file). */
export async function withJournalLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = path + ".lock";
  const deadline = Date.now() + 10000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (e) {
      const err = e as { code?: string };
      if (err.code !== "EEXIST") throw e;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > 10000) await unlink(lockPath); // stale takeover
      } catch {
        /* lock vanished — retry immediately */
      }
      if (Date.now() > deadline) throw new Error(`journal lock timeout: ${lockPath}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}
