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

SIGN_SUCCEEDED=false
ORIGINAL_MANIFEST=""

cleanup() {
  if [[ "$SIGN_SUCCEEDED" != true && -n "$ORIGINAL_MANIFEST" ]]; then
    cp "$ORIGINAL_MANIFEST" manifest.json
  fi
  [[ -n "$ORIGINAL_MANIFEST" ]] && rm -f "$ORIGINAL_MANIFEST"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

ORIGINAL_MANIFEST="$(mktemp)"
cp manifest.json "$ORIGINAL_MANIFEST"

echo "Bump version in manifest.json..."
python3 - <<'PY'
import json
from pathlib import Path

manifest = Path("manifest.json")
data = json.loads(manifest.read_text())
major, minor, patch = data["version"].split(".")
data["version"] = ".".join((major, minor, str(int(patch) + 1)))
manifest.write_text(json.dumps(data, indent=2) + "\n")
print("Bumped version to:", data["version"])
PY

echo "Packaging and submitting to Mozilla ($CHANNEL)..."
# The listed channel submits the build for AMO review. The first listed
# submission creates the public listing, and the .xpi may not be signed
# immediately.
npx --no-install web-ext sign --channel="$CHANNEL"
SIGN_SUCCEEDED=true

echo "Done! You can install the new .xpi from ./web-ext-artifacts/ via about:addons"
