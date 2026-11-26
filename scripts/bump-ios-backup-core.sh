#!/usr/bin/env bash
# Moves the ios-backup-core pin. Every workflow (CI, the weekly corpus, releases, the installer
# and pre-release checks) builds and tests the commit in ios-backup-core.ref, so a merge in
# ios-backup-core reaches this repo only through a PR that moves the pin. This resolves a
# branch, tag or commit of ios-backup-core on GitHub and writes its full SHA there.
#
#   scripts/bump-ios-backup-core.sh              # ios-backup-core's master as it is now
#   scripts/bump-ios-backup-core.sh some-branch  # a branch or tag
#   scripts/bump-ios-backup-core.sh <full SHA>   # a commit (checked that GitHub has it)
#
# scripts/ios-backup-core-pin.test.mjs (npm test) checks the file and that no workflow gets
# ios-backup-core any other way.
set -euo pipefail

URL=https://github.com/charleswest775/ios-backup-core.git
REF=${1:-master}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PIN="$ROOT/ios-backup-core.ref"

if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  SHA=$REF
  # ls-remote lists only branches and tags; fetching the commit (no files) checks GitHub has it.
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  git init -q "$TMP"
  if ! git -C "$TMP" fetch -q --depth=1 --filter=tree:0 "$URL" "$SHA" 2>/dev/null; then
    echo "GitHub has no ios-backup-core commit $SHA. Is it pushed?" >&2
    exit 1
  fi
else
  REFS=$(git ls-remote --heads --tags "$URL")
  NAME=${REF#refs/heads/}
  NAME=${NAME#refs/tags/}
  # A branch first, then the commit an annotated tag points at, then a lightweight tag.
  SHA=""
  for want in "refs/heads/$NAME" "refs/tags/$NAME^{}" "refs/tags/$NAME"; do
    SHA=$(awk -v want="$want" '$2 == want { print $1; exit }' <<<"$REFS")
    [ -n "$SHA" ] && break
  done
  if [ -z "$SHA" ]; then
    echo "ios-backup-core has no branch or tag called '$NAME' ($URL)." >&2
    exit 1
  fi
fi

OLD=""
[ -f "$PIN" ] && OLD=$(tr -d '[:space:]' < "$PIN")
if [ "$OLD" = "$SHA" ]; then
  echo "ios-backup-core.ref already pins $SHA ($REF). Nothing to do."
  exit 0
fi
printf '%s\n' "$SHA" > "$PIN"

echo "ios-backup-core.ref: ${OLD:-(none)} -> $SHA ($REF)"
if [ -n "$OLD" ]; then
  echo "What changed: https://github.com/charleswest775/ios-backup-core/compare/$OLD...$SHA"
fi
cat <<EOF

Next:
  1. Run the tests against that commit. Check it out in the ios-backup-core checkout the
     engine uses (../ios-backup-core beside this repo; the corpus tests also take
     \$OPENEXTRACT_IOS_BACKUP_CORE):
       git -C ../ios-backup-core fetch origin
       git -C ../ios-backup-core checkout --detach $SHA
       npm test
       pytest python/tests -q
       pytest python/tests/corpus -m corpus -q
  2. Commit ios-backup-core.ref on a branch and open a PR: CI tests the new commit on Linux,
     macOS and Windows. Releases build whatever the pin says on main, so merge it before
     releasing ios-backup-core's fixes.
EOF
