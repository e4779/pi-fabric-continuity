// Shared probe hygiene: every probe owns its HOME.
//
// Correctness: journals are reset BEFORE the assertions run. Cleaning only
// after breaks the moment a run crashes or is interrupted mid-way — the next
// run inherits poisoned state and fails confusingly (e.g. "version 2 :: got
// 78"). Before-reset makes every run hermetic regardless of history;
// after-clean is just hygiene and is best-effort only.
//
// Safety: a bare `node tests/x.probe.mjs` (no HOME= override) must never
// touch real journals. When HOME is unset or still the real home (taken from
// the password database, immune to $HOME), the probe provisions a throwaway
// mkdtemp home instead. An explicit HOME= override is honored and reset in
// place, so the documented recipe stays reproducible.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export function probeHome() {
  const real = userInfo().homedir;
  if (process.env.HOME && process.env.HOME !== real) return process.env.HOME;
  const fresh = mkdtempSync(join(tmpdir(), "continuity-probe-home-"));
  process.env.HOME = fresh; // journal.js resolves ROOT at import time
  process.on("exit", () => rmSync(fresh, { recursive: true, force: true }));
  return fresh;
}

export function resetJournals(j, combos) {
  const real = userInfo().homedir;
  for (const [scope, cwd] of combos) {
    const p = j.journalPath(scope, cwd);
    if (p === real || p.startsWith(real + "/")) {
      throw new Error(`refusing to reset a real journal: ${p}`);
    }
    rmSync(p, { force: true });
  }
}
