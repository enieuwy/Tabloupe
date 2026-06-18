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
  "focusMappings",
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
  "tabSearchShortcut",
  "aiProvider",
  "aiGroupingPrompt",
  "focusCatalog",
];

const state = {
  focusMappings: {},
  seenFocusIds: {},
  lastFocusSeen: null,
  lastAction: null,
  groupTitles: [],
  firefoxGroupTitles: [],
  unmappedFocusId: null,
  missingGroup: null,
  emptyGroup: null,
  expandedGroups: [],
  collapsedGroups: [],
  updateFailures: [],
  tabSearchShortcut: { ...DEFAULT_TAB_SEARCH_SHORTCUT },
  aiProvider: { kind: "foundation" },
  aiGroupingPrompt: "",
  focusCatalog: {},
};

let draftMappings = {};
let dirty = false;
let recordingShortcut = false;
let activeAdderId = null;
let activePatternAdderId = null;
const expandedPatternRows = new Set();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isGlobPattern(entry) {
  return /[*?]/.test(entry);
}

// A focus maps to a list of tab-group titles. [] means "seen but ignored".
function normalizeTitles(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const titles = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const title = item.trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      titles.push(title);
    }
  }
  return titles;
}

function normalizeMappings(value) {
  const output = {};
  if (!isRecord(value)) {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === "string") {
      output[key] = normalizeTitles(entry);
    }
  }
  return output;
}

function cloneMappings(mappings) {
  const output = {};
  for (const [id, titles] of Object.entries(mappings)) {
    output[id] = [...titles];
  }
  return output;
}

function normalizeSeen(value) {
  const output = {};
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

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
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

function uniqueSortedTitles(groups) {
  return [...new Set(groups.map((group) => group.title).filter((title) => typeof title === "string" && title.length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

async function queryGroupTitles() {
  try {
    const groups = await browser.tabGroups.query({});
    return uniqueSortedTitles(groups);
  } catch (error) {
    console.error("Firefox tab group query failed:", error);
    return [];
  }
}

async function loadAll() {
  const [stored, firefoxGroupTitles] = await Promise.all([
    browser.storage.local.get(STORAGE_KEYS),
    queryGroupTitles(),
  ]);

  state.focusMappings = normalizeMappings(stored.focusMappings);
  state.seenFocusIds = normalizeSeen(stored.seenFocusIds);
  state.lastFocusSeen = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
  state.lastAction = typeof stored.lastAction === "string" ? stored.lastAction : null;
  state.groupTitles = normalizeStringArray(stored.groupTitles);
  state.firefoxGroupTitles = firefoxGroupTitles;
  state.unmappedFocusId = typeof stored.unmappedFocusId === "string" ? stored.unmappedFocusId : null;
  state.missingGroup = typeof stored.missingGroup === "string" ? stored.missingGroup : null;
  state.emptyGroup = typeof stored.emptyGroup === "string" ? stored.emptyGroup : null;
  state.expandedGroups = normalizeStringArray(stored.expandedGroups);
  state.collapsedGroups = normalizeStringArray(stored.collapsedGroups);
  state.updateFailures = normalizeStringArray(stored.updateFailures);
  state.tabSearchShortcut = "tabSearchShortcut" in stored
    ? normalizeShortcut(stored.tabSearchShortcut)
    : { ...DEFAULT_TAB_SEARCH_SHORTCUT };
  state.aiProvider = normalizeProvider(stored.aiProvider);
  state.aiGroupingPrompt = normalizeGroupingPrompt(stored.aiGroupingPrompt);
  state.focusCatalog = isRecord(stored.focusCatalog) ? stored.focusCatalog : {};
  if (!dirty) {
    draftMappings = cloneMappings(state.focusMappings);
  }

  render();
  renderProvider();
  renderGroupingPrompt();
}

function sortedFocusIds() {
  const ids = new Set([
    ...Object.keys(draftMappings),
    ...Object.keys(state.seenFocusIds),
  ]);
  const order = new Map(DEFAULT_FOCUS_ORDER.map((id, index) => [id, index]));

  return [...ids].sort((a, b) => {
    const aIndex = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const bIndex = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    return a.localeCompare(b);
  });
}

function setStatus(message, kind = "") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = kind;
}

function markDirty() {
  dirty = true;
  setStatus("Unsaved changes", "");
}

function makeStatus(kind, label) {
  const tag = document.createElement("span");
  tag.className = `status-tag status-${kind}`;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  tag.append(dot, document.createTextNode(label));
  return tag;
}

const TRASH_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

const CHEVRON_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 9l6 6 6-6"/></svg>';

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
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    (FOCUS_ICON_PATHS[iconName] || FOCUS_ICON_PATHS.target) + "</svg>";
  return wrap;
}

function assignedTitles() {
  const set = new Set();
  for (const titles of Object.values(draftMappings)) {
    for (const title of titles) set.add(title);
  }
  return set;
}

function makeRowDatalist(listId, excluded) {
  const datalist = document.createElement("datalist");
  datalist.id = listId;
  const available = state.firefoxGroupTitles.filter((title) => !excluded.includes(title));
  datalist.replaceChildren(...available.map((title) => {
    const option = document.createElement("option");
    option.value = title;
    return option;
  }));
  return datalist;
}

function addTitleToFocus(id, rawTitle) {
  const title = rawTitle.trim();
  if (!title) return;
  if (!hasOwn(draftMappings, id)) draftMappings[id] = [];
  if (draftMappings[id].includes(title)) return;
  draftMappings[id].push(title);
  markDirty();
  activeAdderId = id;
  renderMappings();
}

function addPatternToFocus(id, rawValue) {
  const value = rawValue.trim();
  if (!value) return;
  if (!hasOwn(draftMappings, id)) draftMappings[id] = [];
  if (draftMappings[id].includes(value)) return;
  draftMappings[id].push(value);
  expandedPatternRows.add(id);
  markDirty();
  activePatternAdderId = id;
  renderMappings();
}

function removeTitleFromFocus(id, title) {
  if (!hasOwn(draftMappings, id)) return;
  draftMappings[id] = draftMappings[id].filter((existing) => existing !== title);
  markDirty();
  renderMappings();
}

let dragState = null;

// Assign a group title to a Focus row. A truthy fromId removes it from that
// source row (move); fromId null adds without removing (copy via Alt-drag, or
// from the unassigned bucket).
function moveTitleToFocus(title, fromId, toId) {
  const clean = (title || "").trim();
  if (!clean || !toId || fromId === toId) return;
  if (fromId && hasOwn(draftMappings, fromId)) {
    draftMappings[fromId] = draftMappings[fromId].filter((existing) => existing !== clean);
  }
  if (!hasOwn(draftMappings, toId)) draftMappings[toId] = [];
  if (!draftMappings[toId].includes(clean)) draftMappings[toId].push(clean);
  markDirty();
  renderMappings();
}

function makeDraggable(chip, title, sourceId) {
  chip.draggable = true;
  chip.addEventListener("dragstart", (event) => {
    dragState = { title, sourceId };
    chip.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData("text/plain", title);
    }
  });
  chip.addEventListener("dragend", () => {
    dragState = null;
    chip.classList.remove("dragging");
  });
}

function makeDropTarget(el, onDrop) {
  el.addEventListener("dragover", (event) => {
    if (!dragState) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (event) => {
    event.preventDefault();
    el.classList.remove("drop-target");
    if (dragState) onDrop(dragState, event);
  });
}

function makeUnassignedChip(title) {
  const chip = document.createElement("span");
  chip.className = "group-chip group-chip-unassigned";
  const label = document.createElement("span");
  label.className = "group-chip-label";
  label.textContent = title;
  chip.append(label);
  makeDraggable(chip, title, null);
  return chip;
}

function renderUnassigned() {
  const list = document.getElementById("unassigned-list");
  if (!list) return;
  const assigned = assignedTitles();
  const titles = state.firefoxGroupTitles.filter((title) => !assigned.has(title));
  if (titles.length === 0) {
    const empty = document.createElement("span");
    empty.className = "unassigned-empty";
    empty.textContent = state.firefoxGroupTitles.length === 0
      ? "No Firefox tab groups found."
      : "Every tab group is assigned to a Focus mode.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...titles.map((title) => makeUnassignedChip(title)));
}

function makeChip(id, title) {
  const chip = document.createElement("span");
  chip.className = "group-chip";
  const label = document.createElement("span");
  label.className = "group-chip-label";
  label.textContent = title;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "group-chip-remove";
  remove.setAttribute("aria-label", `Remove ${title}`);
  remove.textContent = "\u00d7";
  remove.draggable = false;
  remove.addEventListener("click", () => removeTitleFromFocus(id, title));
  chip.append(label, remove);
  makeDraggable(chip, title, id);
  return chip;
}

function makePatternChip(id, pattern) {
  const chip = document.createElement("span");
  chip.className = "group-chip group-chip-pattern";
  const label = document.createElement("span");
  label.className = "group-chip-label";
  label.textContent = pattern;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "group-chip-remove";
  remove.setAttribute("aria-label", `Remove pattern ${pattern}`);
  remove.textContent = "\u00d7";
  remove.addEventListener("click", () => removeTitleFromFocus(id, pattern));
  chip.append(label, remove);
  return chip;
}

function makeUnseenDot() {
  const dot = document.createElement("span");
  dot.className = "status-dot status-unseen";
  dot.title = "Not seen yet";
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function makeUnassignedRow() {
  const row = document.createElement("tr");
  row.className = "unassigned-row";

  const labelCell = document.createElement("td");
  labelCell.className = "col-focus";
  const label = document.createElement("span");
  label.className = "focus-cell unassigned-label";
  label.textContent = "Unassigned";
  labelCell.append(label);

  const arrowCell = document.createElement("td");
  arrowCell.className = "col-arrow";

  const groupsCell = document.createElement("td");
  groupsCell.className = "col-groups";
  const list = document.createElement("div");
  list.id = "unassigned-list";
  list.className = "unassigned-list";
  groupsCell.append(list);

  const actionCell = document.createElement("td");
  actionCell.className = "col-action";

  row.append(labelCell, arrowCell, groupsCell, actionCell);
  makeDropTarget(row, (drag) => {
    if (drag.sourceId) removeTitleFromFocus(drag.sourceId, drag.title);
  });
  return row;
}

function renderMappings() {
  const body = document.getElementById("mappings-body");
  const ids = sortedFocusIds();

  if (ids.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "empty-row";
    cell.textContent = "No Focus IDs yet. Toggle a macOS Focus mode or add a custom mapping.";
    row.append(cell);
    body.replaceChildren(row, makeUnassignedRow());
    renderUnassigned();
    return;
  }

  let adderInput = null;
  let patternAdderInput = null;

  const rows = ids.map((id, index) => {
    const row = document.createElement("tr");
    const hasMapping = hasOwn(draftMappings, id);
    const titles = hasMapping ? draftMappings[id] : [];
    const exactTitles = titles.filter((title) => !isGlobPattern(title));
    const patternTitles = titles.filter((title) => isGlobPattern(title));
    const hasSeen = hasOwn(state.seenFocusIds, id);
    const isActive = state.lastFocusSeen === id;
    const entry = focusCatalogEntry(id);
    if (isActive) {
      row.className = "is-active";
    }

    const idCell = document.createElement("td");
    idCell.className = "col-focus";
    const focusCell = document.createElement("span");
    focusCell.className = "focus-cell";
    focusCell.append(makeFocusIcon(entry.icon, entry.color));
    const name = document.createElement("span");
    name.className = "focus-name";
    name.textContent = entry.name;
    name.title = id;
    focusCell.append(name);
    if (isActive) {
      focusCell.append(makeStatus("active", "active"));
    } else if (!hasSeen) {
      focusCell.append(makeUnseenDot());
    }
    idCell.append(focusCell);

    const arrowCell = document.createElement("td");
    arrowCell.className = "col-arrow";
    arrowCell.setAttribute("aria-hidden", "true");
    arrowCell.textContent = "\u2192";

    const groupsCell = document.createElement("td");
    groupsCell.className = "col-groups";
    const chips = document.createElement("span");
    chips.className = "group-chips";
    for (const title of exactTitles) {
      chips.append(makeChip(id, title));
    }
    const input = document.createElement("input");
    input.type = "text";
    input.className = "group-chip-input";
    input.setAttribute("list", "firefox-groups-row-" + index);
    input.autocomplete = "off";
    input.placeholder = exactTitles.length === 0 ? "+ add tab group" : "+ add";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addTitleToFocus(id, input.value);
      } else if (event.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });
    chips.append(input);
    groupsCell.append(chips);
    groupsCell.append(makeRowDatalist("firefox-groups-row-" + index, titles));
    if (id === activeAdderId) {
      adderInput = input;
    }

    // "More options": title-pattern (glob) matching, revealed by the row's
    // options button so the common exact-title case stays uncluttered.
    const optionsOpen = expandedPatternRows.has(id);
    const panel = document.createElement("div");
    panel.className = "row-options";
    panel.hidden = !optionsOpen;
    const patternChips = document.createElement("span");
    patternChips.className = "group-chips group-chips-patterns";
    for (const pattern of patternTitles) {
      patternChips.append(makePatternChip(id, pattern));
    }
    const patternInput = document.createElement("input");
    patternInput.type = "text";
    patternInput.className = "group-chip-input pattern-input";
    patternInput.autocomplete = "off";
    patternInput.placeholder = "+ add title pattern, e.g. Work-*";
    patternInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addPatternToFocus(id, patternInput.value);
      } else if (event.key === "Escape") {
        patternInput.value = "";
        patternInput.blur();
      }
    });
    patternChips.append(patternInput);
    const hint = document.createElement("p");
    hint.className = "pattern-hint";
    hint.textContent = "Patterns match tab-group titles by glob: * = any text, ? = one character.";
    panel.append(patternChips, hint);
    groupsCell.append(panel);
    if (id === activePatternAdderId) {
      patternAdderInput = patternInput;
    }

    const actionCell = document.createElement("td");
    actionCell.className = "col-action";
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const optionsBtn = document.createElement("button");
    optionsBtn.type = "button";
    optionsBtn.className = "icon-btn icon-btn-options";
    if (optionsOpen) {
      optionsBtn.classList.add("is-open");
    }
    if (patternTitles.length > 0) {
      optionsBtn.classList.add("has-content");
    }
    optionsBtn.setAttribute("aria-expanded", String(optionsOpen));
    optionsBtn.title = patternTitles.length > 0 ? `Title patterns (${patternTitles.length})` : "Title patterns";
    optionsBtn.setAttribute("aria-label", `Title pattern options for ${id}`);
    optionsBtn.innerHTML = CHEVRON_ICON;
    optionsBtn.addEventListener("click", () => {
      const open = !expandedPatternRows.has(id);
      if (open) {
        expandedPatternRows.add(id);
      } else {
        expandedPatternRows.delete(id);
      }
      panel.hidden = !open;
      optionsBtn.classList.toggle("is-open", open);
      optionsBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        patternInput.focus();
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = "Delete this focus mapping";
    remove.setAttribute("aria-label", `Delete mapping for ${id}`);
    remove.disabled = !hasMapping;
    remove.innerHTML = TRASH_ICON;
    remove.addEventListener("click", () => {
      delete draftMappings[id];
      expandedPatternRows.delete(id);
      markDirty();
      renderMappings();
    });
    actions.append(optionsBtn, remove);
    actionCell.append(actions);

    row.append(idCell, arrowCell, groupsCell, actionCell);
    makeDropTarget(row, (drag, event) => moveTitleToFocus(drag.title, event && event.altKey ? null : drag.sourceId, id));
    return row;
  });

  body.replaceChildren(...rows, makeUnassignedRow());
  renderUnassigned();
  if (adderInput) {
    adderInput.focus();
    activeAdderId = null;
  }
  if (patternAdderInput) {
    patternAdderInput.focus();
    activePatternAdderId = null;
  }
}

function formatValue(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "—";
}

function renderDiagnostics() {
  document.getElementById("diag-last-focus").textContent = formatValue(state.lastFocusSeen);
  document.getElementById("diag-last-action").textContent = formatValue(state.lastAction);
  document.getElementById("diag-current-groups").textContent = formatList(state.firefoxGroupTitles);
  document.getElementById("diag-group-titles").textContent = formatList(state.groupTitles);

  const details = [];
  if (state.unmappedFocusId) {
    details.push(`unmapped Focus ID: ${state.unmappedFocusId}`);
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

function renderCallout() {
  const callout = document.getElementById("unmapped-callout");
  const codeEl = document.getElementById("callout-focus-id");

  const showCallout =
    state.lastAction === "unmapped_focus_id" &&
    typeof state.unmappedFocusId === "string" &&
    state.unmappedFocusId.length > 0 &&
    !hasOwn(draftMappings, state.unmappedFocusId);

  if (showCallout) {
    codeEl.textContent = state.unmappedFocusId;
    callout.hidden = false;
  } else {
    callout.hidden = true;
  }
}

function render() {
  renderMappings();
  renderDiagnostics();
  renderCallout();
  renderShortcut();
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

function buildMappingsForSave() {
  const output = {};
  for (const [id, titles] of Object.entries(draftMappings)) {
    const normalizedId = id.trim();
    if (!normalizedId) continue;
    output[normalizedId] = normalizeTitles(titles);
  }
  return output;
}

function addCustomMapping() {
  const idInput = document.getElementById("new-focus-id");
  const id = idInput.value.trim();
  if (!id) {
    setStatus("Enter an Apple Focus ID.", "error");
    return;
  }
  if (!hasOwn(draftMappings, id)) {
    draftMappings[id] = [];
    markDirty();
  }
  hideAddFocusRow();
  // Focus the new row's group adder so the user can map groups immediately.
  activeAdderId = id;
  renderMappings();
}

function showAddFocusRow() {
  const rowEl = document.getElementById("add-focus-row");
  const idInput = document.getElementById("new-focus-id");
  if (rowEl) {
    rowEl.hidden = false;
  }
  if (idInput) {
    idInput.focus();
  }
}

function hideAddFocusRow() {
  const rowEl = document.getElementById("add-focus-row");
  const idInput = document.getElementById("new-focus-id");
  if (idInput) {
    idInput.value = "";
  }
  if (rowEl) {
    rowEl.hidden = true;
  }
}

async function saveMappings(event) {
  event.preventDefault();
  const focusMappings = buildMappingsForSave();
  await browser.storage.local.set({ focusMappings });
  state.focusMappings = focusMappings;
  draftMappings = cloneMappings(focusMappings);
  dirty = false;
  render();
  setStatus("Saved", "ok");
}

function discardChanges() {
  draftMappings = cloneMappings(state.focusMappings);
  dirty = false;
  render();
  setStatus("Discarded changes", "");
}

function applyStorageChange(changes) {
  if (changes.focusMappings) {
    state.focusMappings = normalizeMappings(changes.focusMappings.newValue);
    if (!dirty) {
      draftMappings = cloneMappings(state.focusMappings);
    }
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
  if (changes.focusCatalog) {
    state.focusCatalog = isRecord(changes.focusCatalog.newValue) ? changes.focusCatalog.newValue : {};
  }
  render();
}

async function refreshFirefoxGroups() {
  state.firefoxGroupTitles = await queryGroupTitles();
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

function setProviderStatus(message, kind = "") {
  const status = document.getElementById("provider-status");
  if (!status) {
    return;
  }
  status.textContent = message;
  status.className = kind;
}

function providerCustomVisible(visible) {
  const custom = document.getElementById("provider-custom");
  if (custom) {
    custom.hidden = !visible;
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
  setProviderStatus("");
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
  setProviderStatus("Reset to the default grouping prompt.", "ok");
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
    setProviderStatus("Saved — using the on-device Foundation model.", "ok");
    return;
  }

  const baseURL = document.getElementById("provider-url").value.trim();
  const model = document.getElementById("provider-model").value.trim();
  const apiKey = document.getElementById("provider-key").value.trim();
  if (!baseURL || !model) {
    setProviderStatus("Enter both an API base URL and a model.", "error");
    return;
  }
  let origin;
  try {
    origin = new URL(baseURL).origin;
  } catch (error) {
    setProviderStatus("That base URL is not valid.", "error");
    return;
  }

  let granted;
  try {
    granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  } catch (error) {
    console.error("Host permission request failed:", error);
    setProviderStatus("Could not request permission for that domain.", "error");
    return;
  }
  if (!granted) {
    setProviderStatus("Permission denied — the extension can't reach that domain.", "error");
    return;
  }

  const provider = { kind: "custom", baseURL, model, apiKey };
  await browser.storage.local.set({ aiProvider: provider, aiGroupingPrompt: promptOverride });
  state.aiProvider = provider;
  state.aiGroupingPrompt = promptOverride;
  if (promptField) {
    promptField.value = promptOverride || DEFAULT_GROUPING_PROMPT;
  }
  setProviderStatus(`Saved — using ${model} at ${origin}.`, "ok");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("mappings-form").addEventListener("submit", (event) => {
    saveMappings(event).catch((error) => {
      console.error("Focus mapping save failed:", error);
      setStatus("Save failed. See extension console for details.", "error");
    });
  });
  document.getElementById("discard").addEventListener("click", discardChanges);
  document.getElementById("add-mapping").addEventListener("click", addCustomMapping);
  document.getElementById("reveal-add-focus").addEventListener("click", showAddFocusRow);
  document.getElementById("cancel-add-focus").addEventListener("click", hideAddFocusRow);
  document.getElementById("new-focus-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomMapping();
    } else if (event.key === "Escape") {
      hideAddFocusRow();
    }
  });

  document.getElementById("apply-now").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "apply-current-focus" })
      .then(() => setStatus("Reapplied current Focus", "ok"))
      .catch((error) => {
        console.error("Apply current Focus failed:", error);
        setStatus("Apply failed. See extension console.", "error");
      });
  });

  document.getElementById("callout-map-btn").addEventListener("click", () => {
    const rawId = state.unmappedFocusId;
    if (!rawId) return;
    document.getElementById("new-focus-id").value = rawId;
    addCustomMapping();
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
      setProviderStatus("Save failed. See extension console.", "error");
    });
  });

  document.getElementById("ai-prompt-reset").addEventListener("click", () => {
    resetGroupingPrompt().catch((error) => {
      console.error("Grouping prompt reset failed:", error);
      setProviderStatus("Reset failed. See extension console.", "error");
    });
  });

  document.getElementById("provider-key-toggle").addEventListener("click", () => {
    const input = document.getElementById("provider-key");
    const toggle = document.getElementById("provider-key-toggle");
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
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
  });

  loadAll().catch((error) => {
    console.error("Focus options load failed:", error);
    setStatus("Load failed. See extension console for details.", "error");
  });
});
