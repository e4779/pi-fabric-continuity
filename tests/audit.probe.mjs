// Behavioral probe for the deterministic reality audit.
// Run: tsc -p tsconfig.build.json && node tests/audit.probe.mjs
import { existsSync, mkdirSync } from "node:fs";
import { probeHome } from "./hermetic.mjs";

const candidates = ["/tmp/continuity-probe/src/audit.js", "/tmp/continuity-probe/audit.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted audit.js not found; run tsc -p tsconfig.build.json first");
probeHome(); // audit.js resolves package discovery from $HOME
const home = process.env.HOME;
const a = await import(found);

// Fixtures: one installed scoped package, one real dir — everything else missing.
mkdirSync(home + "/.pi/agent/npm/node_modules/@monotykamary/pi-vcc", { recursive: true });
mkdirSync(home + "/real-dir", { recursive: true });

const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);

const items = [
  { id: "c_ok", kind: "memory", active: true, content: "check ~/real-dir before deploys; vcc lives at npm:@monotykamary/pi-vcc", evidence: "", importance: 1, scope: "project", createdAt: 1, updatedAt: 1 },
  { id: "c_stale", kind: "memory", active: true, content: "dumps wait in ~/.pi/agent/cache/pi-context-guard/ — read via pi.read; installed as npm:pi-context-guard", evidence: "", importance: 1, scope: "project", createdAt: 2, updatedAt: 2 },
  { id: "c_off", kind: "prompt", active: false, content: "~/definitely-gone-path", evidence: "", importance: 1, scope: "project", createdAt: 3, updatedAt: 3 },
];

const findings = a.auditItems(items, { home });
check("clean item: no findings", !findings.some((f) => f.id === "c_ok"), JSON.stringify(findings));
check("missing path flagged", findings.some((f) => f.id === "c_stale" && f.reason === "path-missing" && f.detail.includes("pi-context-guard")));
check("absent package flagged", findings.some((f) => f.id === "c_stale" && f.reason === "package-absent" && f.detail.includes("pi-context-guard")));
check("inactive items skipped", !findings.some((f) => f.id === "c_off"));

const deltas = a.proposedDeltas(findings);
check("one consolidated retire per item", deltas.length === 1 && deltas[0].op === "delete" && deltas[0].id === "c_stale" && deltas[0].reason.includes("path-missing") && deltas[0].reason.includes("package-absent"));

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;