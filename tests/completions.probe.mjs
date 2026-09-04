// Behavioral probes for /harness argument completions (TUI-contract level).
// Emulates how pi-tui invokes getArgumentCompletions: full argument text after
// the command name, including the subcommand word and any trailing space.
import { existsSync } from "node:fs";

const base = "/tmp/continuity-probe";
const jPath = [`${base}/src/journal.js`, `${base}/journal.js`].find((p) => existsSync(p));
const cPath = [`${base}/src/commands.js`, `${base}/commands.js`].find((p) => existsSync(p));
if (!jPath || !cPath) throw new Error("emitted modules not found");
const j = await import(jPath);

// seed one item so keep/drop have something to suggest (slug = cwd basename)
await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "probe item", evidence: "completions probe" },
] });

// capture the registered command like the pi loader would
let registered = null;
const fakePi = { registerCommand: (name, opts) => { if (name === "harness") registered = opts; } };
const commands = await import(cPath);
commands.registerHarnessCommand(fakePi);
if (!registered || typeof registered.getArgumentCompletions !== "function") {
  throw new Error("harness command not registered or has no completions");
}
const complete = (t) => registered.getArgumentCompletions(t);

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}
const resolve = (v) => (v && typeof v.then === "function" ? v : Promise.resolve(v));

// subcommand suggestions (no space yet)
const kee = await resolve(complete("kee"));
check("subcommands: 'kee' suggests keep", Array.isArray(kee) && kee.some((i) => i.value === "keep"));

// keep + trailing space -> item ids (the case that failed live)
const keepSpace = await resolve(complete("keep "));
check("keep: trailing space suggests item ids", Array.isArray(keepSpace) && keepSpace.length === 1 && /^c_/.test(keepSpace[0].value), JSON.stringify(keepSpace));
check("keep: label carries kind preview", Array.isArray(keepSpace) && keepSpace[0].label.startsWith("memory:"));

// partial id
const snap = await j.currentSnapshot("project");
const id = snap.items[0].id;
const keepPartial = await resolve(complete(`keep ${id.slice(0, 6)}`));
check("keep: partial id filters", Array.isArray(keepPartial) && keepPartial.length === 1 && keepPartial[0].value === id);

// drop same path
const dropSpace = await resolve(complete("drop "));
check("drop: same suggestions", Array.isArray(dropSpace) && dropSpace.length === 1);

// list kinds
const listSpace = await resolve(complete("list "));
check("list: kinds suggested", Array.isArray(listSpace) && listSpace.some((i) => i.value === "subagent"));
const listM = await resolve(complete("list m"));
check("list: kind prefix filters", Array.isArray(listM) && listM.length === 1 && listM[0].value === "memory");

// revert versions
const revSpace = await resolve(complete("revert "));
check("revert: versions suggested", Array.isArray(revSpace) && revSpace.some((i) => i.value === "1"));

// unknown subcommand -> null
const bogus = await resolve(complete("bogus "));
check("unknown: returns null", bogus === null);

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
