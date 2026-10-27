# Deploying v0.6 (atomic note store)

Two rails exist after v0.6: the git rail (dot-pi, single-writer-at-a-time —
what we deploy on FIRST, because it needs no peer) and the rsync rail
(scripts/continuity-sync.sh — the end state once both machines are up).
The store format is rail-agnostic; switching rails later moves no data.

## Release

```
# in the repo, after the phase-3 commit is reviewed and green:
npm version patch   # or edit package.json to 0.6.0
git commit -m "release: v0.6.0"
git tag v0.6.0 && git push origin main v0.6.0
# publish.yml (trusted publishing, OIDC) ships it to npm
```

## hlab (order matters)

1. **Point the store at the synced tree** — edit
   `~/.pi/agent/continuity/config.json` (currently a symlink into dot-pi;
   replace the symlink with a real file first — config is machine-local
   per F6.2):
   ```json
   { "autoRefine": { "enabled": true, "everyTurns": 20 },
     "store": { "dir": "/home/e4779/projects/dot-pi/common/continuity" } }
   ```
   Notes now land directly in the dot-pi git tree; the symlink farm for
   `global`/`projects` is bypassed (retire them in step 4).
2. **Pre-migrate and verify** (before flipping the running extension):
   ```
   cd ~/projects/pi-fabric-continuity && npm run build
   HOME=/home/e4779 node -e '
     const m = await import("/tmp/continuity-probe/src/migrate.js");
     const j = await import("/tmp/continuity-probe/src/journal.js");
     for (const s of ["global", "project"]) await m.migrateLegacyScope({ scope: s, cwd: undefined });
     for (const slug of ["homelab","b","durable-homelab","pi-fabric","pi-fabric-continuity","p9draw","acme-next"])
       await m.migrateLegacyScope({ scope: "project", cwd: "/x/" + slug });  // slug via path basename
     const g = await j.currentSnapshot("global");
     console.log("global:", g.items.length, "items,", g.fileCount, "notes,", g.digest8);
   '
   ```
   Expect: global ~97 items, fileCount == old journal line count (369 at
   the time of writing). `journal.legacy-<host>.jsonl` backups appear; the
   marker `~/.pi/agent/continuity/.migrated-*` is machine-local.
3. **Flip the extension**: after the tag publishes,
   `pi update --extensions` (or `cd ~/.pi/agent/npm && npm install
   pi-fabric-continuity@0.6.0 --registry=https://registry.npmjs.org`), then
   restart pi sessions. Auto-migration is idempotent — anything the
   pre-migration missed is caught on first open.
4. **Retire the symlink farm** (only after 3 ran clean):
   `config.json` and `counters.json`: replace symlinks with real local
   files (counters are machine-local in v0.6; dot-pi copies stay as
   historical template). `global`/`projects` symlinks: the store now lives
   in dot-pi directly; remove the `~/.pi/agent/continuity/global` symlink
   ONLY if store.dir points elsewhere — with store.dir at the dot-pi path,
   the extension no longer reads through it.
5. **Rail** (when thinkpad is reachable): add to the pi-memory-sync cron —
   `$HOME/projects/pi-fabric-continuity/scripts/continuity-sync.sh
   e4779@192.168.1.15 pi-continuity-store` — then retire the git rail for
   notes (dot-pi keeps configs).

## thinkpad (runbook — machine was unreachable at deploy time)

NOTE: dot-pi's whitelist gitignore deliberately excludes continuity DATA
(only config.json is tracked) — there is NO git rail for notes, by design
(I5, rail-agnostic store). The stores REUNIFY via the rsync rail, not git:

1. Replace the config symlink with a local file (same shape as hlab's, its
   own autoRefine + `store.dir` pointing at ITS shared store path).
2. Update the package (`pi update --extensions`). Its own legacy
   `journal.jsonl` auto-migrates with the fixed `host="legacy"` label —
   lines SHARED with hlab's history produce byte-identical content-addressed
   filenames, so the first rail sync dedupes them; only machine-unique tails
   arrive as new notes (spec F6.6 — this is exactly what it was designed for).
3. Join the rsync rail (step 5 above) from both sides.
4. Only after both machines ride the rail: retire the dot-pi continuity
   symlinks on thinkpad (config/counters go machine-local, as on hlab).

## Rollback

- Legacy backups (`journal.legacy-<host>.jsonl`) are never deleted; a
  rollback = reinstall 0.5.0 and restore `journal.jsonl` from the backup.
- The migration marker (`~/.pi/agent/continuity/.migrated-*`) blocks
  re-runs; `migrateLegacyScope({ force: true })` re-splits idempotently.
- Notes written after the flip are NOT in the legacy backup — export them
  via `readScopeTransitions` before any rollback.
