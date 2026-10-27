// pi-fabric-continuity — core domain types.
//
// Lineage: pi-continual-harness's HarnessItem/Delta, re-scoped:
// scope replaces strict per-model ownership (models is a relevance hint only).

/** The four Continual Harness components (arXiv 2605.09998). */
export type ComponentKind = "prompt" | "memory" | "skill" | "subagent";

export type Scope = "project" | "global";

/** F4.1: outcome of running an item's evidenceCmds (fail-closed). */
export type CertStatus = "certified" | "violated";

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
  /** F4.1: optional machine-verifiable evidence commands (certify runs them). */
  evidenceCmds?: string[];
  /** F4.1: latest certification outcome, folded from certify deltas. */
  cert?: { status: CertStatus; at: number; digest?: string };
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
      evidenceCmds?: string[];
      scope?: Scope;
      /** Explicit id (moves/migrations); server-generated when omitted. */
      id?: string;
    }
  | {
      op: "update";
      id: string;
      content?: string;
      evidence?: string;
      importance?: number;
      active?: boolean;
      models?: string[];
      evidenceCmds?: string[];
      scope?: Scope;
    }
  | { op: "delete"; id: string; reason: string; scope?: Scope }
  | { op: "move"; id: string; to: Scope; reason?: string }
  | { op: "certify"; id: string; status: CertStatus; digest?: string; scope?: Scope };

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
  /** v0.6: sha256 over the sorted note content hashes (first 8 hex) —
   *  snapshot identity; the per-file version counter is retired (F6.3). */
  digest8: string;
  /** Number of note files in the fold (monotonicity companion to digest8). */
  fileCount: number;
  items: HarnessItem[];
}
