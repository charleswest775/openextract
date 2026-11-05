#!/usr/bin/env bash
# OpenExtract's Windows smoke test: copies a commit (or installs a release) on a Windows PC
# over SSH, runs the Python suite and npm test there, then drives Back up my iPhone in the
# signed-in user's session, and brings back a summary and screenshots. See SKILL.md.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: smoke.sh [--commit REF | --working-tree | --release TAG] [options]

What to test (default: --commit HEAD)
  --commit REF            this commit, with the dev build of the app
  --working-tree          this checkout as it is, uncommitted changes included
  --release TAG           install this release's Windows installer (drafts too) over the
                          PC's OpenExtract and drive it; tests run on TAG's commit.
                          Installs software on the PC: ask the maintainer first.
Options
  --ios-backup-core REF   ios-backup-core commit (default: origin/master, as CI uses)
  --skip-tests            don't run pytest and npm test
  --skip-app              don't drive the app
  --require-device        fail unless an iPhone or iPad is listed (plug one in, unlock it)
  --start-backup          back up the first device until files arrive, then stop and
                          delete it (someone may need to enter the iPhone's passcode)
  --fresh-apple-devices   uninstall Apple Devices first, so Install Apple Devices runs
                          winget. Changes the PC: ask the maintainer first.
  --out DIR               where results go (default: $TMPDIR/openextract-windows-smoke)

Settings, from the environment or ~/.config/openextract/windows-smoke.env:
  OPENEXTRACT_SMOKE_HOST        user@host of the Windows PC (required)
  OPENEXTRACT_SMOKE_SSH_OPTS    extra ssh/scp options, e.g. "-o HostKeyAlias=..."
  OPENEXTRACT_IOS_BACKUP_CORE   ios-backup-core checkout (default: next to the main checkout)
EOF
}

config="${OPENEXTRACT_SMOKE_CONFIG:-$HOME/.config/openextract/windows-smoke.env}"
# shellcheck disable=SC1090
[ -f "$config" ] && . "$config"

mode=commit ref=HEAD ibc_ref=origin/master out="${TMPDIR:-/tmp}/openextract-windows-smoke"
options=()
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) mode=commit ref="$2"; shift ;;
    --working-tree) mode=worktree ;;
    --release) mode=release ref="$2"; shift ;;
    --ios-backup-core) ibc_ref="$2"; shift ;;
    --skip-tests) options+=(SkipTests) ;;
    --skip-app) options+=(SkipApp) ;;
    --require-device) options+=(RequireDevice) ;;
    --start-backup) options+=(StartBackup) ;;
    --fresh-apple-devices) options+=(FreshAppleDevices) ;;
    --out) out="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

host="${OPENEXTRACT_SMOKE_HOST:?Set OPENEXTRACT_SMOKE_HOST (user@host of the Windows PC), or put it in $config}"
# shellcheck disable=SC2206
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 ${OPENEXTRACT_SMOKE_SSH_OPTS:-})
pc() { ssh "${ssh_opts[@]}" "$host" "$@"; }

repo="$(git rev-parse --show-toplevel)"
skill="$(cd "$(dirname "$0")" && pwd)"
main_checkout="$(dirname "$(cd "$(git -C "$repo" rev-parse --git-common-dir)" && pwd)")"
ibc="${OPENEXTRACT_IOS_BACKUP_CORE:-$(dirname "$main_checkout")/ios-backup-core}"
[ -d "$ibc/.git" ] || { echo "No ios-backup-core checkout at $ibc; set OPENEXTRACT_IOS_BACKUP_CORE" >&2; exit 2; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# ── What to test ──────────────────────────────────────────────────────────────
case "$mode" in
  commit)
    sha="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
    git -C "$repo" archive --format=tar.gz -o "$stage/repo.tgz" "$sha"
    source="commit ${sha:0:12} ($(git -C "$repo" log -1 --format=%s "$sha"))" ;;
  worktree)
    # Tracked and new files as they are on disk (deleted ones left out); no AppleDouble files.
    (cd "$repo" && git ls-files -z --cached --others --exclude-standard |
      while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s\0' "$f"; done |
      COPYFILE_DISABLE=1 tar --null -T - -czf "$stage/repo.tgz")
    source="working tree on $(git -C "$repo" rev-parse --short=12 HEAD)$(git -C "$repo" diff --quiet HEAD && echo '' || echo ', with uncommitted changes')" ;;
  release)
    slug="$(cd "$repo" && gh repo view --json nameWithOwner --jq .nameWithOwner)"
    git -C "$repo" fetch -q origin "refs/tags/$ref:refs/tags/$ref" 2>/dev/null || true
    sha="$(git -C "$repo" rev-parse --verify "refs/tags/$ref^{commit}")"
    git -C "$repo" archive --format=tar.gz -o "$stage/repo.tgz" "$sha"
    echo "Downloading $ref's Windows installer..."
    gh release download "$ref" --repo "$slug" --pattern 'OpenExtract-Setup-*.exe' --dir "$stage"
    source="release $ref (commit ${sha:0:12})" ;;
esac
git -C "$ibc" fetch -q origin
ibc_sha="$(git -C "$ibc" rev-parse --verify "$ibc_ref^{commit}")"
git -C "$ibc" archive --format=tar.gz -o "$stage/ibc.tgz" "$ibc_sha"
printf '%s\n' "$source" > "$stage/source.txt"
printf '%s\n' "$ibc_sha" > "$stage/ibc.txt"
cp "$skill"/pc/*.ps1 "$stage/"

# ── Copy it over and start ────────────────────────────────────────────────────
run="$(date +%Y%m%d-%H%M%S)"
win_dir="%USERPROFILE%\\oe-smoke\\runs\\$run"
echo "Smoke run $run: $source"
pc "mkdir $win_dir" >/dev/null
scp -q "${ssh_opts[@]}" "$stage"/* "$host:oe-smoke/runs/$run/"
start_args=(-RunDir "$win_dir")
[ ${#options[@]} -gt 0 ] && start_args+=(-Options "$(IFS=,; echo "${options[*]}")")
[ "$mode" = release ] && start_args+=(-Release "$ref")
pc "powershell -NoProfile -ExecutionPolicy Bypass -File $win_dir\\start.ps1 ${start_args[*]}"

# ── Follow its log ────────────────────────────────────────────────────────────
seen=0 began=$(date +%s) status=
while :; do
  if ! reply="$(pc "powershell -NoProfile -ExecutionPolicy Bypass -File $win_dir\\poll.ps1 -RunDir $win_dir -Skip $seen" | tr -d '\r')"; then
    echo "(can't reach the PC; trying again)"; sleep 20; continue
  fi
  lines="$(printf '%s\n' "$reply" | grep -v '^::' || true)"
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines"
    seen=$((seen + $(printf '%s\n' "$lines" | grep -c '')))
  fi
  case "$reply" in
    *'::done::'*) status="$(printf '%s\n' "$reply" | sed -n 's/^::done:: *//p')"; break ;;
    *'::stopped::'*) if [ $(( $(date +%s) - began )) -gt 60 ]; then echo "The run stopped before it finished; see its log on the PC: $win_dir"; status=1; break; fi ;;
  esac
  if [ $(( $(date +%s) - began )) -gt 7200 ]; then echo 'Gave up after two hours'; status=1; break; fi
  sleep 10
done

# ── Bring back the results ────────────────────────────────────────────────────
mkdir -p "$out"
rm -rf "${out:?}/$run"
scp -q -r "${ssh_opts[@]}" "$host:oe-smoke/runs/$run/out" "$out/$run" || echo "Couldn't copy the results back"
echo
[ -f "$out/$run/summary.txt" ] && sed $'s/^\xEF\xBB\xBF//' "$out/$run/summary.txt"
echo
echo "Results: $out/$run (log.txt, results.json, *.txt per step)"
shots=$(find "$out/$run" -name '*.png' 2>/dev/null | sort)
[ -n "$shots" ] && printf 'Screenshots:\n%s\n' "$shots"
exit "${status:-1}"
