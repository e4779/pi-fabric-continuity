// Behavioral probes for the v0.6 journal facade over the note store.
// Run: tsc -p tsconfig.build.json && node tests/journal.probe.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { probeHome, resetJournals } from "./hermetic.mjs";

const candidates = ["/tmp/continuity-probe/src/journal.js", "/tmp/continuity-probe/journal.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted journal.js not found");
probeHome(); // before import: paths resolve from $HOME
const j = await import(found);

const results = [];
function check(name, cond, detail = "") {
  results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + detail));
}
const cwd = "/tmp/continuity-probe-journal-cwd";
resetJournals(j, [["project", cwd], ["global", cwd]]);

// create -> notes-backed snapshot
const out1 = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "first fact", evidence: "e1", importance: 0.7 },
] });
check("append: create returns transition + snapshot", out1.transitions.length === 1 && typeof out1.snapshot.digest8 === "string" && out1.snapshot.digest8.length === 8 && out1.snapshot.fileCount === 1, JSON.stringify(out1.snapshot));
const id1 = out1.transitions[0].target;
check("append: create allocates a persisted id", typeof id1 === "string" && id1.startsWith("c_"), String(id1));

// id stability across folds (the v0.5 regenerated-id pain class)
const snap1 = await j.currentSnapshot("project", cwd);
check("fold: id stable across reads", snap1.items.length === 1 && snap1.items[0].id === id1);
check("fold: digest stable across reads", snap1.digest8 === out1.snapshot.digest8);

// update lands as a pinned note
const out2 = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "update", id: id1, content: "first fact v2" },
] });
const snap2 = await j.currentSnapshot("project", cwd);
check("append: pinned update applies", snap2.items[0].content === "first fact v2" && snap2.digest8 !== snap1.digest8, snap2.items[0] && snap2.items[0].content);

// history carries fold-order versions
const hist = await j.history("project", cwd, 10);
check("history: versions are fold positions", hist.length === 2 && hist[0].version === 1 && hist[1].version === 2, JSON.stringify(hist.map((h) => h.version)));

// move preserves the id across scopes
const mv = await j.moveItem({ cwd, id: id1, to: "global", actor: "probe" });
const gSnap = await j.currentSnapshot("global", cwd);
const pSnap = await j.currentSnapshot("project", cwd);
check("move: id preserved, scopes swapped", mv.moved === true && gSnap.items.some((i) => i.id === id1) && !pSnap.items.some((i) => i.id === id1));

// revert: undo the move's create in global
const rv = await j.revertItems({ scope: "global", cwd, ids: [id1], actor: "probe" });
const gSnap2 = await j.currentSnapshot("global", cwd);
check("revert: undo create removes item", rv.transitions.length >= 1 && !gSnap2.items.some((i) => i.id === id1), "applied=" + rv.transitions.length);

// revert a delete: create -> delete -> revert restores
const out3 = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "prompt", content: "temp", evidence: "e" },
] });
const id3 = out3.transitions[0].target;
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "delete", id: id3, reason: "probe delete" },
] });
await j.revertItems({ scope: "project", cwd, ids: [id3], actor: "probe" });
const snap3 = await j.currentSnapshot("project", cwd);
check("revert: undo delete restores item", snap3.items.some((i) => i.id === id3 && i.content === "temp"));

// legacy JSONL: auto-migrated on first open, marker blocks sneaked re-runs
const cwd2 = "/tmp/continuity-probe-mig-cwd";
resetJournals(j, [["project", cwd2]]);
const home = process.env.HOME;
const legacyPath = j.journalPath("project", cwd2);
mkdirSync(legacyPath.split("/").slice(0, -1).join("/"), { recursive: true });
const line = (v, t, delta, target) => JSON.stringify({ version: v, ts: t, actor: "legacy", source: "manual", delta, ...(target ? { target } : {}) });
writeFileSync(legacyPath, [
  line(1, 1793000000000, { op: "create", kind: "memory", content: "legacy fact", evidence: "le" }, "c_leg_x"),
  line(2, 1793000000001, { op: "update", id: "c_leg_x", importance: 0.9 }),
].join("\n") + "\n");
const migSnap = await j.currentSnapshot("project", cwd2);
check("migrate: legacy auto-splits on first open", migSnap.items.length === 1 && migSnap.items[0].id === "c_leg_x" && migSnap.items[0].importance === 0.9, JSON.stringify(migSnap.items.map((i) => [i.id, i.importance])));
check("migrate: original renamed, marker machine-local", !existsSync(legacyPath) && existsSync(home + "/.pi/agent/continuity/.migrated-p-continuity-probe-mig-cwd"));
const before = (await j.currentSnapshot("project", cwd2)).digest8;
writeFileSync(legacyPath, line(3, 1793000000002, { op: "create", kind: "prompt", content: "sneak", evidence: "e" }, "c_sneak") + "\n");
const after = (await j.currentSnapshot("project", cwd2)).digest8;
check("migrate: marker blocks re-migration of sneaked legacy", before === after);

// store.dir config routes the store (dynamic resolution, no restart)
writeFileSync(home + "/.pi/agent/continuity/config.json", JSON.stringify({ store: { dir: home + "/alt-store" } }));
const outAlt = await j.appendDeltas({ scope: "global", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "skill", content: "alt store", evidence: "e" },
] });
check("store.dir: notes land in the configured root", outAlt.snapshot.fileCount >= 1 && existsSync(home + "/alt-store/global"));
writeFileSync(home + "/.pi/agent/continuity/config.json", "{}");

const fails = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log((results.length - fails.length) + "/" + results.length + " passed");
process.exit(fails.length ? 1 : 0);
