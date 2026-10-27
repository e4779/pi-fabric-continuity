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
machine-readable supersession. kn refs: adr-overview, adr-best-practices.

Council review 2026-10-27 (4 roles: distributed-correctness, operability,
maintainability, YAGI; verdict 4/4 adopt-with-fixes) — amendments folded in
and attributed below.

## F6.0 — invariants

- I1 file-per-transition: one JSON note per file; written once, never edited.
- I2 single writer per file: the filename carries the host; a machine writes
  only files named its own. (The property that makes the session rsync safe.)
- I3 atomic visibility: write tmp, then `rename()`. A partially written note
  never appears; torn tails become impossible by construction.
- I4 immutability + supersession: update/delete are NEW notes carrying
  `supersedes`; no in-place mutation ever. Current state = fold over links.
- I5 rail-agnostic: correctness over rsync (no --delete), git, syncthing, or
  a copied directory. Content-addressed filenames make delivery idempotent.
- I6 read path never mutates the store (council: auto-quarantine MOVES foreign
  files, violating I2, and flaps forever under rsync-no-delete; version-skew
  quarantine silently splits the digest). Fold skips-and-logs, that is all.

## F6.1 — note record

One JSON object per file. v0.6 changes the ENVELOPE (one line = one file),
not the delta schema: every v0.4/v0.5 journal-line field carries over
unchanged — the certify op (status, digest, evidenceCmds, models, note),
annotations, source (council: silent schema drop was a defect).

    {
      "id": "c_mujuul0c_kbzgx",            // stable item identity
      "ts": "2026-10-27T09:14:00.123Z",     // writer clock — ordering hint only
      "host": "hlab", "seq": 7,             // per-host monotonic (see below)
      "actor": "model:zai/glm-5.3",
      "op": "create|update|delete|confirm|decay|certify",
      "kind": "prompt|memory|skill|subagent",
      "scope": "project|global",
      "content": "...", "evidence": "...",
      "importance": 0.55, "active": true,
      "supersedes": "c_...",                // update/delete: target item id
      "supersedesFile": "<hash8>"           // REQUIRED on update/delete:
    }                                       // content-hash pin of the DIRECT
                                            // predecessor — the causal anchor

`supersedesFile` decision (material disagreement preserved): YAGI voted drop
(no consumer); correctness voted require (clock skew lets a +10min-fast create
outrank a causally-later update and DROP it — applyDelta no-ops unseen ids).
Decided: REQUIRE — the topological fold in F6.3 is exactly the missing
consumer. Mismatch semantics tooling is deferred (F6.7).

- seq allocation: `1 + max(seq among own-host filenames)` at write time (the
  directory is the truth), persisted BEFORE the note write, zero-padded (%06d)
  in the filename. Same-ms batches and crash-restart cannot collide.
- filename `<ISOts>-<host>-<seq6>-<hash8>.json`; if the name exists with
  DIFFERENT content, widen to hash12/full hash — a silent rsync overwrite is
  note loss.
- unparseable file → fold deterministically skips and logs it. Quarantine-move
  is a manual operator action, own-host files only (I6).

## F6.2 — layout & store.dir

    <store>/global/*.json
    <store>/projects/<slug>/*.json
    <store>/.last-sync-<host>.json     (rail heartbeat, F6.5)
    <store>/.rail-backup/              (rsync --backup target, F6.5)

`store.dir` holds NOTES ONLY. config.json, last-refine.log, counters.json and
`*.lock` stay machine-local in ~/.pi/agent/continuity, NEVER inside the store
(council: rsync -a would ship per-host autoRefine flip-flopping between
machines, plus stale locks). The dot-pi symlink farm is retired; dot-pi keeps
configs only.

## F6.3 — fold & snapshot identity

- glob `*.json` → parse → order by (ts, host, seq, contentHash) parsed from
  FILENAMES — never readdir order (platform-dependent).
- orphan tolerance: a note whose supersedes target has not arrived (partial
  peer sync is the COMMON state on a 15-min rail) renders as head of a
  truncated chain; applies when the parent arrives. Never quarantined.
- chain resolution is TOPOLOGICAL via supersedesFile pins: a note always
  dominates its pinned predecessor regardless of clock skew. (ts, host, seq)
  breaks only TRUE concurrency — sibling heads: max wins, losers historical.
  Cycles (constructible under partial visibility): all but max historical,
  conflict surfaced.
- sibling heads are SURFACED, not silently resolved (council): fold reports
  conflict count + item ids; /refine notify and stats carry them.
- snapshot identity = sha256 over the sorted note content hashes + fileCount
  for monotonicity: `snapshot <hash8>/<n>` (council: a digest alone proves
  equality but not staleness/progression).
- certify digests UNCHANGED (council, strongest finding): still per-item
  evidence-command digests, byte-stable across days. The merkle digest is
  snapshot identity only — mixing it into certification would invalidate
  every cert on every new note.

## F6.4 — supersession semantics

- update → new note with supersedes + supersedesFile; delete → tombstone note
  with reason; confirm/decay → op notes with target id + ts. Confirms are
  fold-derived (no separate truth).
- revert anchors on an explicit note-id set or single-note inverse deltas.
  NEVER on snapshot digest or a ts-cut (council: late-arriving older-ts notes
  change what a cut means; a digest names content, not a history point).
  Replaces v0.5 revertToVersion, which retires with the version counter.

## F6.5 — counters & sync rails

- counters.json stays machine-local OUTSIDE the store — no per-host split, no
  sync (council YAGI, adopted over the draft): injections are per-machine
  events; decay eligibility = local injections >= threshold AND no confirm
  note in the fold.
- decay quiescence (council x3): decay additionally requires the newest
  FOREIGN note in scope to be older than 2x the sync interval; fold rule — a
  confirm note with ts >= a decay note ts suppresses that decay (late confirm
  wins; decay must be countermandable).
- same-host concurrency (two pi sessions, one machine): keep the existing
  withJournalLock discipline around seq allocation and counters mutation.
- the rail is a DEDICATED wrapper script (continuity-sync), not inline cron
  lines: the sibling kn-mirror line in pi-memory-sync.sh already uses
  --delete — one copy-paste wipes every peer-unsynced note (council: live
  hazard, not hypothetical). Wrapper: rsync -a, --backup
  --backup-dir=<store>/.rail-backup, --exclude='*.lock', and NO --delete
  anywhere; the backup dir keeps even a deliberate --delete reversible.
- observability: every successful push writes .last-sync-<host>.json
  {ts, fileCount, digest}; /refine surfaces peer-heartbeat age and digest
  divergence. Dead cron, unreachable peer, disk-full receiver must not
  diverge stores silently for days.

## F6.6 — migration

- the splitter ingests journal.jsonl AND journal.legacy*.jsonl; ALL legacy
  lines split as host="legacy", seq=<old version counter> (council x2:
  Transition lines carry no host field, "inferred from provenance" collapses
  to the migrating host and duplicates every note under two names; the fixed
  label makes both machines emit byte-identical filenames — rsync dedupes).
- raw backups are per-machine: journal.legacy-<host>.jsonl (a same-named
  backup file clobbers across the rail).
- migration markers are machine-local per scope and NEVER files inside the
  store (council: a store-side marker ships via rsync, the peer starts
  un-migrated, and its post-retirement journal tail is silently ignored).
- AUTO-migrate on first scope open: the splitter is deterministic and
  idempotent, so v0.6 splits, renames to legacy-<host>, writes the local
  marker, and warns loudly in the log. Hard refusal at most for a single
  affected scope, never provider-wide (a dusty checkout or a v0.5 peer must
  not outage the layer; council: "refuse to start" was an outage for a
  formality).

## F6.7 — boundaries / non-goals

- No query engine: rg/grep over the directory IS the query engine;
  continuity.search stays thin sugar.
- No compaction yet (volume ~10^2 files/year; revisit at 10^5).
- mesh/state remain rejected (v0.4 boundaries unchanged).
- SQLite only as a DISPOSABLE derived read index, never the source of truth.
- Implementation order (minimal viable subset first): store.dir +
  file-per-transition + fork rule + digest identity + host-scoped
  auto-migration; counters machine-local; confirm/decay rework lands
  incrementally. Deferred: supersedesFile-mismatch remediation tooling.

## Open questions

- fsync policy: per note (default) vs per refine batch — default per note.
- Project slug normalization across machines (homelab on hlab vs thinkpad
  paths) — verify during migration.
- Provider JSON surface churn inventory (Transition.version /
  JournalSnapshot.version removal) — list types, response shapes, and the
  probe-suite rewrite plan in the implementation branch, not here
  (council maintainability: name the blast radius before coding).
