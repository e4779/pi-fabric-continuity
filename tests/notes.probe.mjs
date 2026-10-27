// Behavioral probes for the v0.6 notes engine + migration (pure fs, no LLM).
// Run: tsc -p tsconfig.build.json && node tests/notes.probe.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const candidates = ["/tmp/continuity-probe/src/notes.js", "/tmp/continuity-probe/notes.js"];
const cpath = ["/tmp/continuity-probe/src/migrate.js", "/tmp/continuity-probe/migrate.js"];
const found = candidates.find((p) => existsSync(p));
const mfound = cpath.find((p) => existsSync(p));
if (!found || !mfound) throw new Error("emitted notes.js/migrate.js not found");
const n = await import(found);
const m = await import(mfound);

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}
const dir = () => mkdtempSync(join(tmpdir(), "notes-probe-"));

// filename roundtrip + ordering
const meta = n.parseNoteFileName("1793000000000-hlab-000007-a3f9c1d2.json");
check("name: parse roundtrip", meta !== null && meta.ts === 1793000000000 && meta.host === "hlab" && meta.seq === 7 && meta.hash === "a3f9c1d2");
check("name: rejects junk", n.parseNoteFileName("not-a-note.json") === null && n.parseNoteFileName("1793000000000-hlab-7-a3f9c1d2.json") === null);
const n1 = n.noteFileName(1793000000000, "hlab", 7, "aaaaaaaa");
const n2 = n.noteFileName(1793000000000, "hlab", 42, "bbbbbbbb");
check("name: zero-padded seq sorts", n1 < n2);

// canonical json stability
check("canonical: key order ignored", n.canonicalJson({ b: 1, a: 2 }) === n.canonicalJson({ a: 2, b: 1 }));

// write + fold roundtrip
{
  const d = dir();
  const w = await n.writeNotesDir(d, [
    { actor: "test", source: "manual", delta: { op: "create", kind: "memory", content: "fact one", evidence: "e1" } },
  ]);
  const f = await n.foldDir(d, "global");
  check("write+fold: one item", f.items.length === 1 && f.items[0].content === "fact one" && f.fileCount === 1);
  const f2 = await n.foldDir(d, "global");
  check("fold: deterministic digest", f.digest === f2.digest && f.digest8.length === 8);
  // idempotent re-write: same record, same name, no duplicate
  await n.writeNotesDir(d, [{ actor: "test", source: "manual", host: w.records[0].host, seq: w.records[0].seq, ts: w.records[0].ts, delta: w.records[0].delta, target: w.records[0].target }]);
  const f3 = await n.foldDir(d, "global");
  check("write: idempotent re-write no dup", f3.fileCount === 1);
}

// seq allocation continues from directory
{
  const d = dir();
  await n.writeNotesDir(d, [
    { actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "a", evidence: "e" } },
    { actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "b", evidence: "e" } },
  ]);
  const r2 = await n.writeNotesDir(d, [{ actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "c", evidence: "e" } }]);
  check("seq: continues from dir max", r2.records[0].seq === 3, "got " + r2.records[0].seq);
}

// update requires supersedesFile (non-legacy)
{
  const d = dir();
  let threw = false;
  try {
    await n.writeNotesDir(d, [{ actor: "t", source: "manual", delta: { op: "update", id: "c_1", importance: 0.5 } }]);
  } catch {
    threw = true;
  }
  check("write: update without pin rejected", threw);
}

// update with pin applies; late-create orphan adoption
{
  const d = dir();
  const created = await n.writeNotesDir(d, [
    { actor: "t", source: "manual", delta: { op: "create", kind: "memory", content: "v1", evidence: "e" } },
  ]);
  const id = created.records[0].target;
  await n.writeNotesDir(d, [
    { actor: "t", source: "manual", delta: { op: "update", id, content: "v2", evidence: "e2" }, supersedesFile: created.metas[0].hash, target: id },
  ]);
  let f = await n.foldDir(d, "global");
  check("fold: pinned update applies", f.items.length === 1 && f.items[0].content === "v2");

  // orphan: update whose create has not arrived yet (partial sync)
  const d2 = dir();
  const late = await n.writeNotesDir(d2, [
    { actor: "t", source: "manual", delta: { op: "create", kind: "memory", content: "x", evidence: "e" } },
  ]);
  const xid = late.records[0].target;
  const dUpd = dir();
  const upd = await n.writeNotesDir(dUpd, [
    { actor: "t", source: "manual", delta: { op: "update", id: xid, content: "x2", evidence: "e2" }, supersedesFile: late.metas[0].hash, target: xid },
  ]);
  // simulate: only the update file synced (copy just that file)
  const partial = dir();
  mkdirSync(partial, { recursive: true });
  const { copyFileSync } = await import("node:fs");
  copyFileSync(join(dUpd, upd.metas[0].name), join(partial, upd.metas[0].name));
  f = await n.foldDir(partial, "global");
  check("fold: orphan update does not crash, counted", f.items.length === 0 && f.orphans === 1);
  // parent arrives late (older ts) — multi-pass adopts it
  copyFileSync(join(d2, late.metas[0].name), join(partial, late.metas[0].name));
  f = await n.foldDir(partial, "global");
  check("fold: late parent adopted", f.items.length === 1 && f.items[0].content === "x2" && f.orphans === 0);
}

// fork surfacing: two updates on the same id, same pin, different hosts
{
  const d = dir();
  const c = await n.writeNotesDir(d, [{ actor: "t", source: "manual", delta: { op: "create", kind: "skill", content: "s1", evidence: "e" } }]);
  const id = c.records[0].target;
  const pin = c.metas[0].hash;
  await n.writeNotesDir(d, [{ actor: "t", source: "manual", host: "h1", ts: 1793000000001, delta: { op: "update", id, content: "h1 wins", evidence: "e" }, supersedesFile: pin, target: id }]);
  await n.writeNotesDir(d, [{ actor: "t", source: "manual", host: "h2", ts: 1793000000002, delta: { op: "update", id, content: "h2 wins", evidence: "e" }, supersedesFile: pin, target: id }]);
  const f = await n.foldDir(d, "global");
  check("fork: newest (ts,host,seq) wins", f.items.length === 1 && f.items[0].content === "h2 wins");
  check("fork: conflict surfaced", f.conflicts.length === 1 && f.conflicts[0] === id);
}

// skip-and-log (I6): garbage and hash-mismatched files never break the fold
{
  const d = dir();
  await n.writeNotesDir(d, [{ actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "ok", evidence: "e" } }]);
  writeFileSync(join(d, "1793000000000-hlab-000001-deadbeef.json"), "{not json");
  writeFileSync(join(d, "junk.json"), "whatever");
  const f = await n.foldDir(d, "global");
  check("fold: skips garbage, keeps good note", f.items.length === 1 && f.skipped === 2, "skipped=" + f.skipped);
  check("fold: did not mutate garbage (I6)", existsSync(join(d, "junk.json")));
}

// hash widening on same-name collision
{
  const d = dir();
  const rec = { actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "collide", evidence: "e" } };
  const w1 = await n.writeNotesDir(d, [rec]);
  // forge a file with the same name but different content
  const forged = join(d, w1.metas[0].name);
  writeFileSync(forged, '{"different":"content"}');
  // same (ts,host,seq) => same primary name, different content => must widen
  const w2 = await n.writeNotesDir(d, [{ ...rec, ts: w1.records[0].ts, host: w1.records[0].host, seq: w1.records[0].seq, target: w1.records[0].target }]);
  check("collision: widened hash, no overwrite", w2.metas[0].hash.length > 8 && w2.metas[0].name !== w1.metas[0].name);
}

// migration: split + rename + idempotent re-run
{
  const home = dir();
  process.env.HOME = home; // marker + journalPath go under HOME? journalPath uses homedir() at module load...
  // NOTE: homedir() is cached by node:os — instead test migrateLegacyScope against a crafted legacy dir via env override is unreliable;
  // so drive the core directly: legacy lines -> notes dir.
  const legacyLines = [
    JSON.stringify({ version: 1, ts: 1793000000000, actor: "a", source: "manual", delta: { op: "create", kind: "memory", content: "L1", evidence: "e" }, target: "c_leg_1" }),
    JSON.stringify({ version: 2, ts: 1793000000001, actor: "a", source: "refine", delta: { op: "update", id: "c_leg_1", importance: 0.7 } }),
  ].join("\n");
  // simulate both machines splitting the SAME legacy file into DIFFERENT dirs:
  const dA = dir();
  const dB = dir();
  const toWrites = (raw) => raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((t) => ({
    ts: t.ts, host: "legacy", seq: t.version, actor: t.actor, source: t.source, delta: t.delta, ...(t.target !== undefined ? { target: t.target } : {}),
  }));
  const wA = await n.writeNotesDir(dA, toWrites(legacyLines));
  const wB = await n.writeNotesDir(dB, toWrites(legacyLines));
  check("migrate: byte-identical filenames on both machines", wA.metas[0].name === wB.metas[0].name && wA.metas[1].name === wB.metas[1].name);
  const fA = await n.foldDir(dA, "global");
  check("migrate: legacy fold = create+update applied", fA.items.length === 1 && fA.items[0].importance === 0.7 && fA.items[0].id === "c_leg_1");
  check("migrate: legacy notes carry no pins, no conflicts", fA.conflicts.length === 0);
}

// fork: disjoint fields on sibling heads must NOT merge (winner only)
{
  const dD = dir();
  const cD = await n.writeNotesDir(dD, [{ actor: "t", source: "manual", delta: { op: "create", kind: "skill", content: "d1", evidence: "e" } }]);
  const did = cD.records[0].target;
  await n.writeNotesDir(dD, [{ actor: "t", source: "manual", host: "h9", ts: 1793000000100, delta: { op: "update", id: did, content: "h9c" }, supersedesFile: cD.metas[0].hash, target: did }]);
  await n.writeNotesDir(dD, [{ actor: "t", source: "manual", host: "hz", ts: 1793000000200, delta: { op: "update", id: did, importance: 0.11 }, supersedesFile: cD.metas[0].hash, target: did }]);
  const fD = await n.foldDir(dD, "global");
  check("fork: disjoint fields winner-only (no Frankenstein)", fD.items.length === 1 && fD.items[0].content === "d1" && fD.items[0].importance === 0.11, "c=" + fD.items[0].content + " i=" + fD.items[0].importance);
}

// legacy chains: update+certify is the norm, never a conflict
{
  const dL = dir();
  await n.writeNotesDir(dL, [
    { actor: "t", source: "manual", host: "legacy", ts: 1793000000001, seq: 1, delta: { op: "create", kind: "memory", content: "l", evidence: "e" }, target: "c_l1" },
    { actor: "t", source: "manual", host: "legacy", ts: 1793000000002, seq: 2, delta: { op: "update", id: "c_l1", importance: 0.7 } },
    { actor: "t", source: "manual", host: "legacy", ts: 1793000000003, seq: 3, delta: { op: "certify", id: "c_l1", status: "certified" } },
  ]);
  const fL = await n.foldDir(dL, "global");
  check("legacy: update+certify not a conflict", fL.conflicts.length === 0 && fL.items.length === 1 && fL.items[0].cert !== undefined && fL.items[0].cert.status === "certified");
}

// dotfiles (.last-sync-*.json) must not pollute skipped stats
{
  const dS = dir();
  await n.writeNotesDir(dS, [{ actor: "t", source: "manual", delta: { op: "create", kind: "prompt", content: "s", evidence: "e" } }]);
  writeFileSync(join(dS, ".last-sync-hlab.json"), "{}");
  const fS = await n.foldDir(dS, "global");
  check("fold: dotfiles ignored (not skipped-noise)", fS.items.length === 1 && fS.skipped === 0);
}

// migration end-to-end: real migrateLegacyScope in a child with fresh HOME
{
  const home = dir();
  const cont = join(home, ".pi", "agent", "continuity");
  mkdirSync(join(cont, "global"), { recursive: true });
  const jpath = join(cont, "global", "journal.jsonl");
  const line = (v, t, delta, target) => JSON.stringify({ version: v, ts: t, actor: "a", source: "manual", delta, ...(target ? { target } : {}) });
  writeFileSync(jpath, [
    line(1, 1793000000000, { op: "create", kind: "memory", content: "M1", evidence: "e" }, "c_m_1"),
    line(2, 1793000000001, { op: "update", id: "c_m_1", importance: 0.7 }),
  ].join("\n") + "\n");
  const store = join(home, "store");
  writeFileSync(join(cont, "config.json"), JSON.stringify({ store: { dir: store } }));
  const driver = join(home, "driver.mjs");
  writeFileSync(driver, [
    "const m = await import(process.env.PROBE_MIGRATE);",
    "const n = await import(process.env.PROBE_NOTES);",
    'const out = await m.migrateLegacyScope({ scope: "global" });',
    'const f = await n.foldDir(process.env.PROBE_STORE + "/global", "global");',
    "console.log(JSON.stringify({ out, fileCount: f.fileCount, items: f.items.map((i) => [i.id, i.importance]) }));",
  ].join("\n"));
  const env = { ...process.env, HOME: home, PROBE_MIGRATE: mfound, PROBE_NOTES: found, PROBE_STORE: store };
  const r1 = JSON.parse(spawnSync(process.execPath, [driver], { env, encoding: "utf8" }).stdout);
  check("migrate e2e: split + fold via store.dir", r1.out.migrated === 2 && r1.fileCount === 2 && r1.items.length === 1 && r1.items[0][0] === "c_m_1" && r1.items[0][1] === 0.7, JSON.stringify(r1).slice(0, 160));
  check("migrate e2e: journal renamed per-host", r1.out.renamed.length === 1 && !existsSync(jpath));
  const r2 = JSON.parse(spawnSync(process.execPath, [driver], { env, encoding: "utf8" }).stdout);
  check("migrate e2e: marker -> rerun no-op", r2.out.alreadyMarked === true && r2.fileCount === 2);
  const mks = readdirSync(cont).filter((n) => n.startsWith(".migrated-global"));
  check("migrate e2e: marker machine-local + store-keyed", mks.length >= 1, mks.join(","));
}

const fails = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log((results.length - fails.length) + "/" + results.length + " passed");
process.exit(fails.length ? 1 : 0);
