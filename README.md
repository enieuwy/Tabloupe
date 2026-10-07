<p align="center">
  <img src="icons/icon.svg" alt="Tabloupe" width="120" height="120">
</p>

# Tabloupe

Save and switch views of your Firefox tab groups. A **lens** is a saved view: switching to it expands the groups you care about and collapses the rest. Tabs stay open — nothing is closed, nothing is lost.

Firefox 142+ (uses the `tabGroups` API).

## Features

- **Lenses** — save groups as named views. Match by title, glob, container, color, restricted regex, or exact URL host. Share one lens or an entire pack; import optional Developer, Researcher, and Shopping templates.
- **Tab Search** — a Chrome-style overlay (default `Ctrl+S`) with fuzzy search across windows. Bulk actions include moving tabs to an existing window. Optional bookmark and native recently-closed results sit beside history and web search. Closing a tab offers **Undo last close** when session access exists.
- **AI tab grouping** — opt-in, preview-before-apply clustering of ungrouped tabs through the optional Apple Intelligence helper or a configured OpenAI-compatible endpoint. Pinned and privileged tabs stay unchanged.
- **Automation (optional)** — activate lenses from macOS Focus, schedules, or browser-fetched ICS subscriptions. The popup also supports timed focus for 1–240 minutes. A later manual or automation switch cancels the timer's return.
- **Performance** — optionally discard tabs in collapsed groups to reclaim memory; pinned, active, and audio-playing tabs are never touched.
- **Sync** — optionally mirror lenses, schedules, and shortcuts through Firefox Sync. API keys and provider settings never sync.
- **Workspace snapshots** — save a lens's matching web tabs locally, then restore missing URLs into same-title groups. Untitled groups keep separate membership and colors. Snapshots never sync. Restoration creates fresh tabs, without navigation history, scroll position, or container identity.
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
./build.sh firefox
# dist/firefox contains the unpacked extension.
# dist/tabloupe-firefox-<version>.zip contains the unsigned package.
```


## Usage

1. Arrange a window's tab groups, open the popup, and *Save current groups as a lens*.
2. Switch lenses from the popup, or bind keys in Options → Shortcuts (activate lens 1–9, cycle, show all).
3. `Ctrl+S` opens Tab Search on any web page. Multi-select with checkboxes, ⌘/Ctrl-click, or Shift-click to unlock bulk actions.
4. *Organize tabs…* in the popup runs AI grouping: preview the proposal, then Apply — or Dismiss.

Everything else — selector editing, schedules, calendar patterns, container rules, sync, backup — lives in the Options page.

Untitled groups appear as **Untitled group** during onboarding and in Options. Saving them creates an empty-title selector, which matches untitled groups without matching named groups.

Tab Search browse mode includes every open tab; only ranked search results have a display cap. Dragging onto a row or group header affects only tabs in the target window.

Selector and calendar-pattern edits commit in order. A failed write leaves the last saved values in place.

### Calendar subscriptions

In Options → Automation, enter up to five HTTPS or `webcal` ICS URLs, one per line. Save grants access only to their hosts. Loopback HTTP URLs also work for local feeds. Add calendar-title patterns to the desired lens. The browser checks active events every minute and fetches feeds every 15 minutes; **Refresh calendars** fetches immediately. Configured subscriptions replace the daemon's calendar source, not its Focus source.

Feeds must include `VTIMEZONE` definitions for named time zones. A failed source shows an error while other sources continue. Known events expire at their recorded end, even when a feed remains unavailable. Editing subscriptions drops queued events from the old sources and refreshes the current sources. Subscription URLs can contain private tokens; the extension stores them locally.

### Isolated overnight demo

```sh
./build.sh firefox
node demo/prepare.cjs firefox
node demo/server.cjs
mkdir -p .demo-profile/firefox
# In another terminal:
npx --no-install web-ext run --source-dir demo/fixture-firefox \
  --firefox=/Applications/Firefox.app/Contents/MacOS/firefox \
  --firefox-profile .demo-profile/firefox --profile-create-if-missing \
  --keep-profile-changes --no-reload --no-input --args=-headless --verbose
# Use the debugger port printed by web-ext:
node demo/run-firefox.cjs <port>
```

The driver refuses profiles outside this worktree's `.demo-profile` directory. It resets only that disposable browser, uses real extension handlers, and waits for a real one-minute timer. The fixture manifest grants demo-only bookmark/session/loopback access at installation; production permission prompts remain unchanged. JSON results live in `demo/evidence/`.

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

The code is unminified vanilla JS. `background.js` owns the lens model, activation, snapshots, timers, and AI bus. `calendar-runtime.js` handles ICS polling; `native-runtime.js` handles bookmarks, window moves, menus, and omnibox events. `scripts/package.cjs` copies the Firefox package's explicit file list. Architecture notes live in `AGENTS.md`.

## License

[MIT](LICENSE)

The bundled `ical.js` parser is MPL-2.0; its license is in `vendor/ICAL-LICENSE`.
