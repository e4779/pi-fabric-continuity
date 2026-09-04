// pi-fabric-continuity — core domain types.
//
// Lineage: pi-continual-harness's HarnessItem/Delta, re-scoped:
// scope replaces strict per-model ownership (models is a relevance hint only).

/** The four Continual Harness components (arXiv 2605.09998). */
export type ComponentKind = "prompt" | "memory" | "skill" | "subagent";

export type Scope = "project" | "global";

/** A single item in the harness journal's derived state. */
export interface HarnessItem {
  id: string;
  kind: ComponentKind;
  /** Payload: a prompt note, memory fact, skill description, or sub-agent spec. */
  content: string;
  /** Why this item exists, grounded in trajectory evidence. Required on create. */
  evidence: string;
  /** Fitness signal in [0,1]. Items below the floor can be pruned/deactivated. */
  importance: number;
  /** Whether the item is injected into the system prompt each turn. */
  active: boolean;
  scope: Scope;
  /** Optional relevance hint ("provider/id"). Never ownership, never a blank-slate reset. */
  models?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Structured CRUD delta — the unit of self-improvement (ACE-style, never prose). */
export type Delta =
  | {
      op: "create";
      kind: ComponentKind;
      content: string;
      evidence: string;
      importance?: number;
      models?: string[];
    }
  | {
      op: "update";
      id: string;
      content?: string;
      evidence?: string;
      importance?: number;
      active?: boolean;
      models?: string[];
    }
  | { op: "delete"; id: string; reason: string };

export type DeltaSource = "manual" | "refine" | "migrate";

/** One append-only journal record. State is derived by folding these. */
export interface Transition {
  version: number;
  ts: number;
  /** Who: "provider:continuity.<action>" | "command:<name>" | "model:<provider/id>". */
  actor: string;
  source: DeltaSource;
  delta: Delta;
  /** Item id touched by this transition, when resolvable. */
  target?: string;
  /** Human-readable annotation (e.g. "revert to v3"). */
  note?: string;
}

export interface JournalSnapshot {
  version: number;
  items: HarnessItem[];
}
