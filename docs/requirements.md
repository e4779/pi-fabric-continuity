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

- `/harness status | list | show <id>` — inspect via `continuity.list/read/history`.
- `/harness refine [n]` — run refine now (fabric_exec program: memory.recall → propose → state.transition).
- `/harness keep|drop <id>` — importance hygiene as transitions.
- Provider actions `continuity.list/read/history/mutate/refine/status` — callable as tools, from `/harness` commands, and from any fabric_exec program (incl. spawned durable agents).

## Data model (draft)

`HarnessItem {id, kind, content, evidence, importance, active, scope: session|project|global, timestamps}`
Delta = `create|update|delete(reason)` mapped 1:1 to journal transitions (op, target, evidence, actor, ts).

## Integration seam (decided 2026-09-04)

Sanctioned surface only: `pi-fabric/protocol` (public export). The extension registers a `FabricProvider` via `pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, ...)` (+ `FABRIC_PROVIDER_DISCOVER_EVENT` subscription). Actions become first-class `continuity.*` calls inside fabric_exec with fabric-side validation, risk policy, nested-call audit, cancellation. `StateStore`/`MeshStore` are NOT exported (exports map: `.` and `./protocol`) — deep imports would be fragile; provider-owns-state is the documented model.

## Storage mapping

- Authority: **provider-owned journal** — `~/.pi/agent/continuity/<scope>/journal.jsonl` (append-only deltas) + folded `snapshot.json` (versioned). Same discipline as the mesh: one authority, state derived from journal, explicit revert transitions.
- Trajectory: `memory.recall/walk`, `branches:"active"`.
- Refine runner: inline at `turn_end` cadence (v1); durable path = documented recipe — fabric_exec one-liner `agents.spawn({task: "continuity.refine …", residency: "durable"})`, since provider actions are guest-callable.

## Injection

`before_agent_start` renders active items of the scope, token-budgeted (port select.ts); show delta-since-last-turn (playbook: prompts as projections).

## Known trade-off (accepted)

Mesh state lives **outside** the session tree: /tree rewind does not roll harness state back (unlike continual-harness's branch-local entries). Rollback is an explicit revert transition against the journal. Branch-correctness applies to trajectory reads; durability applies to mutations. Documented, accepted.

## Acceptance criteria

1. Fresh session, same project: harness state visible with zero manual steps.
2. Every mutation is a journaled transition with evidence; `continuity.history` shows who/when/why.
3. Refine output: deltas with evidence, applied via CAS; failed refine leaves state untouched.
4. Background refine survives session close; results appear next turn.
5. Injection respects the token budget.

## Decisions (2026-09-04)

1. **No per-model ownership.** Scopes only: `project` (default) and `global` (opt-in). Optional `models?: string[]` hint on an item for relevance filtering — never ownership, never blank-slate resets.
2. **Runner-agnostic refine pipeline.** One propose→transition path; runners: `inline` (default for manual `/harness refine`, runs at turn end like prime-agent) and `durable` one-shot (cadence/event triggers, survives session close).
3. **Name: pi-fabric-continuity** (directory renamed; old path symlinked for the current session).
4. **No importer feature.** One-shot migration recipe documented: an agent reads the old `harness-state.md` / session entries and emits create-transitions.
