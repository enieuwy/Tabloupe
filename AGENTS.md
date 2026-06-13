# Agent Knowledge Base: Focus Tab Groups

## Architecture
- **Daemon:** `mac-command-centre` (Swift) listens for macOS Focus mode changes via `DistributedNotificationCenter`, reads the active ID from `Assertions.json`, maps it to a tab group string, and broadcasts it over a `ws://127.0.0.1:8767` WebSocket.
- **Client:** `focus-tab-groups` (Firefox Extension) maintains a persistent WebSocket connection and calls the `tabGroups` API to collapse/expand groups matching the string.
- **Bidirectional bus:** The WebSocket carries two flows. Daemon→client: Focus broadcasts (`{ "focus": "<rawId>" }`). Client→daemon: AI tab-grouping requests (`{ "type": "groupTabs", … }`) answered with `{ "type": "groupTabsResult", … }`. `WebSocketServer` was broadcast-only until this; it now also `receiveMessage`s and routes inbound frames via `requestHandler`. (WireGuard/Audio commands still arrive via the file-drop control directory, not the socket — a browser can't write there.)

## AI Tab Grouping
- **What:** Clusters the current window's ungrouped tabs into named topic groups (like Safari 27's automatic tab groups). Opt-in, preview-before-apply — never silent, never touches existing manual groups or pinned/privileged (`about:`, `moz-extension:`) tabs.
- **Where the AI runs:** On-device in the daemon via Apple's FoundationModels framework (`TabGrouping/TabClusterer.swift`, `FoundationModelsTabClusterer`) — the same on-device model class behind Safari's feature. Nothing leaves the Mac. Requires macOS 26+; gated with `#if canImport(FoundationModels)` + `@available(macOS 26.0, *)` so the daemon still builds/runs on macOS 14. `SystemLanguageModel.default.availability` is checked per request; when unavailable the client gets `ok:false` + a stable `error` code (e.g. `apple_intelligence_disabled`).
- **Contract:** Client sends `[{ index, title, url }]`; daemon returns `[{ topic, tabIndices }]`. The model only proposes topics + membership — the client owns presentation (assigns tab-group colors round-robin) and re-maps indices to concrete tab ids. Both `TabGroupingSanitizer` (daemon) and `mapProposalToGroups` (client) defensively drop out-of-range/duplicate indices and empty groups.
- **Apply path:** `background.js` `applyTabGrouping` calls `browser.tabs.group({tabIds})` then `browser.tabGroups.update(groupId, {title, color})` (Firefox 139+). Generated groups are ordinary tab groups, so they participate in Focus collapse/expand automatically.
- **UX:** The toolbar button (`browser_action` → `popup.html`/`popup.js`) is the primary surface. The popup resolves its own window via `windows.getCurrent()`, passes that `windowId` to the background, and on open **auto-previews** when enabled + ≥2 groupable tabs + no fresh cache (Apply stays manual: Apply/Regroup/Dismiss). The background caches the last proposal **per window** (`lastProposalByWindow`, 5-min TTL) so the ephemeral popup survives being closed mid-compute and shows results instantly on reopen; the cache is cleared on apply, `ai-group-clear` (Dismiss), and `windows.onRemoved`. Messages: `ai-group-state` → `{enabled, groupableCount, proposal}`, `ai-group-preview`, `ai-group-apply`, `ai-group-clear` (all carry `windowId`; it falls back to `WINDOW_ID_CURRENT`). The enable toggle (`aiGroupingEnabled` in `storage.local`) lives in the popup; the Options page only links to it. No new manifest permissions beyond `default_popup`: reuses `tabs`/`tabGroups` and the already-allowed `ws://127.0.0.1:8767`.

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
