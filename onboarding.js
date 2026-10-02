// First-run welcome page. Deliberately thin: it reads the current window's real
// tab groups and saves them through the same `lens-save` message the popup uses,
// so onboarding can never drift from the real lens model.

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");
const DEFAULT_TAB_SEARCH_SHORTCUT = Object.freeze({ ctrl: true, alt: false, shift: false, meta: false, key: "s" });

let windowId = null;
let saved = false;

function el(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "") {
  const status = el("status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function normalizeShortcut(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") return { ...DEFAULT_TAB_SEARCH_SHORTCUT };
  const key = typeof value.key === "string" && value.key.length > 0 ? value.key : DEFAULT_TAB_SEARCH_SHORTCUT.key;
  return {
    ctrl: value.ctrl === true,
    alt: value.alt === true,
    shift: value.shift === true,
    meta: value.meta === true,
    key,
  };
}

function formatShortcut(shortcut) {
  if (!shortcut) return "Disabled";
  const parts = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.meta) parts.push(IS_MAC ? "Cmd" : "Meta");
  if (shortcut.alt) parts.push(IS_MAC ? "Option" : "Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return parts.join(" + ");
}

async function renderShortcutHint() {
  const target = el("search-shortcut");
  if (!target) return;
  try {
    const stored = await browser.storage.local.get("tabSearchShortcut");
    const shortcut = "tabSearchShortcut" in stored
      ? normalizeShortcut(stored.tabSearchShortcut)
      : { ...DEFAULT_TAB_SEARCH_SHORTCUT };
    target.textContent = formatShortcut(shortcut);
  } catch (error) {
    console.error("Reading the tab search shortcut failed:", error);
    target.textContent = formatShortcut(DEFAULT_TAB_SEARCH_SHORTCUT);
  }
}

function renderGroups(groups) {
  const list = el("groups-list");
  const summary = el("groups-summary");
  list.textContent = "";
  if (groups.length === 0) {
    list.hidden = true;
    el("save-row").hidden = true;
    el("groups-empty").hidden = false;
    summary.textContent = "No tab groups in this window yet.";
    return;
  }
  for (const group of groups) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "onboarding-swatch";
    if (group.color) {
      swatch.style.background = group.color;
    }
    const label = document.createElement("span");
    label.textContent = group.title || "Untitled group";
    item.append(swatch, label);
    list.appendChild(item);
  }
  list.hidden = false;
  el("groups-empty").hidden = true;
  el("save-row").hidden = false;
  summary.textContent = groups.length === 1
    ? "This window has 1 tab group. Save it as your first lens:"
    : `This window has ${groups.length} tab groups. Save them as your first lens:`;
  const nameInput = el("lens-name");
  if (nameInput && groups.length === 1 && groups[0].title) {
    nameInput.value = groups[0].title;
  }
}

async function loadGroups() {
  try {
    const current = await browser.windows.getCurrent();
    windowId = current && typeof current.id === "number" ? current.id : null;
  } catch (error) {
    console.error("Welcome page window lookup failed:", error);
  }
  if (typeof windowId !== "number") {
    // Saving a window's groups without a concrete window would sweep in every
    // other window's groups, so fail closed exactly like the popup does.
    el("groups-summary").textContent = "Could not read this window's tab groups.";
    el("groups-empty").hidden = false;
    setStatus("Reload this page to try again.", "error");
    return;
  }
  try {
    const state = await browser.runtime.sendMessage({ type: "lens-state", windowId });
    const groups = state && Array.isArray(state.currentGroups) ? state.currentGroups : [];
    renderGroups(groups.filter((group) => group && typeof group.title === "string"));
  } catch (error) {
    console.error("Welcome page lens-state failed:", error);
    el("groups-summary").textContent = "Could not read this window's tab groups.";
    setStatus("Reload this page to try again.", "error");
  }
}

async function saveLens() {
  if (saved) return;
  const button = el("save-lens");
  const name = el("lens-name").value.trim();
  if (!name) {
    setStatus("Give the lens a name first.", "error");
    return;
  }
  button.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      type: "lens-save",
      windowId,
      source: "window",
      name,
    });
    if (!result || result.ok !== true) {
      button.disabled = false;
      setStatus("Could not save that lens. Try again.", "error");
      return;
    }
  } catch (error) {
    console.error("Welcome page lens save failed:", error);
    button.disabled = false;
    setStatus("Could not save that lens. Try again.", "error");
    return;
  }
  saved = true;
  button.textContent = "Saved";
  setStatus(`“${name}” is ready — open the Tabloupe toolbar icon to switch to it.`, "ok");
}

async function closePage() {
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab && typeof tab.id === "number") {
      await browser.tabs.remove(tab.id);
      return;
    }
  } catch (error) {
    // Fall through to window.close() below.
  }
  window.close();
}

function init() {
  el("save-lens").addEventListener("click", () => { saveLens(); });
  el("lens-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveLens();
    }
  });
  el("open-options").addEventListener("click", () => {
    browser.runtime.openOptionsPage().catch((error) => console.error("Opening options failed:", error));
  });
  el("done").addEventListener("click", () => { closePage(); });
  loadGroups();
  renderShortcutHint();
}

document.addEventListener("DOMContentLoaded", init);
