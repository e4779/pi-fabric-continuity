// Continuity config: ~/.pi/agent/continuity/config.json (tolerant loader).
// v0 surface: autoRefine { enabled, everyTurns }, decayAfterInjections (F1.4),
// vccEvidence (F2.1). Everything else defaults.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AutoRefineConfig {
  enabled: boolean;
  everyTurns: number;
}

export interface ContinuityConfig {
  autoRefine: AutoRefineConfig;
  /** F1.4: zero-touch injections before refine proposes an importance decay. */
  decayAfterInjections: number;
  /** F2.1: collect bounded vcc_recall evidence during refine (default false). */
  vccEvidence: boolean;
  /** F4.1: per-command execution budget for certify. */
  certify: { timeoutMs: number };
}

/** F1.4 — DECAY_AFTER_INJECTIONS from the spec. */
export const DEFAULT_DECAY_AFTER_INJECTIONS = 20;

export const DEFAULT_CERTIFY_TIMEOUT_MS = 10_000;

export const DEFAULT_CONFIG: ContinuityConfig = {
  autoRefine: { enabled: false, everyTurns: 50 },
  decayAfterInjections: DEFAULT_DECAY_AFTER_INJECTIONS,
  vccEvidence: false,
  certify: { timeoutMs: DEFAULT_CERTIFY_TIMEOUT_MS },
};

export function configPath(): string {
  return join(homedir(), ".pi", "agent", "continuity", "config.json");
}

export async function loadConfig(): Promise<ContinuityConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as Partial<ContinuityConfig>;
    const ar = (raw.autoRefine ?? {}) as Partial<AutoRefineConfig>;
    return {
      autoRefine: {
        enabled: ar.enabled === true,
        everyTurns:
          typeof ar.everyTurns === "number" && ar.everyTurns > 0
            ? Math.floor(ar.everyTurns)
            : DEFAULT_CONFIG.autoRefine.everyTurns,
      },
      decayAfterInjections:
        typeof raw.decayAfterInjections === "number" && raw.decayAfterInjections > 0
          ? Math.floor(raw.decayAfterInjections)
          : DEFAULT_CONFIG.decayAfterInjections,
      vccEvidence: raw.vccEvidence === true,
      certify: {
        timeoutMs:
          typeof (raw.certify as { timeoutMs?: unknown } | undefined)?.timeoutMs === "number" &&
          (raw.certify as { timeoutMs: number }).timeoutMs > 0
            ? Math.floor((raw.certify as { timeoutMs: number }).timeoutMs)
            : DEFAULT_CONFIG.certify.timeoutMs,
      },
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      autoRefine: { ...DEFAULT_CONFIG.autoRefine },
      certify: { ...DEFAULT_CONFIG.certify },
    };
  }
}
