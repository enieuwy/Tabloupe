#!/bin/bash
set -euo pipefail
# Automatically bumps version, loads API keys, and signs the Firefox extension.

usage() {
  echo "Usage: $0 [unlisted|listed]" >&2
  exit 2
}

CHANNEL="${1:-unlisted}"
if [[ $# -gt 1 ]]; then
  usage
fi

case "$CHANNEL" in
  unlisted|listed) ;;
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
# snapshot -> bump -> sign -> cleanup transaction. mkdir is atomic and
# portable (macOS has no flock by default), so only one build runs at a time.
LOCK_DIR=".build.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Error: another build is already running (lock '$LOCK_DIR' is held)." >&2
  echo "If no build is running, this lock is stale — remove it with: rmdir '$LOCK_DIR'" >&2
  exit 1
fi

SUBMISSION_ACCEPTED=false
ORIGINAL_MANIFEST=""

cleanup() {
  if [[ "$SUBMISSION_ACCEPTED" != true && -n "$ORIGINAL_MANIFEST" ]]; then
    cp "$ORIGINAL_MANIFEST" manifest.json
  fi
  [[ -n "$ORIGINAL_MANIFEST" ]] && rm -f "$ORIGINAL_MANIFEST"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

ORIGINAL_MANIFEST="$(mktemp)"
cp manifest.json "$ORIGINAL_MANIFEST"

echo "Bump version in manifest.json..."
NEW_VERSION="$(python3 - <<'PY'
import json
from pathlib import Path

manifest = Path("manifest.json")
data = json.loads(manifest.read_text())
major, minor, patch = data["version"].split(".")
data["version"] = ".".join((major, minor, str(int(patch) + 1)))
manifest.write_text(json.dumps(data, indent=2) + "\n")
print(data["version"])
PY
)"
echo "Bumped version to: $NEW_VERSION"

echo "Packaging and submitting to Mozilla ($CHANNEL)..."
# The listed channel submits the build for AMO review. The first listed
# submission creates the public listing, and the .xpi may not be signed
# immediately.
npx --no-install web-ext sign --channel="$CHANNEL"
# A successful submission reserves this version at AMO even if signing is
# pending. Do not restore the manifest and reuse an accepted version.
SUBMISSION_ACCEPTED=true

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
