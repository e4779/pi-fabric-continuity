// F4.1 — self-verifying notes: run each item's evidenceCmds, fail-closed,
// journal the outcome as certify deltas. Semantics follow fabric's state-layer
// (docs/state-layer.md): evidence commands run with the invoking process's
// authority; any non-zero exit, timeout, or spawn failure is `violated`; the
// digest is a deterministic sha256 over command outcomes. The journal stays
// the single authority — meshEvents are an OPTIONAL guest-side mirror payload
// (the provider seam is one-way: fabric calls us, we cannot call mesh).

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.js";
import { appendDeltas, currentSnapshot } from "./journal.js";
import type { CertStatus, ComponentKind, Delta, Scope } from "./types.js";

export interface CertifyItemResult {
  id: string;
  kind: ComponentKind;
  status: CertStatus | "skipped";
  commands: number;
  digest?: string;
  error?: string;
  durationMs: number;
}

export interface CertifyMeshEvent {
  topic: "continuity.certification";
  kind: CertStatus;
  data: { id: string; status: CertStatus; at: number; digest?: string };
}

export interface CertifyOutcome {
  results: CertifyItemResult[];
  applied: number;
  version: number;
  meshEvents: CertifyMeshEvent[];
}

interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

function runCommand(cmd: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | undefined;
      const code = err ? (typeof err.code === "number" ? err.code : err.killed ? 124 : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: err ? err.message : undefined });
    });
  });
}

export async function certifyItems(opts: {
  scope: Scope;
  cwd?: string;
  actor?: string;
  timeoutMs?: number;
}): Promise<CertifyOutcome> {
  const actor = opts.actor ?? "command:harness";
  const config = await loadConfig();
  const timeoutMs = opts.timeoutMs ?? config.certify.timeoutMs;
  const snap = await currentSnapshot(opts.scope, opts.cwd);
  const results: CertifyItemResult[] = [];
  const deltas: Delta[] = [];
  const now = Date.now();
  for (const it of snap.items) {
    if (!it.active) continue;
    const cmds = it.evidenceCmds ?? [];
    if (cmds.length === 0) {
      results.push({ id: it.id, kind: it.kind, status: "skipped", commands: 0, durationMs: 0 });
      continue;
    }
    const started = Date.now();
    const hash = createHash("sha256");
    let ok = true;
    const errors: string[] = [];
    for (const c of cmds) {
      const r = await runCommand(c, timeoutMs);
      hash.update(`${r.code}\n${r.stdout}\n${r.stderr}\n`);
      if (r.code !== 0) {
        ok = false;
        errors.push(
          `${c.slice(0, 80)} -> exit ${r.code}${r.error ? ` (${r.error.slice(0, 120)})` : ""}${r.stderr ? `: ${r.stderr.trim().slice(0, 120)}` : ""}`,
        );
      }
    }
    const digest = `sha256:${hash.digest("hex")}`;
    const status: CertStatus = ok ? "certified" : "violated";
    deltas.push({ op: "certify", id: it.id, status, digest });
    results.push({
      id: it.id,
      kind: it.kind,
      status,
      commands: cmds.length,
      digest,
      error: errors.length > 0 ? errors.join("; ") : undefined,
      durationMs: Date.now() - started,
    });
  }
  let applied = 0;
  let version = snap.version;
  if (deltas.length > 0) {
    const out = await appendDeltas({ scope: opts.scope, cwd: opts.cwd, actor, source: "manual", deltas });
    applied = out.transitions.length;
    version = out.snapshot.version;
  }
  const meshEvents: CertifyMeshEvent[] = results
    .filter((r): r is CertifyItemResult & { status: CertStatus } => r.status === "certified" || r.status === "violated")
    .map((r) => ({
      topic: "continuity.certification",
      kind: r.status,
      data: { id: r.id, status: r.status, at: now, ...(r.digest ? { digest: r.digest } : {}) },
    }));
  return { results, applied, version, meshEvents };
}
