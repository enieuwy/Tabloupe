// Tab search overlay (content script).
//
// Opens a Chrome/Edge-style "Search Tabs" panel on the current page. The panel
// lives in a Shadow DOM root so the host page's CSS can't touch it (and vice
// versa). Content scripts can't call browser.tabs, so the list/switch/close work
// is delegated to background.js over runtime messages.
//
// Triggers (the in-page shortcut is configurable on the Options page):
//   - The configured shortcut (default Ctrl+S) on any web page, captured here;
//     preventDefault stops "Save Page As" on Windows/Linux. On macOS Ctrl+S
//     isn't bound, so nothing is overridden. Stored in storage.local as
//     `tabSearchShortcut` ({ctrl,alt,shift,meta,key}); null disables it.
//   - The "search-tabs" command (remappable in about:addons), relayed by the
//     background as a {type:"tabsearch-open"} message.

const TABSEARCH_HOST_ID = "focus-tab-search-overlay";

let allTabs = [];
let filtered = [];
let selectedIndex = 0;
const marked = new Set();
let anchorIndex = null;
let host = null;
let shadow = null;
let inputEl = null;
let listEl = null;
let footerEl = null;
let groupDraftOpen = false;
let actionMessage = "";
let previewState = null;
const collapsedGroups = new Set();
let dragTabIds = [];
let dropIndicator = null;
const MAX_RENDERED_RESULTS = 50;

const DEFAULT_TAB_SEARCH_SHORTCUT = { ctrl: true, alt: false, shift: false, meta: false, key: "s" };
let shortcut = { ...DEFAULT_TAB_SEARCH_SHORTCUT };

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"></path></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
const ICON_UNGROUP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 3"></rect><path d="M8 12h8"></path></svg>';
const HINT_HTML =
  '<span class="grp"><kbd>\u2191</kbd><kbd>\u2193</kbd> navigate</span><span class="grp"><kbd>\u21b5</kbd> switch</span><span class="grp"><kbd>esc</kbd> close</span>';

function trustedHTMLNodes(markup) {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  return Array.from(parsed.body.childNodes, (node) => document.importNode(node, true));
}

function replaceChildrenWithTrustedHTML(element, markup) {
  element.replaceChildren(...trustedHTMLNodes(markup));
}

// Case-insensitive AND-match: every whitespace token must appear in the
// precomputed title/url/group haystack.
function filterTabs(tabs, query, limit = tabs.length) {
  const tokens = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return tabs;
  const matches = tabs.slice(0, 0);
  for (const tab of tabs) {
    const haystack = tab._searchHaystack || "";
    if (tokens.every((token) => haystack.includes(token))) {
      matches.push(tab);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function prepareTabsForSearch(tabs) {
  if (!Array.isArray(tabs)) return [];
  for (const tab of tabs) {
    tab._searchHaystack = `${tab.title || ""} ${tab.url || ""} ${tab.groupTitle || ""}`.toLowerCase();
  }
  return tabs;
}

function faviconFor(tab) {
  const url = tab.favIconUrl || "";
  // Only render http(s)/data favicons; skip privileged/empty to avoid console noise.
  return /^(https?:|data:)/i.test(url) ? url : "";
}

function isOpen() {
  return host !== null;
}

function buildOverlay() {
  host = document.createElement("div");
  host.id = TABSEARCH_HOST_ID;
  // Keep the host itself inert to page styles; the real UI lives in the shadow.
  host.style.cssText = "all: initial;";
  shadow = host.attachShadow({ mode: "open" });

  // Keep keystrokes inside the overlay. The input lives in this shadow root, so
  // when key events bubble out to the host page's document they are retargeted to
  // the host <div> (not a form field). Page-level hotkey handlers (e.g. GitHub's
  // @github/hotkey, registered on document keydown in the bubble phase) then think
  // no field is focused and steal focus to their own search box on every 's'/'/'.
  // Our own handlers sit on deeper nodes (inputEl) and fire first; swallowing here
  // only stops the event from leaving the overlay.
  const swallowKey = (event) => event.stopPropagation();
  host.addEventListener("keydown", swallowKey);
  host.addEventListener("keypress", swallowKey);
  host.addEventListener("keyup", swallowKey);

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      background: rgba(10, 10, 14, 0.44);
      -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
      display: flex; align-items: flex-start; justify-content: center;
      animation: fts-fade 0.12s ease both;
      --accent: #7cc4ff;
      --accent-bg: rgba(124, 196, 255, 0.15);
      --text: #fbfbfe;
      --muted: #b4b2c0;
      --faint: #8a8896;
      --surface-2: #42414d;
      --border: rgba(255, 255, 255, 0.10);
    }
    .panel {
      margin-top: 11vh; width: min(640px, 92vw); max-height: 68vh;
      display: flex; flex-direction: column; overflow: hidden;
      background: #1c1b22; color: var(--text);
      border: 1px solid var(--border); border-radius: 14px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 24px 60px -12px rgba(0, 0, 0, 0.6), 0 8px 24px -8px rgba(0, 0, 0, 0.5);
      animation: fts-pop 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    .search-wrap {
      display: flex; align-items: center; gap: 11px;
      padding: 0 16px; border-bottom: 1px solid var(--border);
    }
    .search-icon { flex: 0 0 auto; display: flex; color: var(--faint); }
    .search-icon svg { width: 18px; height: 18px; }
    .search {
      flex: 1 1 auto; min-width: 0; padding: 15px 0; border: 0; outline: 0;
      background: transparent; color: var(--text); font: inherit; font-size: 16px;
      caret-color: var(--accent);
    }
    .search::placeholder { color: var(--faint); }
    .list {
      list-style: none; margin: 0; padding: 6px; overflow-y: auto; position: relative;
      scrollbar-width: thin; scrollbar-color: var(--surface-2) transparent;
    }
    .list::-webkit-scrollbar { width: 10px; }
    .list::-webkit-scrollbar-thumb {
      background: var(--surface-2); border-radius: 999px;
      border: 3px solid transparent; background-clip: padding-box;
    }
    .row {
      position: relative; display: flex; align-items: center; gap: 11px;
      padding: 9px 11px; border-radius: 9px; cursor: pointer;
      transition: background 0.1s ease;
    }
    .row[aria-selected="true"] { background: var(--accent-bg); }
    .row[aria-selected="true"]::before {
      content: ""; position: absolute; left: 0; top: 7px; bottom: 7px;
      width: 3px; border-radius: 0 3px 3px 0; background: var(--accent);
    }
    .row.marked { background: rgba(124, 196, 255, 0.08); }
    .row .mark {
      width: 16px; height: 16px; flex: 0 0 16px; margin: 0;
      accent-color: var(--accent); opacity: 0; cursor: pointer;
      transition: opacity 0.1s ease;
    }
    .row:hover .mark, .row.marked .mark, .has-marks .row .mark { opacity: 1; }
    .row .fav {
      width: 18px; height: 18px; flex: 0 0 18px;
      border-radius: 4px; object-fit: contain;
    }
    .row .fav-fallback {
      width: 18px; height: 18px; flex: 0 0 18px; border-radius: 4px;
      background: var(--surface-2); color: var(--faint);
      display: flex; align-items: center; justify-content: center;
    }
    .row .fav-fallback svg { width: 12px; height: 12px; }
    .row .text { min-width: 0; flex: 1 1 auto; }
    .row .title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .row .name {
      min-width: 0; font-size: 14px; color: #e8e6ef;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .row[aria-selected="true"] .name { color: #fff; }
    .row .url {
      font-size: 12px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .row .badge, .row .group-badge {
      flex: 0 0 auto; font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
    }
    .row .badge { color: var(--accent); background: var(--accent-bg); }
    .row .group-badge { color: #f0eff4; background: rgba(255, 255, 255, 0.12); }
    .row .group-badge[data-color="blue"] { background: rgba(0, 97, 224, 0.42); }
    .row .group-badge[data-color="cyan"] { background: rgba(0, 139, 170, 0.42); }
    .row .group-badge[data-color="green"] { background: rgba(18, 128, 54, 0.42); }
    .row .group-badge[data-color="orange"] { background: rgba(180, 100, 0, 0.42); }
    .row .group-badge[data-color="pink"] { background: rgba(190, 55, 120, 0.42); }
    .row .group-badge[data-color="purple"] { background: rgba(120, 75, 190, 0.42); }
    .row .group-badge[data-color="red"] { background: rgba(190, 55, 55, 0.42); }
    .row .group-badge[data-color="yellow"] { background: rgba(160, 125, 0, 0.42); }
    .row .close {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent; color: var(--faint);
      padding: 5px; border-radius: 6px; cursor: pointer; opacity: 0;
      transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
    }
    .row .close svg { width: 15px; height: 15px; }
    .row:hover .close, .row[aria-selected="true"] .close { opacity: 1; }
    .row .close:hover { background: rgba(255, 255, 255, 0.10); color: var(--text); }
    .divider {
      padding: 7px 11px 5px; color: var(--faint); font-size: 10px;
      letter-spacing: 0.06em; text-transform: uppercase;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .preview-topic {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 11px 5px; color: var(--text); font-size: 12px; font-weight: 600;
    }
    .preview-topic .group-badge {
      font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 7px; border-radius: 999px; color: #f0eff4;
      background: rgba(255, 255, 255, 0.12);
    }
    .preview-topic .group-badge[data-color="blue"] { background: rgba(0, 97, 224, 0.42); }
    .preview-topic .group-badge[data-color="cyan"] { background: rgba(0, 139, 170, 0.42); }
    .preview-topic .group-badge[data-color="green"] { background: rgba(18, 128, 54, 0.42); }
    .preview-topic .group-badge[data-color="orange"] { background: rgba(180, 100, 0, 0.42); }
    .preview-topic .group-badge[data-color="pink"] { background: rgba(190, 55, 120, 0.42); }
    .preview-topic .group-badge[data-color="purple"] { background: rgba(120, 75, 190, 0.42); }
    .preview-topic .group-badge[data-color="red"] { background: rgba(190, 55, 55, 0.42); }
    .preview-topic .group-badge[data-color="yellow"] { background: rgba(160, 125, 0, 0.42); }
    .empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 40px 16px; color: var(--faint); font-size: 14px;
    }
    .empty .empty-icon { display: flex; }
    .empty .empty-icon svg { width: 22px; height: 22px; opacity: 0.7; }
    .hint {
      display: flex; gap: 16px; align-items: center;
      padding: 9px 16px; font-size: 11px; color: var(--faint);
      border-top: 1px solid var(--border);
    }
    .hint .grp { display: flex; align-items: center; gap: 6px; }
    .hint kbd {
      font-family: inherit; font-size: 10px; line-height: 1;
      min-width: 17px; height: 18px; padding: 0 5px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--surface-2); color: var(--text);
      border-radius: 5px; box-shadow: 0 1px 0 rgba(0, 0, 0, 0.45);
    }
    .actions {
      display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
      padding: 9px 16px; font-size: 12px; color: var(--muted);
      border-top: 1px solid var(--border);
    }
    .actions .count { color: var(--text); font-weight: 600; margin-right: 4px; }
    .actions .message { flex: 1 1 100%; color: var(--faint); }
    .actions button {
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px;
      padding: 5px 9px; background: var(--surface-2); color: var(--text);
      font: inherit; font-size: 12px; cursor: pointer;
    }
    .actions button:disabled { opacity: 0.45; cursor: default; }
    .actions .primary { background: var(--accent-bg); border-color: rgba(124, 196, 255, 0.32); }
    .actions details { position: relative; }
    .actions summary {
      list-style: none; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 7px;
      padding: 5px 9px; background: var(--surface-2); color: var(--text); cursor: pointer;
    }
    .actions summary::-webkit-details-marker { display: none; }
    .actions .menu {
      position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 1;
      min-width: 170px; padding: 6px; border: 1px solid var(--border); border-radius: 9px;
      background: #2b2a33; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
    }
    .actions .menu button { width: 100%; text-align: left; margin: 2px 0; background: transparent; border: 0; }
    .actions input {
      min-width: 160px; padding: 5px 8px; border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.14); background: #2b2a33; color: var(--text);
      font: inherit; font-size: 12px; outline: 0;
    }
    .group-header {
      position: relative; display: flex; align-items: center; gap: 8px;
      padding: 8px 11px 5px; cursor: pointer; color: var(--text);
      font-size: 12px; font-weight: 600; border-radius: 8px;
    }
    .group-header .chevron { flex: 0 0 auto; display: flex; color: var(--faint); transition: transform 0.12s ease; }
    .group-header .chevron svg { width: 12px; height: 12px; }
    .group-header.collapsed .chevron { transform: rotate(-90deg); }
    .group-header .group-badge {
      flex: 0 0 auto; font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 7px; border-radius: 999px; color: #f0eff4; background: rgba(255, 255, 255, 0.12);
    }
    .group-header .group-badge[data-color="blue"] { background: rgba(0, 97, 224, 0.42); }
    .group-header .group-badge[data-color="cyan"] { background: rgba(0, 139, 170, 0.42); }
    .group-header .group-badge[data-color="green"] { background: rgba(18, 128, 54, 0.42); }
    .group-header .group-badge[data-color="orange"] { background: rgba(180, 100, 0, 0.42); }
    .group-header .group-badge[data-color="pink"] { background: rgba(190, 55, 120, 0.42); }
    .group-header .group-badge[data-color="purple"] { background: rgba(120, 75, 190, 0.42); }
    .group-header .group-badge[data-color="red"] { background: rgba(190, 55, 55, 0.42); }
    .group-header .group-badge[data-color="yellow"] { background: rgba(160, 125, 0, 0.42); }
    .group-header .gcount { color: var(--faint); font-weight: 500; font-size: 11px; }
    .group-header .spacer { flex: 1 1 auto; }
    .group-header .ghbtn {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent; color: var(--faint); padding: 4px;
      border-radius: 6px; cursor: pointer; opacity: 0;
      transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
    }
    .group-header .ghbtn svg { width: 14px; height: 14px; }
    .group-header:hover .ghbtn { opacity: 1; }
    .group-header .ghbtn:hover { background: rgba(255, 255, 255, 0.10); color: var(--text); }
    .group-header.drop-target { background: var(--accent-bg); box-shadow: inset 0 0 0 1px rgba(124, 196, 255, 0.45); }
    .row.in-group { margin-left: 18px; }
    .row.in-group::after {
      content: ""; position: absolute; left: -9px; top: 6px; bottom: 6px;
      width: 2px; border-radius: 2px; background: rgba(255, 255, 255, 0.12);
    }
    .drop-indicator {
      position: absolute; left: 6px; right: 6px; height: 2px;
      background: var(--accent); border-radius: 1px;
      pointer-events: none; z-index: 2; display: none;
    }
    @keyframes fts-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fts-pop {
      from { opacity: 0; transform: translateY(-8px) scale(0.985); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .backdrop, .panel { animation: none; }
    }
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeOverlay();
  });

  const panel = document.createElement("div");
  panel.className = "panel";

  const searchWrap = document.createElement("div");
  searchWrap.className = "search-wrap";
  const searchIcon = document.createElement("span");
  searchIcon.className = "search-icon";
  replaceChildrenWithTrustedHTML(searchIcon, ICON_SEARCH);

  inputEl = document.createElement("input");
  inputEl.className = "search";
  inputEl.type = "text";
  inputEl.placeholder = "Search tabs\u2026";
  inputEl.setAttribute("aria-label", "Search open tabs");
  inputEl.addEventListener("input", () => {
    anchorIndex = null;
    render(inputEl.value);
  });
  inputEl.addEventListener("keydown", onPanelKeydown);
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(inputEl);

  listEl = document.createElement("ul");
  listEl.className = "list";
  dropIndicator = document.createElement("div");
  dropIndicator.className = "drop-indicator";

  footerEl = document.createElement("div");
  footerEl.className = "hint";
  replaceChildrenWithTrustedHTML(footerEl, HINT_HTML);

  panel.appendChild(searchWrap);
  panel.appendChild(listEl);
  panel.appendChild(footerEl);
  backdrop.appendChild(panel);
  shadow.appendChild(style);
  shadow.appendChild(backdrop);
  document.documentElement.appendChild(host);
}

function render(query) {
  pruneMarked();
  if (previewState) {
    renderPreview();
    return;
  }
  const matches = filterTabs(allTabs, query, MAX_RENDERED_RESULTS);
  const renderedCount = Math.min(matches.length, MAX_RENDERED_RESULTS);
  listEl.textContent = "";
  listEl.classList.toggle("has-marks", marked.size > 0);

  if (renderedCount === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    const emptyIcon = document.createElement("span");
    emptyIcon.className = "empty-icon";
    replaceChildrenWithTrustedHTML(emptyIcon, ICON_SEARCH);
    const emptyText = document.createElement("span");
    emptyText.textContent = "No matching tabs";
    empty.append(emptyIcon, emptyText);
    listEl.appendChild(empty);
    filtered = [];
    selectedIndex = 0;
    renderFooter();
    return;
  }

  // Browse (empty query) shows structured group sections; search shows the flat
  // ranked list with a per-row group pill, since matches scatter across groups.
  const browse = query.trim() === "";
  const spansWindows = new Set(matches.slice(0, renderedCount).map((tab) => tab.windowId)).size > 1;
  const groupSizes = browse ? countGroupSizes() : null;
  const visible = [];
  let previousWindowId = null;
  let currentGroupId = null;

  for (let index = 0; index < renderedCount; index += 1) {
    const tab = matches[index];
    if (spansWindows && tab.windowId !== previousWindowId) {
      const divider = document.createElement("li");
      divider.className = "divider";
      divider.textContent = tab.currentWindow ? "This window" : `Window ${tab.windowId}`;
      listEl.appendChild(divider);
      previousWindowId = tab.windowId;
      currentGroupId = null;
    }
    if (browse && tab.grouped) {
      if (tab.groupId !== currentGroupId) {
        listEl.appendChild(makeGroupHeader(tab, groupSizes.get(tab.groupId) || 0));
        currentGroupId = tab.groupId;
      }
      if (collapsedGroups.has(tab.groupId)) continue; // members hidden + not navigable
      const idx = visible.length;
      visible.push(tab);
      listEl.appendChild(makeTabRow(tab, idx, true, { inGroup: true }));
    } else {
      if (browse) currentGroupId = null;
      const idx = visible.length;
      visible.push(tab);
      listEl.appendChild(makeTabRow(tab, idx, true));
    }
  }

  filtered = visible;
  if (selectedIndex >= filtered.length) selectedIndex = Math.max(0, filtered.length - 1);
  if (dropIndicator) {
    dropIndicator.style.display = "none";
    listEl.appendChild(dropIndicator);
  }
  renderFooter();
}

function makeTabRow(tab, index, interactive, opts = {}) {
  const row = document.createElement("li");
  row.className = "row";
  if (opts.inGroup) row.classList.add("in-group");
  if (marked.has(tab.id)) row.classList.add("marked");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(interactive && index === selectedIndex));
  if (interactive) {
    row.draggable = true;
    row.addEventListener("mousemove", () => setSelected(index));
    row.addEventListener("click", (event) => {
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        markRange(index);
      } else if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleMark(index);
      } else {
        activate(tab);
      }
    });
    row.addEventListener("dragstart", (event) => {
      // Drag the whole marked selection if this row is part of it, else just it.
      dragTabIds = marked.has(tab.id) && marked.size > 0 ? markedTabs().map((t) => t.id) : [tab.id];
      if (event.dataTransfer) {
        try {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(tab.id));
        } catch (error) {
          // dragTabIds is the source of truth; ignore engines that block setData.
        }
      }
    });
    row.addEventListener("dragend", () => {
      dragTabIds = [];
      hideDropIndicator();
    });
    row.addEventListener("dragover", (event) => {
      if (dragTabIds.length === 0 || !browseMode()) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = event.clientY - rect.top > rect.height / 2;
      showDropIndicator(row, after);
    });
    row.addEventListener("drop", (event) => {
      if (dragTabIds.length === 0 || !browseMode()) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      const after = event.clientY - rect.top > rect.height / 2;
      hideDropIndicator();
      const ids = dragTabIds.slice();
      dragTabIds = [];
      dropAtPosition(ids, index, after);
    });
  }

  const mark = document.createElement("input");
  mark.className = "mark";
  mark.type = "checkbox";
  mark.title = "Select tab";
  mark.checked = marked.has(tab.id);
  mark.disabled = !interactive;
  mark.addEventListener("click", (event) => {
    event.stopPropagation();
    if (interactive) toggleMark(index);
  });
  row.appendChild(mark);

  const favUrl = faviconFor(tab);
  if (favUrl) {
    const fav = document.createElement("img");
    fav.className = "fav";
    fav.src = favUrl;
    fav.addEventListener("error", () => {
      fav.replaceWith(makeFavFallback());
    });
    row.appendChild(fav);
  } else {
    row.appendChild(makeFavFallback());
  }

  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("div");
  title.className = "title";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = tab.title;
  title.appendChild(name);
  if (tab.active && tab.currentWindow) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "current";
    title.appendChild(badge);
  }
  if (tab.groupTitle && !opts.inGroup) {
    const badge = document.createElement("span");
    badge.className = "group-badge";
    badge.textContent = tab.groupTitle;
    if (tab.groupColor) badge.dataset.color = tab.groupColor;
    title.appendChild(badge);
  }
  const url = document.createElement("div");
  url.className = "url";
  url.textContent = tab.url;
  text.appendChild(title);
  text.appendChild(url);

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.title = "Close tab";
  replaceChildrenWithTrustedHTML(close, ICON_CLOSE);
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(tab);
  });

  row.appendChild(text);
  row.appendChild(close);
  return row;
}

function browseMode() {
  return !!inputEl && inputEl.value.trim() === "";
}

function showDropIndicator(row, after) {
  if (!dropIndicator) return;
  // A single flat line in the gap (the row's top or bottom edge), so crossing
  // the before/after threshold doesn't swap two corner-rounded box-shadows.
  dropIndicator.style.top = `${row.offsetTop + (after ? row.offsetHeight : 0) - 1}px`;
  dropIndicator.style.display = "block";
}

function hideDropIndicator() {
  if (dropIndicator) dropIndicator.style.display = "none";
}

function dropAtPosition(tabIds, index, placeAfter) {
  const anchor = filtered[index];
  if (!anchor) return;
  const prev = placeAfter ? anchor : filtered[index - 1];
  const next = placeAfter ? filtered[index + 1] : anchor;
  const inWindow = (tab) => tab && tab.windowId === anchor.windowId;
  // The insertion sits "inside" a group only when both neighbours share the same
  // real group; anywhere else (group edges, ungrouped runs) drops out of groups.
  let groupId = -1;
  if (inWindow(prev) && inWindow(next) && prev.grouped && next.grouped && prev.groupId === next.groupId) {
    groupId = prev.groupId;
  }
  moveOntoPosition(tabIds, anchor.windowId, anchor.id, placeAfter, groupId);
}

async function moveOntoPosition(tabIds, windowId, anchorId, placeAfter, groupId) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return;
  try {
    const refreshed = await browser.runtime.sendMessage({
      type: "tabsearch-move",
      tabIds,
      windowId,
      anchorId,
      placeAfter,
      groupId,
    });
    if (Array.isArray(refreshed)) {
      allTabs = prepareTabsForSearch(refreshed);
      clearMarks();
      pruneMarked();
    }
  } catch (error) {
    actionMessage = "Could not move tabs.";
  }
  if (isOpen()) render(inputEl.value);
}

function renderPreview() {
  listEl.textContent = "";
  listEl.classList.remove("has-marks");
  filtered = [];
  for (const group of previewState.groups) {
    const topic = document.createElement("li");
    topic.className = "preview-topic";
    const badge = document.createElement("span");
    badge.className = "group-badge";
    badge.textContent = group.topic;
    if (group.color) badge.dataset.color = group.color;
    topic.appendChild(badge);
    listEl.appendChild(topic);
    for (const tab of group.tabs) {
      const fullTab = allTabs.find((candidate) => candidate.id === tab.id) || tab;
      listEl.appendChild(makeTabRow(fullTab, -1, false));
    }
  }
  renderPreviewFooter();
}

function countGroupSizes() {
  const sizes = new Map();
  for (const tab of allTabs) {
    if (tab.grouped) sizes.set(tab.groupId, (sizes.get(tab.groupId) || 0) + 1);
  }
  return sizes;
}

function groupTabIds(groupId) {
  return allTabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id);
}

function makeGroupHeader(tab, count) {
  const header = document.createElement("li");
  header.className = "group-header";
  if (collapsedGroups.has(tab.groupId)) header.classList.add("collapsed");

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  replaceChildrenWithTrustedHTML(chevron, ICON_CHEVRON);
  header.appendChild(chevron);

  const badge = document.createElement("span");
  badge.className = "group-badge";
  badge.textContent = tab.groupTitle || "Group";
  if (tab.groupColor) badge.dataset.color = tab.groupColor;
  header.appendChild(badge);

  const gcount = document.createElement("span");
  gcount.className = "gcount";
  gcount.textContent = String(count);
  header.appendChild(gcount);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  header.appendChild(spacer);

  const ungroupBtn = document.createElement("button");
  ungroupBtn.type = "button";
  ungroupBtn.className = "ghbtn";
  ungroupBtn.title = "Ungroup";
  replaceChildrenWithTrustedHTML(ungroupBtn, ICON_UNGROUP);
  ungroupBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    runBulkListAction("tabsearch-ungroup", { tabIds: groupTabIds(tab.groupId) });
  });
  header.appendChild(ungroupBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghbtn";
  closeBtn.title = "Close group";
  replaceChildrenWithTrustedHTML(closeBtn, ICON_CLOSE);
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    runBulkListAction("tabsearch-close-many", { tabIds: groupTabIds(tab.groupId) });
  });
  header.appendChild(closeBtn);

  header.addEventListener("click", () => {
    if (collapsedGroups.has(tab.groupId)) collapsedGroups.delete(tab.groupId);
    else collapsedGroups.add(tab.groupId);
    render(inputEl.value);
  });

  header.addEventListener("dragover", (event) => {
    if (dragTabIds.length === 0) return;
    event.preventDefault();
    hideDropIndicator();
    header.classList.add("drop-target");
  });
  header.addEventListener("dragleave", () => header.classList.remove("drop-target"));
  header.addEventListener("drop", (event) => {
    event.preventDefault();
    header.classList.remove("drop-target");
    const ids = dragTabIds.slice();
    dragTabIds = [];
    groupOntoExisting(ids, tab.groupId, tab.windowId);
  });

  return header;
}

async function groupOntoExisting(tabIds, groupId, windowId) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return;
  try {
    const result = await browser.runtime.sendMessage({ type: "tabsearch-group", tabIds, groupId, windowId });
    if (result && result.ok) {
      if (Array.isArray(result.list)) allTabs = prepareTabsForSearch(result.list);
      clearMarks();
      pruneMarked();
    } else {
      actionMessage = (result && (result.message || result.error)) || "Could not group tabs.";
    }
  } catch (error) {
    actionMessage = "Could not group tabs.";
  }
  if (isOpen()) render(inputEl.value);
}

function makeFavFallback() {
  const fallback = document.createElement("span");
  fallback.className = "fav-fallback";
  replaceChildrenWithTrustedHTML(fallback, ICON_GLOBE);
  return fallback;
}

function pruneMarked() {
  const knownIds = new Set(allTabs.map((tab) => tab.id));
  for (const tabId of marked) {
    if (!knownIds.has(tabId)) marked.delete(tabId);
  }
}

function markedTabs() {
  return allTabs.filter((tab) => marked.has(tab.id));
}

function sharedMarkedWindowId(tabs) {
  if (tabs.length === 0) return null;
  const windowId = tabs[0].windowId;
  return tabs.every((tab) => tab.windowId === windowId) ? windowId : null;
}

function markRange(index) {
  if (!filtered[index]) return;
  const anchor = anchorIndex === null ? index : anchorIndex;
  const start = Math.min(anchor, index);
  const end = Math.max(anchor, index);
  for (let i = start; i <= end; i += 1) {
    if (filtered[i]) marked.add(filtered[i].id);
  }
  anchorIndex = index;
  groupDraftOpen = false;
  actionMessage = "";
  render(inputEl.value);
}

function toggleMark(index) {
  const tab = filtered[index];
  if (!tab) return;
  if (marked.has(tab.id)) {
    marked.delete(tab.id);
  } else {
    marked.add(tab.id);
  }
  anchorIndex = index;
  groupDraftOpen = false;
  actionMessage = "";
  render(inputEl.value);
}

function clearMarks() {
  marked.clear();
  anchorIndex = null;
  groupDraftOpen = false;
  actionMessage = "";
}

function renderFooter() {
  if (!footerEl) return;
  if (marked.size === 0) {
    footerEl.className = "hint";
    replaceChildrenWithTrustedHTML(footerEl, HINT_HTML);
    return;
  }

  const tabs = markedTabs();
  const windowId = sharedMarkedWindowId(tabs);
  const sameWindow = windowId !== null;
  const allPinned = tabs.length > 0 && tabs.every((tab) => tab.pinned);
  const canUngroup = sameWindow && tabs.some((tab) => tab.grouped);
  footerEl.className = "actions";
  footerEl.textContent = "";

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${tabs.length} selected`;
  footerEl.appendChild(count);

  const group = makeActionButton("Group", () => {
    groupDraftOpen = true;
    actionMessage = "";
    render(inputEl.value);
  });
  group.className = "primary";
  group.disabled = !sameWindow;
  if (!sameWindow) group.title = "select tabs from one window to group";
  footerEl.appendChild(group);

  const ai = makeActionButton("AI group", () => previewAiGroups(windowId));
  ai.disabled = !sameWindow;
  if (!sameWindow) ai.title = "select tabs from one window to group";
  footerEl.appendChild(ai);

  footerEl.appendChild(makeActionButton("Close", () => runBulkListAction("tabsearch-close-many", { tabIds: tabs.map((tab) => tab.id) })));

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "More \u25be";
  details.appendChild(summary);
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.appendChild(makeActionButton("Move to new window", () => runBulkListAction("tabsearch-move-new-window", { tabIds: tabs.map((tab) => tab.id) })));
  const ungroup = makeActionButton("Ungroup", () => runBulkListAction("tabsearch-ungroup", { tabIds: tabs.map((tab) => tab.id) }));
  ungroup.disabled = !canUngroup;
  if (!sameWindow) ungroup.title = "select tabs from one window to group";
  menu.appendChild(ungroup);
  menu.appendChild(makeActionButton(allPinned ? "Unpin" : "Pin", () =>
    runBulkListAction("tabsearch-set-pinned", { tabIds: tabs.map((tab) => tab.id), pinned: !allPinned })
  ));
  menu.appendChild(makeActionButton("Discard", () => runBulkListAction("tabsearch-discard", { tabIds: tabs.map((tab) => tab.id) })));
  details.appendChild(menu);
  footerEl.appendChild(details);

  const clear = makeActionButton("Clear", () => {
    clearMarks();
    render(inputEl.value);
  });
  footerEl.appendChild(clear);

  if (!sameWindow || actionMessage) {
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = actionMessage || "select tabs from one window to group";
    footerEl.appendChild(message);
  }

  if (groupDraftOpen && sameWindow) {
    renderGroupDraft(tabs, windowId);
  }
}

function renderGroupDraft(tabs, windowId) {
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Group name";
  input.setAttribute("list", "focus-tab-search-groups");
  const datalist = document.createElement("datalist");
  datalist.id = "focus-tab-search-groups";
  const titles = new Set();
  for (const tab of allTabs) {
    if (tab.groupTitle) titles.add(tab.groupTitle);
  }
  for (const title of titles) {
    const option = document.createElement("option");
    option.value = title;
    datalist.appendChild(option);
  }
  form.appendChild(input);
  form.appendChild(datalist);
  form.appendChild(makeActionButton("Save", () => {}, "submit"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitManualGroup(tabs.map((tab) => tab.id), input.value.trim(), windowId);
  });
  footerEl.appendChild(form);
  input.focus();
}

function renderPreviewFooter() {
  footerEl.className = "actions";
  footerEl.textContent = "";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = "AI group preview";
  footerEl.appendChild(count);
  footerEl.appendChild(makeActionButton("Apply", applyAiPreview, "button", "primary"));
  footerEl.appendChild(makeActionButton("Cancel", () => {
    previewState = null;
    render(inputEl.value);
  }));
}

function makeActionButton(label, onClick, type = "button", className = "") {
  const button = document.createElement("button");
  button.type = type;
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function setSelected(index) {
  if (index === selectedIndex) return;
  selectedIndex = index;
  const rows = listEl.querySelectorAll(".row");
  rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === selectedIndex)));
}

function moveSelection(delta) {
  const renderedCount = Math.min(filtered.length, MAX_RENDERED_RESULTS);
  if (renderedCount === 0) return;
  const next = (selectedIndex + delta + renderedCount) % renderedCount;
  setSelected(next);
  const rows = listEl.querySelectorAll(".row");
  if (rows[next] && rows[next].scrollIntoView) {
    rows[next].scrollIntoView({ block: "nearest" });
  }
}

function onPanelKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  // Keep navigation keys away from the host page.
  if (event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    if (!previewState) moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    if (!previewState) moveSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    if (previewState) return;
    if (event.metaKey || event.ctrlKey) {
      toggleMark(selectedIndex);
      moveSelection(1);
    } else if (filtered[selectedIndex]) {
      activate(filtered[selectedIndex]);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (previewState) {
      previewState = null;
      render(inputEl.value);
    } else if (marked.size > 0) {
      clearMarks();
      render(inputEl.value);
    } else {
      closeOverlay();
    }
  }
}

async function openOverlay() {
  if (isOpen()) {
    closeOverlay();
    return;
  }
  buildOverlay();
  selectedIndex = 0;
  inputEl.focus();
  try {
    allTabs = prepareTabsForSearch((await browser.runtime.sendMessage({ type: "tabsearch-list" })) || []);
  } catch (error) {
    allTabs = [];
  }
  if (!isOpen()) return; // closed while awaiting
  render(inputEl.value);
}

function closeOverlay() {
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null;
  shadow = null;
  inputEl = null;
  listEl = null;
  footerEl = null;
  allTabs = [];
  filtered = [];
  selectedIndex = 0;
  clearMarks();
  previewState = null;
  dropIndicator = null;
}

function activate(tab) {
  browser.runtime
    .sendMessage({ type: "tabsearch-activate", tabId: tab.id, windowId: tab.windowId })
    .catch(() => {});
  closeOverlay();
}

async function closeTab(tab) {
  try {
    const refreshed = await browser.runtime.sendMessage({ type: "tabsearch-close", tabId: tab.id });
    if (Array.isArray(refreshed)) allTabs = prepareTabsForSearch(refreshed);
  } catch (error) {
    allTabs = allTabs.filter((candidate) => candidate.id !== tab.id);
  }
  if (isOpen()) render(inputEl.value);
}

async function runBulkListAction(type, payload) {
  try {
    const refreshed = await browser.runtime.sendMessage({ type, ...payload });
    if (Array.isArray(refreshed)) {
      allTabs = prepareTabsForSearch(refreshed);
      clearMarks();
      pruneMarked();
    }
  } catch (error) {
    actionMessage = "Action failed.";
  }
  if (isOpen()) render(inputEl.value);
}

async function submitManualGroup(tabIds, title, windowId) {
  if (!title) {
    actionMessage = "Enter a group name.";
    render(inputEl.value);
    return;
  }
  try {
    const result = await browser.runtime.sendMessage({ type: "tabsearch-group", tabIds, title, windowId });
    if (result && result.ok) {
      if (Array.isArray(result.list)) allTabs = prepareTabsForSearch(result.list);
      clearMarks();
      pruneMarked();
    } else {
      actionMessage = (result && (result.message || result.error)) || "Could not group tabs.";
    }
  } catch (error) {
    actionMessage = "Could not group tabs.";
  }
  if (isOpen()) render(inputEl.value);
}

async function previewAiGroups(windowId) {
  const tabIds = markedTabs().map((tab) => tab.id);
  try {
    const result = await browser.runtime.sendMessage({ type: "tabsearch-ai-preview", windowId, tabIds });
    if (result && result.ok) {
      previewState = { windowId, groups: result.groups || [] };
      actionMessage = "";
    } else {
      actionMessage = (result && (result.message || result.error)) || "Could not preview AI groups.";
    }
  } catch (error) {
    actionMessage = "Could not preview AI groups.";
  }
  if (isOpen()) render(inputEl.value);
}

async function applyAiPreview() {
  if (!previewState) return;
  const groups = previewState.groups.map((group) => ({
    topic: group.topic,
    color: group.color,
    tabs: group.tabs.map((tab) => ({ id: tab.id })),
  }));
  try {
    const result = await browser.runtime.sendMessage({ type: "ai-group-apply", windowId: previewState.windowId, groups });
    if (result && result.ok) {
      closeOverlay();
      return;
    }
    actionMessage = (result && (result.message || result.error)) || "Could not apply AI groups.";
  } catch (error) {
    actionMessage = "Could not apply AI groups.";
  }
  previewState = null;
  if (isOpen()) render(inputEl.value);
}

function normalizeShortcut(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.key !== "string" || value.key.length === 0) {
    return { ...DEFAULT_TAB_SEARCH_SHORTCUT };
  }
  return {
    ctrl: Boolean(value.ctrl),
    alt: Boolean(value.alt),
    shift: Boolean(value.shift),
    meta: Boolean(value.meta),
    key: value.key.length === 1 ? value.key.toLowerCase() : value.key,
  };
}

function matchesShortcut(event, sc) {
  if (!sc || !sc.key) return false;
  if (event.ctrlKey !== sc.ctrl) return false;
  if (event.altKey !== sc.alt) return false;
  if (event.shiftKey !== sc.shift) return false;
  if (event.metaKey !== sc.meta) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return key === sc.key;
}

function onGlobalKeydown(event) {
  if (event.repeat) return;
  if (matchesShortcut(event, shortcut)) {
    event.preventDefault();
    event.stopPropagation();
    openOverlay();
  }
}

if (!window.__focusTabSearchInit) {
  window.__focusTabSearchInit = true;
  document.addEventListener("keydown", onGlobalKeydown, true);
  if (browser.storage && browser.storage.local) {
    browser.storage.local
      .get("tabSearchShortcut")
      .then((stored) => {
        if (stored && "tabSearchShortcut" in stored) {
          shortcut = normalizeShortcut(stored.tabSearchShortcut);
        }
      })
      .catch(() => {});
  }
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.tabSearchShortcut) {
        shortcut = normalizeShortcut(changes.tabSearchShortcut.newValue);
      }
    });
  }
  if (browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener((message) => {
      if (message && message.type === "tabsearch-open") {
        openOverlay();
      }
    });
  }
}
