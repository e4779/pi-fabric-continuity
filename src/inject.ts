// before_agent_start: append the continuity block to the system prompt.
// Immutable base + supplemental — never rewrites, only appends (Continual
// Harness lineage). Selection is importance-ordered, capped per kind and by a
// total token budget; `models` on an item is a soft relevance hint.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentSnapshot } from "./journal.js";
import type { ComponentKind, HarnessItem } from "./types.js";

const KIND_ORDER: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

const TITLES: Record<ComponentKind, string> = {
  prompt: "Self-improved prompt notes",
  memory: "Remembered facts",
  skill: "Available skill notes",
  subagent: "Reusable sub-agent specs",
};

export interface InjectionConfig {
  enabled: boolean;
  maxTokens: number;
  maxPerKind: number;
  charsPerToken: number;
}

export const DEFAULT_INJECTION: InjectionConfig = {
  enabled: true,
  maxTokens: 800,
  maxPerKind: 8,
  charsPerToken: 4,
};

export function modelKeyOf(m?: { provider: string; id: string }): string | undefined {
  return m ? `${m.provider}/${m.id}` : undefined;
}

function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

export function selectForInjection(items: HarnessItem[], modelKey: string | undefined, cfg: InjectionConfig) {
  const relevant = items
    .filter((i) => i.active)
    .filter((i) => !i.models || i.models.length === 0 || (modelKey !== undefined && i.models.includes(modelKey)));
  const sorted = [...relevant].sort((a, b) => b.importance - a.importance);
  const selected: HarnessItem[] = [];
  const perKind = new Map<ComponentKind, number>();
  let used = 0;
  let omitted = 0;
  for (const it of sorted) {
    const k = perKind.get(it.kind) ?? 0;
    const cost = estimateTokens(`- [${it.id}] ${it.content}`, cfg.charsPerToken);
    if (k >= cfg.maxPerKind || used + cost > cfg.maxTokens) {
      omitted += 1;
      continue;
    }
    perKind.set(it.kind, k + 1);
    used += cost;
    selected.push(it);
  }
  return { selected, omitted };
}

export function renderContinuityBlock(items: HarnessItem[], modelKey: string | undefined, cfg: InjectionConfig): string {
  if (items.length === 0) return "";
  const { selected, omitted } = selectForInjection(items, modelKey, cfg);
  if (selected.length === 0) return "";
  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const forKind = selected.filter((i) => i.kind === kind);
    if (forKind.length === 0) continue;
    const bullets = forKind.map((i) => `- [${i.id}] ${i.content}`).join("\n");
    sections.push(`### ${TITLES[kind]}\n${bullets}`);
  }
  if (sections.length === 0) return "";
  const lines = [
    "",
    "## Continuity harness state",
    "Self-improved notes accumulated from past trajectories.",
    "Treat these as durable working context. Correct or retire stale entries via the continuity provider (mutate).",
    "",
    sections.join("\n\n"),
  ];
  if (omitted > 0) {
    lines.push("", `_${omitted} item(s) not shown — below the injection budget._`);
  }
  return lines.join("\n");
}

export function registerInjection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = DEFAULT_INJECTION;
    if (!cfg.enabled) return;
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    let snap;
    try {
      snap = await currentSnapshot("project", cwd);
    } catch {
      return;
    }
    if (snap.items.length === 0) return;
    const block = renderContinuityBlock(snap.items, modelKeyOf(ctx.model as { provider: string; id: string } | undefined), cfg);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n" + block };
  });
}
