const DEFAULT_FOCUS_ORDER = [
  "com.apple.focus.work",
  "com.apple.focus.personal-time",
  "com.apple.donotdisturb.mode.default",
  "com.apple.sleep.sleep-mode",
  "com.apple.donotdisturb.mode.graduationcapfill",
  "com.apple.focus.reduce-interruptions",
];

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
};

let draftMappings = {};
let dirty = false;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeStringMap(value) {
  const output = {};
  if (!isRecord(value)) {
    return output;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === "string" && typeof entry === "string") {
      output[key] = entry;
    }
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

  state.focusMappings = normalizeStringMap(stored.focusMappings);
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
  if (!dirty) {
    draftMappings = { ...state.focusMappings };
  }

  render();
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

function renderDatalist() {
  const datalist = document.getElementById("firefox-groups");
  datalist.replaceChildren(...state.firefoxGroupTitles.map((title) => {
    const option = document.createElement("option");
    option.value = title;
    return option;
  }));
}

function makeBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = className ? `badge ${className}` : "badge";
  badge.textContent = text;
  return badge;
}

function renderMappings() {
  const body = document.getElementById("mappings-body");
  const ids = sortedFocusIds();

  if (ids.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "No Focus IDs yet. Toggle a macOS Focus mode or add a custom mapping.";
    row.append(cell);
    body.replaceChildren(row);
    return;
  }

  const rows = ids.map((id) => {
    const row = document.createElement("tr");
    const idCell = document.createElement("td");
    const titleCell = document.createElement("td");
    const actionCell = document.createElement("td");

    const code = document.createElement("code");
    code.textContent = id;
    idCell.append(code);

    const badges = document.createElement("div");
    badges.className = "badges";
    const hasMapping = hasOwn(draftMappings, id);
    const hasSeen = hasOwn(state.seenFocusIds, id);
    if (state.lastFocusSeen === id) {
      badges.append(makeBadge("currently active", "active"));
    }
    if (hasMapping && draftMappings[id] === "") {
      badges.append(makeBadge("ignored", ""));
    } else if (hasMapping && !hasSeen) {
      badges.append(makeBadge("not yet seen", "warning"));
    } else if (!hasMapping && hasSeen) {
      badges.append(makeBadge("unmapped", "warning"));
    }
    if (badges.childElementCount > 0) {
      idCell.append(badges);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("list", "firefox-groups");
    input.autocomplete = "off";
    input.placeholder = "Tab group title (empty = ignore)";
    input.value = hasMapping ? draftMappings[id] : "";
    input.addEventListener("input", () => {
      draftMappings[id] = input.value;
      markDirty();
    });
    titleCell.append(input);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.disabled = !hasMapping;
    remove.addEventListener("click", () => {
      delete draftMappings[id];
      markDirty();
      renderMappings();
    });
    actionCell.append(remove);

    row.append(idCell, titleCell, actionCell);
    return row;
  });

  body.replaceChildren(...rows);
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
  renderDatalist();
  renderMappings();
  renderDiagnostics();
  renderCallout();
}

function buildMappingsForSave() {
  const output = {};
  for (const [id, title] of Object.entries(draftMappings)) {
    const normalizedId = id.trim();
    if (!normalizedId) continue;
    output[normalizedId] = typeof title === "string" ? title.trim() : "";
  }
  return output;
}

function addCustomMapping() {
  const idInput = document.getElementById("new-focus-id");
  const titleInput = document.getElementById("new-group-title");
  const id = idInput.value.trim();
  const title = titleInput.value.trim();

  if (!id) {
    setStatus("Enter a Focus ID. Leave the group title empty to ignore it.", "error");
    return;
  }

  draftMappings[id] = title;
  idInput.value = "";
  titleInput.value = "";
  markDirty();
  renderMappings();
}

async function saveMappings(event) {
  event.preventDefault();
  const focusMappings = buildMappingsForSave();
  await browser.storage.local.set({ focusMappings });
  state.focusMappings = focusMappings;
  draftMappings = { ...focusMappings };
  dirty = false;
  render();
  setStatus("Saved", "ok");
}

function discardChanges() {
  draftMappings = { ...state.focusMappings };
  dirty = false;
  render();
  setStatus("Discarded changes", "");
}

function applyStorageChange(changes) {
  if (changes.focusMappings) {
    state.focusMappings = normalizeStringMap(changes.focusMappings.newValue);
    if (!dirty) {
      draftMappings = { ...state.focusMappings };
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
  render();
}

async function refreshFirefoxGroups() {
  state.firefoxGroupTitles = await queryGroupTitles();
  render();
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
    const idInput = document.getElementById("new-focus-id");
    const titleInput = document.getElementById("new-group-title");
    idInput.value = rawId;
    titleInput.value = "";
    titleInput.focus();
    idInput.scrollIntoView({ behavior: "smooth", block: "center" });
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
