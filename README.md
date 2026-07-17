<p align="center">
  <img src="icons/icon.svg" alt="Tabloupe" width="120" height="120">
</p>

# Tabloupe

Save and switch views of your Firefox tab groups. A **lens** is a saved view: switching to it expands the groups you care about and collapses the rest. Tabs stay open — nothing is closed, nothing is lost.

Firefox 142+ (uses the `tabGroups` API).

## Features

- **Lenses** — save the current window's groups as a named view, or build one from title/glob/container selectors. Switch from the toolbar popup, with keyboard shortcuts, or automatically.
- **Tab Search** — a Chrome-style overlay (default `Ctrl+S`) with fuzzy search across every window: switch, close, group, pin, discard, move between windows and containers, select duplicates, drag to reorder, plus history and web-search fallback rows.
- **AI tab grouping** — opt-in, preview-before-apply clustering of ungrouped tabs into named topic groups. Runs on-device via Apple Intelligence (with the optional macOS helper) or against any OpenAI-compatible endpoint you configure — including local ones like Ollama. Never touches your existing groups or pinned tabs.
- **Automation (optional)** — activate lenses from macOS Focus modes, per-lens time schedules, or calendar events, with per-window overrides and a manual-always-wins guarantee.
- **Performance** — optionally discard tabs in collapsed groups to reclaim memory; pinned, active, and audio-playing tabs are never touched.
- **Sync** — optionally mirror lenses, schedules, and shortcuts through Firefox Sync. API keys and provider settings never sync.

## Install

Until the AMO listing is live, build and install from source:

```sh
npm ci
./build.sh            # signs an unlisted build; drops an .xpi in web-ext-artifacts/
```

Then `about:addons` → gear menu → *Install Add-on From File…* and pick the `.xpi`. Signing requires AMO API keys in `.env` (see `build.sh`).

For development, run it in a throwaway profile instead:

```sh
npx web-ext run --firefox=deved
```

## Usage

1. Arrange a window's tab groups, open the popup, and *Save current groups as a lens*.
2. Switch lenses from the popup, or bind keys in Options → Shortcuts (activate lens 1–9, cycle, show all).
3. `Ctrl+S` opens Tab Search on any web page. Multi-select with checkboxes, ⌘/Ctrl-click, or Shift-click to unlock bulk actions.
4. *Organize tabs…* in the popup runs AI grouping: preview the proposal, then Apply — or Dismiss.

Everything else — selector editing, schedules, calendar patterns, container rules, sync, backup — lives in the Options page.

## Optional macOS helper

`mac-command-centre` is a small Swift daemon (not yet published) that provides Focus-mode and calendar triggers plus on-device AI grouping over a local WebSocket (`ws://127.0.0.1:8767`). It is entirely optional: manual lens switching works on every OS without it.

Pair the two by running `mac-command-centre pairing-token` and pasting the token into Options → Automation. Connections are then mutually authenticated (HMAC challenge-response); see [`docs/local-bus-protocol.md`](docs/local-bus-protocol.md) for the frame reference if you want to drive the bus from your own tools.

## Privacy

No telemetry, no analytics, no accounts. Everything stays on your machine unless you explicitly configure a remote AI endpoint — in which case only tab titles and hostnames of the window being organized are sent, to that endpoint alone. Backup export never includes API keys. The full permissions rationale is in [`docs/amo-listing.md`](docs/amo-listing.md).

## Development

```sh
npm ci
npm run verify        # web-ext lint + node --test (260+ tests) + npm audit
```

The codebase is unminified vanilla JS with no build step: `background.js` (event page, lens model, activation, bus client), `popup.js`, `options.js`, `tabsearch.js` (content-script overlay). Architecture notes live in `AGENTS.md`.

## License

[MIT](LICENSE)
