# Spec — v0.4: self-verifying notes, crash resilience, pi 1.x alignment

Sources: housekeeping session 2026-10-21 (four stale facts found by manual live
probes), fabric state-layer semantics (docs/state-layer.md), prime-agent #3387
(torn-tail healing), pi 1.0–1.3 changelog.

## Architecture stance

The journal stays the single authority (global scope, dot-pi sharing, survives
any fabric version). Fabric primitives are used where they are genuinely
fabric's: inter-agent visibility (mesh topics). Evidence execution stays local
(`node:child_process`, ~20 lines) — delegating it to `state.verify` would bolt
note certification onto a project-scoped single-head workflow and create a
second source of truth (thicker, not thinner).

## F4.1 — evidenceCmds + certify

- `HarnessItem.evidenceCmds?: string[]` — optional machine-verifiable evidence.
  Set via `create`/`update` deltas. Empty/absent = not verifiable (skipped).
- New delta op `certify`: `{ op: "certify", id, status: "certified"|"violated",
  digest?: string }`. The fold attaches `item.cert = { status, at, digest }`
  (latest wins — the journal is the authority).
- `certify.ts`: runs every active item's evidenceCmds (bounded: 10s/cmd default,
  `certify.timeoutMs` config), fail-closed — non-zero exit, timeout, spawn error,
  or empty command list with evidenceCmds present → `violated`. digest = sha256
  over concatenated `exit|stdout|stderr` of all commands (state-layer
  resultDigest semantics).
- Trust model = fabric state-layer trust model: evidence commands run with the
  invoking process's authority; they are operator-journaled, visible, and
  revertible. Cross-machine sync means machine-specific commands simply fail
  closed on machines where they don't apply.
- Provider action `continuity.certify` (risk `execute`): runs the pass, appends
  certify deltas, returns `{ results, meshEvents }`.
- Mesh mirror (guest-side one-liner): certify returns ready `meshEvents`
  (`{ topic: "continuity.certification", kind: status, data: {id, status, at,
  digest} }`); the fabric_exec caller publishes them for inter-agent visibility.
  The plugin itself cannot call mesh (one-way provider seam — verified against
  pi-fabric/protocol 0.117).
- `/harness certify [global]` — TUI path, journal-only (no mirror).

## F4.2 — inject freshness annotations

When `item.cert` exists, the injected line gains a suffix: `⚡ certified <rel>`
or `⚠ violated <rel>`. Line order stays (createdAt, id)-stable; content churn
happens only on certify runs (rare, explicit).

## F4.3 — torn-tail healing

`readTransitions(path, { heal })`: if the LAST non-empty line fails to parse
(or the file lacks a trailing newline), heal under the journal lock — re-read,
  re-check, truncate the torn tail, keep every valid record. UTF-8 corruption
  inside a complete record still skips that record (unchanged). Healing never
  runs concurrently with an appending writer: the lock is the same one
  appendDeltas uses.

## F4.4 — pi 1.x alignment

- peerDependencies: `@earendil-works/pi-coding-agent >= 1.0.0`,
  `pi-fabric >= 0.117.0` (provider protocol stable there).
- devDependencies → pi 1.3.0 / pi-fabric 0.119.x; full test pass on 1.3.0.
- README install line: pi >= 1.0.

## Non-goals

- state.transition adoption (dual authority; single-head + project scoping
  mismatch — see architecture stance).
- Memory-source adapter for journal search (session-shaped extraction is a
  poor fit; continuity.search stays).
- Background refine actor (v0.5 candidate).
