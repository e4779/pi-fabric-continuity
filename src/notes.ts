// notes — v0.6 atomic note store engine (docs/spec-v0.6.md).
// File-per-transition: one JSON note per file, written once, never edited.
// Single writer per file (host-scoped filename), tmp+rename atomicity with
// per-note fsync, content-addressed names (idempotent delivery over any rail).
// The read path is pure: fold skips-and-logs, never mutates the store (I6).

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { applyDelta, genId, projectSlug, sortItems, validateDelta, withJournalLock } from "./journal.js";
import type { Delta, DeltaSource, HarnessItem, Scope } from "./types.js";

/** One atomic note = one v0.5 Transition, resharded into its own file.
 *  Envelope change only: the delta schema carries over unchanged (F6.1). */
export interface NoteRecord {
  ts: number;
  host: string;
  seq: number;
  actor: string;
  source: DeltaSource;
  delta: Delta;
  target?: string;
  note?: string;
  /** REQUIRED on update/delete (except legacy notes): content-hash pin of the
   *  direct predecessor note — the causal anchor (F6.1). */
  supersedesFile?: string;
}

export interface NoteFileMeta {
  ts: number;
  host: string;
  seq: number;
  hash: string;
  name: string;
}

export interface NotesFold {
  items: HarnessItem[];
  /** sha256 over the sorted note content hashes — snapshot identity (F6.3). */
  digest: string;
  digest8: string;
  fileCount: number;
  /** Files skipped and logged (unparseable / hash mismatch / cross-id pin). Read path never mutates them (I6). */
  skipped: number;
  /** Mutation notes whose superseded item never arrived (partial peer sync) — pending heads (F6.3). */
  orphans: number;
  /** Item ids with sibling supersession heads (forks surfaced, not hidden). */
  conflicts: string[];
}

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const NAME_RE = /^(\d{13,})-([a-z0-9][a-z0-9-]{0,23})-(\d{6,})-([0-9a-f]{8,64})\.json$/;

export function hostLabel(): string {
  const h = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return HOST_RE.test(h) ? h : "unknown";
}

export function noteFileName(ts: number, host: string, seq: number, hash: string): string {
  return `${ts}-${host}-${String(seq).padStart(6, "0")}-${hash}.json`;
}

export function parseNoteFileName(name: string): NoteFileMeta | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { ts: Number(m[1]), host: m[2], seq: Number(m[3]), hash: m[4], name };
}

/** Stable stringify: sorted keys, no undefined — the canonical form both the
 *  content hash and the on-disk bytes are computed from, so independently
 *  produced identical notes are byte-identical across machines. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k])).join(",") + "}";
}

export function noteContentHash(record: NoteRecord): string {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

/** Store root: config store.dir override, else the legacy default root (F6.2). */
export async function storeRoot(): Promise<string> {
  try {
    const cfg = await loadConfig();
    if (cfg.store?.dir && cfg.store.dir.trim()) return cfg.store.dir;
  } catch {
    // Config problems must not break path resolution.
  }
  return join(homedir(), ".pi", "agent", "continuity");
}

export async function noteDir(scope: Scope, cwd?: string): Promise<string> {
  const root = await storeRoot();
  return scope === "global" ? join(root, "global") : join(root, "projects", projectSlug(cwd ?? process.cwd()));
}

export interface NoteWrite {
  actor: string;
  source: DeltaSource;
  delta: Delta;
  target?: string;
  note?: string;
  supersedesFile?: string;
  ts?: number;
  /** Overrides for migration only (fixed label host="legacy", seq=<version>). */
  host?: string;
  seq?: number;
}

function nextSeq(existing: Set<string>, host: string): number {
  let max = 0;
  for (const name of existing) {
    const meta = parseNoteFileName(name);
    if (meta && meta.host === host && meta.seq > max) max = meta.seq;
  }
  return max + 1;
}

/** Write notes into a directory: seq allocation, canonical bytes, tmp+fsync+
 *  rename, hash-width widening on a same-name/different-content collision.
 *  Whole batch under one lock (same-host sessions serialize here — F6.5). */
export async function writeNotesDir(dir: string, writes: NoteWrite[]): Promise<{ metas: NoteFileMeta[]; records: NoteRecord[] }> {
  if (writes.length === 0) return { metas: [], records: [] };
  // Whole-batch validation BEFORE any disk write (v0.5 discipline): a
  // mid-batch throw would leave immutable notes half-written, and a caller
  // retry would re-allocate create ids — duplicate items (review finding 6).
  for (const w of writes) {
    const err = validateDelta(w.delta);
    if (err) throw new Error(err);
    if (w.host !== "legacy" && (w.delta.op === "update" || w.delta.op === "delete") && !w.supersedesFile) {
      throw new Error(`note for op ${w.delta.op} requires supersedesFile (F6.1)`);
    }
  }
  // Lock anchor is MACHINE-LOCAL, never inside the store (F6.2): a shipped
  // held lock would stall peer writes for the lock timeout (review finding 2).
  return withJournalLock(join(homedir(), ".pi", "agent", "continuity", "locks", sha256Hex(dir).slice(0, 16)), async () => {
    await mkdir(dir, { recursive: true });
    const host = hostLabel();
    const existing = new Set((await readdir(dir)).filter((n) => n.endsWith(".json")));
    const perHostSeq = new Map<string, number>();
    const metas: NoteFileMeta[] = [];
    const records: NoteRecord[] = [];
    for (const w of writes) {
      const wHost = w.host ?? host;
      const seq = w.seq ?? ((perHostSeq.get(wHost) ?? nextSeq(existing, wHost)));
      // Explicit seqs must still seed the batch cursor: a later auto write
      // never allocates below the batch's own max (review finding 8).
      perHostSeq.set(wHost, Math.max(perHostSeq.get(wHost) ?? 0, seq + 1));
      // Creates without an explicit id allocate one HERE, persisted in the
      // note file (record.target) — folds must never regenerate ids (v0.5
      // appendDeltas discipline, carried into the envelope).
      let target = w.target;
      if (w.delta.op === "create" && target === undefined && w.delta.id === undefined) {
        // Legacy creates without a recorded target must NOT genId() — both
        // machines must emit byte-identical files (F6.6, review finding 10).
        target = wHost === "legacy" ? `c_legacy_${sha256Hex(canonicalJson(w.delta)).slice(0, 12)}` : genId();
      }
      const record: NoteRecord = {
        ts: w.ts ?? Date.now(),
        host: wHost,
        seq,
        actor: w.actor,
        source: w.source,
        delta: w.delta,
        ...(target !== undefined ? { target } : {}),
        ...(w.note !== undefined ? { note: w.note } : {}),
        ...(w.supersedesFile !== undefined ? { supersedesFile: w.supersedesFile } : {}),
      };
      const full = noteContentHash(record);
      let hash = full.slice(0, 8);
      let name = noteFileName(record.ts, wHost, seq, hash);
      while (existing.has(name)) {
        // Same name, verify content: identical => idempotent no-op.
        let same = false;
        try {
          same = (await readFile(join(dir, name), "utf8")) === canonicalJson(record);
        } catch {
          same = false;
        }
        if (same) break;
        const widths = [12, 16, 24, 64];
        const next = widths.find((wd) => wd > hash.length);
        if (!next) throw new Error(`note name collision at full hash: ${name}`);
        hash = full.slice(0, next);
        name = noteFileName(record.ts, wHost, seq, hash);
      }
      if (!existing.has(name)) {
        const bytes = canonicalJson(record);
        const tmp = join(dir, name + ".tmp");
        const fh = await open(tmp, "w");
        try {
          await fh.writeFile(bytes, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, join(dir, name));
        existing.add(name);
      }
      metas.push({ ts: record.ts, host: wHost, seq, hash, name });
      records.push(record);
    }
    return { metas, records };
  });
}

interface LoadedNote {
  meta: NoteFileMeta;
  record: NoteRecord;
}

type MutationDelta = Extract<Delta, { op: "update" | "delete" | "certify" }>;

function isMutation(d: Delta): d is MutationDelta {
  return d.op === "update" || d.op === "delete" || d.op === "certify";
}

/** Fold a note directory: filename order (never readdir), multi-pass orphan
 *  adoption (late/skewed parents), pin checks, fork surfacing, digest (F6.3). */
export async function foldDir(dir: string, scope: Scope): Promise<NotesFold> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return { items: [], digest: sha256Hex(""), digest8: sha256Hex("").slice(0, 8), fileCount: 0, skipped: 0, orphans: 0, conflicts: [] };
  }
  const skipped = { n: 0 };
  const loaded: LoadedNote[] = [];
  const pinOwner = new Map<string, string>(); // hash8 -> item id it mutates
  for (const name of names) {
    const meta = parseNoteFileName(name);
    if (!meta) {
      skipped.n += 1;
      continue;
    }
    let record: NoteRecord | undefined;
    try {
      record = JSON.parse(await readFile(join(dir, name), "utf8")) as NoteRecord;
    } catch {
      record = undefined;
    }
    const d = record?.delta as { op?: unknown } | undefined;
    if (!record || typeof record.ts !== "number" || typeof record.host !== "string" || typeof record.seq !== "number" || !d || typeof d.op !== "string") {
      skipped.n += 1;
      continue;
    }
    // Content-address integrity: filename hash must pin the file bytes (F6.1).
    if (noteContentHash(record).slice(0, meta.hash.length) !== meta.hash) {
      skipped.n += 1;
      continue;
    }
    loaded.push({ meta, record });
  }
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  loaded.sort((a, b) => a.meta.ts - b.meta.ts || cmp(a.meta.host, b.meta.host) || a.meta.seq - b.meta.seq || cmp(a.meta.hash, b.meta.hash));

  // Deterministic pin ownership: built from the SORTED array — readdir order
  // must never leak into fold results (review finding 4).
  for (const ln of loaded) {
    if (ln.record.host === "legacy") continue;
    const itemId = ln.record.target ?? (isMutation(ln.record.delta) ? ln.record.delta.id : undefined);
    if (itemId && ln.record.supersedesFile) pinOwner.set(ln.record.supersedesFile, itemId);
  }

  // Sibling forks (>=2 mutation notes on one id pinning the SAME predecessor,
  // non-legacy): newest by (ts,host,seq,hash) wins and is applied; losers
  // stay historical — never applied, no Frankenstein merge of disjoint
  // fields (review finding 5). Legacy is totally ordered by seq=version:
  // forks impossible (review finding 3).
  const pinsById = new Map<string, Map<string, LoadedNote[]>>();
  for (const ln of loaded) {
    if (ln.record.host === "legacy" || !isMutation(ln.record.delta)) continue;
    const id = ln.record.target ?? ln.record.delta.id;
    const pin = ln.record.supersedesFile;
    if (pin === undefined) continue;
    const byPin = pinsById.get(id) ?? new Map<string, LoadedNote[]>();
    const arr = byPin.get(pin) ?? [];
    arr.push(ln);
    byPin.set(pin, arr);
    pinsById.set(id, byPin);
  }
  const conflicts: string[] = [];
  const losers = new Set<string>();
  for (const [id, byPin] of pinsById) {
    let forked = false;
    for (const arr of byPin.values()) {
      if (arr.length < 2) continue;
      forked = true;
      const ordered = [...arr].sort((a, b) => a.meta.ts - b.meta.ts || cmp(a.meta.host, b.meta.host) || a.meta.seq - b.meta.seq || cmp(a.meta.hash, b.meta.hash));
      for (const l of ordered.slice(0, -1)) losers.add(l.meta.name);
    }
    if (forked) conflicts.push(id);
  }

  const items = new Map<string, HarnessItem>();
  const apply = (ln: LoadedNote): string | null => {
    // Cross-id pin (pin exists but belongs to another item): skip and log (I6).
    if (ln.record.supersedesFile && ln.record.host !== "legacy") {
      const owner = pinOwner.get(ln.record.supersedesFile);
      const self = ln.record.target ?? (isMutation(ln.record.delta) ? ln.record.delta.id : undefined);
      if (owner !== undefined && self !== undefined && owner !== self) return "SKIP";
    }
    return applyDelta(items, ln.record.delta, ln.record.ts, scope, ln.record.target);
  };
  const isSkip = (r: string | null | undefined): r is "SKIP" => r === "SKIP";

  let queue = loaded;
  let orphans = 0;
  for (let pass = 0; pass < 6; pass++) {
    const failed: LoadedNote[] = [];
    let skipInc = 0;
    for (const ln of queue) {
      if (losers.has(ln.meta.name)) continue;
      const res = apply(ln);
      if (isSkip(res)) skipInc += 1;
      else if (res === null && isMutation(ln.record.delta)) failed.push(ln);
    }
    skipped.n += skipInc;
    if (failed.length === 0) {
      orphans = 0;
      break;
    }
    if (pass === 5 || failed.length === queue.length) {
      orphans = failed.length;
      break;
    }
    queue = failed; // parents may arrive later in (ts,host,seq) — retry
  }

  const hashes = loaded.map((ln) => ln.meta.hash).sort();
  const digest = sha256Hex(hashes.join("\n"));
  return {
    items: sortItems([...items.values()]),
    digest,
    digest8: digest.slice(0, 8),
    fileCount: loaded.length,
    skipped: skipped.n,
    orphans,
    conflicts,
  };
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Scope-aware convenience wrappers. */
export async function writeNotes(scope: Scope, cwd: string | undefined, writes: NoteWrite[]): Promise<{ metas: NoteFileMeta[]; records: NoteRecord[] }> {
  return writeNotesDir(await noteDir(scope, cwd), writes);
}

export async function foldNotes(scope: Scope, cwd?: string): Promise<NotesFold> {
  return foldDir(await noteDir(scope, cwd), scope);
}
