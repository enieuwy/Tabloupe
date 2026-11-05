#!/bin/bash
set -euo pipefail
# Automatically bumps version, loads API keys, and signs the Firefox extension.

usage() {
  echo "Usage: $0 [unlisted|listed|firefox]" >&2
  exit 2
}

CHANNEL="${1:-unlisted}"
if [[ $# -gt 1 ]]; then
  usage
fi

case "$CHANNEL" in
  unlisted|listed) ;;
  firefox)
    node scripts/package.cjs "$CHANNEL"
    exit
    ;;
  *) usage ;;
esac

# 1. Load secrets from .env
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
else
  echo "Error: .env file not found. Cannot load API keys."
  exit 1
fi

if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
  echo "Error: API keys missing from .env"
  exit 1
fi

# Acquire an exclusive repo-scoped lock around the whole
# snapshot -> bump -> sign -> cleanup transaction. macOS has no flock by
# default, so the lock is a directory that a single rename publishes; only one
# build runs at a time.
#
# The lock directory doubles as a discoverable transaction record: it holds the
# owning PID, the pre-bump manifest, and the transaction state. The PID is inside
# before the lock appears, so every lock names its owner. A build killed by
# SIGKILL, the OOM killer, or a power cut never runs its EXIT trap, so the next
# build attributes the leftover lock to its (dead) owner and resolves the
# interrupted transaction itself instead of demanding a manual rmdir.
LOCK_DIR=".build.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_MANIFEST_FILE="$LOCK_DIR/manifest.json.orig"
LOCK_STATE_FILE="$LOCK_DIR/state"
# Recovery itself is mutually exclusive, or two builds could each delete the
# lock the other had just re-created.
RECOVERY_LOCK_DIR=".build.lock.recovery"
HOLD_LOCK=false
SUBMISSION_ACCEPTED=false

# Replace a file in a single rename so a kill mid-write can never leave a torn
# manifest or a torn transaction record behind. Staging names end in `.part`, so
# a leftover beside the manifest matches the ignore rules and the recovery sweep.
atomic_write() {
  local destination="$1"
  local part="$destination.$$.part"
  cat >"$part"
  mv -f "$part" "$destination"
}

atomic_copy() {
  local source="$1" destination="$2"
  local part="$destination.$$.part"
  cp "$source" "$part"
  mv -f "$part" "$destination"
}

manifest_version() {
  python3 - "${1:-manifest.json}" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())["version"])
PY
}

# A snapshot is only trustworthy for rollback if it still parses as a manifest
# carrying a real version, so a torn snapshot is ignored rather than restored.
manifest_is_valid() {
  python3 - "$1" <<'PY'
import json
import re
import sys
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text())
except (OSError, ValueError):
    sys.exit(1)
version = data.get("version") if isinstance(data, dict) else None
sys.exit(0 if isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version) else 1)
PY
}

txn_state() {
  [[ -f "$LOCK_STATE_FILE" ]] || return 0
  tr -d '[:space:]' <"$LOCK_STATE_FILE"
}

set_txn_state() {
  printf '%s\n' "$1" | atomic_write "$LOCK_STATE_FILE"
}

lock_owner_pid() {
  local pid
  # The owner may release the lock between any check and this read.
  pid="$(tr -d '[:space:]' 2>/dev/null <"$LOCK_PID_FILE")" || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  printf '%s' "$pid"
}

# `ps -p` is POSIX and reports processes owned by other users, which `kill -0`
# cannot do (it fails with EPERM and looks like "gone"). A killed build whose
# parent has not reaped it yet lingers as a zombie that still has a ps row, so
# zombies count as dead, and a PID the system has since recycled for another
# program is not a build. Nor is this build: it failed to publish the lock, so a
# record naming its PID was left by an earlier build that had the same PID (PID
# namespaces hand a container's build the same PID on every run). The `kill -0`
# fallback covers a hostless ps.
owner_alive() {
  local state cmdline
  [[ "$1" != "$$" ]] || return 1
  if command -v ps >/dev/null 2>&1; then
    state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$state" && "$state" != Z* ]] || return 1
    cmdline="$(ps -p "$1" -o command= 2>/dev/null)"
    [[ "$cmdline" == *build.sh* ]]
    return
  fi
  kill -0 "$1" 2>/dev/null
}

# Succeeds while the lock may belong to a running build, and leaves the recorded
# owner in LOCK_OWNER. A build publishes its lock with the PID already inside, so
# a lock without one comes from a build.sh that predates PID records (or was made
# by hand). Its age proves nothing about its creator, so it is never recovered.
LOCK_OWNER=""
lock_held() {
  LOCK_OWNER="$(lock_owner_pid)"
  [[ -d "$LOCK_DIR" ]] || return 1
  [[ -n "$LOCK_OWNER" ]] || return 0
  owner_alive "$LOCK_OWNER"
}

report_held_lock() {
  if [[ -n "$LOCK_OWNER" ]]; then
    echo "Error: another build is already running (PID $LOCK_OWNER holds '$LOCK_DIR')." >&2
    return
  fi
  echo "Error: build lock '$LOCK_DIR' records no owner, so a build may still be using it." >&2
  echo "If no build is running, an older build.sh left it; remove it with: rmdir '$LOCK_DIR'" >&2
}

# rename() quietly replaces an empty directory, which is exactly what a lock
# left by a build.sh without PID records looks like, so any existing lock wins.
publish_lock() {
  python3 - "$1" "$LOCK_DIR" <<'PY'
import os
import sys

staging, lock = sys.argv[1:]
if os.path.lexists(lock):
    sys.exit(1)
try:
    os.rename(staging, lock)
except OSError:
    sys.exit(1)
PY
}

# The PID goes into a private staging directory that is then renamed into place,
# so no build ever sees this lock without its owner, however long this build is
# paused or starved between the steps.
claim_lock() {
  local staging="$LOCK_DIR.$$.part"
  rm -rf -- "$staging"
  if mkdir "$staging" && printf '%s\n' "$$" >"$staging/pid" && publish_lock "$staging"; then
    HOLD_LOCK=true
    return 0
  fi
  rm -rf -- "$staging"
  return 1
}

# Take the lock out of place in one rename before deleting it, so no build ever
# sees a half-deleted lock (an emptied one would look ownerless).
remove_lock() {
  local trash="$LOCK_DIR.$$.gone"
  rm -rf -- "$trash"
  if [[ -d "$LOCK_DIR" ]]; then
    mv -- "$LOCK_DIR" "$trash"
  fi
  rm -rf -- "$trash"
}

resolve_interrupted_transaction() {
  local state stranded
  # A kill mid-bump or mid-restore can leave a staging file beside the manifest;
  # it must never reach a signed package.
  rm -f -- manifest.json.*.part
  state="$(txn_state)"
  case "$state" in
    signing|submitted)
      # The dead build had already handed this version to web-ext sign. AMO
      # reserves an accepted version permanently and we cannot tell from here
      # whether it landed, so the bumped manifest stays: rolling it back would
      # risk reusing a reserved version.
      stranded="$(manifest_version 2>/dev/null || true)"
      echo "Notice: recovered an interrupted build that had already started submitting version ${stranded:-unknown} (state: $state)." >&2
      echo "Keeping the bumped manifest — AMO does not release a submitted version. Verify the submission at AMO before rebuilding." >&2
      ;;
    *)
      # The bump either never happened or never reached submission, so the
      # pre-bump manifest is the correct state to return to.
      if [[ -f "$LOCK_MANIFEST_FILE" ]] && manifest_is_valid "$LOCK_MANIFEST_FILE"; then
        atomic_copy "$LOCK_MANIFEST_FILE" manifest.json
        echo "Notice: recovered an interrupted build; manifest.json rolled back to version $(manifest_version)." >&2
      else
        echo "Notice: recovered an interrupted build with no usable manifest snapshot; manifest.json left as it is." >&2
      fi
      ;;
  esac
}

if ! claim_lock; then
  if lock_held; then
    report_held_lock
    exit 1
  fi
  if ! mkdir "$RECOVERY_LOCK_DIR" 2>/dev/null; then
    echo "Error: another build is already recovering the stale lock '$LOCK_DIR'." >&2
    echo "If no build is running, a recovery was killed; remove its lock with: rmdir '$RECOVERY_LOCK_DIR'" >&2
    exit 1
  fi
  RECOVERED=false
  # Re-check under the recovery lock: the owner may have exited (and cleaned up)
  # or a fresh build may have claimed the lock since the first look.
  if [[ ! -d "$LOCK_DIR" ]]; then
    RECOVERED=true
  elif lock_held; then
    report_held_lock
  else
    echo "Notice: build lock '$LOCK_DIR' is stale (owner PID ${LOCK_OWNER:-unknown} is gone) — recovering." >&2
    resolve_interrupted_transaction
    remove_lock
    RECOVERED=true
  fi
  rmdir "$RECOVERY_LOCK_DIR" 2>/dev/null || true
  if [[ "$RECOVERED" != true ]]; then
    exit 1
  fi
  if ! claim_lock; then
    echo "Error: could not acquire the build lock '$LOCK_DIR' after recovering a stale one." >&2
    exit 1
  fi
fi

cleanup() {
  # Only the build that owns the lock may act on the transaction record. A
  # refused build sees a live owner's snapshot and must leave it alone.
  if [[ "$HOLD_LOCK" != true ]]; then
    return
  fi
  if [[ "$SUBMISSION_ACCEPTED" != true && -f "$LOCK_MANIFEST_FILE" ]]; then
    atomic_copy "$LOCK_MANIFEST_FILE" manifest.json
  fi
  remove_lock
}
trap cleanup EXIT

atomic_copy manifest.json "$LOCK_MANIFEST_FILE"
set_txn_state bumping

echo "Bump version in manifest.json..."
NEW_VERSION="$(python3 - <<'PY'
import json
import os
import tempfile
from pathlib import Path

manifest = Path("manifest.json")
data = json.loads(manifest.read_text())
major, minor, patch = data["version"].split(".")
data["version"] = ".".join((major, minor, str(int(patch) + 1)))
# Write beside the manifest and rename over it, so a kill during this step
# leaves either the old manifest or the new one — never a half-written file.
handle = tempfile.NamedTemporaryFile("w", dir=".", prefix="manifest.json.",
                                     suffix=".part", delete=False)
try:
    handle.write(json.dumps(data, indent=2) + "\n")
    handle.flush()
    os.fsync(handle.fileno())
    handle.close()
    os.replace(handle.name, manifest)
except BaseException:
    os.unlink(handle.name)
    raise
print(data["version"])
PY
)"
echo "Bumped version to: $NEW_VERSION"

echo "Packaging and submitting to Mozilla ($CHANNEL)..."
# The listed channel submits the build for AMO review. The first listed
# submission creates the public listing, and the .xpi may not be signed
# immediately.
# Record the submission attempt before it starts: if this build dies mid-flight,
# recovery must not roll the version back and reuse it.
set_txn_state signing
npx --no-install web-ext sign --channel="$CHANNEL"
# A successful submission reserves this version at AMO even if signing is
# pending. Do not restore the manifest and reuse an accepted version.
SUBMISSION_ACCEPTED=true
set_txn_state submitted

XPI_PATH="$(python3 - "$NEW_VERSION" <<'PY'
import json
import sys
import zipfile
from pathlib import Path

files = sorted(Path("web-ext-artifacts").glob("*.xpi"),
               key=lambda path: path.stat().st_mtime, reverse=True)
for path in files:
    try:
        with zipfile.ZipFile(path) as archive:
            version = json.loads(archive.read("manifest.json"))["version"]
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        continue
    if version == sys.argv[1]:
        print(path)
        break
PY
)"

if [[ -z "$XPI_PATH" ]]; then
  if [[ "$CHANNEL" == listed ]]; then
    echo "Submission accepted for version $NEW_VERSION; signing is pending."
    echo "No matching .xpi is available. Do not install an older artifact for this version."
    exit 0
  fi
  echo "Error: submission accepted for version $NEW_VERSION, but no matching .xpi is available." >&2
  exit 1
fi

# Keep the newest signed artifacts, and always retain the matching installable
# artifact even if an older version has a newer modification time.
KEEP_ARTIFACTS=5
if [[ -d web-ext-artifacts ]]; then
  shopt -s nullglob
  artifacts=(web-ext-artifacts/*.xpi)
  shopt -u nullglob
  if ((${#artifacts[@]} > KEEP_ARTIFACTS)); then
    while IFS= read -r old_xpi; do
      [[ "$old_xpi" == "$XPI_PATH" ]] && continue
      rm -f "$old_xpi"
    done < <(ls -t "${artifacts[@]}" | tail -n +$((KEEP_ARTIFACTS + 1)))
  fi
fi

echo "Done! Install version $NEW_VERSION from $XPI_PATH via about:addons"
