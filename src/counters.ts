// Attribution counters — "a note must earn its tokens" (spec F1).
// injections: how often an item was rendered into the system prompt (F1.1,
// recorded by the injector). touches: how often the model or operator acted
// on it — a continuity.mutate transition targeting the item, or /harness
// keep (F1.2). Counters live in a derived cache keyed by item id (ids are
// stable across moves and refolds) and survive restarts (F1.5);
// read-modify-write cycles take the journal's inter-process lock.
// Decay (F1.4): an ACTIVE item that reached the injection threshold with zero
// touches is a decay candidate — refine proposes an importance decrease with
// the counters as evidence, journaled like every refine delta.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DECAY_AFTER_INJECTIONS } from "./config.js";
import { withJournalLock } from "./journal.js";
import type { Delta, HarnessItem } from "./types.js";

export interface ItemCounters {
  injections: number;
  touches: number;
  lastInjectedAt?: number;
}

interface CountersFile {
  version: 1;
  counters: Record<string, ItemCounters>;
}

export interface ItemStats {
  id: string;
  injections: number;
  touches: number;
  lastInjectedAt: number | null;
  decayEligible: boolean;
}

/** One importance tier down per decay proposal — small nudges, ACE-style. */
export const DECAY_IMPORTANCE_FACTOR = 0.75;

export function countersPath(): string {
  return join(homedir(), ".pi", "agent", "continuity", "counters.json");
}

function normalize(c: unknown): ItemCounters {
  const r = (c ?? {}) as Partial<ItemCounters>;
  return {
    injections: typeof r.injections === "number" && r.injections > 0 ? Math.floor(r.injections) : 0,
    touches: typeof r.touches === "number" && r.touches > 0 ? Math.floor(r.touches) : 0,
    ...(typeof r.lastInjectedAt === "number" ? { lastInjectedAt: r.lastInjectedAt } : {}),
  };
}

/** Tolerant read: a missing or corrupt counters file reads as empty. */
export async function readCounters(): Promise<Record<string, ItemCounters>> {
  try {
    const raw = JSON.parse(await readFile(countersPath(), "utf8")) as Partial<CountersFile>;
    const out: Record<string, ItemCounters> = {};
    for (const [id, c] of Object.entries(raw.counters ?? {})) out[id] = normalize(c);
    return out;
  } catch {
    return {};
  }
}

async function mutateCounters(fn: (counters: Record<string, ItemCounters>) => void): Promise<void> {
  await withJournalLock(countersPath(), async () => {
    const counters = await readCounters();
    fn(counters);
    const file: CountersFile = { version: 1, counters };
    await writeFile(countersPath(), JSON.stringify(file, null, 2) + "\n", "utf8");
  });
}

/** F1.1: one injection turn for each item rendered into the system prompt. */
export async function recordInjections(ids: readonly string[], ts: number = Date.now()): Promise<void> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return;
  await mutateCounters((counters) => {
    for (const id of uniq) {
      const c = normalize(counters[id]);
      counters[id] = { injections: c.injections + 1, touches: c.touches, lastInjectedAt: ts };
    }
  });
}

/** F1.2: one touch for each item the model or operator acted on. */
export async function recordTouches(ids: readonly string[]): Promise<void> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return;
  await mutateCounters((counters) => {
    for (const id of uniq) {
      const c = normalize(counters[id]);
      counters[id] = {
        injections: c.injections,
        touches: c.touches + 1,
        ...(c.lastInjectedAt !== undefined ? { lastInjectedAt: c.lastInjectedAt } : {}),
      };
    }
  });
}

/** F1.4: an active item at/over the threshold with zero touches. */
export function isDecayEligible(
  item: HarnessItem,
  c: ItemCounters | undefined,
  afterInjections: number = DEFAULT_DECAY_AFTER_INJECTIONS,
): boolean {
  return item.active && (c?.injections ?? 0) >= afterInjections && (c?.touches ?? 0) === 0;
}

/** F1.3: per-item stats over folded items; ids without a record read as zeros. */
export function statsForItems(
  items: HarnessItem[],
  counters: Record<string, ItemCounters>,
  afterInjections: number = DEFAULT_DECAY_AFTER_INJECTIONS,
): ItemStats[] {
  return items.map((i) => {
    const c = counters[i.id];
    return {
      id: i.id,
      injections: c?.injections ?? 0,
      touches: c?.touches ?? 0,
      lastInjectedAt: c?.lastInjectedAt ?? null,
      decayEligible: isDecayEligible(i, c, afterInjections),
    };
  });
}

/** F1.4: deterministic importance-decrease proposals citing the counters.
 *  The refine run journals them like every refine delta — never silent. */
export function decayProposals(
  items: HarnessItem[],
  counters: Record<string, ItemCounters>,
  afterInjections: number = DEFAULT_DECAY_AFTER_INJECTIONS,
): Delta[] {
  const out: Delta[] = [];
  for (const it of items) {
    const c = counters[it.id];
    if (c === undefined || !isDecayEligible(it, c, afterInjections)) continue;
    const importance = Math.round(it.importance * DECAY_IMPORTANCE_FACTOR * 100) / 100;
    if (importance >= it.importance) continue;
    const last = c.lastInjectedAt !== undefined ? new Date(c.lastInjectedAt).toISOString() : "never";
    const evidence = `decay: ${c.injections} injections, 0 touches (threshold ${afterInjections}); last injected ${last}; importance ${it.importance.toFixed(2)} -> ${importance.toFixed(2)}`;
    out.push({ op: "update", id: it.id, importance, evidence, scope: it.scope });
  }
  return out;
}
