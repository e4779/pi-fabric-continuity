// Behavioral probes for certify (F4.1/F4.2) — no framework needed.
// Run: tsc -p tsconfig.build.json && node tests/certify.probe.mjs
import { existsSync } from "node:fs";
import { probeHome, resetJournals } from "./hermetic.mjs";

const candidates = ["/tmp/continuity-probe/src/certify.js", "/tmp/continuity-probe/certify.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted certify.js not found; run tsc -p tsconfig.build.json first");
probeHome(); // must precede the import: modules resolve paths from $HOME
const c = await import(found);
const j = await import(candidates[0].replace("certify.js", "journal.js").startsWith("/") && existsSync(candidates[0].replace("certify.js", "journal.js")) ? candidates[0].replace("certify.js", "journal.js") : found.replace("certify.js", "journal.js"));
const inj = await import(found.replace("certify.js", "inject.js"));

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}

const cwd = "/tmp/fakehome/proj";
resetJournals(j, [["project", cwd]]);

// four items: exit-0, exit-3, timeout, and one without evidenceCmds
await j.appendDeltas({ scope: "project", cwd, actor: "probe", source: "manual", deltas: [
  { op: "create", kind: "memory", content: "ok item", evidence: "probe", id: "c_probe_ok", evidenceCmds: ["node -e 'process.exit(0)'"] },
  { op: "create", kind: "memory", content: "fail item", evidence: "probe", id: "c_probe_fail", evidenceCmds: ["node -e 'process.exit(3)'"] },
  { op: "create", kind: "memory", content: "timeout item", evidence: "probe", id: "c_probe_to", evidenceCmds: ["node -e 'setTimeout(()=>{},5000)'"] },
  { op: "create", kind: "memory", content: "plain item", evidence: "probe", id: "c_probe_plain" },
] });

const out = await c.certifyItems({ scope: "project", cwd, actor: "probe:certify", timeoutMs: 800 });
const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
check("certify: exit-0 item certified", by.c_probe_ok?.status === "certified", JSON.stringify(by.c_probe_ok));
check("certify: non-zero item violated", by.c_probe_fail?.status === "violated", JSON.stringify(by.c_probe_fail));
check("certify: timeout item violated (exit 124)", by.c_probe_to?.status === "violated" && /exit 124/.test(by.c_probe_to?.error ?? ""), by.c_probe_to?.error);
check("certify: no-cmds item skipped", by.c_probe_plain?.status === "skipped");
check("certify: digest sha256 prefix", typeof by.c_probe_ok?.digest === "string" && by.c_probe_ok.digest.startsWith("sha256:"));
check("certify: applied 3 deltas", out.applied === 3, String(out.applied));
check("certify: meshEvents 3 on continuity.certification", out.meshEvents.length === 3 && out.meshEvents.every((e) => e.topic === "continuity.certification" && (e.kind === "certified" || e.kind === "violated")));

// fold attaches cert to items
const snap = await j.currentSnapshot("project", cwd);
const okItem = snap.items.find((i) => i.id === "c_probe_ok");
const failItem = snap.items.find((i) => i.id === "c_probe_fail");
check("fold: cert attached (status+at)", okItem?.cert?.status === "certified" && typeof okItem?.cert?.at === "number");
check("fold: violated attached", failItem?.cert?.status === "violated");
check("fold: plain item has no cert", !snap.items.find((i) => i.id === "c_probe_plain")?.cert);

// digest determinism across runs (same commands, same outputs)
const out2 = await c.certifyItems({ scope: "project", cwd, actor: "probe:certify", timeoutMs: 800 });
check("digest: deterministic across runs", out2.results.find((r) => r.id === "c_probe_ok")?.digest === by.c_probe_ok.digest);

// F4.2: inject freshness tags
const block = inj.renderSelectedBlock(snap.items.filter((i) => i.id === "c_probe_ok" || i.id === "c_probe_fail"), 0);
check("inject: certified tag rendered", block.includes("[certified ") && block.includes("c_probe_ok"));
check("inject: violated tag rendered", block.includes("[VIOLATED ") && block.includes("c_probe_fail"));

// delta validation
check("validate: evidenceCmds non-array rejected", j.validateDelta({ op: "create", kind: "memory", content: "x", evidence: "y", evidenceCmds: "nope" }) !== null);
check("validate: evidenceCmds bad element rejected", j.validateDelta({ op: "create", kind: "memory", content: "x", evidence: "y", evidenceCmds: ["ok", 42] }) !== null);
check("validate: certify bad status rejected", j.validateDelta({ op: "certify", id: "c_probe_ok", status: "maybe" }) !== null);
check("validate: certify delta accepted", j.validateDelta({ op: "certify", id: "c_probe_ok", status: "certified", digest: "sha256:x" }) === null);

const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails === 0 ? 0 : 1);
