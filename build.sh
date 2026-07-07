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

ORIGINAL_MANIFEST="$(mktemp)"
cp manifest.json "$ORIGINAL_MANIFEST"
SIGN_SUCCEEDED=false

cleanup() {
  if [[ "$SIGN_SUCCEEDED" != true ]]; then
    cp "$ORIGINAL_MANIFEST" manifest.json
  fi
  rm -f "$ORIGINAL_MANIFEST"
}
trap cleanup EXIT

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
