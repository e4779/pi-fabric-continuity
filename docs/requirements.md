# v1 requirements — pi-harness-state

## Goals

1. One pi extension over pi-fabric: self-improving prompt notes, principles, skill descriptions, subagent specs.
2. **Single authority**: mesh state (CAS + append-only journal). No durable md as a second authority.
3. Zero manual round-trip: a fresh session in the same scope sees harness state automatically.
4. Evidence-backed structured deltas only (ACE); full audit history; rollback = explicit revert transition.
5. Adaptive refine: cadence/event-triggered, runs as a durable background agent, invisible to the live context budget.
6. /tree-correct trajectory reads (memory active branches).

## Non-goals (v1)

- No prose prompt rewrites; no provider integrations; no new storage formats beyond mesh.
- pi-reflect projection (export-only view) — post-v1.

## Command surface (draft)

- `/harness status | list | show <id>` — inspect via `state.get` + `state.history`.
- `/harness refine [n]` — run refine now (fabric_exec program: memory.recall → propose → state.transition).
- `/harness keep|drop <id>` — importance hygiene as transitions.
- Model tools: `harness_list` / `harness_mutate` equivalents backed by the state provider.

## Data model (draft)

`HarnessItem {id, kind, content, evidence, importance, active, scope: session|project|global, timestamps}`
Delta = `create|update|delete(reason)` mapped 1:1 to `state.transition` (label `kind:id`, summary = evidence, tags `[kind, op]`).

## Storage mapping

- Authority: mesh CAS key per scope (e.g. `state/harness/<scope>/current`), journal in `fabric.state` topic.
- Trajectory: `memory.recall/walk`, `branches:"active"`.
- Refine runner: durable one-shot (`agents.spawn`, `residency:"durable"`), triggers: turn cadence, `state.violated`, failed `checkGoal`.

## Injection

`before_agent_start` renders active items of the scope, token-budgeted (port select.ts); show delta-since-last-turn (playbook: prompts as projections).

## Known trade-off (accepted)

Mesh state lives **outside** the session tree: /tree rewind does not roll harness state back (unlike continual-harness's branch-local entries). Rollback is an explicit revert transition against the journal. Branch-correctness applies to trajectory reads; durability applies to mutations. Documented, accepted.

## Acceptance criteria

1. Fresh session, same project: harness state visible with zero manual steps.
2. Every mutation is a journaled transition with evidence; `state.history` shows who/when/why.
3. Refine output: deltas with evidence, applied via CAS; failed refine leaves state untouched.
4. Background refine survives session close; results appear next turn.
5. Injection respects the token budget.

## Open questions

1. Model binding: strict per-model (continual-harness) vs scope-only + optional model tag (prime-agent)?
2. Refine in-turn vs background-first? (proposal: background-first)
3. Name: keep `pi-harness-state`?
4. Migration importer from continual-harness session entries / md file?
