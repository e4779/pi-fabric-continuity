// /harness audit — deterministic staleness check of active items against the
// live machine. LLM-free by design: reality is checked, not guessed. The
// refine proposer stays the judgment layer; audit only supplies hard evidence
// and conservative retire proposals. Nothing applies without an explicit
// --apply — the journal remains the only writer of state.
//
// Two check classes, both conservative (only concrete, anchored tokens):
//   path-missing   — `~/…`, `/home/…`, `/Users/…` tokens that no longer
//                    exist on disk (globs, URLs and sentence punctuation are
//                    stripped before the check);
//   package-absent — `npm:@scope/name`, `@scope/name`, `pi-name` tokens
//                    absent from pi-visible installs (npm tree, git-sourced
//                    checkouts, global nvm tree) and the pi manifest. Bare
//                    `pi-*` prose mentions can still false-positive (e.g.
//                    "consider pi-goal") — findings are proposals for review,
//                    never silent deletes.

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
  /** Project root: its node_modules (and the parent's, for monorepos) count as installed. */
  cwd?: string;
  /** Package names considered installed (pi manifest entries). */
  manifestPackages?: string[];
}

const PATH_TOKEN_RE = /(?:~|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/[\w@./-]+/g;
const PKG_TOKEN_RE = /npm:[@a-z0-9][\w./-]*|@[a-z][\w.-]*\/[\w.-]+|\bpi-[a-z0-9][\w-]*\b/g;

export function homeDir(ctx?: AuditContext): string {
  return ctx?.home ?? os.homedir();
}

function tryReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Package names visible to pi: the npm-installed pi packages
 * (~/.pi/agent/npm/node_modules), git-sourced checkouts
 * (~/.pi/agent/git/<host>/<owner>/<repo>), the global nvm tree, plus any
 * manifest names handed in.
 */
export function installedPackages(ctx?: AuditContext): Set<string> {
  const found = new Set<string>(ctx?.manifestPackages ?? []);
  const home = homeDir(ctx);
  const scanFlat = (dir: string) => {
    for (const entry of tryReaddir(dir)) {
      if (entry.startsWith("@")) {
        for (const sub of tryReaddir(path.join(dir, entry))) found.add(`${entry}/${sub}`);
      } else {
        found.add(entry);
      }
    }
  };
  scanFlat(path.join(home, ".pi", "agent", "npm", "node_modules"));
  const gitRoot = path.join(home, ".pi", "agent", "git");
  for (const host of tryReaddir(gitRoot)) {
    for (const owner of tryReaddir(path.join(gitRoot, host))) {
      for (const repo of tryReaddir(path.join(gitRoot, host, owner))) found.add(repo);
    }
  }
  for (const version of tryReaddir(path.join(home, ".nvm", "versions", "node"))) {
    scanFlat(path.join(home, ".nvm", "versions", "node", version, "lib", "node_modules"));
  }
  // project-local installs: <cwd>/node_modules and <cwd>/../node_modules (monorepo)
  if (ctx?.cwd) {
    scanFlat(path.join(ctx.cwd, "node_modules"));
    scanFlat(path.join(ctx.cwd, "..", "node_modules"));
  }
  return found;
}

function missingPaths(content: string, ctx?: AuditContext): string[] {
  const home = homeDir(ctx);
  const missing: string[] = [];
  for (const raw of content.match(PATH_TOKEN_RE) ?? []) {
    const p = raw.replace(/[.,;:)\]]+$/, "");
    if (p.includes("*") || p.includes("..")) continue; // globs and typographic ellipsis in stored prose
    // "~/.pi/..." style real anchors carry a directory segment; short bare
    // "~/x" tokens are almost always documentation examples, not anchors.
    const rel = p.startsWith("~") ? p.slice(2) : null;
    if (rel !== null && !rel.includes("/") && rel.length <= 2) continue;
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
  const seen = new Set<string>();
  const push = (f: AuditFinding) => {
    const key = `${f.id}|\u0000${f.reason}|\u0000${f.detail}`;
    if (!seen.has(key)) { seen.add(key); findings.push(f); }
  };
  for (const item of items) {
    if (!item.active) continue;
    // Evidence is audited too (it can carry real claims), but migration
    // provenance markers ("[migrated from pi-continual-harness]") are history,
    // not dependencies — strip before matching.
    const evidence = item.evidence.replace(/\[[^\]]*migrated[^\]]*\]/gi, "");
    const text = `${item.content}\n${evidence}`;
    for (const p of missingPaths(text, ctx)) {
      push({ id: item.id, kind: item.kind, reason: "path-missing", detail: `${p} does not exist` });
    }
    for (const name of missingPackages(text, installed)) {
      push({ id: item.id, kind: item.kind, reason: "package-absent", detail: `${name} not installed and not in the pi manifest` });
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
