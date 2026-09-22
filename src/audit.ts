// /harness audit — deterministic staleness check of active items against the
// live machine. LLM-free by design: reality is checked, not guessed. The
// refine proposer stays the judgment layer; audit only supplies hard evidence
// and conservative retire proposals. Nothing applies without an explicit
// --apply — the journal remains the only writer of state.
//
// Two check classes, both conservative (only concrete, anchored tokens):
//   path-missing   — `~/…`, `/home/…`, `/Users/…` tokens that no longer
//                    exist on disk (globs and URLs are skipped);
//   package-absent — `npm:@scope/name`, `@scope/name`, `pi-name` tokens
//                    absent from installed extensions (~/.pi/agent/npm) and
//                    the pi manifest. Bare `pi-*` prose mentions can
//                    false-positive (e.g. "consider pi-goal") — findings are
//                    proposals for review, never silent deletes.

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Delta, HarnessItem } from "./types.js";

export type AuditReason = "path-missing" | "package-absent";

export interface AuditFinding {
  id: string;
  kind: HarnessItem["kind"];
  reason: AuditReason;
  detail: string;
}

export interface AuditContext {
  /** HOME used for `~` expansion and package discovery (tests override). */
  home?: string;
  /** Package names considered installed (pi manifest entries). */
  manifestPackages?: string[];
}

const PATH_TOKEN_RE = /(?:~|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/[\w@./-]+/g;
const PKG_TOKEN_RE = /npm:[@a-z0-9][\w./-]*|@[a-z0-9][\w.-]*\/[\w.-]+|\bpi-[a-z0-9][\w-]*\b/g;

export function homeDir(ctx?: AuditContext): string {
  return ctx?.home ?? os.homedir();
}

/** Package names visible to pi: ~/.pi/agent/npm/node_modules (+ manifest list). */
export function installedPackages(ctx?: AuditContext): Set<string> {
  const found = new Set<string>(ctx?.manifestPackages ?? []);
  const nm = path.join(homeDir(ctx), ".pi", "agent", "npm", "node_modules");
  try {
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith("@")) {
        for (const sub of readdirSync(path.join(nm, entry))) found.add(`${entry}/${sub}`);
      } else {
        found.add(entry);
      }
    }
  } catch {
    // No npm tree (fresh install / hermetic home) — manifest list only.
  }
  return found;
}

function missingPaths(content: string, ctx?: AuditContext): string[] {
  const home = homeDir(ctx);
  const missing: string[] = [];
  for (const raw of content.match(PATH_TOKEN_RE) ?? []) {
    const p = raw.replace(/[.,;)]]+$/, "");
    if (p.includes("*")) continue;
    const abs = p.startsWith("~") ? path.join(home, p.slice(1)) : p;
    if (!existsSync(abs)) missing.push(p);
  }
  return missing;
}

function missingPackages(content: string, installed: Set<string>): string[] {
  const missing: string[] = [];
  for (const raw of content.match(PKG_TOKEN_RE) ?? []) {
    const name = raw.replace(/^npm:/, "");
    if (name.includes("/")) {
      if (!installed.has(name)) missing.push(name);
      continue;
    }
    // Bare pi-* name: accept scoped installed forms (@scope/pi-foo) too.
    let found = false;
    for (const have of installed) {
      if (have === name || have.endsWith(`/${name}`)) { found = true; break; }
    }
    if (!found) missing.push(name);
  }
  return missing;
}

export function auditItems(items: HarnessItem[], ctx?: AuditContext): AuditFinding[] {
  const installed = installedPackages(ctx);
  const findings: AuditFinding[] = [];
  for (const item of items) {
    if (!item.active) continue;
    const text = `${item.content}\n${item.evidence}`;
    for (const p of missingPaths(text, ctx)) {
      findings.push({ id: item.id, kind: item.kind, reason: "path-missing", detail: `${p} does not exist` });
    }
    for (const name of missingPackages(text, installed)) {
      findings.push({ id: item.id, kind: item.kind, reason: "package-absent", detail: `${name} not installed and not in the pi manifest` });
    }
  }
  return findings;
}

/** Conservative proposals: retire, never rewrite (content edits need judgment). */
export function proposedDeltas(findings: AuditFinding[]): Delta[] {
  const reasons = new Map<string, string[]>();
  for (const f of findings) {
    reasons.set(f.id, [...(reasons.get(f.id) ?? []), `audit: ${f.reason} — ${f.detail}`]);
  }
  return [...reasons.entries()].map(([id, rs]) => ({ op: "delete" as const, id, reason: rs.join("; ") }));
}
