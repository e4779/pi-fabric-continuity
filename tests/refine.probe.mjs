// Behavioral probes for refine-core (pure, LLM-free).
// Run: tsc -p tsconfig.build.json && HOME=/tmp/fakehome node tests/refine.probe.mjs
import { existsSync } from "node:fs";

const candidates = ["/tmp/continuity-probe/src/refine-core.js", "/tmp/continuity-probe/refine-core.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted refine-core.js not found");
const c = await import(found);

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}

// parseProposerOutput
const fenced = c.parseProposerOutput('Some preamble.\n```json\n{"summary":"s","deltas":[{"op":"create","kind":"memory","content":"x","evidence":"y"}]}\n```');
check("parse: fenced json", fenced !== null && fenced.deltas.length === 1 && fenced.summary === "s");
const plain = c.parseProposerOutput('{"summary":"t","deltas":[]}');
check("parse: plain json", plain !== null && plain.deltas.length === 0);
check("parse: prose only -> null", c.parseProposerOutput("I think no changes are needed.") === null);
check("parse: empty -> null", c.parseProposerOutput("") === null);
const wrapped = c.parseProposerOutput('Here you go: {"deltas":[{"op":"delete","id":"c_1","reason":"stale"}]} hope this helps');
check("parse: json embedded in prose", wrapped !== null && wrapped.deltas[0].op === "delete");

// gatherEvidence
const fakeBranch = [
  { type: "custom", customType: "noise" },
  { type: "user", content: [{ type: "text", text: "first message" }] },
  { type: "assistant", content: [{ type: "text", text: "done" }] },
  { type: "user", content: "string content works too" },
  { type: "tool_result", content: [{ type: "text", text: "tool noise ignored" }] },
  { type: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: "final answer" }] },
];
const ev = c.gatherEvidence(fakeBranch, 25, 16000);
check("evidence: user+assistant only", ev.includes("user:") && ev.includes("assistant:") && !ev.includes("noise") && !ev.includes("tool"));
check("evidence: string content", ev.includes("string content works too"));
check("evidence: text blocks joined, non-text skipped", ev.includes("final answer") && !ev.includes("hidden"));
const short = c.gatherEvidence(fakeBranch, 1, 16000);
check("evidence: lookback tail", !short.includes("first message") && short.includes("final answer"));
const capped = c.gatherEvidence([{ type: "user", content: "x".repeat(50000) }], 25, 100);
check("evidence: byte cap keeps tail", capped.length <= 110 && capped.startsWith("…"));

// evaluateCadence
const auto = { enabled: true, everyTurns: 10 };
check("cadence: first sighting seeds baseline", c.evaluateCadence(auto, 5, -1).fire === false);
check("cadence: baseline recorded", c.evaluateCadence(auto, 5, -1).next === 5);
check("cadence: no fire before interval", c.evaluateCadence(auto, 14, 5).fire === false);
check("cadence: fires at interval", c.evaluateCadence(auto, 15, 5).fire === true);
check("cadence: fire resets baseline", c.evaluateCadence(auto, 15, 5).next === 15);
check("cadence: disabled never fires", c.evaluateCadence({ enabled: false, everyTurns: 1 }, 100, 0).fire === false);

// buildUserText
const u = c.buildUserText([{ id: "c_1", kind: "prompt", content: "note", evidence: "e", importance: 0.7, active: true, scope: "project", createdAt: 1, updatedAt: 1 }], "user: hi");
check("usertext: lists items", u.includes("[c_1] prompt 0.70: note"));
check("usertext: includes evidence", u.includes("user: hi"));
check("usertext: empty store noted", c.buildUserText([], "ev").includes("(empty store)"));

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
