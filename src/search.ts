// continuity.search — case-insensitive literal search over the harness
// corpus (spec F3). The corpus is the folded current items PLUS historical
// item text reachable from journal transitions: superseded content/evidence
// and deleted items stay findable, because the journal is append-only.
// Deliberately dumb: toLowerCase + indexOf, no LLM, no ranking, no regex —
// a search hit must never depend on a model or misread metacharacters.

import { currentSnapshot, journalPath, readTransitions } from "./journal.js";
import type { ComponentKind, Scope, Transition } from "./types.js";

/** Hard cap on returned hits — a search result stays bounded by design. */
export const SEARCH_MAX_HITS = 20;

/** Hard cap on one snippet; the match is always kept inside the window. */
export const SNIPPET_MAX = 160;

export interface SearchHit {
  id: string;
  scope: Scope;
  /** true: matches the folded current item; false: historical text only. */
  current: boolean;
  kind?: ComponentKind;
  active?: boolean;
  /** Journal version carrying the matched text. Current hits cite the
   *  transition that established the matched field's current text. */
  version: number;
  ts: number;
  /** Which item text field matched. */
  field: "content" | "evidence";
  /** Bounded, whitespace-flattened excerpt centered on the first match. */
  snippet: string;
}

export interface SearchResult {
  query: string;
  scopes: Scope[];
  /** Matches found before the hit cap. */
  total: number;
  hits: SearchHit[];
}

/** Excerpt around text[at, at+len), at most SNIPPET_MAX chars, ellipsized.
 *  Whitespace is flattened after slicing so TUI lines stay single-line. */
export function boundedSnippet(text: string, at: number, len: number): string {
  const match = Math.min(len, SNIPPET_MAX);
  const radius = Math.floor((SNIPPET_MAX - match) / 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + match + radius);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

/** First case-insensitive literal occurrence of query in text. */
function indexOfLiteral(text: string, queryLower: string): number {
  return text.toLowerCase().indexOf(queryLower);
}

interface TextSpot {
  id: string;
  version: number;
  ts: number;
  field: "content" | "evidence";
  text: string;
}

type TextAsOf = Partial<Record<"content" | "evidence", { version: number; ts: number }>>;

/** One journal's search: a read-only walk for historical text spots plus the
 *  current snapshot for live items. Never touches the journal. */
async function searchOneScope(scope: Scope, cwd: string | undefined, queryLower: string): Promise<SearchHit[]> {
  const transitions = await readTransitions(journalPath(scope, cwd));

  // Historical item text: every content/evidence value a transition ever
  // carried, deduped per (id, version) with content preferred.
  const spots = new Map<string, TextSpot>();
  const kindById = new Map<string, ComponentKind>();
  // Per field: the transition that established the text still current now.
  const lastText = new Map<string, TextAsOf>();
  const consider = (id: string, t: Transition, field: "content" | "evidence", text: string) => {
    if (indexOfLiteral(text, queryLower) < 0) return;
    const key = `${id}:${t.version}`;
    if (!spots.has(key)) spots.set(key, { id, version: t.version, ts: t.ts, field, text });
  };
  for (const t of transitions) {
    const d = t.delta;
    if (d.op === "create") {
      const id = t.target ?? d.id;
      if (!id) continue; // unaddressable pre-target journals: no id to cite
      kindById.set(id, d.kind);
      consider(id, t, "content", d.content);
      consider(id, t, "evidence", d.evidence);
      const asOf = { version: t.version, ts: t.ts };
      lastText.set(id, { content: asOf, evidence: asOf });
    } else if (d.op === "update") {
      if (d.content === undefined && d.evidence === undefined) continue;
      consider(d.id, t, "content", d.content ?? "");
      consider(d.id, t, "evidence", d.evidence ?? "");
      const prev = lastText.get(d.id) ?? {};
      lastText.set(d.id, {
        content: d.content !== undefined ? { version: t.version, ts: t.ts } : prev.content,
        evidence: d.evidence !== undefined ? { version: t.version, ts: t.ts } : prev.evidence,
      });
    }
  }

  // Current items: one hit per item, first matching field wins, cited at the
  // transition that established that field's current text.
  const snap = await currentSnapshot(scope, cwd);
  const currentHits: SearchHit[] = [];
  const currentAsOf = new Map<string, number>(); // "id:field" -> version
  for (const it of snap.items) {
    let field: "content" | "evidence" | null = null;
    let at = -1;
    const cAt = indexOfLiteral(it.content, queryLower);
    if (cAt >= 0) {
      field = "content";
      at = cAt;
    } else {
      const eAt = indexOfLiteral(it.evidence, queryLower);
      if (eAt >= 0) {
        field = "evidence";
        at = eAt;
      }
    }
    if (!field) continue;
    const asOf = lastText.get(it.id)?.[field];
    const hit: SearchHit = {
      id: it.id,
      scope,
      current: true,
      kind: it.kind,
      active: it.active,
      version: asOf?.version ?? snap.version,
      ts: asOf?.ts ?? it.updatedAt,
      field,
      snippet: boundedSnippet(field === "content" ? it.content : it.evidence, at, queryLower.length),
    };
    currentHits.push(hit);
    currentAsOf.set(`${it.id}:${field}`, hit.version);
  }

  // Historical hits, newest first; a spot at the current hit's journal
  // position for the same field is the same text and would double-report.
  const historical: SearchHit[] = [];
  for (const spot of [...spots.values()].sort((a, b) => b.version - a.version)) {
    if (currentAsOf.get(`${spot.id}:${spot.field}`) === spot.version) continue;
    historical.push({
      id: spot.id,
      scope,
      current: false,
      ...(kindById.has(spot.id) ? { kind: kindById.get(spot.id) } : {}),
      version: spot.version,
      ts: spot.ts,
      field: spot.field,
      snippet: boundedSnippet(spot.text, indexOfLiteral(spot.text, queryLower), queryLower.length),
    });
  }
  return [...currentHits, ...historical];
}

/** F3.1: search current and historical item text. scope omitted searches
 *  both journals (project first, then global); each hit is scope-tagged. */
export async function searchItems(opts: { query: string; scope?: Scope; cwd?: string }): Promise<SearchResult> {
  const query = opts.query.trim();
  const scopes: Scope[] = opts.scope ? [opts.scope] : ["project", "global"];
  const queryLower = query.toLowerCase();
  const hits: SearchHit[] = [];
  if (queryLower) {
    for (const scope of scopes) hits.push(...(await searchOneScope(scope, opts.cwd, queryLower)));
  }
  return { query, scopes, total: hits.length, hits: hits.slice(0, SEARCH_MAX_HITS) };
}
