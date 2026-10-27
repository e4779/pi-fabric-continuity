// migrate — v0.6 one-time legacy JSONL splitter (spec F6.6).
// Every legacy line becomes a note with the FIXED label host="legacy",
// seq=<old version counter> — both machines emit byte-identical content-
// addressed filenames, so cross-machine re-runs are idempotent (rsync
// dedupes). Originals are renamed per-machine; markers stay machine-local
// and NEVER inside the store (a store-side marker ships via rsync and lets
// the peer start un-migrated — council finding).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { journalPath, projectSlug } from "./journal.js";
import { hostLabel, noteDir, writeNotesDir } from "./notes.js";
import type { NoteWrite } from "./notes.js";
import type { Scope, Transition } from "./types.js";

function markerPath(scope: Scope, cwd?: string): string {
  const slug = scope === "global" ? "global" : `p-${projectSlug(cwd ?? process.cwd())}`;
  return join(homedir(), ".pi", "agent", "continuity", `.migrated-${slug}`);
}

export async function migrateLegacyScope(opts: { scope: Scope; cwd?: string; force?: boolean }): Promise<{ migrated: number; renamed: string[]; alreadyMarked: boolean }> {
  const marker = markerPath(opts.scope, opts.cwd);
  let already = false;
  try {
    await readFile(marker, "utf8");
    already = true;
  } catch {
    already = false;
  }
  if (already && !opts.force) return { migrated: 0, renamed: [], alreadyMarked: true };

  const legacy = journalPath(opts.scope, opts.cwd);
  const dir = await noteDir(opts.scope, opts.cwd);
  const writes: NoteWrite[] = [];
  const sources: string[] = [legacy];

  // Also ingest any journal.legacy*.jsonl sitting beside (peer-delivered or
  // prior partial migrations) — content-addressed names keep it idempotent.
  let raw = "";
  for (const src of sources) {
    try {
      raw += (await readFile(src, "utf8")) + "\n";
    } catch {
      // missing source is fine
    }
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let t: Transition;
    try {
      t = JSON.parse(line) as Transition;
    } catch {
      continue; // torn/corrupt tail line — skipped, original preserved
    }
    if (!t || typeof t.version !== "number" || !t.delta) continue;
    writes.push({
      ts: t.ts,
      host: "legacy",
      seq: t.version,
      actor: t.actor,
      source: t.source,
      delta: t.delta,
      ...(t.target !== undefined ? { target: t.target } : {}),
      ...(t.note !== undefined ? { note: t.note } : {}),
    });
  }
  if (writes.length > 0) await writeNotesDir(dir, writes);

  // Rename the live journal per-machine (same-named backups would clobber
  // across the rail). Missing file => nothing to rename.
  const renamed: string[] = [];
  try {
    const backup = join(legacy, "..", `journal.legacy-${hostLabel()}.jsonl`);
    await rename(legacy, backup);
    renamed.push(backup);
  } catch {
    // no live journal — fine
  }
  await mkdir(join(homedir(), ".pi", "agent", "continuity"), { recursive: true });
  await writeFile(marker, JSON.stringify({ ts: Date.now(), scope: opts.scope, migrated: writes.length } satisfies { ts: number; scope: Scope; migrated: number }, null, 2), "utf8");
  return { migrated: writes.length, renamed, alreadyMarked: false };
}
