# pi-fabric-continuity

[![npm](https://img.shields.io/npm/v/pi-fabric-continuity)](https://www.npmjs.com/package/pi-fabric-continuity)
[![checks](https://github.com/e4779/pi-fabric-continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/e4779/pi-fabric-continuity/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-ISC-blue.svg)](./LICENSE)

Continual harness for [pi](https://github.com/earendil-works/pi-coding-agent), built on
[pi-fabric](https://github.com/monotykamary/pi-fabric) primitives: self-improving prompt
notes, principles, skill descriptions, and sub-agent specs — with a refine loop and
**no manual import/export** of a durable file.

Successor to the pi-continual-harness concept, re-architected per
[The Harness Playbook](https://stencil.so/blog/harness-playbook): one authority
(an append-only journal), state derived by folding, /tree-correct trajectory reads.

## How it fits

The roles around the model boundary are deliberately separate:

- **pi-fabric** executes and orchestrates; its compaction engine writes the deterministic summary.
- **pi-context-engineer** decides what data may cross a single call boundary.
- **pi-vcc** preserves the raw lineage that compaction removes.
- **continuity** governs the identity boundary: which distilled claims about the operator, the
  project and the harness itself ride into every system prompt — kept honest by a journaled,
  evidence-backed self-improvement loop.

## Lineage & inspirations

- [The Continual Harness](https://arxiv.org/abs/2605.09998) — the four components
  (prompt / memory / skill / subagent) this package implements.
- [The Harness Playbook](https://stencil.so/blog/harness-playbook) — one authority, folding,
  /tree-correct reads (already linked above; it shaped the architecture).
- [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) — the refine loop:
  trajectory evidence → proposed deltas → journaled, revertible transitions.
- ACE (Agentic Context Engineering) — structured, evidence-backed CRUD deltas instead of
  prose rewrites; the `Delta` type is ACE-shaped on purpose.
- [pi-vcc](https://github.com/monotykamary/pi-vcc) — sticky sections and stable-first
  ordering; our emission order is prompt-cache-stable for the same reason.
- [pi-context-engineer](https://github.com/p-yan-6908/pi-context-engineer) — boundary
  governance; continuity extends that philosophy to the identity boundary.
- [pi-reflect](https://www.npmjs.com/package/pi-reflect) and
  [pi-mem](https://www.npmjs.com/package/pi-mem) — surveyed in
  [docs/domain-map.md](docs/domain-map.md).

## Install

Requires pi >= 1.0 with the pi-fabric extension installed.

```bash
pi install npm:pi-fabric-continuity
```

Or from the repo directly:

```bash
pi install git:github.com/e4779/pi-fabric-continuity
```

Or drop a symlink into `~/.pi/agent/extensions/` for development:

```bash
ln -s ~/projects/pi-fabric-continuity ~/.pi/agent/extensions/pi-fabric-continuity
```

## Usage

```
/refine [lookback] [instructions]
                          # trajectory evidence -> LLM proposer -> journaled deltas;
                          # /refine 50 reviews the last 50 turns. Free text after
                          # the optional number focuses the proposer
                          # (e.g. /refine 100 git discipline)
```

The single human entry point. Everything else is agent-driven: any
`fabric_exec` program (including spawned durable agents) can ask for and
apply curation through the journaled provider — status, list, read, search,
history, audit, stats, certify, revert, mutate.
`tools.call({ ref: "continuity.mutate", args: { deltas: [...] } })` with
fabric-side validation, risk policy, and nested-call audit — just ask.
(v0.4: the `/harness` TUI subcommands were removed at the operator's
request; `/refine` was the only command ever used, and provider actions
cover the rest with full journal provenance.)
`continuity.search` is the same search as `/harness search` as a read-risk
action: `{ query, scope?, cwd? }` — literal, case-insensitive, no LLM.
`continuity.stats` is the read-risk view behind `/harness stats`: per-item
injection/touch counters with decay eligibility (see F1 attribution counters).
`continuity.certify` (execute-risk) runs every active item's `evidenceCmds`
fail-closed (non-zero exit or timeout = violated) and appends certify deltas;
the fold exposes `item.cert = { status, at, digest }`, and injected lines gain
a freshness tag (`[certified 2m ago]` / `[VIOLATED 3h ago]`). It also returns
ready-to-publish `meshEvents` for an optional guest-side mirror:
`for (const e of out.meshEvents) await mesh.publish(e);` — durable note-health
events on the `continuity.certification` topic, visible to sub-agents and
peers without loading this plugin.

Auto-refine cadence and refine evidence (opt-in):

```json
// ~/.pi/agent/continuity/config.json
{ "autoRefine": { "enabled": true, "everyTurns": 50 }, "vccEvidence": false,
  "certify": { "timeoutMs": 10000 } }
```

`"vccEvidence": true` feeds the refine proposer a bounded, labeled section of
`vcc_recall` output (queries derived from the project directory, ~2k char cap).
Requires @monotykamary/pi-vcc; when it is absent or the call fails, refine
proceeds unchanged.

## The daily loop

Three roles, one journal:

1. **Refine** — every N turns (opt-in `autoRefine`) or on demand (`/harness refine`),
   the pipeline reads the recent trajectory and proposes evidence-backed deltas.
   Repeated patterns, durable facts, and stale items become journal transitions.
2. **The model self-corrects** — active items are injected into the system prompt
   each turn (importance-ordered, token-budgeted). When the model notices an item
   is wrong or stale mid-session, it updates it directly via `continuity.mutate`
   from any fabric_exec program — no waiting for the human.
3. **You curate** — `/harness keep`/`drop` to steer importance, `/harness history`
   to audit who changed what and why, `/harness revert <v>` to undo a bad refine.
   Every mutation is journaled; nothing happens outside the audit trail.

Scopes: `project` per working directory (default) and `global` for cross-project
principles. The refine proposer decides per delta (it sees both stores and the
scope rules); explicit calls can pin `scope` per delta or per batch. Global
items inject into every project.


## Storage

Provider-owned append-only journals, one authority, snapshots derived by folding:

```
~/.pi/agent/continuity/global/journal.jsonl
~/.pi/agent/continuity/projects/<slug>/journal.jsonl
```

Scopes: `project` (default, slug from cwd) and `global`. Items carry an optional
`models` hint for relevance — never ownership, never blank-slate resets.

## Design

- [docs/requirements.md](docs/requirements.md) — goals, decisions, storage mapping,
  acceptance criteria
- [docs/domain-map.md](docs/domain-map.md) — survey of pi-continual-harness,
  prime-agent refinement, pi-reflect, pi-mem
- [docs/durable-recipe.md](docs/durable-recipe.md) — durable background refine
  and migration recipes

Probes (no framework needed):

```bash
npm run -s typecheck || npx tsc --noEmit -p tsconfig.json
tsc -p tsconfig.build.json && node tests/journal.probe.mjs && node tests/completions.probe.mjs && node tests/refine.probe.mjs
```

## License

[ISC](LICENSE) — the OpenBSD-style license.
