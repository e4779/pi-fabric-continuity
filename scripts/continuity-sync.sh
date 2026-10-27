#!/bin/sh
# continuity-sync — the sanctioned rail for the v0.6 note store (spec F6.5).
#
# Safety contract:
#   - rsync -a, NO --delete anywhere. The sibling kn-mirror line in
#     pi-memory-sync.sh uses --delete; one copy-paste there wipes every
#     peer-unsynced note. This wrapper is the ONLY sanctioned command.
#   - --backup --backup-dir: even a deliberately hostile --delete stays
#     reversible from .rail-backup/.
#   - *.lock and .rail-backup never ride the rail; heartbeat dotfiles are
#     pushed explicitly and excluded from pulls.
#
# Usage: continuity-sync <user@peerhost> [remote-store-path]
# Env:   CONTINUITY_STORE (default ~/.pi/agent/continuity)
#        CONTINUITY_DRY=1 -> rsync -n (show what would transfer)
set -eu

STORE=${CONTINUITY_STORE:-$HOME/.pi/agent/continuity}
PEER=${1:?usage: continuity-sync <user@peerhost> [remote-store-path]}
REMOTE=${2:-pi-store}
HOST=$(hostname | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g' | cut -c1-24)
[ -n "$HOST" ] || HOST=unknown
DRY=${CONTINUITY_DRY:+-n}

for d in global projects; do
  [ -d "$STORE/$d" ] || continue
  # push: our notes -> peer (growth only, reversible)
  rsync -a $DRY --backup --backup-dir="$STORE/.rail-backup" \
    --exclude='*.lock' --exclude='.rail-backup' --exclude='.last-sync-*' \
    "$STORE/$d/" "$PEER:$REMOTE/$d/"
done

# heartbeat: peer-visible via the rail itself; the fold ignores dotfiles.
COUNT=$(find "$STORE/global" "$STORE/projects" -name '*.json' -not -name '.*' 2>/dev/null | wc -l | tr -d ' ')
printf '{"ts":%s,"host":"%s","fileCount":%s}\n' "$(date +%s)" "$HOST" "$COUNT" \
  > "$STORE/global/.last-sync-$HOST.json"
rsync -a $DRY "$STORE/global/.last-sync-$HOST.json" "$PEER:$REMOTE/global/"

# pull: peer notes -> us (same safety flags; never deletes anything)
rsync -a $DRY --backup --backup-dir="$STORE/.rail-backup" \
  --exclude='*.lock' --exclude='.rail-backup' --exclude='.last-sync-*' \
  "$PEER:$REMOTE/" "$STORE/"

echo "continuity-sync: ok (peer=$PEER store=$STORE notes=$COUNT${DRY:+ [dry-run]})"
