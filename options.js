const DEFAULT_FOCUS_ORDER = [
  "com.apple.focus.work",
  "com.apple.focus.personal-time",
  "com.apple.donotdisturb.mode.default",
  "com.apple.sleep.sleep-mode",
  "com.apple.donotdisturb.mode.graduationcapfill",
  "com.apple.focus.reduce-interruptions",
];

const DEFAULT_TAB_SEARCH_SHORTCUT = Object.freeze({ ctrl: true, alt: false, shift: false, meta: false, key: "s" });
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");
const LENS_COLOR_PALETTE = Object.freeze([
  "#0060df",
  "#00a7e0",
  "#12bc00",
  "#ff9400",
  "#d70022",
  "#b5007f",
  "#7c5cff",
  "#d7b600",
]);

// Default AI grouping system prompt. MUST stay identical to GROUPING_SYSTEM_PROMPT
// in background.js so a field equal to the default can be stored as an empty
// override (which then tracks future default changes).
const DEFAULT_GROUPING_PROMPT =
  "You organize a user's open browser tabs into a small number of topic groups. " +
  "Group tabs that share a project, task, or subject. Prefer " +
  "two to six groups. Every tab index belongs to exactly one group. Topic labels must be short " +
  '(1-4 words). Respond with ONLY a JSON object of the form ' +
  '{"groups":[{"topic":"...","tabIndices":[0,1]}]} and nothing else.';

const STORAGE_KEYS = [
  "lenses",
  "activeView",
  "lastActivation",
  "legacyFocusMappingsBackup",
  "seenFocusIds",
  "lastFocusSeen",
  "lastAction",
  "groupTitles",
  "unmappedFocusId",
  "missingGroup",
  "emptyGroup",
  "expandedGroups",
  "collapsedGroups",
  "updateFailures",
  "connectionState",
  "lastError",
  "tabSearchShortcut",
  "aiProvider",
  "aiGroupingPrompt",
  "lastProviderCheck",
  "focusCatalog",
  "lensSchedules",
  "focusSessionHistory",
  "automationFallback",
  "discardCollapsedTabs",
];

const state = {
  windowId: undefined,
  lenses: [],
  activeView: { kind: "all" },
  lastActivation: null,
  legacyFocusMappingsBackup: null,
  seenFocusIds: {},
  lastFocusSeen: null,
  lastAction: null,
  groupTitles: [],
  firefoxGroupTitles: [],
  firefoxGroupTitleCounts: {},
  currentGroups: [],
  containers: [],
  containerNames: [],
  unmappedFocusId: null,
  missingGroup: null,
  emptyGroup: null,
  expandedGroups: [],
  collapsedGroups: [],
  updateFailures: [],
  connectionState: "disconnected",
  lastError: null,
  tabSearchShortcut: { ...DEFAULT_TAB_SEARCH_SHORTCUT },
  aiProvider: { kind: "foundation" },
  aiGroupingPrompt: "",
  lastProviderCheck: null,
  focusCatalog: {},
  lensSchedules: [],
  focusSessionHistory: [],
  automationFallback: { kind: "all" },
  discardCollapsedTabs: false,
};

let recordingShortcut = false;
let activeAdderId = null;
let activeFocusPickerId = null;
let pendingNameEditId = null;
let openIconEditorId = null;
let dragState = null;
let rowDragState = null;
let statusUndoTimer = null;
const expandedLensRows = new Set();
const untouchedDefaultLensIds = new Set();
const userNamedLensIds = new Set();
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isGlobPattern(entry) {
  return /[*?]/.test(entry);
}

function normalizeSelector(value) {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type === "glob" ? "glob" : value.type === "title" ? "title" : value.type === "container" ? "container" : null;
  const selectorValue = typeof value.value === "string" ? value.value.trim() : "";
  if (!type || !selectorValue) {
    return null;
  }
  return { type, value: selectorValue };
}

function normalizeSelectors(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const selectors = [];
  for (const item of value) {
    const selector = normalizeSelector(item);
    if (!selector) continue;
    const key = `${selector.type}:${selector.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectors.push(selector);
  }
  return selectors;
}

function normalizeLens(value) {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Untitled lens",
    icon: typeof value.icon === "string" && value.icon.trim() ? value.icon.trim() : "target",
    color: typeof value.color === "string" && value.color.trim() ? value.color.trim() : null,
    groupSelectors: normalizeSelectors(value.groupSelectors),
    triggers: {
      appleFocusIds: isRecord(value.triggers) ? normalizeStringArray(value.triggers.appleFocusIds) : [],
    },
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    migratedFrom: isRecord(value.migratedFrom) ? value.migratedFrom : undefined,
  };
}

function normalizeLenses(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeLens).filter(Boolean);
}

function normalizeLensSchedules(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((schedule) => ({
    lensId: typeof schedule.lensId === "string" ? schedule.lensId : "",
    enabled: schedule.enabled === true,
    days: Array.isArray(schedule.days)
      ? [...new Set(schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [],
    start: typeof schedule.start === "string" && /^\d{2}:\d{2}$/.test(schedule.start) ? schedule.start : "09:00",
    end: typeof schedule.end === "string" && /^\d{2}:\d{2}$/.test(schedule.end) ? schedule.end : "17:00",
  })).filter((schedule) => schedule.lensId);
}

function normalizeFocusSessionHistory(value) {
  return Array.isArray(value) ? value.filter(isRecord).map((entry) => ({
    view: isRecord(entry.view) ? entry.view : { kind: "all" },
    trigger: typeof entry.trigger === "string" ? entry.trigger : "manual",
    startedAt: typeof entry.startedAt === "number" ? entry.startedAt : null,
    endedAt: typeof entry.endedAt === "number" ? entry.endedAt : null,
    expandedGroups: normalizeStringArray(entry.expandedGroups),
    collapsedGroups: normalizeStringArray(entry.collapsedGroups),
  })).filter((entry) => entry.startedAt && entry.endedAt) : [];
}

function normalizeSeen(value) {
  const output = {};
  if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id === "string" && id) {
        output[id] = { firstSeen: null, lastSeen: null };
      }
    }
    return output;
  }
  if (!isRecord(value)) {
    return output;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === "string" && isRecord(entry)) {
      output[key] = {
        firstSeen: typeof entry.firstSeen === "number" ? entry.firstSeen : null,
        lastSeen: typeof entry.lastSeen === "number" ? entry.lastSeen : null,
      };
    }
  }
  return output;
}

function normalizeCurrentGroups(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((group) => isRecord(group) && typeof group.title === "string" && group.title.length > 0)
    .map((group) => ({
      title: group.title,
      color: typeof group.color === "string" ? group.color : null,
      savedIn: Array.isArray(group.savedIn) ? normalizeStringArray(group.savedIn) : null,
      active: Boolean(group.active),
    }));
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function normalizeLastError(value) {
  if (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.at === "number" &&
    value.source === "ai"
  ) {
    return {
      code: value.code,
      message: value.message,
      at: value.at,
      source: "ai",
    };
  }
  return null;
}

function normalizeShortcut(value) {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.key !== "string" || value.key.length === 0) {
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

function uniqueSortedTitlesFromValues(titles) {
  return [...new Set(titles.filter((title) => typeof title === "string" && title.length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

async function queryFirefoxGroupSnapshot() {
  try {
    const groups = await browser.tabGroups.query({});
    const counts = {};
    const currentGroups = [];
    for (const group of groups) {
      if (typeof group.title !== "string" || group.title.length === 0) continue;
      counts[group.title] = (counts[group.title] || 0) + 1;
      currentGroups.push({
        title: group.title,
        color: typeof group.color === "string" ? group.color : null,
        savedIn: null,
        active: Boolean(group.active),
      });
    }
    return {
      titles: uniqueSortedTitlesFromValues(Object.keys(counts)),
      counts,
      currentGroups,
    };
  } catch (error) {
    console.error("Firefox tab group query failed:", error);
    return { titles: [], counts: {}, currentGroups: [] };
  }
}

function normalizeConnectionState(value) {
  if (value === "connected") {
    return "connected";
  }
  if (value === "reconnecting" || value === "connecting") {
    return "reconnecting";
  }
  return "disconnected";
}

async function currentWindowId() {
  if (!browser.windows || typeof browser.windows.getCurrent !== "function") {
    return undefined;
  }
  try {
    const current = await browser.windows.getCurrent();
    return current && typeof current.id === "number" ? current.id : undefined;
  } catch (error) {
    console.error("Current window lookup failed:", error);
    return undefined;
  }
}

async function requestLensState(windowId) {
  try {
    return await browser.runtime.sendMessage({ type: "lens-state", windowId });
  } catch (error) {
    console.error("Lens state request failed:", error);
    return null;
  }
}

function normalizeContainers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((container) => ({
      cookieStoreId: typeof container.cookieStoreId === "string" ? container.cookieStoreId : "",
      name: typeof container.name === "string" ? container.name.trim() : "",
      color: typeof container.color === "string" ? container.color : "",
      icon: typeof container.icon === "string" ? container.icon : "",
    }))
    .filter((container) => container.cookieStoreId && container.name);
}

async function requestContainers() {
  try {
    const response = await browser.runtime.sendMessage({ type: "tabsearch-containers" });
    return response && response.ok ? normalizeContainers(response.containers) : [];
  } catch (error) {
    return [];
  }
}

function mergeLensStateSummaries(lensSummaries) {
  if (!Array.isArray(lensSummaries)) {
    return;
  }
  const byId = new Map(state.lenses.map((lens) => [lens.id, lens]));
  for (const summary of lensSummaries) {
    if (!isRecord(summary) || typeof summary.id !== "string") continue;
    const existing = byId.get(summary.id);
    if (!existing) continue;
    if (typeof summary.name === "string" && summary.name.trim()) {
      existing.name = summary.name.trim();
    }
    if (typeof summary.icon === "string" && summary.icon.trim()) {
      existing.icon = summary.icon.trim();
    }
    if (typeof summary.color === "string" && summary.color.trim()) {
      existing.color = summary.color.trim();
    }
    if (summary.active) {
      state.activeView = { kind: "lens", lensId: summary.id };
    }
  }
}

async function loadAll() {
  const windowId = await currentWindowId();
  state.windowId = windowId;
  const [stored, firefoxSnapshot, lensState, containers] = await Promise.all([
    browser.storage.local.get(STORAGE_KEYS),
    queryFirefoxGroupSnapshot(),
    requestLensState(windowId),
    requestContainers(),
  ]);

  state.lenses = normalizeLenses(stored.lenses);
  state.activeView = isRecord(stored.activeView) ? stored.activeView : { kind: "all" };
  state.lastActivation = isRecord(stored.lastActivation) ? stored.lastActivation : null;
  state.legacyFocusMappingsBackup = isRecord(stored.legacyFocusMappingsBackup) ? stored.legacyFocusMappingsBackup : null;
  state.seenFocusIds = normalizeSeen(stored.seenFocusIds);
  state.lastFocusSeen = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
  state.lastAction = typeof stored.lastAction === "string" ? stored.lastAction : null;
  state.groupTitles = normalizeStringArray(stored.groupTitles);
  state.firefoxGroupTitles = firefoxSnapshot.titles;
  state.firefoxGroupTitleCounts = firefoxSnapshot.counts;
  state.currentGroups = firefoxSnapshot.currentGroups;
  state.containers = containers;
  state.containerNames = uniqueSortedTitlesFromValues(containers.map((container) => container.name));
  state.unmappedFocusId = typeof stored.unmappedFocusId === "string" ? stored.unmappedFocusId : null;
  state.missingGroup = typeof stored.missingGroup === "string" ? stored.missingGroup : null;
  state.emptyGroup = typeof stored.emptyGroup === "string" ? stored.emptyGroup : null;
  state.expandedGroups = normalizeStringArray(stored.expandedGroups);
  state.collapsedGroups = normalizeStringArray(stored.collapsedGroups);
  state.updateFailures = normalizeStringArray(stored.updateFailures);
  state.connectionState = normalizeConnectionState(stored.connectionState);
  state.lastError = normalizeLastError(stored.lastError);
  state.tabSearchShortcut = "tabSearchShortcut" in stored
    ? normalizeShortcut(stored.tabSearchShortcut)
    : { ...DEFAULT_TAB_SEARCH_SHORTCUT };
  state.aiProvider = normalizeProvider(stored.aiProvider);
  state.aiGroupingPrompt = normalizeGroupingPrompt(stored.aiGroupingPrompt);
  state.lastProviderCheck = normalizeProviderCheck(stored.lastProviderCheck);
  state.discardCollapsedTabs = stored.discardCollapsedTabs === true;
  state.focusCatalog = isRecord(stored.focusCatalog) ? stored.focusCatalog : {};
  state.lensSchedules = normalizeLensSchedules(stored.lensSchedules);
  state.focusSessionHistory = normalizeFocusSessionHistory(stored.focusSessionHistory);
  state.automationFallback = isRecord(stored.automationFallback) ? stored.automationFallback : { kind: "all" };
  if (isRecord(lensState)) {
    if (isRecord(lensState.activeView)) {
      state.activeView = lensState.activeView;
    }
    if (isRecord(lensState.lastActivation)) {
      state.lastActivation = lensState.lastActivation;
    }
    if (Array.isArray(lensState.currentGroups)) {
      const liveGroups = normalizeCurrentGroups(lensState.currentGroups);
      const liveCounts = {};
      for (const group of liveGroups) {
        liveCounts[group.title] = (liveCounts[group.title] || 0) + 1;
      }
      state.currentGroups = liveGroups;
      state.firefoxGroupTitles = uniqueSortedTitlesFromValues(Object.keys(liveCounts));
      state.firefoxGroupTitleCounts = liveCounts;
    }
    mergeLensStateSummaries(lensState.lenses);
  }
  syncUntouchedDefaultLenses();

  render();
  renderProvider();
  renderGroupingPrompt();
}

function clearStatusUndoTimer() {
  window.clearTimeout(statusUndoTimer);
  statusUndoTimer = null;
}

function setStatus(message, kind = "") {
  clearStatusUndoTimer();
  const status = document.getElementById("status");
  status.replaceChildren(document.createTextNode(message));
  status.className = kind;
}


const TRASH_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

const CHEVRON_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 9l6 6 6-6"/></svg>';

function trustedHTMLNodes(markup) {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  return Array.from(parsed.body.childNodes, (node) => document.importNode(node, true));
}

function replaceChildrenWithTrustedHTML(element, markup) {
  element.replaceChildren(...trustedHTMLNodes(markup));
}

// ── Focus catalog fallback (bundled) ──
// MCC is the source of truth: it broadcasts id -> {name, icon, color}, which we
// cache in storage (state.focusCatalog) and prefer here. This bundled table is
// only a fallback for ids the daemon has not sent yet (daemon down / fresh
// start). The UI only depends on focusCatalogEntry().
const FOCUS_CATALOG = {
  "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#c678dd" },
  "com.apple.focus.personal-time": { name: "Personal", icon: "person", color: "#c678dd" },
  "com.apple.donotdisturb.mode.default": { name: "Do Not Disturb", icon: "moon", color: "#e5c07b" },
  "com.apple.sleep.sleep-mode": { name: "Sleep", icon: "bed", color: "#56b6c2" },
  "com.apple.donotdisturb.mode.graduationcapfill": { name: "Study", icon: "graduation-cap", color: "#61afef" },
  "com.apple.focus.reduce-interruptions": { name: "Reduce Interruptions", icon: "sparkles", color: "#e5c07b" },
};

const FOCUS_ICON_PATHS = {
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  person: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  bed: '<path d="M2 4v16"/><path d="M2 9h18a2 2 0 0 1 2 2v9"/><path d="M2 16h20"/><path d="M6 9v3"/>',
  "graduation-cap": '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 4v3M20.5 5.5h-3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
};

function focusCatalogEntry(id) {
  const cached = state.focusCatalog[id];
  if (cached && typeof cached.name === "string" && cached.name) {
    return {
      name: cached.name,
      icon: typeof cached.icon === "string" ? cached.icon : "target",
      color: typeof cached.color === "string" ? cached.color : null,
    };
  }
  return FOCUS_CATALOG[id] || { name: id, icon: "target", color: null };
}

function makeFocusIcon(iconName, color) {
  const wrap = document.createElement("span");
  wrap.className = "focus-icon";
  wrap.setAttribute("aria-hidden", "true");
  if (color) wrap.style.color = color;
  replaceChildrenWithTrustedHTML(
    wrap,
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      (FOCUS_ICON_PATHS[iconName] || FOCUS_ICON_PATHS.target) +
      "</svg>"
  );
  return wrap;
}

function findLens(lensId) {
  return state.lenses.find((lens) => lens.id === lensId) || null;
}

function cloneLensForRestore(lens) {
  return {
    ...lens,
    groupSelectors: lens.groupSelectors.map((selector) => ({ ...selector })),
    triggers: { appleFocusIds: [...lens.triggers.appleFocusIds] },
  };
}

function lensIsActive(lens) {
  return state.activeView && state.activeView.kind === "lens" && state.activeView.lensId === lens.id;
}

function provisionalDefaultName() {
  return `Lens ${state.lenses.length + 1}`;
}

function isProvisionalDefaultName(name) {
  return typeof name === "string" && /^Lens \d+$/.test(name.trim());
}

function lensHasNoBindings(lens) {
  return lens.groupSelectors.length === 0 && lens.triggers.appleFocusIds.length === 0;
}

function syncUntouchedDefaultLenses() {
  const liveIds = new Set(state.lenses.map((lens) => lens.id));
  for (const lens of state.lenses) {
    if (!userNamedLensIds.has(lens.id) && isProvisionalDefaultName(lens.name) && lensHasNoBindings(lens)) {
      untouchedDefaultLensIds.add(lens.id);
    } else {
      untouchedDefaultLensIds.delete(lens.id);
    }
  }
  for (const lensId of [...untouchedDefaultLensIds]) {
    if (!liveIds.has(lensId)) {
      untouchedDefaultLensIds.delete(lensId);
      userNamedLensIds.delete(lensId);
    }
  }
  for (const lensId of [...userNamedLensIds]) {
    if (!liveIds.has(lensId)) {
      userNamedLensIds.delete(lensId);
    }
  }
}

function lensHasUntouchedDefaultName(lens) {
  return !userNamedLensIds.has(lens.id) &&
    isProvisionalDefaultName(lens.name) &&
    (untouchedDefaultLensIds.has(lens.id) || lensHasNoBindings(lens));
}

function firstBindingAutoNamePatch(lens, proposedName, isFirstBinding) {
  const name = typeof proposedName === "string" ? proposedName.trim() : "";
  if (!isFirstBinding || !name || !lensHasUntouchedDefaultName(lens)) {
    return {};
  }
  untouchedDefaultLensIds.delete(lens.id);
  return { name };
}

function nextLensColor() {
  const used = new Set(state.lenses.map((lens) => (lens.color || "").toLowerCase()).filter(Boolean));
  const unused = LENS_COLOR_PALETTE.find((color) => !used.has(color.toLowerCase()));
  return unused || LENS_COLOR_PALETTE[state.lenses.length % LENS_COLOR_PALETTE.length];
}

function generateLensId() {
  return `lens_${Math.random().toString(36).slice(2, 10) || Date.now().toString(36)}`;
}

function uniqueLensId(lenses) {
  const existingIds = new Set(lenses.map((lens) => lens.id));
  let id = generateLensId();
  while (existingIds.has(id)) {
    id = generateLensId();
  }
  return id;
}

function sharePayloadForLens(lens) {
  return {
    tabloupeLens: 1,
    lens: {
      name: lens.name,
      icon: lens.icon,
      color: lens.color,
      groupSelectors: normalizeSelectors(lens.groupSelectors),
    },
  };
}

function showLensShareFallback(code) {
  try {
    if (typeof window.prompt === "function") {
      window.prompt("Copy this lens code:", code);
      return;
    }
  } catch (error) {
    console.error("Lens share prompt failed:", error);
  }
  const input = document.getElementById("lens-import-code");
  if (input) {
    input.value = code;
    input.focus();
    input.select();
  }
  showToast("Copy the lens code shown on this page.", "ok");
}

async function shareLens(lens) {
  const code = JSON.stringify(sharePayloadForLens(lens));
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(code);
    showToast("Lens copied to clipboard.", "ok");
  } catch (error) {
    showLensShareFallback(code);
  }
}

function importedLensFromCode(code, existingLenses) {
  let parsed;
  try {
    parsed = JSON.parse(code.trim());
  } catch (error) {
    return null;
  }
  if (!isRecord(parsed) || parsed.tabloupeLens !== 1 || !isRecord(parsed.lens)) {
    return null;
  }
  const name = typeof parsed.lens.name === "string" ? parsed.lens.name.trim() : "";
  if (!name) {
    return null;
  }
  const now = Date.now();
  return normalizeLens({
    id: uniqueLensId(existingLenses),
    name,
    icon: parsed.lens.icon,
    color: parsed.lens.color,
    groupSelectors: parsed.lens.groupSelectors,
    triggers: { appleFocusIds: [] },
    createdAt: now,
    updatedAt: now,
  });
}

async function addLensFromCode() {
  const input = document.getElementById("lens-import-code");
  const code = input ? input.value : "";
  const stored = await browser.storage.local.get("lenses");
  const lenses = normalizeLenses(stored.lenses);
  const lens = importedLensFromCode(code, lenses);
  if (!lens) {
    showToast("Not a valid lens code.", "error");
    return;
  }
  const next = normalizeLenses([...lenses, lens]);
  await browser.storage.local.set({ lenses: next });
  state.lenses = next;
  if (input) {
    input.value = "";
  }
  render();
  showToast("Lens added.", "ok");
}

function selectorKey(selector) {
  return `${selector.type}:${selector.value}`;
}

function lensSelectorValues(lens, type) {
  return lens.groupSelectors
    .filter((selector) => selector.type === type)
    .map((selector) => selector.value);
}

function makeRowDatalist(listId, excluded) {
  const datalist = document.createElement("datalist");
  datalist.id = listId;
  const excludedSet = new Set(excluded);
  const available = state.firefoxGroupTitles.filter((title) => !excludedSet.has(title));
  datalist.replaceChildren(...available.map((title) => {
    const option = document.createElement("option");
    option.value = title;
    return option;
  }));
  return datalist;
}

function makeContainerDatalist(listId, excluded) {
  const datalist = document.createElement("datalist");
  datalist.id = listId;
  const excludedSet = new Set(excluded.map((value) => value.toLowerCase()));
  const available = state.containerNames.filter((name) => !excludedSet.has(name.toLowerCase()));
  datalist.replaceChildren(...available.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
  return datalist;
}

function replaceLensInState(lensId, patch) {
  const index = state.lenses.findIndex((lens) => lens.id === lensId);
  if (index === -1) {
    return null;
  }
  const current = state.lenses[index];
  const next = normalizeLens({
    ...current,
    ...patch,
    triggers: patch.triggers || current.triggers,
    groupSelectors: patch.groupSelectors || current.groupSelectors,
    updatedAt: Date.now(),
  });
  if (!next) {
    return null;
  }
  state.lenses.splice(index, 1, next);
  return next;
}

async function persistLensPatch(lensId, patch, statusMessage = "Saved") {
  const next = replaceLensInState(lensId, patch);
  if (!next) {
    setStatus("Lens not found.", "error");
    return null;
  }
  render();
  await browser.runtime.sendMessage({ type: "lens-update", lensId, patch });
  setStatus(statusMessage, "ok");
  return next;
}

function selectorFromText(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  return { type: isGlobPattern(trimmed) ? "glob" : "title", value: trimmed };
}

function selectorFromTypedInput(type, value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  if (type === "container") {
    return { type: "container", value: trimmed };
  }
  if (type === "glob") {
    return { type: "glob", value: trimmed };
  }
  return selectorFromText(trimmed);
}

function addSelectorToLens(lensId, selector) {
  const lens = findLens(lensId);
  const normalized = normalizeSelector(selector);
  if (!lens || !normalized) return;
  if (lens.groupSelectors.some((existing) => selectorKey(existing) === selectorKey(normalized))) return;
  const groupSelectors = [...lens.groupSelectors, normalized];
  const patch = {
    groupSelectors,
    ...firstBindingAutoNamePatch(lens, normalized.type === "title" ? normalized.value : "", lens.groupSelectors.length === 0),
  };
  activeAdderId = lensId;
  if (normalized.type === "glob") {
    expandedLensRows.add(lensId);
  }
  persistLensPatch(lensId, patch, "Group saved").catch((error) => {
    console.error("Lens group save failed:", error);
    setStatus("Save failed. See extension console.", "error");
  });
}

function removeSelectorFromLens(lensId, selector) {
  const lens = findLens(lensId);
  const normalized = normalizeSelector(selector);
  if (!lens || !normalized) return;
  const removeKey = selectorKey(normalized);
  const groupSelectors = lens.groupSelectors.filter((existing) => selectorKey(existing) !== removeKey);
  persistLensPatch(lensId, { groupSelectors }, "Group removed").catch((error) => {
    console.error("Lens group removal failed:", error);
    setStatus("Save failed. See extension console.", "error");
  });
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${body}$`);
}

function selectorMatchesTitle(selector, title) {
  if (selector.type === "title") {
    return selector.value === title;
  }
  if (selector.type === "glob") {
    return globToRegExp(selector.value).test(title);
  }
  return false;
}

function selectorMatchCount(selector) {
  if (selector.type === "title") {
    return state.firefoxGroupTitleCounts[selector.value] || 0;
  }
  if (selector.type === "container") {
    const target = selector.value.toLowerCase();
    return state.containerNames.some((name) => name.toLowerCase() === target) ? 1 : 0;
  }
  const regex = globToRegExp(selector.value);
  return Object.entries(state.firefoxGroupTitleCounts).reduce((count, [title, titleCount]) => {
    return regex.test(title) ? count + titleCount : count;
  }, 0);
}

function makeChip(lensId, selector) {
  const chip = document.createElement("span");
  const count = selectorMatchCount(selector);
  chip.className = `group-chip${selector.type === "glob" ? " group-chip-pattern" : ""}${selector.type === "container" ? " group-chip-container" : ""}${count === 0 ? " is-muted" : ""}`;
  const label = document.createElement("span");
  label.className = "group-chip-label";
  label.textContent = selector.value;
  chip.append(label);

  if (selector.type === "glob" || selector.type === "container") {
    const badge = document.createElement("span");
    badge.className = "group-chip-badge";
    badge.textContent = selector.type === "container" ? "container" : "pattern";
    chip.append(badge);
  }
  if (count === 0) {
    const meta = document.createElement("span");
    meta.className = "group-chip-meta";
    meta.textContent = "no match";
    chip.append(meta);
  } else if (selector.type === "glob") {
    const meta = document.createElement("span");
    meta.className = "group-chip-meta";
    meta.textContent = `matches ${count}`;
    chip.append(meta);
  } else if (count > 1) {
    const meta = document.createElement("span");
    meta.className = "group-chip-meta";
    meta.textContent = `in ${count} groups`;
    chip.append(meta);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "group-chip-remove";
  remove.setAttribute("aria-label", `Remove ${selector.value}`);
  remove.textContent = "\u00d7";
  remove.addEventListener("click", () => removeSelectorFromLens(lensId, selector));
  chip.append(remove);
  return chip;
}

function makePatternChip(lensId, selector) {
  const chip = makeChip(lensId, selector);
  chip.querySelector(".group-chip-remove").setAttribute("aria-label", `Remove pattern ${selector.value}`);
  return chip;
}

function lensIconGlyph(icon) {
  const glyphs = {
    briefcase: "\ud83d\udcbc",
    book: "\ud83d\udcd6",
    circle: "\u25e6",
    moon: "\ud83c\udf19",
    person: "\ud83d\udc64",
    reading: "\ud83d\udcd6",
    sparkles: "\u2726",
    target: "\u25ce",
  };
  if (!icon) return "L";
  return glyphs[icon] || icon.slice(0, 2);
}

function makeLensStyleEditor(lens) {
  const editor = document.createElement("div");
  editor.className = "lens-style-editor";

  const iconLabel = document.createElement("label");
  const iconText = document.createElement("span");
  iconText.textContent = "Icon";
  const iconInput = document.createElement("input");
  iconInput.type = "text";
  iconInput.value = lens.icon || "";
  iconInput.placeholder = "briefcase";
  iconInput.setAttribute("aria-label", `Icon for ${lens.name}`);
  iconInput.addEventListener("change", () => {
    const icon = iconInput.value.trim() || "circle";
    persistLensPatch(lens.id, { icon }, "Icon saved").catch((error) => {
      console.error("Lens icon save failed:", error);
      setStatus("Save failed. See extension console.", "error");
    });
  });
  iconLabel.append(iconText, iconInput);

  const colorLabel = document.createElement("label");
  const colorText = document.createElement("span");
  colorText.textContent = "Color";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = /^#[0-9a-f]{6}$/i.test(lens.color || "") ? lens.color : "#7c5cff";
  colorInput.setAttribute("aria-label", `Color for ${lens.name}`);
  colorInput.addEventListener("change", () => {
    persistLensPatch(lens.id, { color: colorInput.value || null }, "Color saved").catch((error) => {
      console.error("Lens color save failed:", error);
      setStatus("Save failed. See extension console.", "error");
    });
  });
  colorLabel.append(colorText, colorInput);

  editor.append(iconLabel, colorLabel);
  return editor;
}

function makeLensIcon(lens) {
  const wrap = document.createElement("span");
  wrap.className = "lens-icon-wrap";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lens-icon-button";
  button.textContent = lensIconGlyph(lens.icon || lens.name);
  button.title = "Edit lens icon and color";
  button.setAttribute("aria-label", `Edit icon and color for ${lens.name}`);
  if (lens.color) {
    button.style.color = lens.color;
  }
  button.addEventListener("click", () => {
    openIconEditorId = openIconEditorId === lens.id ? null : lens.id;
    render();
  });
  wrap.append(button);
  if (openIconEditorId === lens.id) {
    const popover = document.createElement("div");
    popover.className = "lens-icon-popover";
    popover.append(makeLensStyleEditor(lens));
    wrap.append(popover);
  }
  return wrap;
}

function dragPayloadFromEvent(event) {
  if (dragState) {
    return dragState;
  }
  const raw = event.dataTransfer && event.dataTransfer.getData("application/x-tab-lens");
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function makeDraggable(element, payload) {
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    dragState = payload;
    element.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = payload.type === "focus" ? "move" : "copy";
      event.dataTransfer.setData("application/x-tab-lens", JSON.stringify(payload));
      event.dataTransfer.setData("text/plain", payload.value);
    }
  });
  element.addEventListener("dragend", () => {
    dragState = null;
    element.classList.remove("is-dragging");
  });
  return element;
}

function makeDropTarget(element, acceptedType, onDrop) {
  const accepts = (event) => {
    const payload = dragPayloadFromEvent(event);
    return payload && payload.type === acceptedType;
  };
  element.addEventListener("dragenter", (event) => {
    if (!accepts(event)) return;
    event.preventDefault();
    element.classList.add("is-drop-active");
  });
  element.addEventListener("dragover", (event) => {
    if (!accepts(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = acceptedType === "focus" ? "move" : "copy";
    }
    element.classList.add("is-drop-active");
  });
  element.addEventListener("dragleave", () => {
    element.classList.remove("is-drop-active");
  });
  element.addEventListener("drop", (event) => {
    const payload = dragPayloadFromEvent(event);
    element.classList.remove("is-drop-active");
    if (!payload || payload.type !== acceptedType) return;
    event.preventDefault();
    onDrop(payload.value);
  });
  return element;
}

function focusUiGated() {
  return IS_MAC ||
    Object.keys(state.seenFocusIds).length > 0 ||
    Object.keys(state.focusCatalog).length > 0 ||
    state.lenses.some((lens) => lens.triggers.appleFocusIds.length > 0);
}

function sortedFocusIds() {
  const ids = new Set([
    ...Object.keys(state.focusCatalog),
    ...Object.keys(state.seenFocusIds),
  ]);
  for (const lens of state.lenses) {
    for (const id of lens.triggers.appleFocusIds) {
      ids.add(id);
    }
  }
  const order = new Map(DEFAULT_FOCUS_ORDER.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => {
    const aIndex = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const bIndex = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    return focusCatalogEntry(a).name.localeCompare(focusCatalogEntry(b).name);
  });
}

function lensBoundToAppleFocusId(focusId) {
  return state.lenses.find((lens) => lens.triggers.appleFocusIds.includes(focusId)) || null;
}

function unlinkedFocusIds() {
  return sortedFocusIds().filter((id) => !lensBoundToAppleFocusId(id));
}

async function linkFocusToLens(lensId, focusId) {
  if (!focusId) return;
  const targetLens = lensId ? findLens(lensId) : null;
  const entry = focusCatalogEntry(focusId);
  const namePatch = targetLens
    ? firstBindingAutoNamePatch(targetLens, entry.name, targetLens.triggers.appleFocusIds.length === 0)
    : {};
  for (const lens of state.lenses) {
    const ids = lens.triggers.appleFocusIds.filter((id) => id !== focusId);
    if (lens.id === lensId) {
      ids.push(focusId);
      if (namePatch.name) {
        lens.name = namePatch.name;
      }
    }
    lens.triggers = { ...lens.triggers, appleFocusIds: [...new Set(ids)].sort() };
  }
  activeFocusPickerId = null;
  render();
  const message = { type: "lens-link-focus", focusId };
  if (lensId) {
    message.lensId = lensId;
  }
  await browser.runtime.sendMessage(message);
  if (lensId && namePatch.name) {
    await browser.runtime.sendMessage({ type: "lens-update", lensId, patch: namePatch });
  }
  setStatus(lensId ? "Focus link saved." : "Focus link removed.", "ok");
}

function makeFocusPill(lens, focusId) {
  const entry = focusCatalogEntry(focusId);
  const pill = document.createElement("span");
  pill.className = "focus-pill";
  pill.title = `When macOS Focus “${entry.name}” turns on → show this lens`;
  pill.append(document.createTextNode(`\u26a1 ${entry.name}`));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "focus-pill-remove";
  remove.textContent = "\u00d7";
  remove.setAttribute("aria-label", `Unlink ${entry.name}`);
  remove.addEventListener("click", () => {
    linkFocusToLens(null, focusId).catch((error) => {
      console.error("Focus unlink failed:", error);
      setStatus("Save failed. See extension console.", "error");
    });
  });
  pill.append(remove);
  return pill;
}

function renderTriggerAffordance(lens) {
  if (!focusUiGated()) {
    return null;
  }
  const trigger = document.createElement("div");
  trigger.className = "lens-trigger";
  makeDropTarget(trigger, "focus", (focusId) => {
    linkFocusToLens(lens.id, focusId).catch((error) => {
      console.error("Focus link failed:", error);
      setStatus("Save failed. See extension console.", "error");
    });
  });

  for (const focusId of lens.triggers.appleFocusIds) {
    trigger.append(makeFocusPill(lens, focusId));
  }

  const pickerWrap = document.createElement("span");
  pickerWrap.className = "focus-picker-wrap";
  const pickerButton = document.createElement("button");
  const hasFocusPills = lens.triggers.appleFocusIds.length > 0;
  const pickerId = `focus-picker-${lens.id}`;
  pickerButton.type = "button";
  pickerButton.className = `secondary focus-picker-toggle${hasFocusPills ? " compact" : ""}`;
  pickerButton.textContent = hasFocusPills ? "+" : "Activate when\u2026";
  pickerButton.title = "Link a macOS Focus mode";
  pickerButton.setAttribute("aria-label", `Link a macOS Focus mode to ${lens.name}`);
  pickerButton.setAttribute("aria-expanded", String(activeFocusPickerId === lens.id));
  pickerButton.setAttribute("aria-controls", pickerId);
  pickerButton.addEventListener("click", () => {
    activeFocusPickerId = activeFocusPickerId === lens.id ? null : lens.id;
    render();
  });
  const picker = document.createElement("select");
  picker.id = pickerId;
  picker.className = "focus-picker";
  picker.hidden = activeFocusPickerId !== lens.id;
  picker.setAttribute("aria-label", `Activate ${lens.name} when Focus starts`);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  const available = unlinkedFocusIds();
  placeholder.textContent = available.length > 0 ? "Choose Focus mode" : "No unlinked modes";
  picker.append(placeholder);
  for (const focusId of available) {
    const option = document.createElement("option");
    option.value = focusId;
    option.textContent = focusCatalogEntry(focusId).name;
    picker.append(option);
  }
  picker.disabled = available.length === 0;
  picker.addEventListener("change", () => {
    linkFocusToLens(lens.id, picker.value).catch((error) => {
      console.error("Focus link failed:", error);
      setStatus("Save failed. See extension console.", "error");
    });
  });
  pickerWrap.append(pickerButton, picker);
  trigger.append(pickerWrap);
  if (activeFocusPickerId === lens.id) {
    window.setTimeout(() => {
      const nextPicker = document.getElementById(pickerId);
      if (nextPicker && !nextPicker.hidden && !nextPicker.disabled) nextPicker.focus();
    }, 0);
  }
  return trigger;
}

function helperStatusText() {
  if (state.connectionState === "connected") {
    return "Helper connected";
  }
  if (state.connectionState === "reconnecting") {
    return "Reconnecting";
  }
  return "No helper connected";
}

function commitLensName(lens, input) {
  const name = input.value.trim();
  if (!name || name === lens.name) {
    input.value = lens.name;
    return;
  }
  untouchedDefaultLensIds.delete(lens.id);
  userNamedLensIds.add(lens.id);
  persistLensPatch(lens.id, { name }, "Lens renamed").catch((error) => {
    console.error("Lens rename failed:", error);
    setStatus("Save failed. See extension console.", "error");
  });
}

async function persistLensOrder(orderedIds) {
  await browser.runtime.sendMessage({ type: "lens-reorder", orderedIds });
  setStatus("Lens order saved.", "ok");
}

function moveLensToIndex(lensId, nextIndex) {
  const currentIndex = state.lenses.findIndex((lens) => lens.id === lensId);
  if (currentIndex === -1) return;
  const boundedIndex = Math.max(0, Math.min(nextIndex, state.lenses.length - 1));
  if (boundedIndex === currentIndex) return;
  const [lens] = state.lenses.splice(currentIndex, 1);
  state.lenses.splice(boundedIndex, 0, lens);
  const orderedIds = state.lenses.map((entry) => entry.id);
  render();
  persistLensOrder(orderedIds).catch((error) => {
    console.error("Lens reorder failed:", error);
    setStatus("Save failed. See extension console.", "error");
  });
}

function makeRowDragHandle(card, lens) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.textContent = "\u283f";
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-label", `Reorder ${lens.name}`);
  handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    rowDragState = { lensId: lens.id };
    card.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", lens.id);
    }
  });
  handle.addEventListener("dragend", () => {
    rowDragState = null;
    card.classList.remove("is-dragging");
  });
  return handle;
}

function makeRowDropTarget(card, lens) {
  card.addEventListener("dragenter", (event) => {
    if (!rowDragState || rowDragState.lensId === lens.id) return;
    event.preventDefault();
    card.classList.add("is-row-drop-target");
  });
  card.addEventListener("dragover", (event) => {
    if (!rowDragState || rowDragState.lensId === lens.id) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  });
  card.addEventListener("dragleave", () => {
    card.classList.remove("is-row-drop-target");
  });
  card.addEventListener("drop", (event) => {
    card.classList.remove("is-row-drop-target");
    if (!rowDragState || rowDragState.lensId === lens.id) return;
    event.preventDefault();
    moveLensToIndex(rowDragState.lensId, state.lenses.findIndex((entry) => entry.id === lens.id));
    rowDragState = null;
  });
}

function scheduleForLens(lensId) {
  return state.lensSchedules.find((schedule) => schedule.lensId === lensId) || {
    lensId,
    enabled: false,
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "17:00",
  };
}

async function persistLensSchedule(lensId, patch) {
  const schedules = normalizeLensSchedules(state.lensSchedules);
  const index = schedules.findIndex((schedule) => schedule.lensId === lensId);
  const existing = index === -1 ? scheduleForLens(lensId) : schedules[index];
  const next = { ...existing, ...patch, lensId };
  if (index === -1) {
    schedules.push(next);
  } else {
    schedules[index] = next;
  }
  state.lensSchedules = normalizeLensSchedules(schedules);
  await browser.storage.local.set({ lensSchedules: state.lensSchedules });
  render();
}

function makeScheduleEditor(lens) {
  const schedule = scheduleForLens(lens.id);
  const wrap = document.createElement("div");
  wrap.className = "schedule-editor";
  const label = document.createElement("label");
  label.className = "toggle inline-toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = schedule.enabled;
  checkbox.addEventListener("change", () => {
    persistLensSchedule(lens.id, { enabled: checkbox.checked }).catch((error) => {
      console.error("Schedule save failed:", error);
      setStatus("Schedule save failed. See extension console.", "error");
    });
  });
  label.append(checkbox, document.createElement("span"));
  label.lastChild.textContent = "Activate on a schedule";

  const row = document.createElement("div");
  row.className = "schedule-row";
  const start = document.createElement("input");
  start.type = "time";
  start.value = schedule.start;
  const end = document.createElement("input");
  end.type = "time";
  end.value = schedule.end;
  const days = document.createElement("input");
  days.type = "text";
  days.className = "mono";
  days.value = schedule.days.join(",");
  days.placeholder = "1,2,3,4,5";
  days.setAttribute("aria-label", `Schedule days for ${lens.name}`);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "secondary compact";
  save.textContent = "Save schedule";
  save.addEventListener("click", () => {
    const parsedDays = days.value.split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
    persistLensSchedule(lens.id, { start: start.value || "09:00", end: end.value || "17:00", days: parsedDays }).catch((error) => {
      console.error("Schedule save failed:", error);
      setStatus("Schedule save failed. See extension console.", "error");
    });
  });
  row.append("Days ", days, " from ", start, " to ", end, save);
  const hint = document.createElement("p");
  hint.className = "field-hint";
  hint.textContent = "Days use 0=Sun through 6=Sat. Schedules are ignored while a live Apple Focus activation owns the current view.";
  wrap.append(label, row, hint);
  return wrap;
}


function renderLensCard(lens, index) {
  const card = document.createElement("article");
  const isActive = lensIsActive(lens);
  card.className = "lens-card lens-row";
  card.dataset.lensId = lens.id;
  if (lens.color) {
    card.style.setProperty("--lens-color", lens.color);
  }
  if (isActive) {
    card.classList.add("is-active");
  }
  makeRowDropTarget(card, lens);

  const header = document.createElement("div");
  header.className = "lens-card-header";
  header.append(makeRowDragHandle(card, lens));
  header.append(makeLensIcon(lens));

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "lens-name-input";
  nameInput.value = lens.name;
  nameInput.setAttribute("aria-label", `Lens name for ${lens.name}`);
  nameInput.addEventListener("blur", () => commitLensName(lens, nameInput));
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      nameInput.blur();
    } else if (event.key === "Escape") {
      nameInput.value = lens.name;
      nameInput.blur();
    }
  });
  nameInput.addEventListener("input", () => {
    if (pendingNameEditId === lens.id) pendingNameEditId = null;
  });
  nameInput.addEventListener("blur", () => {
    if (pendingNameEditId === lens.id) pendingNameEditId = null;
  });
  header.append(nameInput);

  const active = document.createElement("span");
  if (isActive) {
    active.className = "lens-active-pill";
    active.textContent = "\u25cf active";
  }
  header.append(active);

  const trigger = renderTriggerAffordance(lens);
  if (trigger) {
    header.append(trigger);
  } else {
    header.append(document.createElement("span"));
  }

  const actions = document.createElement("div");
  actions.className = "lens-card-actions";
  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "secondary lens-show-button";
  showButton.textContent = isActive ? "Showing" : "Show";
  showButton.disabled = isActive;
  showButton.setAttribute("aria-label", `Show lens ${lens.name}`);
  showButton.addEventListener("click", () => {
    activateLensView({ kind: "lens", lensId: lens.id }).catch((error) => {
      console.error("Lens activation failed:", error);
      setStatus("Switch failed. See extension console.", "error");
    });
  });
  const shareButton = document.createElement("button");
  shareButton.type = "button";
  shareButton.className = "secondary lens-share-button";
  shareButton.textContent = "Share";
  shareButton.setAttribute("aria-label", `Share lens ${lens.name}`);
  shareButton.addEventListener("click", () => {
    shareLens(lens).catch((error) => {
      console.error("Lens share failed:", error);
      showLensShareFallback(JSON.stringify(sharePayloadForLens(lens)));
    });
  });
  const orderActions = document.createElement("span");
  orderActions.className = "row-order-actions";
  const moveUp = document.createElement("button");
  moveUp.type = "button";
  moveUp.textContent = "\u2191";
  moveUp.disabled = index === 0;
  moveUp.setAttribute("aria-label", `Move ${lens.name} up`);
  moveUp.addEventListener("click", () => moveLensToIndex(lens.id, index - 1));
  const moveDown = document.createElement("button");
  moveDown.type = "button";
  moveDown.textContent = "\u2193";
  moveDown.disabled = index === state.lenses.length - 1;
  moveDown.setAttribute("aria-label", `Move ${lens.name} down`);
  moveDown.addEventListener("click", () => moveLensToIndex(lens.id, index + 1));
  orderActions.append(moveUp, moveDown);

  const optionsBtn = document.createElement("button");
  optionsBtn.type = "button";
  optionsBtn.className = "icon-btn icon-btn-options";
  const optionsOpen = expandedLensRows.has(lens.id);
  optionsBtn.classList.toggle("is-open", optionsOpen);
  optionsBtn.setAttribute("aria-expanded", String(optionsOpen));
  optionsBtn.title = "Advanced";
  optionsBtn.setAttribute("aria-label", `Advanced options for ${lens.name}`);
  replaceChildrenWithTrustedHTML(optionsBtn, CHEVRON_ICON);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.title = "Delete this lens";
  remove.setAttribute("aria-label", `Delete lens ${lens.name}`);
  replaceChildrenWithTrustedHTML(remove, TRASH_ICON);
  remove.addEventListener("click", () => deleteLens(lens.id));
  actions.append(showButton, shareButton, orderActions, optionsBtn, remove);
  header.append(actions);
  card.append(header);

  const selectorSection = document.createElement("div");
  selectorSection.className = "selector-section";
  const selectorHeading = document.createElement("p");
  selectorHeading.className = "selector-heading";
  selectorHeading.textContent = "Shows";
  const chips = document.createElement("span");
  chips.className = "group-chips shows-zone";
  makeDropTarget(chips, "group", (title) => addSelectorToLens(lens.id, { type: "title", value: title }));
  for (const selector of lens.groupSelectors) {
    chips.append(selector.type === "glob" ? makePatternChip(lens.id, selector) : makeChip(lens.id, selector));
  }
  const groupListId = "firefox-groups-lens-" + index;
  const containerListId = "firefox-containers-lens-" + index;
  const typeSelect = document.createElement("select");
  typeSelect.className = "group-chip-type";
  typeSelect.setAttribute("aria-label", `Selector type for ${lens.name}`);
  for (const option of [
    ["title", "Group"],
    ["glob", "Pattern"],
    ["container", "Container"],
  ]) {
    const element = document.createElement("option");
    element.value = option[0];
    element.textContent = option[1];
    typeSelect.appendChild(element);
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "group-chip-input";
  input.setAttribute("list", groupListId);
  input.autocomplete = "off";
  input.setAttribute("aria-label", `Add a selector to ${lens.name}`);
  input.placeholder = "+ add group\u2026";
  const updateSelectorInput = () => {
    if (typeSelect.value === "container") {
      input.setAttribute("list", containerListId);
      input.placeholder = "+ add container\u2026";
    } else {
      input.setAttribute("list", groupListId);
      input.placeholder = typeSelect.value === "glob" ? "+ add pattern\u2026" : "+ add group\u2026";
    }
  };
  typeSelect.addEventListener("change", updateSelectorInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const selector = selectorFromTypedInput(typeSelect.value, input.value);
      if (selector) {
        addSelectorToLens(lens.id, selector);
      }
    } else if (event.key === "Escape") {
      input.value = "";
      input.blur();
    }
  });
  chips.append(typeSelect, input);
  selectorSection.append(selectorHeading, chips);
  selectorSection.append(makeRowDatalist(groupListId, lensSelectorValues(lens, "title")));
  selectorSection.append(makeContainerDatalist(containerListId, lensSelectorValues(lens, "container")));

  const panel = document.createElement("div");
  panel.className = "row-options";
  panel.hidden = !optionsOpen;
  const hint = document.createElement("p");
  hint.className = "pattern-hint";
  hint.textContent = "* = any text, ? = one character, e.g. Client *";
  panel.append(hint, makeLensStyleEditor(lens), makeScheduleEditor(lens));
  selectorSection.append(panel);
  card.append(selectorSection);

  optionsBtn.addEventListener("click", () => {
    const open = !expandedLensRows.has(lens.id);
    if (open) {
      expandedLensRows.add(lens.id);
    } else {
      expandedLensRows.delete(lens.id);
    }
    render();
  });

  if (lens.id === activeAdderId) {
    window.setTimeout(() => {
      const nextInput = document.querySelector(`.lens-card[data-lens-id="${lens.id}"] .group-chip-input`);
      if (nextInput) nextInput.focus();
      activeAdderId = null;
    }, 0);
  }
  return card;
}

function renderMigrationSummary() {
  const summary = document.getElementById("migration-summary");
  if (!summary) return;
  if (!state.legacyFocusMappingsBackup) {
    summary.hidden = true;
    summary.textContent = "";
    return;
  }
  const count = Object.keys(state.legacyFocusMappingsBackup).length;
  summary.textContent = `Imported ${count} ${count === 1 ? "lens" : "lenses"} from your previous Apple Focus mappings.`;
  summary.hidden = false;
}

function currentGroupSavedIn(group) {
  if (Array.isArray(group.savedIn)) {
    return group.savedIn;
  }
  return state.lenses
    .filter((lens) => lens.groupSelectors.some((selector) => selectorMatchesTitle(selector, group.title)))
    .map((lens) => lens.name);
}

function makeGroupPaletteChip(group) {
  const chip = document.createElement("span");
  chip.className = "palette-chip group-palette-chip";
  const label = document.createElement("span");
  label.textContent = group.title;
  const savedIn = currentGroupSavedIn(group);
  const meta = document.createElement("span");
  meta.className = "palette-chip-meta";
  meta.textContent = savedIn.length === 0
    ? "unused"
    : `in ${savedIn.length} ${savedIn.length === 1 ? "lens" : "lenses"}`;
  chip.append(label, meta);
  makeDraggable(chip, { type: "group", value: group.title });
  return chip;
}

function renderGroupPalette() {
  const section = document.createElement("section");
  section.className = "lens-palette";
  const heading = document.createElement("p");
  heading.className = "strip-heading";
  heading.textContent = "Tab groups — drag onto a lens, or use \u201c+ add group\u201d:";
  section.append(heading);
  if (state.currentGroups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "No tab groups in this window yet. Create one in Firefox or use Organize tabs in the toolbar, then add it to a lens.";
    section.append(empty);
    return section;
  }
  const chips = document.createElement("div");
  chips.className = "group-chips";
  for (const group of state.currentGroups) {
    chips.append(makeGroupPaletteChip(group));
  }
  section.append(chips);
  return section;
}

function makeFocusPaletteChip(focusId) {
  const entry = focusCatalogEntry(focusId);
  const chip = document.createElement("span");
  chip.className = "palette-chip focus-palette-chip";
  chip.append(makeFocusIcon(entry.icon, entry.color));
  const label = document.createElement("span");
  label.textContent = entry.name;
  chip.append(label);
  makeDraggable(chip, { type: "focus", value: focusId });
  return chip;
}

function renderFocusStrip() {
  if (!focusUiGated()) {
    return null;
  }
  const section = document.createElement("section");
  section.className = "focus-strip";
  const heading = document.createElement("p");
  heading.className = "strip-heading";
  heading.append(document.createTextNode("macOS Focus · not yet linked"));
  const helper = document.createElement("span");
  helper.className = `helper-status ${state.connectionState}`.trim();
  helper.textContent = helperStatusText();
  heading.append(helper);
  section.append(heading);

  const ids = unlinkedFocusIds();
  if (ids.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = sortedFocusIds().length === 0 ? "No Focus modes detected yet." : "All detected Focus modes are linked.";
    section.append(empty);
    return section;
  }
  const chips = document.createElement("div");
  chips.className = "group-chips";
  for (const id of ids) {
    chips.append(makeFocusPaletteChip(id));
  }
  section.append(chips);
  return section;
}

function renderEmptyLenses() {
  const empty = document.createElement("div");
  empty.className = "lens-empty";
  const title = document.createElement("strong");
  title.textContent = "No lenses yet.";
  const copy = document.createElement("p");
  copy.textContent = "A lens shows only the tab groups you pick. To start, create a tab group in Firefox (or use Organize tabs in the toolbar), then add it to a lens.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "+ New lens";
  button.addEventListener("click", () => {
    createEmptyLens().catch((error) => {
      console.error("Create empty lens failed:", error);
      setStatus("Create failed. See extension console for details.", "error");
    });
  });
  empty.append(title, copy, button);
  return empty;
}

function activeViewLabel() {
  if (!state.activeView || state.activeView.kind !== "lens") {
    return "All groups";
  }
  const lens = findLens(state.activeView.lensId);
  return lens ? lens.name : "Unknown lens";
}

function renderActiveViewSummary() {
  const summary = document.createElement("div");
  summary.className = "active-view-summary";
  const label = document.createElement("span");
  label.textContent = `Showing: ${activeViewLabel()}`;
  const showAll = document.createElement("button");
  showAll.type = "button";
  showAll.className = "secondary show-all-groups";
  showAll.textContent = "Show all groups";
  showAll.disabled = !state.activeView || state.activeView.kind !== "lens";
  showAll.addEventListener("click", () => {
    activateLensView({ kind: "all" }).catch((error) => {
      console.error("Show all groups failed:", error);
      setStatus("Switch failed. See extension console.", "error");
    });
  });
  summary.append(label, showAll);
  return summary;
}

function applyLensStateSnapshot(lensState) {
  if (!isRecord(lensState)) {
    return;
  }
  if (isRecord(lensState.activeView)) {
    state.activeView = lensState.activeView;
  }
  if (isRecord(lensState.lastActivation)) {
    state.lastActivation = lensState.lastActivation;
  }
  if (Array.isArray(lensState.currentGroups)) {
    const liveGroups = normalizeCurrentGroups(lensState.currentGroups);
    const liveCounts = {};
    for (const group of liveGroups) {
      liveCounts[group.title] = (liveCounts[group.title] || 0) + 1;
    }
    state.currentGroups = liveGroups;
    state.firefoxGroupTitles = uniqueSortedTitlesFromValues(Object.keys(liveCounts));
    state.firefoxGroupTitleCounts = liveCounts;
  }
  mergeLensStateSummaries(lensState.lenses);
}

async function refreshLensState(windowId = state.windowId) {
  const resolvedWindowId = windowId === undefined ? await currentWindowId() : windowId;
  state.windowId = resolvedWindowId;
  const lensState = await requestLensState(resolvedWindowId);
  applyLensStateSnapshot(lensState);
  render();
}

async function activateLensView(view) {
  const windowId = state.windowId === undefined ? await currentWindowId() : state.windowId;
  state.windowId = windowId;
  state.activeView = view;
  render();
  await browser.runtime.sendMessage({ type: "lens-activate", windowId, view });
  await refreshLensState(windowId);
  setStatus(view.kind === "all" ? "Showing all groups." : "Showing lens.", "ok");
}

function renderLenses() {
  const list = document.getElementById("lenses-list");
  if (!list) return;
  renderMigrationSummary();
  if (state.lenses.length === 0) {
    list.replaceChildren(renderActiveViewSummary(), renderEmptyLenses());
    return;
  }
  const rows = document.createElement("div");
  rows.className = "lens-rows";
  rows.replaceChildren(...state.lenses.map((lens, index) => renderLensCard(lens, index)));
  const children = [renderActiveViewSummary(), rows, renderGroupPalette()];
  const focusStrip = renderFocusStrip();
  if (focusStrip) {
    children.push(focusStrip);
  }
  list.replaceChildren(...children);
}

function defaultWindowLensName() {
  const activeGroup = state.currentGroups.find((group) => group.active);
  return activeGroup ? activeGroup.title : "Window lens";
}

async function saveWindowAsLens() {
  const cleanName = defaultWindowLensName();
  const color = nextLensColor();
  const windowId = state.windowId === undefined ? await currentWindowId() : state.windowId;
  state.windowId = windowId;
  const response = await browser.runtime.sendMessage({
    type: "lens-save",
    windowId,
    source: "window",
    name: cleanName,
    color,
  });
  if (isRecord(response) && isRecord(response.lens)) {
    const lens = normalizeLens({ ...response.lens, color: response.lens.color || color });
    if (lens) {
      pendingNameEditId = lens.id;
      state.lenses = normalizeLenses([...state.lenses.filter((existing) => existing.id !== lens.id), lens]);
      render();
    }
  }
  setStatus("Saved current window as a lens.", "ok");
}

async function createEmptyLens() {
  const name = provisionalDefaultName();
  const color = nextLensColor();
  const response = await browser.runtime.sendMessage({
    type: "lens-save",
    source: "empty",
    name,
    color,
  });
  if (isRecord(response) && isRecord(response.lens)) {
    const lens = normalizeLens({ ...response.lens, color: response.lens.color || color });
    if (lens) {
      pendingNameEditId = lens.id;
      untouchedDefaultLensIds.add(lens.id);
      state.lenses = normalizeLenses([...state.lenses.filter((existing) => existing.id !== lens.id), lens]);
      render();
    }
  }
  setStatus("Created a new lens.", "ok");
}

function showDeletedLensUndo(deletedLens, originalIndex) {
  clearStatusUndoTimer();
  const status = document.getElementById("status");
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "status-undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", () => {
    clearStatusUndoTimer();
    undo.disabled = true;
    restoreDeletedLens(deletedLens, originalIndex).catch((error) => {
      console.error("Lens restore failed:", error);
      setStatus("Restore failed. See extension console.", "error");
    });
  });
  status.className = "ok";
  status.replaceChildren(document.createTextNode(`Deleted ${deletedLens.name} \u00b7 `), undo);
  statusUndoTimer = window.setTimeout(() => {
    if (status.contains(undo)) {
      status.replaceChildren();
      status.className = "";
    }
    statusUndoTimer = null;
  }, 6000);
}

async function restoreDeletedLens(deletedLens, originalIndex) {
  const response = await browser.runtime.sendMessage({
    type: "lens-save",
    source: "empty",
    name: deletedLens.name,
    color: deletedLens.color,
  });
  if (!isRecord(response) || !isRecord(response.lens) || typeof response.lens.id !== "string") {
    throw new Error("Lens restore save failed");
  }
  const lensId = response.lens.id;
  const patch = {
    icon: deletedLens.icon,
    color: deletedLens.color,
    groupSelectors: deletedLens.groupSelectors.map((selector) => ({ ...selector })),
  };
  await browser.runtime.sendMessage({ type: "lens-update", lensId, patch });
  let restored = normalizeLens({
    ...response.lens,
    ...patch,
    triggers: { appleFocusIds: [] },
  });
  if (restored) {
    state.lenses = normalizeLenses([...state.lenses.filter((lens) => lens.id !== lensId), restored]);
  }
  for (const focusId of deletedLens.triggers.appleFocusIds) {
    await browser.runtime.sendMessage({ type: "lens-link-focus", lensId, focusId });
    restored = replaceLensInState(lensId, {
      triggers: { appleFocusIds: [...((restored && restored.triggers.appleFocusIds) || []), focusId] },
    });
  }
  const orderedIds = state.lenses.map((lens) => lens.id).filter((id) => id !== lensId);
  orderedIds.splice(Math.max(0, Math.min(originalIndex, orderedIds.length)), 0, lensId);
  await browser.runtime.sendMessage({ type: "lens-reorder", orderedIds });
  const byId = new Map(state.lenses.map((lens) => [lens.id, lens]));
  state.lenses = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  await refreshLensState();
  setStatus(`Restored ${deletedLens.name}.`, "ok");
}

async function deleteLens(lensId) {
  const lens = findLens(lensId);
  if (!lens) return;
  const originalIndex = state.lenses.findIndex((existing) => existing.id === lensId);
  const deletedLens = cloneLensForRestore(lens);
  state.lenses = state.lenses.filter((existing) => existing.id !== lensId);
  untouchedDefaultLensIds.delete(lensId);
  expandedLensRows.delete(lensId);
  if (activeFocusPickerId === lensId) activeFocusPickerId = null;
  if (openIconEditorId === lensId) openIconEditorId = null;
  render();
  await browser.runtime.sendMessage({ type: "lens-delete", lensId });
  showDeletedLensUndo(deletedLens, originalIndex);
}

function formatValue(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "—";
}

function formatRelativeTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "unknown time";
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (elapsedSeconds < 5) {
    return "just now";
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  return `${Math.floor(elapsedMinutes / 60)}h ago`;
}
function viewName(view) {
  if (!isRecord(view) || view.kind === "all") return "All groups";
  if (view.kind === "lens") {
    const lens = findLens(view.lensId);
    return lens ? lens.name : "Deleted lens";
  }
  return "View";
}

function renderActivity() {
  const summary = document.getElementById("activity-summary");
  const list = document.getElementById("activity-list");
  if (!summary || !list) return;
  list.textContent = "";
  const sessions = state.focusSessionHistory.slice(-10).reverse();
  if (sessions.length === 0) {
    summary.textContent = "No sessions yet.";
    return;
  }
  const totalMs = state.focusSessionHistory.reduce((sum, entry) => sum + Math.max(0, entry.endedAt - entry.startedAt), 0);
  const totalMinutes = Math.round(totalMs / 60000);
  summary.textContent = `${state.focusSessionHistory.length} session${state.focusSessionHistory.length === 1 ? "" : "s"} recorded, ${totalMinutes < 60 ? `${totalMinutes} min` : `${Math.round(totalMinutes / 60)}h`} total.`;
  for (const session of sessions) {
    const item = document.createElement("li");
    const minutes = Math.max(1, Math.round((session.endedAt - session.startedAt) / 60000));
    item.textContent = `${viewName(session.view)} — ${minutes} min via ${session.trigger}`;
    list.append(item);
  }
}

function exportSettings() {
  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    lenses: state.lenses,
    activeView: state.activeView,
    automationFallback: state.automationFallback,
    lensSchedules: state.lensSchedules,
    tabSearchShortcut: state.tabSearchShortcut,
    aiGroupingPrompt: state.aiGroupingPrompt,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tab-lens-settings-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Settings exported.", "success");
}

async function importSettingsFile(file) {
  if (!file) return;
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("Invalid settings file");
  const values = {};
  if (hasOwn(parsed, "lenses")) values.lenses = normalizeLenses(parsed.lenses);
  if (hasOwn(parsed, "activeView") && isRecord(parsed.activeView)) values.activeView = parsed.activeView;
  if (hasOwn(parsed, "automationFallback") && isRecord(parsed.automationFallback)) values.automationFallback = parsed.automationFallback;
  if (hasOwn(parsed, "lensSchedules")) values.lensSchedules = normalizeLensSchedules(parsed.lensSchedules);
  if (hasOwn(parsed, "tabSearchShortcut")) values.tabSearchShortcut = normalizeShortcut(parsed.tabSearchShortcut);
  if (hasOwn(parsed, "aiGroupingPrompt")) values.aiGroupingPrompt = normalizeGroupingPrompt(parsed.aiGroupingPrompt);
  await browser.storage.local.set(values);
  await loadAll();
  if (hasOwn(parsed, "aiProvider")) {
    showToast("Settings imported. AI provider settings are managed in AI tab grouping and are not imported.", "success");
  } else {
    showToast("Settings imported.", "success");
  }
}


function renderDiagnostics() {
  const connection = document.getElementById("diag-connection");
  const connected = state.connectionState === "connected";
  connection.textContent = helperStatusText();
  connection.classList.toggle("diag-ok", connected);
  connection.classList.toggle("diag-warn", !connected);

  const lastError = document.getElementById("diag-last-error");
  if (state.lastError) {
    lastError.textContent = `${state.lastError.message} (${formatRelativeTime(state.lastError.at)})`;
    lastError.classList.add("diag-warn");
  } else {
    lastError.textContent = "None";
    lastError.classList.remove("diag-warn");
  }

  const updateFailures = document.getElementById("diag-update-failures");
  if (state.updateFailures.length > 0) {
    updateFailures.textContent = state.updateFailures.join(", ");
    updateFailures.classList.add("diag-warn");
  } else {
    updateFailures.textContent = "None";
    updateFailures.classList.remove("diag-warn");
  }

  const lastTriggerId = state.lastActivation && typeof state.lastActivation.triggerId === "string"
    ? state.lastActivation.triggerId
    : state.lastFocusSeen;
  const lastAction = state.lastActivation && typeof state.lastActivation.trigger === "string"
    ? `${state.lastActivation.trigger}${typeof state.lastActivation.at === "number" ? ` (${formatRelativeTime(state.lastActivation.at)})` : ""}`
    : state.lastAction;
  document.getElementById("diag-last-focus").textContent = formatValue(lastTriggerId);
  document.getElementById("diag-last-action").textContent = formatValue(lastAction);
  document.getElementById("diag-current-groups").textContent = formatList(state.firefoxGroupTitles);
  document.getElementById("diag-group-titles").textContent = formatList(state.groupTitles);

  const details = [];
  if (state.unmappedFocusId) {
    details.push(`unmapped trigger ID: ${state.unmappedFocusId}`);
  }
  if (state.missingGroup) {
    details.push(`missing group: ${state.missingGroup}`);
  }
  if (state.emptyGroup) {
    details.push(`empty group: ${state.emptyGroup}`);
  }
  if (state.expandedGroups.length > 0) {
    details.push(`expanded: ${state.expandedGroups.join(", ")}`);
  }
  if (state.collapsedGroups.length > 0) {
    details.push(`collapsed: ${state.collapsedGroups.join(", ")}`);
  }
  if (state.updateFailures.length > 0) {
    details.push(`failed updates: ${state.updateFailures.join(", ")}`);
  }
  document.getElementById("diag-action-details").textContent = details.length > 0 ? details.join("; ") : "—";
}


function applyPendingFocus() {
  if (!pendingNameEditId) return;
  const input = document.querySelector(`.lens-card[data-lens-id="${pendingNameEditId}"] .lens-name-input`);
  if (input && document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

function render() {
  renderLenses();
  renderDiagnostics();
  renderActivity();
  renderShortcut();
  renderPerformanceSettings();
  applyPendingFocus();
}

function renderShortcut() {
  const button = document.getElementById("shortcut-record");
  if (!button) return;
  if (recordingShortcut) {
    button.textContent = "Press a shortcut\u2026";
    button.classList.add("recording");
    return;
  }
  button.classList.remove("recording");
  button.textContent = formatShortcut(state.tabSearchShortcut);
}

function renderPerformanceSettings() {
  const checkbox = document.getElementById("discard-collapsed-tabs");
  if (checkbox) {
    checkbox.checked = state.discardCollapsedTabs === true;
  }
}

async function persistDiscardCollapsedTabs(enabled) {
  await browser.storage.local.set({ discardCollapsedTabs: enabled });
  state.discardCollapsedTabs = enabled;
  renderPerformanceSettings();
}

function setShortcutStatus(message, kind = "") {
  const status = document.getElementById("shortcut-status");
  if (!status) return;
  status.textContent = message;
  status.className = kind;
}

async function persistShortcut(shortcut) {
  await browser.storage.local.set({ tabSearchShortcut: shortcut });
  state.tabSearchShortcut = shortcut;
  renderShortcut();
  setShortcutStatus(shortcut ? "Saved" : "Tab search shortcut disabled", "ok");
}

function startRecordingShortcut() {
  recordingShortcut = true;
  setShortcutStatus("Recording\u2026 press your keys, or Esc to cancel.");
  renderShortcut();
  const button = document.getElementById("shortcut-record");
  if (button) button.focus();
}

function onShortcutKeydown(event) {
  if (!recordingShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  const key = event.key;
  if (key === "Escape") {
    recordingShortcut = false;
    renderShortcut();
    setShortcutStatus("Cancelled", "");
    return;
  }
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta" || key === "OS") {
    return; // wait for the non-modifier key
  }
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !isFunctionKey) {
    setShortcutStatus("Add at least one modifier (Ctrl, Alt, or Cmd).", "error");
    return;
  }
  recordingShortcut = false;
  const shortcut = {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: key.length === 1 ? key.toLowerCase() : key,
  };
  persistShortcut(shortcut).catch((error) => {
    console.error("Tab search shortcut save failed:", error);
    setShortcutStatus("Save failed. See extension console.", "error");
  });
}


function applyStorageChange(changes) {
  if (changes.lenses) {
    state.lenses = normalizeLenses(changes.lenses.newValue);
    syncUntouchedDefaultLenses();
  }
  if (changes.activeView) {
    state.activeView = isRecord(changes.activeView.newValue) ? changes.activeView.newValue : { kind: "all" };
  }
  if (changes.lastActivation) {
    state.lastActivation = isRecord(changes.lastActivation.newValue) ? changes.lastActivation.newValue : null;
  }
  if (changes.legacyFocusMappingsBackup) {
    state.legacyFocusMappingsBackup = isRecord(changes.legacyFocusMappingsBackup.newValue) ? changes.legacyFocusMappingsBackup.newValue : null;
  }
  if (changes.seenFocusIds) {
    state.seenFocusIds = normalizeSeen(changes.seenFocusIds.newValue);
  }
  if (changes.lastFocusSeen) {
    state.lastFocusSeen = typeof changes.lastFocusSeen.newValue === "string" ? changes.lastFocusSeen.newValue : null;
  }
  if (changes.lastAction) {
    state.lastAction = typeof changes.lastAction.newValue === "string" ? changes.lastAction.newValue : null;
  }
  if (changes.groupTitles) {
    state.groupTitles = normalizeStringArray(changes.groupTitles.newValue);
  }
  if (changes.unmappedFocusId) {
    state.unmappedFocusId = typeof changes.unmappedFocusId.newValue === "string" ? changes.unmappedFocusId.newValue : null;
  }
  if (changes.missingGroup) {
    state.missingGroup = typeof changes.missingGroup.newValue === "string" ? changes.missingGroup.newValue : null;
  }
  if (changes.emptyGroup) {
    state.emptyGroup = typeof changes.emptyGroup.newValue === "string" ? changes.emptyGroup.newValue : null;
  }
  if (changes.expandedGroups) {
    state.expandedGroups = normalizeStringArray(changes.expandedGroups.newValue);
  }
  if (changes.collapsedGroups) {
    state.collapsedGroups = normalizeStringArray(changes.collapsedGroups.newValue);
  }
  if (changes.updateFailures) {
    state.updateFailures = normalizeStringArray(changes.updateFailures.newValue);
  }
  if (changes.connectionState) {
    state.connectionState = normalizeConnectionState(changes.connectionState.newValue);
  }
  if (changes.lastError) {
    state.lastError = normalizeLastError(changes.lastError.newValue);
  }
  if (changes.tabSearchShortcut) {
    state.tabSearchShortcut = normalizeShortcut(changes.tabSearchShortcut.newValue);
    renderShortcut();
  }
  if (changes.aiProvider) {
    state.aiProvider = normalizeProvider(changes.aiProvider.newValue);
  }
  if (changes.aiGroupingPrompt) {
    state.aiGroupingPrompt = normalizeGroupingPrompt(changes.aiGroupingPrompt.newValue);
    renderGroupingPrompt();
  }
  if (changes.discardCollapsedTabs) {
    state.discardCollapsedTabs = changes.discardCollapsedTabs.newValue === true;
    renderPerformanceSettings();
  }
  if (changes.lastProviderCheck) {
    state.lastProviderCheck = normalizeProviderCheck(changes.lastProviderCheck.newValue);
    renderProviderLastCheck();
  }
  if (changes.focusCatalog) {
    state.focusCatalog = isRecord(changes.focusCatalog.newValue) ? changes.focusCatalog.newValue : {};
  }
  if (changes.lensSchedules) {
    state.lensSchedules = normalizeLensSchedules(changes.lensSchedules.newValue);
  }
  if (changes.focusSessionHistory) {
    state.focusSessionHistory = normalizeFocusSessionHistory(changes.focusSessionHistory.newValue);
  }
  if (changes.automationFallback) {
    state.automationFallback = isRecord(changes.automationFallback.newValue) ? changes.automationFallback.newValue : { kind: "all" };
  }
  render();
}

async function refreshFirefoxGroups() {
  const snapshot = await queryFirefoxGroupSnapshot();
  state.firefoxGroupTitles = snapshot.titles;
  state.firefoxGroupTitleCounts = snapshot.counts;
  state.currentGroups = snapshot.currentGroups;
  render();
}

async function refreshContainers() {
  const containers = await requestContainers();
  state.containers = containers;
  state.containerNames = uniqueSortedTitlesFromValues(containers.map((container) => container.name));
  render();
}


const AI_GROUPING_PROMPT_MAX = 4000;

function normalizeGroupingPrompt(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.length > AI_GROUPING_PROMPT_MAX
    ? trimmed.slice(0, AI_GROUPING_PROMPT_MAX)
    : trimmed;
}

const PROVIDER_PRESETS = {
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  groq: { baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
};

function normalizeProvider(value) {
  if (
    isRecord(value) &&
    value.kind === "custom" &&
    typeof value.baseURL === "string" &&
    typeof value.model === "string"
  ) {
    return {
      kind: "custom",
      baseURL: value.baseURL,
      model: value.model,
      apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    };
  }
  return { kind: "foundation" };
}

function normalizeProviderCheck(value) {
  if (
    isRecord(value) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    typeof value.detail === "string"
  ) {
    return {
      at: value.at,
      ok: value.ok === true,
      detail: value.detail,
    };
  }
  return null;
}

function validateProviderBaseURL(baseURL) {
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch (error) {
    return { error: "That base URL is not valid." };
  }
  const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
  if (parsed.protocol !== "https:" && !loopbackHosts.includes(parsed.hostname)) {
    return { error: "Use an https:// URL. Plain http is only allowed for localhost." };
  }
  return { parsed, origin: parsed.origin };
}

function requestProviderOriginPermission(origin) {
  return browser.permissions.request({ origins: [`${origin}/*`] });
}

function providerEndpoint(baseURL, path) {
  return `${baseURL.replace(/\/+$/, "")}${path}`;
}

function providerHeaders(apiKey, body = false) {
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function setProviderTestStatus(message) {
  const status = document.getElementById("provider-test-status");
  if (status) {
    status.textContent = message;
  }
}

function formatProviderCheckTime(at) {
  const elapsed = Date.now() - at;
  if (elapsed >= 0 && elapsed < 60000) {
    return "just now";
  }
  if (elapsed >= 0 && elapsed < 3600000) {
    const minutes = Math.max(1, Math.round(elapsed / 60000));
    return `${minutes} min ago`;
  }
  if (elapsed >= 0 && elapsed < 86400000) {
    const hours = Math.max(1, Math.round(elapsed / 3600000));
    return `${hours} hr ago`;
  }
  return new Date(at).toLocaleString();
}

function renderProviderLastCheck() {
  const status = document.getElementById("provider-test-status");
  if (!status || status.textContent) {
    return;
  }
  if (!state.lastProviderCheck) {
    status.textContent = "";
    return;
  }
  status.textContent = `Last check: ${formatProviderCheckTime(state.lastProviderCheck.at)} \u2014 ${state.lastProviderCheck.detail}`;
}

async function rememberProviderCheck(ok, detail) {
  const check = { at: Date.now(), ok, detail };
  state.lastProviderCheck = check;
  setProviderTestStatus(detail);
  try {
    await browser.storage.local.set({ lastProviderCheck: check });
  } catch (error) {
    // The visible result is still useful if private browsing or quota blocks diagnostics.
  }
}

function providerNetworkFailure(error) {
  if (error && error.name === "AbortError") {
    return "Connection failed: Request timed out.";
  }
  return `Connection failed: ${error && error.message ? error.message : "Network error"}`;
}

async function fetchProvider(url, options) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function openAIModelIds(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return null;
  }
  const ids = [];
  for (const item of payload.data) {
    if (isRecord(item) && typeof item.id === "string" && item.id) {
      ids.push(item.id);
      if (ids.length >= 100) {
        break;
      }
    }
  }
  if (payload.data.length > 0 && ids.length === 0) {
    return null;
  }
  return ids;
}

function fillProviderModels(ids) {
  const datalist = document.getElementById("provider-models");
  if (!datalist) {
    return;
  }
  const options = ids.map((id) => {
    const option = document.createElement("option");
    option.value = id;
    return option;
  });
  datalist.replaceChildren(...options);
}

async function testProviderConnection() {
  const button = document.getElementById("provider-test");
  if (button) {
    button.disabled = true;
  }
  setProviderTestStatus("Testing connection\u2026");
  try {
    const baseURL = document.getElementById("provider-url").value.trim();
    const model = document.getElementById("provider-model").value.trim();
    const apiKey = document.getElementById("provider-key").value.trim();
    if (!baseURL) {
      await rememberProviderCheck(false, "Enter an API base URL.");
      return;
    }

    const validation = validateProviderBaseURL(baseURL);
    if (validation.error) {
      await rememberProviderCheck(false, validation.error);
      return;
    }

    let granted;
    try {
      granted = await requestProviderOriginPermission(validation.origin);
    } catch (error) {
      await rememberProviderCheck(false, "Could not request permission for that domain.");
      return;
    }
    if (!granted) {
      await rememberProviderCheck(false, "Permission denied \u2014 the extension can't reach that domain.");
      return;
    }

    const modelsURL = providerEndpoint(baseURL, "/models");
    let response = null;
    try {
      response = await fetchProvider(modelsURL, {
        method: "GET",
        headers: providerHeaders(apiKey),
      });
    } catch (error) {
      response = null;
    }

    if (response && response.ok) {
      try {
        const ids = openAIModelIds(await response.json());
        if (ids) {
          fillProviderModels(ids);
          await rememberProviderCheck(true, `Found ${ids.length} models.`);
          return;
        }
      } catch (error) {
        // Non-JSON responses commonly mean the provider uses a different models path.
      }
    }

    if (!model) {
      await rememberProviderCheck(false, "Set a model to run the fallback check.");
      return;
    }

    try {
      const fallback = await fetchProvider(providerEndpoint(baseURL, "/chat/completions"), {
        method: "POST",
        headers: providerHeaders(apiKey, true),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      if (fallback.ok) {
        await rememberProviderCheck(true, `Model list unavailable, but the endpoint responded (HTTP ${fallback.status}).`);
      } else {
        await rememberProviderCheck(false, `Connection failed: HTTP ${fallback.status}`);
      }
    } catch (error) {
      await rememberProviderCheck(false, providerNetworkFailure(error));
    }
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

let toastTimer = null;
function showToast(message, kind = "") {
  if (!message) {
    return;
  }
  const host = document.getElementById("toast-host");
  if (!host) {
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`.trim();
  toast.textContent = message;
  host.replaceChildren(toast);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => toast.classList.add("show"));
  } else {
    toast.classList.add("show");
  }
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, kind === "error" ? 5000 : 3000);
}

function providerCustomVisible(visible) {
  const custom = document.getElementById("provider-custom");
  if (custom) {
    custom.hidden = !visible;
  }
  const test = document.getElementById("provider-test");
  if (test) {
    test.hidden = !visible;
  }
}

function renderProvider() {
  const provider = state.aiProvider || { kind: "foundation" };
  const kind = provider.kind === "custom" ? "custom" : "foundation";
  for (const radio of document.querySelectorAll('input[name="provider-kind"]')) {
    radio.checked = radio.value === kind;
  }
  providerCustomVisible(kind === "custom");
  if (kind === "custom") {
    document.getElementById("provider-url").value = provider.baseURL || "";
    document.getElementById("provider-model").value = provider.model || "";
    document.getElementById("provider-key").value = provider.apiKey || "";
  }
  renderProviderLastCheck();
}

function applyProviderPreset(presetKey) {
  const preset = PROVIDER_PRESETS[presetKey];
  if (!preset) {
    return;
  }
  for (const radio of document.querySelectorAll('input[name="provider-kind"]')) {
    radio.checked = radio.value === "custom";
  }
  providerCustomVisible(true);
  document.getElementById("provider-url").value = preset.baseURL;
  document.getElementById("provider-model").value = preset.model;
  document.getElementById("provider-key").focus();
}

function renderGroupingPrompt() {
  const field = document.getElementById("ai-grouping-prompt");
  if (field) {
    field.value = state.aiGroupingPrompt || DEFAULT_GROUPING_PROMPT;
  }
}

async function resetGroupingPrompt() {
  await browser.storage.local.set({ aiGroupingPrompt: "" });
  state.aiGroupingPrompt = "";
  const field = document.getElementById("ai-grouping-prompt");
  if (field) {
    field.value = DEFAULT_GROUPING_PROMPT;
  }
  showToast("Reset to the default grouping prompt.", "ok");
}

async function saveProvider() {
  const checked = document.querySelector('input[name="provider-kind"]:checked');
  const kind = checked ? checked.value : "foundation";
  const promptField = document.getElementById("ai-grouping-prompt");
  let promptOverride = normalizeGroupingPrompt(promptField ? promptField.value : "");
  if (promptOverride === DEFAULT_GROUPING_PROMPT) {
    promptOverride = "";
  }

  if (kind !== "custom") {
    const provider = { kind: "foundation" };
    await browser.storage.local.set({ aiProvider: provider, aiGroupingPrompt: promptOverride });
    state.aiProvider = provider;
    state.aiGroupingPrompt = promptOverride;
    if (promptField) {
      promptField.value = promptOverride || DEFAULT_GROUPING_PROMPT;
    }
    showToast("Saved — using the on-device Foundation model.", "ok");
    return;
  }

  const baseURL = document.getElementById("provider-url").value.trim();
  const model = document.getElementById("provider-model").value.trim();
  const apiKey = document.getElementById("provider-key").value.trim();
  if (!baseURL || !model) {
    showToast("Enter both an API base URL and a model.", "error");
    return;
  }
  const validation = validateProviderBaseURL(baseURL);
  if (validation.error) {
    showToast(validation.error, "error");
    return;
  }
  const origin = validation.origin;

  let granted;
  try {
    granted = await requestProviderOriginPermission(origin);
  } catch (error) {
    console.error("Host permission request failed:", error);
    showToast("Could not request permission for that domain.", "error");
    return;
  }
  if (!granted) {
    showToast("Permission denied — the extension can't reach that domain.", "error");
    return;
  }

  const provider = { kind: "custom", baseURL, model, apiKey };
  await browser.storage.local.set({ aiProvider: provider, aiGroupingPrompt: promptOverride });
  state.aiProvider = provider;
  state.aiGroupingPrompt = promptOverride;
  if (promptField) {
    promptField.value = promptOverride || DEFAULT_GROUPING_PROMPT;
  }
  showToast(`Saved — using ${model} at ${origin}.`, "ok");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("save-window-lens").addEventListener("click", () => {
    saveWindowAsLens().catch((error) => {
      console.error("Save current window lens failed:", error);
      setStatus("Save failed. See extension console for details.", "error");
    });
  });
  document.getElementById("new-empty-lens").addEventListener("click", () => {
    createEmptyLens().catch((error) => {
      console.error("Create empty lens failed:", error);
      setStatus("Create failed. See extension console for details.", "error");
    });
  });
  document.getElementById("lens-import-add").addEventListener("click", () => {
    addLensFromCode().catch((error) => {
      console.error("Lens code import failed:", error);
      showToast("Not a valid lens code.", "error");
    });
  });


  const shortcutRecord = document.getElementById("shortcut-record");
  if (shortcutRecord) {
    shortcutRecord.addEventListener("click", startRecordingShortcut);
    shortcutRecord.addEventListener("keydown", onShortcutKeydown);
  }
  document.getElementById("shortcut-reset").addEventListener("click", () => {
    recordingShortcut = false;
    persistShortcut({ ...DEFAULT_TAB_SEARCH_SHORTCUT }).catch((error) => {
      console.error("Tab search shortcut reset failed:", error);
    });
  });
  document.getElementById("shortcut-clear").addEventListener("click", () => {
    recordingShortcut = false;
    persistShortcut(null).catch((error) => {
      console.error("Tab search shortcut disable failed:", error);
    });
  });

  const discardCollapsedTabs = document.getElementById("discard-collapsed-tabs");
  if (discardCollapsedTabs) {
    discardCollapsedTabs.addEventListener("change", () => {
      persistDiscardCollapsedTabs(discardCollapsedTabs.checked).catch((error) => {
        console.error("Discard collapsed tabs setting save failed:", error);
        renderPerformanceSettings();
        showToast("Save failed. See extension console.", "error");
      });
    });
  }

  document.getElementById("preset-openai").addEventListener("click", () => applyProviderPreset("openai"));
  document.getElementById("preset-groq").addEventListener("click", () => applyProviderPreset("groq"));
  document.getElementById("preset-openrouter").addEventListener("click", () => applyProviderPreset("openrouter"));
  for (const radio of document.querySelectorAll('input[name="provider-kind"]')) {
    radio.addEventListener("change", () => {
      const selected = document.querySelector('input[name="provider-kind"]:checked');
      providerCustomVisible(!!selected && selected.value === "custom");
    });
  }

  document.getElementById("provider-save").addEventListener("click", () => {
    saveProvider().catch((error) => {
      console.error("Provider save failed:", error);
      showToast("Save failed. See extension console.", "error");
    });
  });

  document.getElementById("provider-test").addEventListener("click", () => {
    testProviderConnection();
  });

  document.getElementById("ai-prompt-reset").addEventListener("click", () => {
    resetGroupingPrompt().catch((error) => {
      console.error("Grouping prompt reset failed:", error);
      showToast("Reset failed. See extension console.", "error");
    });
  });

  document.getElementById("provider-key-toggle").addEventListener("click", () => {
    const input = document.getElementById("provider-key");
    const toggle = document.getElementById("provider-key-toggle");
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
  });

  document.getElementById("settings-export").addEventListener("click", () => {
    try {
      exportSettings();
    } catch (error) {
      console.error("Settings export failed:", error);
      showToast("Export failed. See extension console.", "error");
    }
  });
  document.getElementById("settings-import").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    importSettingsFile(file).catch((error) => {
      console.error("Settings import failed:", error);
      showToast("Import failed. Check the JSON file.", "error");
    }).finally(() => {
      event.target.value = "";
    });
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      applyStorageChange(changes);
    }
  });

  window.addEventListener("focus", () => {
    refreshFirefoxGroups().catch((error) => {
      console.error("Firefox tab group refresh failed:", error);
    });
    refreshContainers().catch((error) => {
      console.error("Firefox container refresh failed:", error);
    });
  });

  loadAll().catch((error) => {
    console.error("Tabloupe options load failed:", error);
    setStatus("Load failed. See extension console for details.", "error");
  });
});
