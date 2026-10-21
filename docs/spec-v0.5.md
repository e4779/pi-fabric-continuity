# Spec — v0.5: two-sided refine (confirms), touch removal

Trigger: operator question 2026-10-21 — "does the model ever touch the notes?"
Data: 0 touches across 70 global items, ever. The main-model self-report
signal measured nothing. Comparative research (prime-agent, pi-reflect,
pi-mem/RAG family, CLAUDE.md family): nobody implements model-usage
attribution; the working pattern in our lineage is attribution = the refine
distillation cycle itself.

## F5.1 — confirms counter (replaces touches)

- `ItemCounters { injections, confirms, lastInjectedAt }`; `recordConfirms(ids)`.
- Source of a confirm: a refine run whose proposer emitted an update/delete
  targeting the item. Recorded BEFORE decay evaluates, so a just-confirmed
  item never decays in the same run.
- `decayAfterInjections` unchanged; eligibility: active && injections >=
  threshold && confirms === 0.
- Legacy counters.json with a `touches` field reads tolerantly (unknown field
  ignored, confirms defaults 0). No migration.
- Removed: recordTouches, the mutate-path touch recording, /harness keep
  (already gone with the TUI surface in v0.4).

## F5.2 — proposer bump rule (two-sided refine)

PROPOSER_SYSTEM gains an explicit rule: when trajectory evidence RE-CONFIRMS
an existing item, propose an importance-only update (+0.05..0.10, cap 0.90)
with evidence "re-confirmed: ...". RefineResult/notify gain `confirmed`
(count of proposer-targeted ids); last-refine.log v7 records confirmedCount.

## F5.3 — documentation honesty (variant B)

README Attribution section states the semantics: injections = exposure,
confirms = refine attribution, touch = removed dead signal. No claim of
model-usage tracking is made anywhere.
