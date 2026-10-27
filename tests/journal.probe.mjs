// Behavioral probes for the v0.6 journal facade over the note store.
// Run: tsc -p tsconfig.build.json && node tests/journal.probe.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
const markers = readdirSync(home + "/.pi/agent/continuity").filter((n) => n.startsWith(".migrated-p-continuity-probe-mig-cwd"));
check("migrate: original renamed, marker keyed by store root", !existsSync(legacyPath) && markers.length >= 1, markers.join(","));
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

// pending sentinel: updates to not-yet-arrived ids never cross-SKIP (review phase-2/1)
{
  const cwd3 = "/tmp/continuity-probe-pending-cwd";
  resetJournals(j, [["project", cwd3]]);
  await j.appendDeltas({ scope: "project", cwd: cwd3, actor: "probe", source: "manual", deltas: [
    { op: "update", id: "c_pa", content: "A2" },
    { op: "update", id: "c_pb", content: "B2" },
  ] });
  await j.appendDeltas({ scope: "project", cwd: cwd3, actor: "probe", source: "manual", deltas: [
    { op: "create", kind: "memory", content: "A1", evidence: "e", id: "c_pa" },
    { op: "create", kind: "memory", content: "B1", evidence: "e", id: "c_pb" },
  ] });
  const fp = await j.currentSnapshot("project", cwd3);
  const a = fp.items.find((i) => i.id === "c_pa");
  const b = fp.items.find((i) => i.id === "c_pb");
  check("pending: updates to unknown ids apply when parents arrive", a !== undefined && a.content === "A2" && b !== undefined && b.content === "B2", JSON.stringify(fp.items.map((i) => [i.id, i.content])));
}

// same-batch sequential updates form a CHAIN, not a fork (review phase-2/2)
{
  const cwd4 = "/tmp/continuity-probe-chain-cwd";
  resetJournals(j, [["project", cwd4]]);
  const o4 = await j.appendDeltas({ scope: "project", cwd: cwd4, actor: "probe", source: "manual", deltas: [
    { op: "create", kind: "memory", content: "v0", evidence: "e" },
  ] });
  const cid = o4.transitions[0].target;
  await j.appendDeltas({ scope: "project", cwd: cwd4, actor: "probe", source: "manual", deltas: [
    { op: "update", id: cid, content: "v1" },
    { op: "update", id: cid, content: "v2" },
  ] });
  const fc = await j.currentSnapshot("project", cwd4);
  check("batch: sequential updates chain (no lost update)", fc.items.length === 1 && fc.items[0].content === "v2", "content=" + (fc.items[0] && fc.items[0].content));
}

// revert of certify restores the previous status (review phase-2/3)
{
  const cwd5 = "/tmp/continuity-probe-cert-cwd";
  resetJournals(j, [["project", cwd5]]);
  const o5 = await j.appendDeltas({ scope: "project", cwd: cwd5, actor: "probe", source: "manual", deltas: [
    { op: "create", kind: "memory", content: "certme", evidence: "e" },
  ] });
  const id5 = o5.transitions[0].target;
  await j.appendDeltas({ scope: "project", cwd: cwd5, actor: "probe", source: "manual", deltas: [{ op: "certify", id: id5, status: "certified" }] });
  await j.appendDeltas({ scope: "project", cwd: cwd5, actor: "probe", source: "manual", deltas: [{ op: "certify", id: id5, status: "violated" }] });
  const r5 = await j.revertItems({ scope: "project", cwd: cwd5, ids: [id5], actor: "probe" });
  const f5 = await j.currentSnapshot("project", cwd5);
  check("revert: certify undo restores previous status", r5.results[0] !== undefined && r5.results[0].applied === true && f5.items[0].cert !== undefined && f5.items[0].cert.status === "certified", JSON.stringify(f5.items[0] && f5.items[0].cert));
}

// move preserves evidenceCmds (review phase-2/4)
{
  const cwd6 = "/tmp/continuity-probe-mv-cwd";
  resetJournals(j, [["project", cwd6], ["global", cwd6]]);
  const o6 = await j.appendDeltas({ scope: "project", cwd: cwd6, actor: "probe", source: "manual", deltas: [
    { op: "create", kind: "memory", content: "mv", evidence: "e", evidenceCmds: ["echo ok"] },
  ] });
  const id6 = o6.transitions[0].target;
  await j.moveItem({ cwd: cwd6, id: id6, to: "global", actor: "probe" });
  const f6 = await j.currentSnapshot("global", cwd6);
  check("move: evidenceCmds survive", f6.items.some((i) => i.id === id6 && Array.isArray(i.evidenceCmds) && i.evidenceCmds[0] === "echo ok"));
}

const fails = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log((results.length - fails.length) + "/" + results.length + " passed");
process.exit(fails.length ? 1 : 0);
