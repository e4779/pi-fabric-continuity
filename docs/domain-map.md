# Domain map — phase 1 research (2026-09-04)

Three implementations of the continual-harness idea, surveyed before writing v1.

## pi-continual-harness 0.8.0 (port base)

- **Item**: `{id, kind: prompt|memory|skill|subagent, content, evidence, importance∈[0,1], active, ownerModel "provider/id", createdAt, updatedAt}`
- **Delta**: structured CRUD `create|update|delete(reason)` — ACE-style itemized deltas, never prose rewrites.
- **Storage**: (1) session entries `harness-state` after every mutation, reconstructed on `session_start` from the active branch → free /tree rollback; (2) durable md file as composition seam, manual `/harness import|export`, offline-wins merge.
- **Binding**: strict per-model; orphans adopted by active model on first contact; new model id starts blank.
- **`/refine [n] [--commit] [--proposer steering|dedupe]`**: gathers ~16KB evidence from last n turns (default 25), LLM proposes deltas, applies, appends REFINE_ENTRY (source tagged).
- **auto-refine**: opt-in `turn_end` cadence (default every 100 turns), same routine, visible notify.
- **Injection**: `before_agent_start` renders only active items of the active model; token-budgeted selection (select.ts, estimateTokens/charsPerToken).
- **Pain**: two authorities; manual file round-trip.

## prime-agent refinement (fork core, MIT)

- **HarnessEntry**: same four kinds + `title, path, scope: local|global, reference, arguments, metadata, version`; history in `refinements.jsonl` (`{trigger, changes, evidence, outcome}`).
- **Proposal**: `{summary, rationale, edits[], expectedOutcome}`; applied edits carry before/after; **rollback by id**.
- **Scopes**: session-local default, global cross-session store (`harness_state.json`); Python mirror in runtime (`rlm/harness.py`).
- **Auto-refine reasons**: `turn_interval | compact`; an LLM review decides `shouldRefine` with `turnsSinceLastReview` context.
- **Kernel skill**: `await refine.run(instructions?, global_?)` — scheduled, runs at turn end, rebuilds system prompt, auto-resumes; never mid-cell; one request per turn.

## pi-reflect (jo-inc, offline complement)

Target md file + transcript evidence → one LLM call → surgical edits with safety (backup, skip ambiguous matches, reject large deletions, git auto-commit). `/reflect-stats` tracks correction rate + rule recidivism.

## pi-mem (jo-inc, ★74)

Plain-markdown persistent memory: long-term facts, daily logs, scratchpad, semantic search; `save_memory` tool integration.

## Fabric primitives (target platform)

- **`state.*`**: CAS key `state/current` + append-only topic `fabric.state`; transitions proposed→committed/rejected; evidence attachment; fail-closed `verify`; executable goals. Everything in mesh.
- **`memory.*`**: session JSONL is the source of truth; `recall/expand/walk/sessions`; scopes `session|project|global`; **active-branches lineage** (respects /tree; abandoned siblings don't match).
- **`agents.spawn(..., residency:"durable")`**: background one-shots/actors survive session close; mesh is the shared-state medium (residency explicitly does not share agent contexts).

## Landscape

- pi-hermes-memory (★409), pi-observational-memory (★555) — community memory plays, not harness-CRUD.
- monotykamary/pi-reason-harness — reviewed, rejected: test-time strategy ensembling (ARC-AGI), different domain.
