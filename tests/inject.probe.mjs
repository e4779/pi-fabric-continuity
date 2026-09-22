// Behavioral probe for injection selection and cache-stable emission order.
// Run: tsc -p tsconfig.build.json && node tests/inject.probe.mjs
import { existsSync } from "node:fs";
import { probeHome } from "./hermetic.mjs";

const candidates = ["/tmp/continuity-probe/src/inject.js", "/tmp/continuity-probe/inject.js"];
const found = candidates.find((p) => existsSync(p));
if (!found) throw new Error("emitted inject.js not found; run tsc -p tsconfig.build.json first");
probeHome();
const inj = await import(found);

const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " :: " + detail}`);
const mk = (id, createdAt, importance, extra = {}) => ({
  id, kind: "memory", content: "content-" + id, evidence: "", importance,
  active: true, scope: "project", createdAt, updatedAt: createdAt, ...extra,
});
const cfg = { enabled: true, maxTokens: 800, maxPerKind: 8, charsPerToken: 4 };

// 1) Cache-stable order: importance churn re-selects but must not re-order lines.
const lowFirst = inj.renderContinuityBlock([mk("c_a", 1, 0.2), mk("c_b", 2, 0.9)], undefined, cfg);
const highFirst = inj.renderContinuityBlock([mk("c_a", 1, 0.9), mk("c_b", 2, 0.2)], undefined, cfg);
check("order stable across importance churn", lowFirst === highFirst, "block changed when only importance changed");
check("stable order is creation order", lowFirst.indexOf("content-c_a") < lowFirst.indexOf("content-c_b"));

// 2) Importance governs SELECTION under budget pressure (6 tokens ≈ one item).
const tightCfg = { enabled: true, maxTokens: 8, maxPerKind: 8, charsPerToken: 4 };
const tight = inj.selectForInjection([mk("c_low", 1, 0.2), mk("c_high", 2, 0.9)], undefined, tightCfg);
check("budget keeps the important item", tight.selected.some((i) => i.id === "c_high"));
check("budget drops the unimportant item", !tight.selected.some((i) => i.id === "c_low"));
check("omitted accounted", tight.omitted === 1);

// 3) models hint filters out non-matching models.
const hinted = inj.selectForInjection(
  [mk("c_hint", 1, 0.9, { models: ["zai/glm-5.3-flash"] }), mk("c_plain", 2, 0.1)],
  undefined,
  cfg,
);
check("models hint filters", !hinted.selected.some((i) => i.id === "c_hint") && hinted.selected.some((i) => i.id === "c_plain"));

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
