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
let host = null;
let shadow = null;
let inputEl = null;
let listEl = null;
const MAX_RENDERED_RESULTS = 50;

const DEFAULT_TAB_SEARCH_SHORTCUT = { ctrl: true, alt: false, shift: false, meta: false, key: "s" };
let shortcut = { ...DEFAULT_TAB_SEARCH_SHORTCUT };

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"></path></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const HINT_HTML =
  '<span class="grp"><kbd>\u2191</kbd><kbd>\u2193</kbd> navigate</span><span class="grp"><kbd>\u21b5</kbd> switch</span><span class="grp"><kbd>esc</kbd> close</span>';

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
      list-style: none; margin: 0; padding: 6px; overflow-y: auto;
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
  searchIcon.innerHTML = ICON_SEARCH;

  inputEl = document.createElement("input");
  inputEl.className = "search";
  inputEl.type = "text";
  inputEl.placeholder = "Search tabs\u2026";
  inputEl.setAttribute("aria-label", "Search open tabs");
  inputEl.addEventListener("input", () => {
    render(inputEl.value);
  });
  inputEl.addEventListener("keydown", onPanelKeydown);
  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(inputEl);

  listEl = document.createElement("ul");
  listEl.className = "list";

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.innerHTML = HINT_HTML;

  panel.appendChild(searchWrap);
  panel.appendChild(listEl);
  panel.appendChild(hint);
  backdrop.appendChild(panel);
  shadow.appendChild(style);
  shadow.appendChild(backdrop);
  document.documentElement.appendChild(host);
}

function render(query) {
  filtered = filterTabs(allTabs, query, MAX_RENDERED_RESULTS);
  const renderedCount = filtered.length < MAX_RENDERED_RESULTS ? filtered.length : MAX_RENDERED_RESULTS;
  if (selectedIndex >= renderedCount) selectedIndex = Math.max(0, renderedCount - 1);
  listEl.textContent = "";

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.innerHTML = `<span class="empty-icon">${ICON_SEARCH}</span><span>No matching tabs</span>`;
    listEl.appendChild(empty);
    return;
  }

  for (let index = 0; index < renderedCount; index += 1) {
    const tab = filtered[index];
    const row = document.createElement("li");
    row.className = "row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedIndex));
    row.addEventListener("mousemove", () => setSelected(index));
    row.addEventListener("click", () => activate(tab));

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
    if (tab.groupTitle) {
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
    close.innerHTML = ICON_CLOSE;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab);
    });

    row.appendChild(text);
    row.appendChild(close);
    listEl.appendChild(row);
  }
}

function makeFavFallback() {
  const fallback = document.createElement("span");
  fallback.className = "fav-fallback";
  fallback.innerHTML = ICON_GLOBE;
  return fallback;
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
    moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    moveSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    if (filtered[selectedIndex]) activate(filtered[selectedIndex]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeOverlay();
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
  allTabs = [];
  filtered = [];
  selectedIndex = 0;
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
