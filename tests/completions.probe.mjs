// Behavioral probes for /harness argument completions (TUI-contract level).
// The TUI replaces the ENTIRE argument text with the accepted value, so
// multi-word suggestions must embed the subcommand: "keep <id>".
import { existsSync } from "node:fs";

const base = "/tmp/continuity-probe";
const jPath = [`${base}/src/journal.js`, `${base}/journal.js`].find((p) => existsSync(p));
const cPath = [`${base}/src/commands.js`, `${base}/commands.js`].find((p) => existsSync(p));
if (!jPath || !cPath) throw new Error("emitted modules not found");
const j = await import(jPath);

await j.appendDeltas({ scope: "project", actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "probe item", evidence: "completions probe" },
] });

let registered = null;
let registeredNames = [];
const fakePi = { registerCommand: (name, opts) => { registeredNames.push(name); if (name === "harness") registered = opts; } };
const commands = await import(cPath);
commands.registerHarnessCommand(fakePi);
const complete = (t) => registered.getArgumentCompletions(t);
const resolve = (v) => (v && typeof v.then === "function" ? v : Promise.resolve(v));

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}

// stage 1: subcommand typing
const kee = await resolve(complete("kee"));
check("subcommands: 'kee' suggests keep", Array.isArray(kee) && kee.some((i) => i.value === "keep"));
const exact = await resolve(complete("keep"));
check("subcommands: exact 'keep' suggests itself (accept adds the space)", Array.isArray(exact) && exact.length === 1 && exact[0].value === "keep");

// stage 2: keep + space -> full-argument values, id-first labels
const snap = await j.currentSnapshot("project");
const id = snap.items[0].id;
const keepSpace = await resolve(complete("keep "));
const keepEntry = Array.isArray(keepSpace) ? keepSpace.find((i) => i.value === `keep ${id}`) : undefined;
check("keep: value embeds subcommand", keepEntry !== undefined, JSON.stringify(keepSpace));
check("keep: label is id-first with dash", keepEntry !== undefined && /^c_\S+ — /.test(keepEntry.label), keepEntry && keepEntry.label);
check("keep: scope in description", keepEntry !== undefined && keepEntry.description === "project");

// partial id
const keepPartial = await resolve(complete(`keep ${id.slice(0, 6)}`));
check("keep: partial id filters, value still full", Array.isArray(keepPartial) && keepPartial.some((i) => i.value === `keep ${id}`));

// drop same path
const dropSpace = await resolve(complete("drop "));
check("drop: same suggestions", Array.isArray(dropSpace) && dropSpace.some((i) => i.value === `drop ${id}`));

// list kinds embed subcommand
const listSpace = await resolve(complete("list "));
check("list: kinds suggested with subcommand", Array.isArray(listSpace) && listSpace.some((i) => i.value === "list subagent"));
const listM = await resolve(complete("list m"));
check("list: kind prefix filters", Array.isArray(listM) && listM.length === 1 && listM[0].value === "list memory");

// revert versions embed subcommand
const revSpace = await resolve(complete("revert "));
check("revert: versions suggested with subcommand", Array.isArray(revSpace) && revSpace.some((i) => i.value === "revert 1"));

// unknown subcommand -> null
const bogus = await resolve(complete("bogus "));
check("unknown: returns null", bogus === null);

// /refine alias registered
check("alias: /refine command registered", registeredNames.includes("refine"));

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
