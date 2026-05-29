#!/bin/bash
# Automatically bumps version, loads API keys, and signs the Firefox extension.

# 1. Load secrets from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo "Error: .env file not found. Cannot load API keys."
  exit 1
fi

if [ -z "$WEB_EXT_API_KEY" ] || [ -z "$WEB_EXT_API_SECRET" ]; then
  echo "Error: API keys missing from .env"
  exit 1
fi

echo "Bump version in manifest.json..."
# Use node to parse/update manifest version safely if needed, or rely on npm version
# Note: npm version requires a package.json, which we don't have.
# Let's use a quick inline python script to bump the patch version in manifest.json
python3 -c '
import json
with open("manifest.json", "r+") as f:
    data = json.load(f)
    v = data["version"].split(".")
    v[2] = str(int(v[2]) + 1)
    data["version"] = ".".join(v)
    f.seek(0)
    json.dump(data, f, indent=2)
    f.truncate()
    print("Bumped version to:", data["version"])
'

echo "Packaging and submitting to Mozilla..."
npx -y web-ext sign --channel="unlisted"

echo "Done! You can install the new .xpi from ./web-ext-artifacts/ via about:addons"
