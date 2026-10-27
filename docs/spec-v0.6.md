# Spec — v0.6: atomic note store (file-per-transition, ADR supersession)

Trigger: operator design session 2026-10-26/27. Three pains converged:
(a) new project stores born outside the dot-pi symlink farm (keenetic-audit,
kn — unsynced until manually stowed); (b) the latent same-file-append conflict
on the dot-pi git rail — both machines refine into one `global/journal.jsonl`,
resolved today only by manual commit discipline; (c) torn-tail healing and the
opaque per-file `version` counter exist because JSONL append can tear and must
be sequenced. Operator proposal: "a directory where atomic notes from all
devices pile up; read is `cat *`". Record-format lineage: Architecture
Decision Records (Nygard 2011) — one decision per file, immutable,
machine-readable supersession (`superseded by → follow the successor`).
kn refs: adr-overview, adr-best-practices.

## F6.0 — invariants

- I1 file-per-transition: one JSON note per file; written once, never edited.
- I2 single writer per file: the filename carries the host; a machine writes
  only files named its own. (This is the property that makes the session
  rsync safe — we give journals the same property.)
- I3 atomic visibility: write tmp, then `rename()`. A partially written note
  never appears; torn tails become impossible by construction.
- I4 immutability + supersession: update/delete are NEW notes carrying
  `supersedes`; no in-place mutation ever. Current state = fold over links.
- I5 rail-agnostic: correctness over rsync (no --delete), git, syncthing, or
  a copied directory. Content-addressed filenames make delivery idempotent.
  The store is its own backup protocol.

## F6.1 — note record

One JSON object per file:

    {
      "id": "c_mujuul0c_kbzgx",          // stable item identity (unchanged scheme)
      "ts": "2026-10-27T09:14:00.123Z",   // writer clock
      "host": "hlab", "seq": 7,           // per-host monotonic, tiebreak
      "actor": "model:zai/glm-5.3",
      "op": "create|update|delete|confirm|decay",
      "kind": "prompt|memory|skill|subagent",
      "scope": "project|global",
      "content": "...", "evidence": "...",   // evidence ~ MADR decision drivers
      "importance": 0.55, "active": true,
      "supersedes": "c_...",              // update/delete: target item id
      "supersedesFile": "<hash>"          // optional integrity pin
    }

Filename: `<ISOts>-<host>-<seq>-<contentHash8>.json` — sortable,
collision-free, idempotent under re-sync. `cat *` is the fold's conceptual
model; `rg <pat>` over the directory is human search; `ls -t | head` is
recent activity. Quarantine: files failing JSON.parse move to
`_quarantine/` (never deleted — I4 applies to broken files too).

## F6.2 — layout & store.dir

    <store>/global/*.json
    <store>/projects/<slug>/*.json

`store.dir` config option (new in config.ts, default
`~/.pi/agent/continuity` — unchanged behavior). On operator machines it
points at the rsynced shared tree; the dot-pi symlink farm is retired.
config.json and last-refine.log stay machine-local (autoRefine differs per
host). dot-pi keeps configs only — state leaves git for the rsync rail.

## F6.3 — fold & snapshot identity

Fold = glob `*.json` → parse → order by (ts, host, seq) → resolve supersession
chains → snapshot = live notes (not superseded, not deleted); history = the
full chain (search stays as-is conceptually). The per-file monotonic
`version` counter is RETIRED: snapshot identity = sha256 over the sorted
list of note content hashes (merkle digest). `journal v169` in notify/log
becomes `snapshot <hash8>`. readTransitions/attribution anchor on note ids
+ ts, not versions. certify digests move to the merkle digest.

## F6.4 — supersession semantics

- update → note with `supersedes: <id>`; fold renders the newest note of a
  chain as current content, older notes as historical (same as today's
  create-vN citing, now explicit and machine-followable — the ADR status rule).
- delete → note with `supersedes` + op delete (tombstone); reason required.
- confirm/decay → op notes carrying target id + ts; confirms become
  fold-derivable (no separate truth). Decay uses LOCAL injection counts +
  fold-derived confirms (see F6.5).

## F6.5 — counters & sync rails

counters.json today is a shared read-modify-write file — a multi-writer
conflict under any automatic rail. It splits into per-host
`counters-<host>.json` (single writer each; injections are per-machine
events anyway). Confirm state moves INTO notes (F6.4); decay = local
injections ≥ threshold AND no confirm note anywhere in the fold.

Primary rail: the existing pi-memory-sync cron gains two lines (push
`<store>` per direction, rsync -a, NO --delete, opportunistic). Sessions,
memory stores, continuity — one mechanism for all agent state. Alternative
rails remain valid by I5.

## F6.6 — migration

One-time splitter over each existing `journal.jsonl`: line → file, named by
its ts + inferred host (from actor/session provenance where known, else the
migrating host) + content hash. Idempotent (content-addressed names). Old
JSONL kept beside as `journal.legacy.jsonl` (ignored by fold). Fold tolerates
both stores during a transition window? NO — one flag day per machine;
v0.6 refuses to start if legacy journal exists and no migration marker.

## F6.7 — boundaries / non-goals

- No query engine: rg/grep over the directory IS the query engine;
  continuity.search stays thin sugar.
- No compaction yet (volume: ~10² files/year; revisit at 10⁵). LSM-style
  base-snapshot + drops is a future appendix, not v0.6.
- mesh/state remain rejected (v0.4 boundaries unchanged: no root-override,
  single CAS-head vs N parallel notes).
- SQLite only as a DISPOSABLE derived read index if search ever hurts;
  never the source of truth (binary blob breaks multi-master rails).

## Open questions

- fsync policy: per note (safest) vs per refine batch (faster) — default per
  note, volumes are trivial.
- Per-directory file cap: none until ls/rg complain; quarantine growth alert?
- Do project slugs collide across machines with different cwds for one repo
  (homelab on hlab, ~/projects/homelab on thinkpad)? Slug already normalizes
  to the repo name — verify during migration.
- Injection budget display (current "N injections" in stats) becomes
  per-host; wording in provider output.
