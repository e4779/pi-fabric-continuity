# pi-fabric-continuity

Continual harness for [pi](https://github.com/earendil-works/pi-coding-agent), built on
[pi-fabric](https://github.com/monotykamary/pi-fabric) primitives: self-improving prompt
notes, principles, skill descriptions, and sub-agent specs — with a refine loop and
**no manual import/export** of a durable file.

Successor to the pi-continual-harness concept, re-architected per
[The Harness Playbook](https://stencil.so/blog/harness-playbook): one authority
(an append-only journal), state derived by folding, /tree-correct trajectory reads.

## Install

Requires pi >= 0.85 with the pi-fabric extension installed.

```bash
pi install git:github.com/e4779/pi-fabric-continuity
```

Or drop a symlink into `~/.pi/agent/extensions/` for development:

```bash
ln -s ~/projects/pi-fabric-continuity ~/.pi/agent/extensions/pi-fabric-continuity
```

## Usage

```
/harness status            # journal versions + item counts (project & global)
/harness list [kind]       # items, optionally filtered by prompt|memory|skill|subagent
/harness history [n]       # recent journal transitions (who/when/why)
/harness refine [lookback] [instructions]
                          # trajectory evidence -> LLM proposer -> journaled deltas;
                          # /refine is an alias. Free text after the optional
                          # number focuses the proposer (e.g. /refine git discipline)
/harness keep|drop <id>    # importance hygiene (+/-0.1, as transitions)
/harness revert <version>  # compensating deltas; the journal is never rewritten
```

All subcommands, kinds, item ids, and journal versions autocomplete.

The same surface is a first-class fabric provider: any `fabric_exec` program
(including spawned durable agents) can call
`tools.call({ ref: "continuity.mutate", args: { deltas: [...] } })` with
fabric-side validation, risk policy, and nested-call audit.

Auto-refine cadence (opt-in):

```json
// ~/.pi/agent/continuity/config.json
{ "autoRefine": { "enabled": true, "everyTurns": 50 } }
```

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

Scopes: `project` per working directory (default), `global` for cross-project
principles (via the provider's `scope: "global"`).


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
tsc -p tsconfig.build.json && HOME=/tmp/fakehome node tests/journal.probe.mjs && HOME=/tmp/fakehome node tests/refine.probe.mjs
```

## License

[BSD-2-Clause](LICENSE) — the OpenBSD-style license.
