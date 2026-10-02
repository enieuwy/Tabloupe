<p align="center">
  <img src="icons/icon.svg" alt="Tabloupe" width="120" height="120">
</p>

# Tabloupe

Save and switch views of your Firefox tab groups. A **lens** is a saved view: switching to it expands the groups you care about and collapses the rest. Tabs stay open — nothing is closed, nothing is lost.

Firefox 142+ (uses the `tabGroups` API). This branch also packages a Chromium 123+ MV3 prototype. Chromium runtime verification remains blocked in the overnight environment.

## Features

- **Lenses** — save groups as named views. Match by title, glob, container, color, restricted regex, or exact URL host. Share one lens or an entire pack; import optional Developer, Researcher, and Shopping templates.
- **Tab Search** — a Chrome-style overlay (default `Ctrl+S`) with fuzzy search across windows. Bulk actions include moving tabs to an existing window. Optional bookmark and native recently-closed results sit beside history and web search. Closing a tab offers **Undo last close** when session access exists.
- **AI tab grouping** — opt-in, preview-before-apply clustering through the optional Apple Intelligence helper or a configured OpenAI-compatible endpoint. **Include existing groups** allows re-clustering; pinned and privileged tabs stay unchanged. **Suggest a lens** offers an editable name and selectors before saving. A real provider is required; this branch's overnight profile has none.
- **Automation (optional)** — activate lenses from macOS Focus, schedules, or browser-fetched ICS subscriptions. The popup also supports timed focus for 1–240 minutes. A later manual or automation switch cancels the timer's return.
- **Performance** — optionally discard tabs in collapsed groups to reclaim memory; pinned, active, and audio-playing tabs are never touched.
- **Sync** — optionally mirror lenses, schedules, and shortcuts through Firefox Sync. API keys and provider settings never sync.
- **Workspace snapshots** — save a lens's matching web tabs locally, then restore missing URLs into same-title groups. Snapshots never sync. Restoration creates fresh tabs, without navigation history, scroll position, or container identity.
- **Native entry points** — type `tl` and Space in the address bar to find tabs and lenses, including from privileged pages. Options → General enables lens actions in tab/page context menus.
- **Usage insights** — Options → Activity shows time per lens, trigger share, and daily/weekly totals from local session history, including the current session.

## Install

Until the AMO listing is live, build and install from source:

```sh
npm ci
./build.sh            # signs an unlisted build; drops an .xpi in web-ext-artifacts/
```

Then `about:addons` → gear menu → *Install Add-on From File…* and pick the `.xpi`. Signing requires AMO API keys in `.env` (see `build.sh`).

`./build.sh listed` can succeed while AMO signing is still pending. The accepted submission keeps its version reserved. Install only when the script reports a matching artifact. `deploy.sh` checks the XPI's embedded version against `manifest.json` before taking a Firefox session snapshot or showing install instructions.

For development, run it in a throwaway profile instead:

```sh
npx web-ext run --firefox=deved
```

Package unsigned builds without credentials, publication, or a version bump:

```sh
./build.sh both
# dist/firefox and dist/chromium contain unpacked extensions.
# dist/tabloupe-{firefox,chromium}-<version>.zip contains each package.
```

Load `dist/chromium` through Chrome/Edge's **Load unpacked** control. Firefox-only container controls degrade when the API is absent.

## Usage

1. Arrange a window's tab groups, open the popup, and *Save current groups as a lens*.
2. Switch lenses from the popup, or bind keys in Options → Shortcuts (activate lens 1–9, cycle, show all).
3. `Ctrl+S` opens Tab Search on any web page. Multi-select with checkboxes, ⌘/Ctrl-click, or Shift-click to unlock bulk actions.
4. *Organize tabs…* in the popup runs AI grouping: preview the proposal, then Apply — or Dismiss.

Everything else — selector editing, schedules, calendar patterns, container rules, sync, backup — lives in the Options page.

Untitled groups appear as **Untitled group** during onboarding and in Options. Saving them creates an empty-title selector, which matches untitled groups without matching named groups.

Tab Search browse mode includes every open tab; only ranked search results have a display cap. Dragging onto a row or group header affects only tabs in the target window.
### Calendar subscriptions

In Options → Automation, enter up to five HTTPS or `webcal` ICS URLs, one per line. Save grants access only to their hosts. Loopback HTTP URLs also work for local feeds. Add calendar-title patterns to the desired lens. The browser checks active events every minute and fetches feeds every 15 minutes; **Refresh calendars** fetches immediately. Configured subscriptions replace the daemon's calendar source, not its Focus source.

Feeds must include `VTIMEZONE` definitions for named time zones. Invalid feeds show an error instead of acting as an empty calendar. A failed refresh retains known events only until their recorded end. Subscription URLs can contain private tokens; the extension stores them locally.

### Isolated overnight demo

```sh
./build.sh both
node demo/prepare.cjs firefox
node demo/server.cjs
# In another terminal:
npx --no-install web-ext run --source-dir demo/fixture-firefox \
  --firefox=/Applications/Firefox.app/Contents/MacOS/firefox \
  --firefox-profile .demo-profile/firefox --profile-create-if-missing \
  --keep-profile-changes --no-reload --no-input --args=-headless --verbose
# Use the debugger port printed by web-ext:
node demo/run-firefox.cjs <port>
```

The driver refuses profiles outside this worktree's `.demo-profile` directory. It resets only that disposable browser, uses real extension handlers, and waits for a real one-minute timer. The fixture manifest grants demo-only bookmark/session/loopback access at installation; production permission prompts remain unchanged. JSON results and captured Firefox screenshots live in `demo/evidence/`. The AI demo reports its missing-provider blocker rather than substituting a fake response.

Close other add-on debugger sessions before running the driver. Firefox can stall a second extension watcher. For a visible manual demo, omit `--args=-headless`.

## Optional macOS helper

`mac-command-centre` is a small Swift daemon (not yet published) that provides Focus-mode and calendar triggers plus on-device AI grouping over a local WebSocket (`ws://127.0.0.1:8767`). It is entirely optional: manual lens switching works on every OS without it.

Pair the two by running `mac-command-centre pairing-token` and pasting the token into Options → Automation. Connections are then mutually authenticated (HMAC challenge-response); see [`docs/local-bus-protocol.md`](docs/local-bus-protocol.md) for the frame reference if you want to drive the bus from your own tools.

## Privacy

No telemetry, analytics, or accounts. Calendar subscriptions download from the hosts you explicitly allow. A configured remote AI endpoint receives tab titles and hostnames for the requested grouping. Other data stays on your machine, apart from opt-in browser Sync. Backup export excludes API keys. The permissions rationale is in [`docs/amo-listing.md`](docs/amo-listing.md).

Tab Search uses local generic icons instead of loading other tabs' favicon URLs into the current page.

## Development

```sh
npm ci
npm run verify        # web-ext lint + node --test (260+ tests) + npm audit
```

Run `bash tests/signing.test.sh` for offline signing/deployment smoke checks. It uses temporary profiles, synthetic XPIs, and a stub signer; it does not contact AMO.

The shared code is unminified vanilla JS. `background.js` owns the lens model, activation, and AI bus. `calendar-runtime.js` handles ICS polling; `native-runtime.js` handles bookmarks, window moves, menus, and omnibox events. `browser-compat.js` adapts Chromium APIs, and `service-worker.js` loads the shared modules for MV3. `scripts/package.cjs` copies an explicit file list for each manifest. Architecture notes live in `AGENTS.md`.

## License

[MIT](LICENSE)

The bundled `ical.js` parser is MPL-2.0; its license is in `vendor/ICAL-LICENSE`.
