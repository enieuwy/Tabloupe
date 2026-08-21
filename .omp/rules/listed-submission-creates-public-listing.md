---
name: listed-submission-creates-public-listing
description: "./build.sh listed submits to AMO review and the first listed submission creates the permanent public listing — unlisted is the default for a reason"
condition:
  - 'build\.sh[^\n]*\blisted\b'
  - '--channel[= ]"?listed'
scope: ["tool:bash"]
interruptMode: always
---

**`listed` is not a build flavour, it is a publication.** `build.sh` defaults to `unlisted` (`CHANNEL="${1:-unlisted}"`, `build.sh:9`) precisely because the `listed` channel submits the build for AMO review, and **the first listed submission creates the public add-on listing** — which is public, permanent, indexed, and not something you can quietly undo.

Two more consequences of that path, both already handled in the script but worth knowing before you trigger it:

- The signed `.xpi` **may not come back at all** on a listed submission (review is asynchronous). Retention enumerates artifacts with a nullglob array so a missing `.xpi` cannot abort the run under `set -euo pipefail` after signing already succeeded — so "no artifact" is not evidence that anything failed.
- `build.sh` **bumps the patch version in `manifest.json`** before signing (AMO requires a fresh version). A cancelled or failed run still consumed that version number.

Normal iteration is:

```bash
./build.sh              # unlisted, self-distributed, signed, reversible
./build.sh unlisted
```

Then install manually: `about:addons` → ⚙️ → "Install Add-on From File…".

If the user explicitly asked to publish or update the public AMO listing, say so and continue.
