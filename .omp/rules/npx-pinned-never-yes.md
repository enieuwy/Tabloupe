---
name: npx-pinned-never-yes
description: "Never npx -y / --yes in this repo — AMO signing secrets are in the environment, and -y fetches an unpinned registry package"
condition:
  - 'npx (-y|--yes)\b'
  - 'npx (?!--no-install)[^\n]*web-ext'
scope: ["tool:bash"]
interruptMode: always
---

**`build.sh` and `deploy.sh` run with AMO signing secrets in the environment** (`.env` → `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`). `npx -y` answers "yes, install whatever the registry hands me" — an unpinned package, executing with those credentials in reach. That is the whole reason every invocation in this repo is:

```bash
npx --no-install web-ext …    # build.sh:78, deploy.sh:143, deploy.sh:186
```

`--no-install` resolves **only** the lockfile-pinned local `web-ext` and fails loudly if it is missing, rather than silently fetching a new one. The fix for "web-ext not found" is `npm ci`, never `-y`.

Nothing checks this: CI runs `npm ci --ignore-scripts`, `npm run verify`, and `npm run audit` (`.github/workflows/ci.yml`), none of which inspect how a local script invokes npx. The `npx -y` prohibition exists in exactly one place in the tree — the `AGENTS.md:50` sentence — and prose does not stop a command.

If you genuinely need a package that is not in the lockfile, add it as a dev dependency and `npm ci`, so the version is pinned and auditable.
