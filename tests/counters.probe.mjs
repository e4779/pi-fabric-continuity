// Behavioral probe for attribution counters (spec F1).
// Run: tsc -p tsconfig.build.json && node tests/counters.probe.mjs
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { probeHome, resetJournals } from "./hermetic.mjs";

const base = "/tmp/continuity-probe";
const jPath = [`${base}/src/journal.js`, `${base}/journal.js`].find((p) => existsSync(p));
const cPath = [`${base}/src/counters.js`, `${base}/counters.js`].find((p) => existsSync(p));
const iPath = [`${base}/src/inject.js`, `${base}/inject.js`].find((p) => existsSync(p));
if (!jPath || !cPath || !iPath) throw new Error("emitted modules not found; run tsc -p tsconfig.build.json first");
probeHome(); // must precede imports: journal.js/counters.js resolve ROOT from $HOME
const j = await import(jPath);
const counters = await import(cPath);
const inj = await import(iPath);

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

// --- v0.5: confirms (refine-proposer attribution; touches were removed —
// the main model never self-reported usage, the signal measured nothing).
await counters.recordConfirms(["c_a"]);
all = await counters.readCounters();
check("v0.5: confirm counted, injections preserved", all.c_a?.confirms === 1 && all.c_a?.injections === 2, JSON.stringify(all.c_a));
const created = await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [{ op: "create", kind: "prompt", content: "t", evidence: "e", id: "c_t" }] });
const targets = created.transitions.map((t) => t.target).filter(Boolean);
await counters.recordConfirms(targets);
all = await counters.readCounters();
check("v0.5: targeted id confirmed", targets.length === 1 && all.c_t?.confirms === 1, JSON.stringify({ targets, c_t: all.c_t }));

// --- Fixtures: journal items + counter records for decay/stats.
await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "decay me", evidence: "probe", id: "c_decay", importance: 0.8 },
  { op: "create", kind: "memory", content: "touched", evidence: "probe", id: "c_touched", importance: 0.8 },
  { op: "create", kind: "memory", content: "below", evidence: "probe", id: "c_below", importance: 0.8 },
  { op: "create", kind: "memory", content: "inactive", evidence: "probe", id: "c_inactive", importance: 0.8 },
  { op: "update", id: "c_inactive", active: false },
] });
writeFileSync(counters.countersPath(), JSON.stringify({ version: 1, counters: {
  c_decay: { injections: 20, confirms: 0, lastInjectedAt: 1690000000000 },
  c_touched: { injections: 25, confirms: 0 },
  c_below: { injections: 19, confirms: 0, touches: 3 }, // legacy field: must be ignored
  c_inactive: { injections: 40, confirms: 0 },
} }));
await counters.recordConfirms(["c_touched"]); // module write path preserves the crafted file

const snap = await j.currentSnapshot("project");
const cs = await counters.readCounters();
check("F1.5: crafted + module writes coexist", cs.c_decay?.injections === 20 && cs.c_touched?.confirms === 1, JSON.stringify(cs));
check("v0.5: legacy touches field ignored", cs.c_below?.confirms === 0 && !("touches" in (cs.c_below ?? {})), JSON.stringify(cs.c_below));

// --- F1.4: decay eligibility, threshold, evidence, journaling.
const props = counters.decayProposals(snap.items, cs, 20);
check("F1.4: exactly the zero-confirm over-threshold active item", props.length === 1 && props[0].id === "c_decay", JSON.stringify(props));
check("F1.4: importance decreases one tier", props[0]?.importance === 0.6, JSON.stringify(props[0]));
check("F1.4: counters cited as evidence", typeof props[0]?.evidence === "string" && props[0].evidence.includes("20 injections") && props[0].evidence.includes("0 confirms"), props[0]?.evidence);
check("F1.4: proposal validates against the journal", props.length === 1 && j.validateDelta(props[0]) === null);
check("F1.4: configurable threshold admits 19", counters.decayProposals([mk("c_below")], { c_below: { injections: 19, confirms: 0 } }, 19).length === 1);
check("F1.4: eligibility needs active + threshold + zero confirms",
  counters.isDecayEligible(mk("c_x"), { injections: 99, confirms: 0 }, 20) === true &&
  counters.isDecayEligible(mk("c_x", { active: false }), { injections: 99, confirms: 0 }, 20) === false &&
  counters.isDecayEligible(mk("c_x"), undefined, 20) === false &&
  counters.isDecayEligible(mk("c_x"), { injections: 99, confirms: 1 }, 20) === false);

// The proposal is journaled like every refine delta — no silent writes.
const dOut = await j.appendDeltas({ scope: "project", actor: "model:probe/probe-1", source: "refine", deltas: props, note: "attribution decay" });
check("F1.4: journaled as a refine transition", dOut.transitions.length === 1 && dOut.transitions[0].source === "refine" && dOut.transitions[0].note === "attribution decay", JSON.stringify(dOut.transitions[0]));
const after = await j.currentSnapshot("project");
check("F1.4: folded importance dropped", after.items.find((i) => i.id === "c_decay")?.importance === 0.6);

// --- F1.3: stats shape (pre-apply snapshot view).
const stats = counters.statsForItems(snap.items, cs, 20);
const shapeOk = ["c_decay", "c_touched", "c_below", "c_inactive"].every((id) => {
  const s = stats.find((x) => x.id === id);
  return s && typeof s.injections === "number" && typeof s.confirms === "number" && (s.lastInjectedAt === null || typeof s.lastInjectedAt === "number") && typeof s.decayEligible === "boolean";
});
check("F1.3: stats fields per item", shapeOk, JSON.stringify(stats));
check("F1.3: decay-eligible flagged", stats.find((s) => s.id === "c_decay")?.decayEligible === true);
check("F1.3: confirmed/below/inactive not flagged", stats.filter((s) => s.id !== "c_decay").every((s) => s.decayEligible === false), JSON.stringify(stats));
check("F1.3: unknown id reads as zeros", counters.statsForItems([mk("c_unknown")], {}, 20)[0].injections === 0);

// --- F1.3: stats view over freshly recorded injections (the /harness stats
// rendering went with the TUI surface in v0.4; continuity.stats reads the
// same statsForItems — kept honest here).
await counters.recordInjections(["c_stats_fresh"]);
const freshStats = counters.statsForItems(
  [{ id: "c_stats_fresh", kind: "memory", content: "x", evidence: "e", importance: 0.5, active: true, scope: "project", createdAt: 0, updatedAt: 0 }],
  await counters.readCounters(),
  20,
);
check("F1.3: recorded injection visible in stats", freshStats[0]?.injections === 1 && freshStats[0]?.decayEligible === false, JSON.stringify(freshStats[0]));

// --- F1.1 wiring: selection + render split, block unchanged.
const cfg = { enabled: true, maxTokens: 800, maxPerKind: 8, charsPerToken: 4 };
const items2 = [mk("c_w1", { kind: "prompt", content: "wire one", importance: 0.9 }), mk("c_w2", { kind: "prompt", content: "wire two", importance: 0.1 })];
const sel = inj.selectForInjection(items2, undefined, cfg);
check("wiring: renderSelectedBlock == renderContinuityBlock", inj.renderSelectedBlock(sel.selected, sel.omitted) === inj.renderContinuityBlock(items2, undefined, cfg));

// --- F1.5: persistence across a restart — a fresh process reads the file.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const runP = promisify(execFile);
const script = `const c = await import(${JSON.stringify(cPath)}); const all = await c.readCounters(); if (all.c_decay?.injections !== 20 || all.c_touched?.confirms !== 1) throw new Error("counters lost: " + JSON.stringify(all)); console.log("ok");`;
const child = await runP("node", ["--input-type=module", "-e", script]);
check("F1.5: fresh process reads persisted counters", String(child.stdout).includes("ok"), String(child.stderr).slice(0, 200));

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
