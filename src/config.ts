// Continuity config: ~/.pi/agent/continuity/config.json (tolerant loader).
// v0 surface: autoRefine { enabled, everyTurns }. Everything else defaults.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AutoRefineConfig {
  enabled: boolean;
  everyTurns: number;
}

export interface ContinuityConfig {
  autoRefine: AutoRefineConfig;
}

export const DEFAULT_CONFIG: ContinuityConfig = {
  autoRefine: { enabled: false, everyTurns: 50 },
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
    };
  } catch {
    return { autoRefine: { ...DEFAULT_CONFIG.autoRefine } };
  }
}
