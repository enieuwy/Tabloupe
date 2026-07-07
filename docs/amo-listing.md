# Tabloupe AMO listing kit

## Name

Tabloupe

## Summary (AMO short description, 147 characters)

Save and switch views of Firefox tab groups. Collapse what you don't need; tabs stay open. Add fuzzy Tab Search and optional on-device AI grouping.

## Categories and tags

- Category: Tabs
- Secondary angle: Productivity
- Suggested tags: tab groups, tabs, productivity, search tabs, focus, organization, AI grouping

## Full description (paste into AMO)

```html
<p><strong>Tabloupe saves views of your Firefox tab groups.</strong> A saved view is called a lens: choose the group titles or title patterns that belong together, then switch lenses to expand matching groups and collapse the rest. Your tabs stay open, pinned and ungrouped tabs are not hidden, and manual switching works on every desktop Firefox install with no account, daemon, or background service required.</p>

<p>Use Tabloupe when one browser window holds several contexts: work, research, shopping, a client project, or tonight's reading. Keep all of the tabs available, but show only the groups that matter right now.</p>

<ul>
  <li><strong>Lenses:</strong> save named views of existing Firefox tab groups, switch from the toolbar popup, show all groups again at any time, or create a temporary "show just this group" view.</li>
  <li><strong>Tab Search:</strong> press Ctrl+S to open a fuzzy search overlay for open tabs. Search titles, URLs, and group names; switch to a tab; or multi-select tabs for bulk actions such as group, AI group, close, move to a new window, ungroup, pin or unpin, and discard.</li>
  <li><strong>AI tab grouping:</strong> optional, manual, and preview-before-apply. Tabloupe can propose topic groups for ungrouped tabs, show the proposal first, and apply only after you approve it. It never silently reorganizes your existing manual groups.</li>
  <li><strong>Private AI options:</strong> run grouping fully on-device through the optional macOS helper using Apple Intelligence, or configure any OpenAI-compatible endpoint, including a local Ollama server. Tabloupe sends only tab titles and hosts to the endpoint you explicitly configure.</li>
  <li><strong>Optional macOS Focus automation:</strong> if you run the local helper, a Focus mode can activate a lens automatically. Without the helper, Tabloupe remains a normal manual tab-group switcher.</li>
  <li><strong>No telemetry:</strong> no analytics, no ads, no tracking, and no data collection.</li>
</ul>

<p>Tabloupe is built for people who want less browser noise without closing their work. Collapse what you do not need, keep every tab open, and bring the right groups back when the context changes.</p>
```

## Privacy and data-collection disclosure

Paste-ready disclosure:

```text
Tabloupe does not collect, sell, share, or transmit user data for analytics, advertising, profiling, or telemetry. The extension stores its settings locally in Firefox storage.

AI tab grouping is optional. When enabled, Tabloupe sends only the minimum tab metadata needed for grouping: tab titles and hostnames. That metadata goes only to the endpoint the user explicitly configures. Users can keep grouping fully on-device through the optional macOS helper, which uses Apple Intelligence locally, or they can configure any OpenAI-compatible endpoint, including a localhost Ollama server. Existing tab contents, page bodies, cookies, credentials, and browsing history are not sent for AI grouping.

The optional macOS helper uses a local WebSocket connection at ws://127.0.0.1:8767. This is a loopback-only connection for local automation and on-device AI grouping. Manual lens switching, Tab Search, and normal tab organization work without the helper.
```

### Permission rationale and AMO reviewer notes

| Manifest item | Required? | Why Tabloupe needs it |
| --- | --- | --- |
| `tabGroups` | Required permission | Reads Firefox tab groups and expands/collapses them when switching lenses; creates or updates groups when the user applies manual or AI grouping. |
| `tabs` | Required permission | Lists open tabs for the popup and Tab Search, activates selected tabs, closes selected tabs, moves tabs, groups/ungroups selected tabs, and reads tab titles/URLs needed for search and grouping. |
| `storage` | Required permission | Stores lenses, schedules, window profile overrides, AI settings, shortcut preferences, cached local state, and import/export data locally in Firefox. |
| `notifications` | Required permission | Shows user-visible notices for events such as unavailable automation, grouping errors, or completion states where a popup is not open. |
| `alarms` | Required permission | Runs opt-in lens schedules and backs off reconnect attempts to the optional local helper without keeping the event page awake continuously. |
| `history` | Required permission | Adds optional history suggestions to the Tab Search overlay when the user types a query, after open-tab matches. |
| `search` | Required permission | Lets the Tab Search overlay run a normal web search for the current query when the user chooses the search action row. |
| `ws://127.0.0.1/*` | Required host permission | Connects only to the optional local macOS helper on loopback, primarily at `ws://127.0.0.1:8767`, for Focus automation and on-device AI grouping. Manual use does not require a helper to be running. |
| `<all_urls>` content-script match | Content script match | Injects the isolated Tab Search overlay and captures the configured in-page shortcut on normal web pages. The content script communicates with the background script for tab data/actions; it does not collect page content. |
| `https://*/*` | Optional host permission | Requested only when the user configures an HTTPS OpenAI-compatible AI provider endpoint so the background script can call that chosen endpoint. |
| `http://localhost/*` | Optional host permission | Requested only for a user-configured loopback OpenAI-compatible endpoint such as local Ollama on `localhost`; plain HTTP is limited to local development endpoints. |
| `http://127.0.0.1/*` | Optional host permission | Requested only for a user-configured loopback OpenAI-compatible endpoint such as local Ollama on `127.0.0.1`; plain HTTP is limited to local development endpoints. |
| `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]` | Data collection declaration | Declares that the extension does not collect or transmit user data for AMO data-collection purposes. |

## Reviewer notes

- Source is unminified vanilla JavaScript, HTML, and CSS. There is no application build step or bundler; the submitted extension source is the reviewed source.
- `npm ci` installs the pinned development tools used for `web-ext` and tests. The build/signing script runs the lockfile-pinned `web-ext` via `npx --no-install`.
- The optional WebSocket peer is a local daemon referred to in source notes as `mac-command-centre`. No separate helper repository URL is named in the repository files checked for this listing (`AGENTS.md`, absent `README.md`, and `package.json`); describe it to reviewers as an optional local macOS helper that listens on loopback (`127.0.0.1:8767`) for Focus automation and on-device Apple Intelligence grouping.
- To exercise Tabloupe without the daemon: install the extension, create or use existing Firefox tab groups, open the toolbar popup, save a lens from current groups, switch between that lens and "All groups", open Tab Search with Ctrl+S on a normal web page, and try selecting multiple tabs for bulk actions. The Options page can be used to edit lenses, schedules, shortcuts, import/export, and AI provider settings without a helper connection.
- To exercise AI grouping without the macOS helper: configure an OpenAI-compatible HTTPS endpoint or a loopback endpoint such as localhost Ollama in Options, then open the popup's Organize tabs flow, preview a proposal, and apply or dismiss it. Without any provider configured, the AI feature remains disabled/idle and the rest of the extension works normally.

## Screenshot shot list

1. **Popup switcher:** Toolbar popup showing "Tabloupe", the current lens, "Show all groups", saved lenses, and current window groups.
2. **Tab Search overlay with groups:** Ctrl+S overlay showing grouped sections, fuzzy results, group badges, and the action footer.
3. **AI preview:** Organize tabs flow with proposed topic groups visible before the user applies them.
4. **Options lens editor:** Lens card editing name, icon/color, title/glob selector chips, and warnings for unmatched or duplicate groups.
5. **Schedules card:** Options view showing an opt-in schedule attached to a lens.
6. **Container/multi-window view:** Tab Search or popup state showing multiple windows/groups so reviewers can see Tabloupe handles normal multi-window tab organization.

## Launch checklist

1. Run the release gate locally: `npm ci && npm run verify`.
2. Build for AMO public review: `./build.sh listed`.
   - `listed` submits the build for AMO review. The first listed submission creates the public listing, and the signed `.xpi` may not be available immediately.
   - Use `./build.sh` or `./build.sh unlisted` only for unlisted signing.
3. Create the AMO listing with the name, summary, full description, category, tags, privacy disclosure, and reviewer notes above.
4. Upload the six screenshots from the shot list with matching captions.
5. Submit the listed version for review and wait for AMO approval.
6. Once the listing is live, prepare editorial follow-ups: pitch the Firefox Add-ons Blog, then submit a Recommended Extensions nomination with the live AMO URL and screenshots.
