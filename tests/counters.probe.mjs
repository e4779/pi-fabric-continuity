// Behavioral probe for attribution counters (spec F1).
// Run: tsc -p tsconfig.build.json && node tests/counters.probe.mjs
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { probeHome, resetJournals } from "./hermetic.mjs";

const base = "/tmp/continuity-probe";
const jPath = [`${base}/src/journal.js`, `${base}/journal.js`].find((p) => existsSync(p));
const cPath = [`${base}/src/counters.js`, `${base}/counters.js`].find((p) => existsSync(p));
const iPath = [`${base}/src/inject.js`, `${base}/inject.js`].find((p) => existsSync(p));
const cmdPath = [`${base}/src/commands.js`, `${base}/commands.js`].find((p) => existsSync(p));
if (!jPath || !cPath || !iPath || !cmdPath) throw new Error("emitted modules not found; run tsc -p tsconfig.build.json first");
probeHome(); // must precede imports: journal.js/counters.js resolve ROOT from $HOME
const j = await import(jPath);
const counters = await import(cPath);
const inj = await import(iPath);
const commands = await import(cmdPath);

// Hermetic baseline: journals and the counters cache start clean.
resetJournals(j, [["project", undefined], ["global", undefined], ["project", "/tmp/continuity-probe-stats-cwd"]]);
rmSync(counters.countersPath(), { force: true });

const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
const mk = (id, extra = {}) => ({ id, kind: "memory", content: "content-" + id, evidence: "", importance: 0.6, active: true, scope: "project", createdAt: 1, updatedAt: 1, ...extra });

// --- F1.1: injections increment per item, lastInjectedAt recorded.
await counters.recordInjections(["c_a", "c_b"]);
await counters.recordInjections(["c_a"], 1690000000001);
let all = await counters.readCounters();
check("F1.1: per-item injection counts", all.c_a?.injections === 2 && all.c_b?.injections === 1, JSON.stringify(all));
check("F1.1: lastInjectedAt recorded", all.c_a?.lastInjectedAt === 1690000000001, JSON.stringify(all.c_a));

// --- F1.2: touches (keep path + mutate transition targets).
await counters.recordTouches(["c_a"]);
all = await counters.readCounters();
check("F1.2: touch counted, injections preserved", all.c_a?.touches === 1 && all.c_a?.injections === 2, JSON.stringify(all.c_a));
const created = await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [{ op: "create", kind: "prompt", content: "t", evidence: "e", id: "c_t" }] });
const targets = created.transitions.map((t) => t.target).filter(Boolean);
await counters.recordTouches(targets);
all = await counters.readCounters();
check("F1.2: mutate transition target touched", targets.length === 1 && all.c_t?.touches === 1, JSON.stringify({ targets, c_t: all.c_t }));

// --- Fixtures: journal items + counter records for decay/stats.
await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "decay me", evidence: "probe", id: "c_decay", importance: 0.8 },
  { op: "create", kind: "memory", content: "touched", evidence: "probe", id: "c_touched", importance: 0.8 },
  { op: "create", kind: "memory", content: "below", evidence: "probe", id: "c_below", importance: 0.8 },
  { op: "create", kind: "memory", content: "inactive", evidence: "probe", id: "c_inactive", importance: 0.8 },
  { op: "update", id: "c_inactive", active: false },
] });
writeFileSync(counters.countersPath(), JSON.stringify({ version: 1, counters: {
  c_decay: { injections: 20, touches: 0, lastInjectedAt: 1690000000000 },
  c_touched: { injections: 25, touches: 0 },
  c_below: { injections: 19, touches: 0 },
  c_inactive: { injections: 40, touches: 0 },
} }));
await counters.recordTouches(["c_touched"]); // module write path preserves the crafted file

const snap = await j.currentSnapshot("project");
const cs = await counters.readCounters();
check("F1.5: crafted + module writes coexist", cs.c_decay?.injections === 20 && cs.c_touched?.touches === 1, JSON.stringify(cs));

// --- F1.4: decay eligibility, threshold, evidence, journaling.
const props = counters.decayProposals(snap.items, cs, 20);
check("F1.4: exactly the zero-touch over-threshold active item", props.length === 1 && props[0].id === "c_decay", JSON.stringify(props));
check("F1.4: importance decreases one tier", props[0]?.importance === 0.6, JSON.stringify(props[0]));
check("F1.4: counters cited as evidence", typeof props[0]?.evidence === "string" && props[0].evidence.includes("20 injections") && props[0].evidence.includes("0 touches"), props[0]?.evidence);
check("F1.4: proposal validates against the journal", props.length === 1 && j.validateDelta(props[0]) === null);
check("F1.4: configurable threshold admits 19", counters.decayProposals([mk("c_below")], { c_below: { injections: 19, touches: 0 } }, 19).length === 1);
check("F1.4: eligibility needs active + threshold + zero touches",
  counters.isDecayEligible(mk("c_x"), { injections: 99, touches: 0 }, 20) === true &&
  counters.isDecayEligible(mk("c_x", { active: false }), { injections: 99, touches: 0 }, 20) === false &&
  counters.isDecayEligible(mk("c_x"), undefined, 20) === false);

// The proposal is journaled like every refine delta — no silent writes.
const dOut = await j.appendDeltas({ scope: "project", actor: "model:probe/probe-1", source: "refine", deltas: props, note: "attribution decay" });
check("F1.4: journaled as a refine transition", dOut.transitions.length === 1 && dOut.transitions[0].source === "refine" && dOut.transitions[0].note === "attribution decay", JSON.stringify(dOut.transitions[0]));
const after = await j.currentSnapshot("project");
check("F1.4: folded importance dropped", after.items.find((i) => i.id === "c_decay")?.importance === 0.6);

// --- F1.3: stats shape (pre-apply snapshot view).
const stats = counters.statsForItems(snap.items, cs, 20);
const shapeOk = ["c_decay", "c_touched", "c_below", "c_inactive"].every((id) => {
  const s = stats.find((x) => x.id === id);
  return s && typeof s.injections === "number" && typeof s.touches === "number" && (s.lastInjectedAt === null || typeof s.lastInjectedAt === "number") && typeof s.decayEligible === "boolean";
});
check("F1.3: stats fields per item", shapeOk, JSON.stringify(stats));
check("F1.3: decay-eligible flagged", stats.find((s) => s.id === "c_decay")?.decayEligible === true);
check("F1.3: touched/below/inactive not flagged", stats.filter((s) => s.id !== "c_decay").every((s) => s.decayEligible === false), JSON.stringify(stats));
check("F1.3: unknown id reads as zeros", counters.statsForItems([mk("c_unknown")], {}, 20)[0].injections === 0);

// --- F1.3: /harness stats renders the same for the human.
let registered = null;
commands.registerHarnessCommand({ registerCommand: (name, opts) => { if (name === "harness") registered = opts; } });
const statsCwd = "/tmp/continuity-probe-stats-cwd";
await j.appendDeltas({ scope: "project", cwd: statsCwd, actor: "probe", source: "manual", deltas: [{ op: "create", kind: "memory", content: "stats item", evidence: "probe", id: "c_stats" }] });
for (let i = 0; i < 20; i++) await counters.recordInjections(["c_stats"]);
const captured = [];
const fakeCtx = { sessionManager: { getCwd: () => statsCwd }, ui: { notify: async (msg) => captured.push(String(msg)) } };
await registered.handler("stats", fakeCtx);
const rendered = captured.join("\n");
check("F1.3: /harness stats renders counters", rendered.includes("c_stats") && /inj 20 touch 0/.test(rendered), rendered.slice(0, 400));
check("F1.3: /harness stats flags decay candidate", rendered.includes("decay candidate"), rendered.slice(0, 400));

// --- F1.1 wiring: selection + render split, block unchanged.
const cfg = { enabled: true, maxTokens: 800, maxPerKind: 8, charsPerToken: 4 };
const items2 = [mk("c_w1", { kind: "prompt", content: "wire one", importance: 0.9 }), mk("c_w2", { kind: "prompt", content: "wire two", importance: 0.1 })];
const sel = inj.selectForInjection(items2, undefined, cfg);
check("wiring: renderSelectedBlock == renderContinuityBlock", inj.renderSelectedBlock(sel.selected, sel.omitted) === inj.renderContinuityBlock(items2, undefined, cfg));

// --- F1.5: persistence across a restart — a fresh process reads the file.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const runP = promisify(execFile);
const script = `const c = await import(${JSON.stringify(cPath)}); const all = await c.readCounters(); if (all.c_decay?.injections !== 20 || all.c_touched?.touches !== 1) throw new Error("counters lost: " + JSON.stringify(all)); console.log("ok");`;
const child = await runP("node", ["--input-type=module", "-e", script]);
check("F1.5: fresh process reads persisted counters", String(child.stdout).includes("ok"), String(child.stderr).slice(0, 200));

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
