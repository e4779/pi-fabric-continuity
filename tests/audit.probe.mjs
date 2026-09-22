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

// Project-local packages: cwd node_modules (+ parent for monorepos).
const projDir = home + "/proj-a";
mkdirSync(projDir + "/node_modules/@alrt/ui", { recursive: true });
mkdirSync(home + "/node_modules/@monorepo/shared", { recursive: true });
const projItems = [{ id: "c_proj", kind: "memory", active: true, content: "uses @alrt/ui and @monorepo/shared here", evidence: "", importance: 1, scope: "project", createdAt: 4, updatedAt: 4 }];
const withoutCwd = a.auditItems(projItems, { home });
const withCwd = a.auditItems(projItems, { home, cwd: projDir });
check("project-local package flagged without cwd", withoutCwd.some((f) => f.id === "c_proj" && f.reason === "package-absent"));
check("cwd node_modules clears the finding", !withCwd.some((f) => f.id === "c_proj"));
check("parent node_modules clears monorepo packages", Array.isArray(withCwd) && withCwd.length === 0);

// Typography tokens (@24/600) are not scoped packages.
const typo = a.auditItems([{ id: "c_typo", kind: "memory", active: true, content: "SB Sans Display @24/600 weight", evidence: "", importance: 1, scope: "project", createdAt: 5, updatedAt: 5 }], { home });
check("typography token not flagged", !typo.some((f) => f.reason === "package-absent"), JSON.stringify(typo));

// Migration provenance in evidence is history, not a dependency...
const prov = a.auditItems([{ id: "c_prov", kind: "memory", active: true, content: "record observations", evidence: "[migrated from pi-continual-harness] original note", importance: 1, scope: "project", createdAt: 6, updatedAt: 6 }], { home });
check("migrated-from marker not flagged", !prov.some((f) => f.reason === "package-absent"), JSON.stringify(prov));
// ...but a genuine claim in evidence still audits.
const real = a.auditItems([{ id: "c_real", kind: "memory", active: true, content: "record observations", evidence: "installed as npm:pi-nonexistent-here", importance: 1, scope: "project", createdAt: 7, updatedAt: 7 }], { home });
check("genuine evidence claim still flagged", real.some((f) => f.reason === "package-absent" && f.id === "c_real"));

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;