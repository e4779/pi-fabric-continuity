# pi-fabric-continuity

Self-improving harness notes & principles for [pi](https://github.com/earendil-works/pi-coding-agent),
built on **pi-fabric** primitives. Successor to the pi-continual-harness concept,
re-architected per The Harness Playbook.

## Goal

One extension over fabric that manages evolving prompt notes, declared principles,
skill descriptions, and sub-agent specs — with a refine loop and **no manual
import/export** of a durable file.

## Why (design constraints)

pi-continual-harness has two authorities (session entries + `harness-state.md`)
and a manual `/harness import|export` reconciliation — exactly the "two
authorities" failure mode The Harness Playbook criticizes. State must be
derivable from the journal alone; rewind/fork/resume must not lie.

## Architecture (v1, agreed)

- **Authority → mesh state.** Harness state lives as a CAS key
  (`state/current`-style) with an append-only transition topic. One source of
  truth; new sessions just read it. Conflicts resolved by CAS versioning, not
  by manual merge policy.
- **Trajectory source → `memory.*`.** Refine reads recent turns via
  `memory.recall`/`memory.walk` (active branches, scopes: session / project /
  global). Respects `/tree` navigation by construction.
- **Refine → fabric_exec program.** Proposes structured CRUD deltas →
  `state.transition` with evidence attached (ACE-style itemized deltas, never
  prose rewrites).
- **Adaptive → durable background agent.** Event-triggered refine
  (`state.violated`, failed `checkGoal`, every N turns) as a durable one-shot;
  the live session picks up changes next turn without spending context.
- **Thin pi extension layer.** Only prompt-injection hooks and slash commands;
  all logic lives on fabric primitives.
- **pi-reflect compat.** Markdown export becomes a one-way projection (view),
  never a second authority. Offline results are applied back as transitions.

## References

- Base concept: `~/.pi/agent/npm/node_modules/pi-continual-harness/` (src,
  `/refine` semantics, harness-state store)
- Fabric docs: `~/.pi/agent/npm/node_modules/pi-fabric/docs/` — `state-layer.md`,
  `memory-recall.md`, `residency-runtime.md`, `agents.md`, `architecture.md`
- Playbook: `~/kn/_sources/agents/stencil-harness-playbook.md` (+ distilled
  concept `~/kn/bundles/agents/harness-architecture-playbook.md`)
- prime-agent / RLM: `~/kn/bundles/agents/prime-agent.md`, `rlm-paradigm.md`
- Related: pi-reflect (jo-inc/pi-reflect), pi-mem; monotykamary's
  pi-reason-harness reviewed and rejected (different domain: test-time
  strategy ensembling, ARC-AGI oriented)

## Status

Design agreed 2026-09-04; decisions applied 2026-09-04: scope-based binding
(project default, global opt-in, optional models[] hint — no per-model ownership);
runner-agnostic refine pipeline (inline default for manual, durable for cadence);
name `pi-fabric-continuity`; one-shot migration recipe instead of an importer.
- **v0 skeleton implemented** (typecheck clean, 19/19 journal probes green):
  provider-owned journal (append-only, atomic batches, corrupt-line tolerant,
  stable ids across folds), `continuity` FabricProvider (status/list/read/
  history/mutate), before_agent_start injection (token-budgeted), `/harness`
  status|list|history. Probes: `tsc -p tsconfig.build.json &&
  HOME=/tmp/fakehome node tests/journal.probe.mjs`.
- Next: refine pipeline (memory.recall evidence → LLM proposer → journaled
  deltas), turn_end cadence, durable-runner recipe.
