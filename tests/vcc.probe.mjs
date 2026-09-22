// Behavioral probes for F2 — vcc evidence for refine (spec F2.1–F2.4).
// Run: tsc -p tsconfig.build.json && node tests/vcc.probe.mjs
//
// pi-vcc is intentionally NOT assumed to be resolvable from the build dir:
// the un-injected collection below is deterministic either way — an absent
// package fails the import, and a resolvable one still throws inside execute
// (no session context) — both read as the silent fallback of F2.3.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { probeHome } from "./hermetic.mjs";

const base = "/tmp/continuity-probe";
const mod = (n) => {
  const p = [`${base}/src/${n}.js`, `${base}/${n}.js`].find((x) => existsSync(x));
  if (!p) throw new Error(`emitted ${n}.js not found; run tsc -p tsconfig.build.json first`);
  return p;
};
const home = probeHome(); // config loader resolves ~/.pi/agent/continuity from $HOME
const c = await import(mod("refine-core"));
const v = await import(mod("vcc"));
const cfg = await import(mod("config"));

const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);

// --- F2.1: config flag, default false.
const cfgDir = `${home}/.pi/agent/continuity`;
mkdirSync(cfgDir, { recursive: true });
const writeCfg = (obj) => writeFileSync(`${cfgDir}/config.json`, JSON.stringify(obj), "utf8");
check("F2.1: DEFAULT_CONFIG.vccEvidence is false", cfg.DEFAULT_CONFIG.vccEvidence === false);
rmSync(`${cfgDir}/config.json`, { force: true });
check("F2.1: missing config file -> false", (await cfg.loadConfig()).vccEvidence === false);
writeCfg({ autoRefine: { enabled: true, everyTurns: 10 } });
let lc = await cfg.loadConfig();
check("F2.1: absent key -> false", lc.vccEvidence === false && lc.autoRefine.enabled === true);
writeCfg({ autoRefine: { enabled: true, everyTurns: 10 }, vccEvidence: true });
lc = await cfg.loadConfig();
check("F2.1: true -> true, other fields intact", lc.vccEvidence === true && lc.autoRefine.everyTurns === 10 && lc.decayAfterInjections === cfg.DEFAULT_DECAY_AFTER_INJECTIONS);
writeCfg({ autoRefine: { enabled: true, everyTurns: 10 }, vccEvidence: "yes" });
check("F2.1: non-boolean value -> false", (await cfg.loadConfig()).vccEvidence === false);

// --- vccSection: labeled (F2.4) + capped (F2.2).
const H = c.VCC_SECTION_HEADER;
check("F2.4: section is header + text", c.vccSection("some recall text") === `${H}\nsome recall text`);
check("F2.4: empty/blank/undefined -> no section", c.vccSection("") === "" && c.vccSection("   ") === "" && c.vccSection(undefined) === "" && c.vccSection(null) === "");
const capped = c.vccSection("x".repeat(5000));
check("F2.2: over-cap text truncated to ~2k chars", capped.length === (H + "\n").length + c.VCC_EVIDENCE_CHARS + 2 && capped.endsWith(" …"));
const exact = c.vccSection("x".repeat(c.VCC_EVIDENCE_CHARS));
check("F2.2: at-cap text not truncated", exact.length === (H + "\n").length + c.VCC_EVIDENCE_CHARS && !exact.includes("…"));

// --- projectQueries: project-relevant query seeds from cwd.
check("F2.2: query from cwd basename", JSON.stringify(c.projectQueries("/home/u/projects/pi-fabric-continuity")) === JSON.stringify(["pi-fabric-continuity"]));
check("F2.2: trailing slash tolerated", JSON.stringify(c.projectQueries("/tmp/proj/")) === JSON.stringify(["proj"]));
check("F2.2: empty cwd -> no queries", JSON.stringify(c.projectQueries("")) === JSON.stringify([]));

// --- buildUserText: provenance visible as a labeled section (F2.4).
const items = [{ id: "c_1", kind: "prompt", content: "note", evidence: "e", importance: 0.7, active: true, scope: "project", createdAt: 1, updatedAt: 1 }];
const withVcc = c.buildUserText(items, "user: hi", undefined, undefined, "recall hit: deploy discipline");
check("F2.4: vcc section labeled in proposer user text", withVcc.includes(H) && withVcc.includes("recall hit: deploy discipline"));
check("F2.4: section sits after evidence, before the instruction", withVcc.indexOf("user: hi") < withVcc.indexOf(H) && withVcc.indexOf(H) < withVcc.indexOf("Propose deltas"));
check("F2.4: no vcc section when absent", !c.buildUserText(items, "user: hi").includes(H));
check("F2.4: no vcc section when empty", !c.buildUserText(items, "user: hi", undefined, undefined, "").includes(H));

// --- collectVccEvidence orchestration.
// F2.1 gate: flag off -> collector never invoked.
let calls = 0;
const spy = async (a) => { calls += 1; return `out(${a.query}) scope=${a.scope}`; };
const disabled = await v.collectVccEvidence({ enabled: false, cwd: "/home/u/proj", recall: spy });
check("F2.1: disabled flag short-circuits collection", disabled === undefined && calls === 0);

// F2.2 happy path: project query, scope all, prefixed provenance.
const out = await v.collectVccEvidence({ enabled: true, cwd: "/home/u/proj/pi-fabric-continuity", recall: spy });
check("F2.2: collects for project query with scope all", calls === 1 && out === `query "pi-fabric-continuity":\nout(pi-fabric-continuity) scope=all`);

// Whitespace-only output reads as nothing.
check("F2.2: empty recall output -> undefined", (await v.collectVccEvidence({ enabled: true, cwd: "/home/u/proj", recall: async () => "   " })) === undefined);

// F2.3: a failing call is a silent fallback, never an error.
const boom = async () => { throw new Error("vcc exploded"); };
let threw = false;
let res;
try { res = await v.collectVccEvidence({ enabled: true, cwd: "/home/u/proj", recall: boom }); } catch { threw = true; }
check("F2.3: failing recall -> undefined without throwing", threw === false && res === undefined);

// F2.3: absent/unloadable pi-vcc (no recall injected) -> silent undefined.
threw = false;
try { res = await v.collectVccEvidence({ enabled: true, cwd: "/home/u/proj" }); } catch { threw = true; }
check("F2.3: absent pi-vcc -> silent fallback, no throw", threw === false && res === undefined);

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
