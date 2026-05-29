# Agent Knowledge Base: Focus Tab Groups

## Architecture
- **Daemon:** `mac-command-centre` (Swift) listens for macOS Focus mode changes via `DistributedNotificationCenter`, reads the active ID from `Assertions.json`, maps it to a tab group string, and broadcasts it over a `ws://127.0.0.1:8767` WebSocket.
- **Client:** `focus-tab-groups` (Firefox Extension) maintains a persistent WebSocket connection and calls the `tabGroups` API to collapse/expand groups matching the string.

## Extension Deployment & Updates
- **Standard Firefox enforces extension signing.** You cannot simply load an unsigned local extension permanently unless you use Developer Edition/Nightly.
- **Signing:** Use `web-ext sign --channel="unlisted"` with Mozilla Add-ons (AMO) API keys. The keys are stored in `.env`.
- **Automated Build:** Run `./build.sh`. It automatically bumps the patch version in `manifest.json` (required by AMO), signs the code, and drops a new `.xpi` in `web-ext-artifacts/`.
- **Manual Installation:** After building, you *must* manually go to `about:addons` ➡️ ⚙️ ➡️ "Install Add-on From File..." and select the new `.xpi`. Firefox will replace the old version.

## Key Gotchas & Limitations
- **`Assertions.json` Fragility:** Apple provides no public API for reading the *name* of the current Focus mode. We parse `~/Library/DoNotDisturb/DB/Assertions.json`. The schema for this JSON file varies wildly across macOS versions. See `FocusObserver.swift` in `mac-command-centre` for the three fallback key-paths required to extract the ID.
- **Browser Suspension:** Firefox may put the extension's background event page to sleep. `background.js` handles WebSocket disconnects by running an exponential backoff reconnect loop (with a `browser.alarms` fallback).
- **Instant State Recovery:** On a fresh WebSocket connection, the Swift daemon instantly pushes the *current* state. This ensures a restarting browser doesn't have to wait for the *next* focus change to sync.
- **Port Conflicts:** The WebSocket runs on `8767`. In the extension manifest, this requires `"host_permissions": ["ws://127.0.0.1/*"]`.

## Eliminated Cruft
- **Hammerspoon:** Removed `focus_filter.lua`. Detection logic moved to `mac-command-centre`.
- **Rust Host / Unix Sockets / Native Messaging:** Completely bypassed. A direct WebSocket from Swift to Firefox is lighter, requires fewer permissions, and creates a generic event bus for future local apps.
