// Session-bound cwd resolution.
// process.cwd() is the pi process LAUNCH directory — wrong after a restart from
// elsewhere. The session's project dir comes from sessionManager.getCwd();
// commands refresh the cache on every invocation, completions (which get no
// ctx) fall back to the last known value.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let cached: string | undefined;

export function sessionCwdOf(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as { getCwd?: () => string } | undefined;
  const cwd = sm?.getCwd?.() ?? process.cwd();
  cached = cwd;
  return cwd;
}

export function lastKnownSessionCwd(): string {
  return cached ?? process.cwd();
}
