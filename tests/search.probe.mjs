// Behavioral probe for continuity.search (spec F3): provider action search
// + /harness search over current and historical item text.
// Run: tsc -p tsconfig.build.json && node tests/search.probe.mjs
import { existsSync } from "node:fs";
import { probeHome, resetJournals } from "./hermetic.mjs";

const base = "/tmp/continuity-probe";
const jPath = [`${base}/src/journal.js`, `${base}/journal.js`].find((p) => existsSync(p));
const sPath = [`${base}/src/search.js`, `${base}/search.js`].find((p) => existsSync(p));
const cmdPath = [`${base}/src/commands.js`, `${base}/commands.js`].find((p) => existsSync(p));
if (!jPath || !sPath || !cmdPath) throw new Error("emitted modules not found; run tsc -p tsconfig.build.json first");
probeHome(); // must precede the import: journal.js resolves ROOT from $HOME
const j = await import(jPath);
const search = await import(sPath);
const commands = await import(cmdPath);

const cwd = "/tmp/continuity-probe-search-cwd";
resetJournals(j, [["project", cwd], ["global", cwd]]);

// History fixture:
//   project v1 create A (quadlets) -> v2 update A (systemd)
//   project v3 create B (blackhole) -> v4 delete B
//   project v5 create R (regex metachars), v6 create D (long needle)
//   global  v1 create G (TOON)
const v1 = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "deploy via podman quadlets on hlab", evidence: "ops session" },
] });
const idA = v1.transitions[0].target;
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "update", id: idA, content: "deploy via systemd units" },
] });
const v3 = await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "skill", content: "blackhole integration notes", evidence: "idea" },
] });
const idB = v3.transitions[0].target;
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "delete", id: idB, reason: "obsolete" },
] });
await j.appendDeltas({ scope: "global", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "prompt", content: "Prefer TOON over JSON for structured data", evidence: "kb" },
] });
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "prompt", content: "use rg -e 'pat1|pat2' over grep pipes", evidence: "cli cheatsheet" },
] });
const longText = "x".repeat(150) + " needle " + "y".repeat(150);
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: longText, evidence: "bounds probe" },
] });
const CAP = 25;
await j.appendDeltas({
  scope: "project", cwd, actor: "probe", source: "manual",
  deltas: Array.from({ length: CAP }, (_, n) => ({ op: "create", kind: "memory", content: `capme item ${n}`, evidence: "cap probe" })),
});

const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
const run = async (query, opts = {}) => search.searchItems({ query, cwd, ...opts });

// F3.1 — folded current items
const cur = await run("systemd units", { scope: "project" });
check("current: one hit", cur.total === 1 && cur.hits.length === 1, JSON.stringify(cur));
const curHit = cur.hits[0];
check("current: flagged current, kind/active carried", curHit && curHit.current === true && curHit.kind === "memory" && curHit.active === true, JSON.stringify(curHit));
check("current: cited at the establishing version (v2 update)", curHit && curHit.version === 2 && curHit.ts > 0, JSON.stringify(curHit));
check("current: content field + bounded snippet carries match", curHit && curHit.field === "content" && curHit.snippet.includes("systemd units"), curHit && curHit.snippet);
check("current: hit id matches item", curHit && curHit.id === idA);

// F3.1 — historical: superseded text still findable
const old = await run("quadlets", { scope: "project" });
check("historical: superseded content found, not current", old.total === 1 && old.hits[0].current === false, JSON.stringify(old));
check("historical: cites the original create version (v1)", old.hits[0] && old.hits[0].version === 1, JSON.stringify(old.hits[0]));
check("historical: kind remembered from the create", old.hits[0] && old.hits[0].kind === "memory");

// F3.1 — historical: deleted item text still reachable
const gone = await run("blackhole", { scope: "project" });
check("historical: deleted item found", gone.total === 1 && gone.hits[0].id === idB && gone.hits[0].current === false && gone.hits[0].version === 3, JSON.stringify(gone));
const snapNow = await j.currentSnapshot("project", cwd);
check("historical: deleted item really absent from the fold", !snapNow.items.some((i) => i.id === idB));

// F3.1 — evidence field: current evidence cited at the version that set it (create v1)
const ev = await run("ops session", { scope: "project" });
check("evidence: current evidence hit cites create version", ev.total === 1 && ev.hits[0].current === true && ev.hits[0].field === "evidence" && ev.hits[0].version === 1, JSON.stringify(ev));

// F3.3 — case-insensitive, both directions
const ci = await run("SYSTEMD UNITS", { scope: "project" });
check("case-insensitive: UPPER query matches lower content", ci.total === 1 && ci.hits[0].id === idA, JSON.stringify(ci));
const ci2 = await run("toon");
check("case-insensitive: lower query matches UPPER content (global)", ci2.total === 1 && ci2.hits[0].scope === "global", JSON.stringify(ci2));

// F3.3 — literal, not regex
const lit = await run("pat1|pat2", { scope: "project" });
check("literal: 'pat1|pat2' matches itself", lit.total === 1, JSON.stringify(lit));
const re = await run("pat1.pat2", { scope: "project" });
check("literal: 'pat1.pat2' is NOT a regex wildcard match", re.total === 0, JSON.stringify(re));

// F3.1 — bounded snippet
const b = await run("needle", { scope: "project" });
const bSnip = b.hits[0] && b.hits[0].snippet;
check("snippet: bounded length", typeof bSnip === "string" && bSnip.length <= search.SNIPPET_MAX + 2, bSnip);
check("snippet: keeps the match, ellipsized both sides", bSnip && bSnip.includes("needle") && bSnip.startsWith("…") && bSnip.endsWith("…"), bSnip);

// F3.1 — bounded result count
const capped = await run("capme", { scope: "project" });
check("cap: total counts all matches, hits are capped", capped.total === CAP && capped.hits.length === search.SEARCH_MAX_HITS, `total=${capped.total} hits=${capped.hits.length}`);

// F3.1 — scope narrowing; omitted scope searches both journals
const gOnly = await run("TOON", { scope: "global" });
const pOnly = await run("TOON", { scope: "project" });
const both = await run("TOON");
check("scope: 'global' narrows", gOnly.total === 1 && gOnly.scopes.length === 1, JSON.stringify(gOnly));
check("scope: 'project' excludes the global hit", pOnly.total === 0, JSON.stringify(pOnly));
check("scope: omitted searches both", both.total === 1 && both.hits[0].scope === "global" && both.scopes.join() === "project,global", JSON.stringify(both));

// empty/blank query: no hits, no crash
const blank = await run("   ");
check("blank query: empty result", blank.total === 0 && blank.hits.length === 0, JSON.stringify(blank));

// F3.2 — /harness search renders the same hits
let registered = null;
commands.registerHarnessCommand({ registerCommand: (name, opts) => { if (name === "harness") registered = opts; } });
const captured = [];
const fakeCtx = { sessionManager: { getCwd: () => cwd }, ui: { notify: async (msg) => captured.push(String(msg)) } };
await registered.handler("search quadlets", fakeCtx);
let last = captured[captured.length - 1] ?? "";
check("command: renders header + historical hit", last.includes("continuity search") && last.includes(idA) && last.includes("historical") && last.includes("v1"), last);
await registered.handler("search zznothing-here", fakeCtx);
last = captured[captured.length - 1] ?? "";
check("command: no-match message", last.includes("no matches"), last);
await registered.handler("search", fakeCtx);
last = captured[captured.length - 1] ?? "";
check("command: bare search prints usage", last.includes("usage:"), last);

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
