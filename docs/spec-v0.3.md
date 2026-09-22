# Spec: continuity v0.3 — attribution counters, vcc evidence, history search

Repo: ~/projects/pi-fabric-continuity (canonical clone; the managed clone
~/.pi/agent/git/github.com/e4779/pi-fabric-continuity must be fast-forwarded to the
pushed main when the release lands).

Conventions: TypeScript ESM with .js import suffixes; strict typecheck
(tsc --noEmit); probes are plain node scripts in tests/*.probe.mjs executed against
the build emitted by tsc -p tsconfig.build.json to /tmp/continuity-probe; hermetic
homes via tests/hermetic.mjs probeHome(). The journal is append-only; state folds
transitions; nothing writes outside the journal and derived caches. Commits follow
Conventional Commits.

## F1 — Attribution counters ("a note must earn its tokens")

- F1.1 Every injection of an item into the system prompt increments a per-item
  injection counter.
- F1.2 A per-item touch counter increments when the model acts on the item:
  a continuity.mutate transition targeting it, or /harness keep.
- F1.3 Counters are visible: a provider action `stats` (risk read) returns
  per-item {id, injections, touches, lastInjectedAt}; a /harness stats subcommand
  renders the same for the human.
- F1.4 Decay: when an active item reaches DECAY_AFTER_INJECTIONS (configurable,
  default 20) injections with zero touches, the next refine run proposes an
  importance decrease with the counters as evidence. The proposal is journaled
  like every refine delta — no silent writes.
- F1.5 Counters survive restarts (persisted, not in-memory only).

## F2 — vcc evidence for refine

- F2.1 Optional flag in the continuity config (default false) enabling vcc
  evidence collection during refine.
- F2.2 When enabled AND pi-vcc is present, the refine evidence assembly includes
  bounded vcc_recall output for project-relevant queries (cap ~2k chars).
- F2.3 When pi-vcc is absent or the call fails, refine proceeds unchanged:
  silent fallback, never an error.
- F2.4 The evidence provenance is visible in the proposer user text as a labeled
  section.

## F3 — continuity.search over current and historical items

- F3.1 Provider action `search` (risk read): {query, scope?, cwd?} → matches
  from folded current items AND historical item text reachable from journal
  transitions; each hit carries id, version/ts and a bounded snippet.
- F3.2 /harness search <query> renders the same for the human.
- F3.3 Case-insensitive literal matching; no LLM in the search path.

## Release requirements

- R.1 Minor version bump (0.3.0).
- R.2 README documents the new action, subcommands and the config flag.
- R.3 tsc --noEmit clean; tsc -p tsconfig.build.json clean; ALL probes pass
  (journal, audit, inject, completions, delivery, refine, plus new probes for
  F1–F3).
- R.4 Conventional Commits; pushed to origin main; managed clone fast-forwarded.

## Out of scope

CE telemetry ingestion, LLM-based ranking, blackhole/OM integration.
