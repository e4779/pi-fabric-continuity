// Behavioral probe for transcript-delivery gating: appending a refinement
// entry to an IDLE session wakes it (resurrection loop of 2026-09-15), so
// delivery must happen only while a run is live.
// Run: tsc -p tsconfig.build.json && node tests/delivery.probe.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeHome } from "./hermetic.mjs";

const home = probeHome();

// Enable the auto-refine cadence for this probe home.
const cfgDir = join(home, ".pi", "agent", "continuity");
mkdirSync(cfgDir, { recursive: true });
writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ autoRefine: { enabled: true, everyTurns: 10 } }));

const refine = await import("/tmp/continuity-probe/refine.js");

function makePi() {
  return {
    handlers: {},
    appended: [],
    on(name, fn) { this.handlers[name] = fn },
    appendEntry(type, data) { this.appended.push({ type, data }) },
  };
}

function makeCtx() {
  return {
    sessionManager: {
      getCwd: () => "/tmp/continuity-probe-fake-cwd",
      getBranch: () => [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "do a thing" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "thing done" }] } },
      ],
    },
    modelRegistry: {
      complete: async () => ({
        content: [{ type: "text", text: '------------- {"summary":"s","deltas":[{"op":"create","kind":"memory","content":"note x","evidence":"did a thing"}]} -------------' }],
        stopReason: "stop",
      }),
    },
    model: { provider: "probe", id: "probe-1" },
    ui: { notify: async () => {} },
    signal: undefined,
  };
}

const results = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
}

// Scenario A: idle session (no agent_start) — deltas land in the journal but
// the transcript entry must NOT be appended (appending wakes the session).
const idlePi = makePi();
refine.registerAutoRefine(idlePi);
const idleCtx = makeCtx();
await idlePi.handlers["turn_end"]({ turnIndex: 5 }, idleCtx);
await idlePi.handlers["turn_end"]({ turnIndex: 15 }, idleCtx);
check("idle: no appendEntry (session not woken)", idlePi.appended.length === 0, JSON.stringify(idlePi.appended).slice(0, 200));

// Scenario B: live run (agent_start seen) — delivery happens.
const busyPi = makePi();
refine.registerAutoRefine(busyPi);
const busyCtx = makeCtx();
busyPi.handlers["agent_start"]();
await busyPi.handlers["turn_end"]({ turnIndex: 25 }, busyCtx);
check("busy: appendEntry delivered once", busyPi.appended.length === 1 && busyPi.appended[0].type === "continuity-refinement", JSON.stringify(busyPi.appended).slice(0, 200));

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
