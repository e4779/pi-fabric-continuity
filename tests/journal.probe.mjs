// Behavioral probes for the continuity journal (no test framework needed).
// Run: tsc -p tsconfig.build.json && HOME=/tmp/fakehome node tests/journal.probe.mjs
import { appendFileSync, readFileSync, existsSync } from "node:fs";

const candidates = ["/tmp/continuity-probe/src/journal.js", "/tmp/continuity-probe/journal.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted journal.js not found; run tsc -p tsconfig.build.json first");
const j = await import(found);

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}

const cwd = "/tmp/fakehome/proj";

// 1) validation rejects incomplete deltas
check("validate: empty content rejected", j.validateDelta({ op: "create", kind: "prompt", content: "", evidence: "x" }) !== null);
check("validate: delete without reason rejected", j.validateDelta({ op: "delete", id: "c_x" }) !== null);
check("validate: good create passes", j.validateDelta({ op: "create", kind: "memory", content: "always run rg before cat", evidence: "trajectory turn 3" }) === null);

// 2) create batch
const created = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "prompt", content: "verify edits with targeted probes", evidence: "turn 5 fix" },
  { op: "create", kind: "memory", content: "prefer TOON over JSON", evidence: "turn 7", importance: 0.9 },
] });
check("create: version 2", created.snapshot.version === 2, `got ${created.snapshot.version}`);
check("create: two items", created.snapshot.items.length === 2);
const memId = created.snapshot.items.find((i) => i.kind === "memory").id;
check("create: ids server-generated", /^c_/.test(memId));

// 2b) ids must be stable across independent folds
const refold = await j.currentSnapshot("project", cwd);
check("fold: ids stable across refolds", refold.items.length === 2 && refold.items.every((i) => created.snapshot.items.some((c) => c.id === i.id)));

// 3) update + fresh fold
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "update", id: memId, importance: 0.95, active: false },
] });
const snap = await j.currentSnapshot("project", cwd);
const mem = snap.items.find((i) => i.id === memId);
check("update: importance applied", mem && mem.importance === 0.95, JSON.stringify(mem));
check("update: active toggled", mem && mem.active === false);
check("fold: version 3", snap.version === 3);

// 4) history order + target stamping
const h = await j.history("project", cwd, 2);
check("history: newest first", h[0].version === 3 && h[1].version === 2);
check("history: target stamped", h.some((t) => t.target === memId));

// 5) delete with reason
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "delete", id: memId, reason: "superseded by TOON policy item" },
] });
const after = await j.currentSnapshot("project", cwd);
check("delete: item gone", !after.items.some((i) => i.id === memId));
check("delete: version 4", after.version === 4);

// 6) atomicity: invalid batch appends nothing
let threw = false;
try {
  await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
    { op: "create", kind: "skill", content: "ok", evidence: "ok" },
    { op: "update", id: "" },
  ] });
} catch { threw = true; }
check("atomic: invalid batch throws", threw);
const post = await j.currentSnapshot("project", cwd);
check("atomic: version unchanged", post.version === 4, `got ${post.version}`);
check("atomic: no phantom item", post.items.length === 1);

// 7) corrupt-line tolerance
const jp = j.journalPath("project", cwd);
appendFileSync(jp, "{not json at all\n");
const tolerant = await j.currentSnapshot("project", cwd);
check("corrupt: skipped without crash", tolerant.version === 4 && tolerant.items.length === 1);

// 8) scopes are isolated
const globalSnap = await j.currentSnapshot("global", cwd);
check("scope: global isolated", globalSnap.items.length === 0 && globalSnap.version === 0);

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
