# Durable refine & migration recipes

Both are recipes, not built-in features: the v1 pipeline is complete without
them, and each uses only sanctioned surfaces (provider actions + core agents).
Verify on first use.

## Durable background refine

The inline runner (/harness refine) executes in the live turn. The durable
variant keeps working after the TUI closes: a spawned durable agent reads the
project's session data and applies journaled deltas on its own.

From any fabric_exec program:

```ts
const refine = await agents.spawn({
  name: "continuity-refine",
  task: [
    "Read the recent sessions of this project (memory.recall with scope 'project',",
    "branches 'active'; or the session JSONL files via pi.read).",
    "Identify repeated failure patterns, durable facts, reusable tactics, or stale",
    "harness items. Apply them as structured CRUD deltas through",
    "tools.call({ ref: 'continuity.mutate', args: { source: 'refine', deltas: [...] } })",
    "— evidence required on create, reason required on delete, ACE rules:",
    "itemized evidence-backed deltas only, no prose rewrites.",
  ].join(" "),
  residency: "durable",
  extensions: true, // keeps the continuity provider reachable in the child
});
return refine;
```

Notes:
- The durable agent's own session is not the live trajectory; evidence must
  come from memory/session reads, not from its context.
- Terminal status and results are inspectable after resume via agents.status,
  agents.wait, agents.log (durable participants survive session close).
- Cadence trigger: call the spawn from a turn_end-hooked fabric_exec program,
  or manually when wrapping up a long session.

## Migration from pi-continual-harness

One-shot, agent-executable (no importer feature by decision):

1. Read the old durable file (default ~/.pi/agent/harness-state.md, project
   scope: ~/.pi/agent/harness-state/<slug>.md).
2. For each item emit a create delta with the old content/evidence/importance
   and source "migrate":

```ts
await tools.call({
  ref: "continuity.mutate",
  args: { scope: "global", source: "migrate", deltas: [
    { op: "create", kind: "memory", content: "...", evidence: "migrated from harness-state.md", importance: 0.7 },
  ] },
});
```

3. Old ownerModel bindings are dropped by design (scope-based model now);
   optionally add a models hint per item when the note is model-specific.
