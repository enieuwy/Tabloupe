const TAB_GROUP_COLOR_HEX = {
  blue: "#0a84ff",
  cyan: "#22b8cf",
  green: "#34c759",
  orange: "#ff9f0a",
  pink: "#ff2d92",
  purple: "#bf5af2",
  red: "#ff3b30",
  yellow: "#ffd60a",
};

let windowId = null;
let lensState = null;
let proposal = null;
let aiInitialized = false;
let connectionStatus = {
  connectionState: "reconnecting",
  lastError: null,
};

const el = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const status = el("ai-status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function setLensStatus(message, kind = "") {
  const status = el("lens-status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

function renderConnectionStatus(state = connectionStatus) {
  const connection = el("popup-connection");
  const lastError = state.lastError;
  if (state.connectionState !== "connected") {
    connection.textContent = "⚠ Not connected to mac-command-centre";
    connection.className = "conn conn-warn";
    return;
  }
  if (lastError && lastError.message) {
    connection.textContent = lastError.message;
    connection.className = "conn conn-warn";
    return;
  }
  connection.textContent = "";
  connection.className = "conn";
}

async function initConnectionStatus() {
  const stored = await browser.storage.local.get(["connectionState", "lastError"]);
  connectionStatus = {
    connectionState: stored.connectionState,
    lastError: stored.lastError || null,
  };
  renderConnectionStatus();
  if (connectionStatus.lastError) {
    await browser.storage.local.set({ lastError: null });
    connectionStatus.lastError = null;
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes.connectionState) {
    return;
  }
  connectionStatus = {
    ...connectionStatus,
    connectionState: changes.connectionState.newValue,
  };
  renderConnectionStatus();
}

function showButtons({ apply = false, regroup = false, dismiss = false, organize = false }) {
  el("ai-apply").hidden = !apply;
  el("ai-regroup").hidden = !regroup;
  el("ai-dismiss").hidden = !dismiss;
  el("ai-organize").hidden = !organize;
}

function setActionsDisabled(disabled) {
  for (const id of ["ai-apply", "ai-regroup", "ai-dismiss", "ai-organize"]) {
    el(id).disabled = disabled;
  }
}

function renderProposal(groups) {
  const container = el("ai-groups");
  container.textContent = "";
  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "group";
    const hex = TAB_GROUP_COLOR_HEX[group.color];
    if (hex) {
      card.style.borderLeftColor = hex;
    }
    const heading = document.createElement("h2");
    heading.textContent = `${group.topic} (${group.tabs.length})`;
    card.appendChild(heading);
    const list = document.createElement("ul");
    for (const tab of group.tabs) {
      const item = document.createElement("li");
      item.textContent = tab.title;
      list.appendChild(item);
    }
    card.appendChild(list);
    container.appendChild(card);
  }
  container.hidden = false;
  el("ai-summary").textContent = "";
  showButtons({ apply: true, regroup: true, dismiss: true });
  setActionsDisabled(false);
}

function renderDisabled() {
  proposal = null;
  el("ai-groups").hidden = true;
  el("ai-summary").textContent = "Turn on AI tab grouping to organize this window's tabs into topics.";
  setStatus("");
  showButtons({});
}

function renderIdle(groupableCount) {
  proposal = null;
  el("ai-groups").hidden = true;
  setStatus("");
  if (groupableCount >= 2) {
    el("ai-summary").textContent = `${groupableCount} ungrouped tabs in this window.`;
    showButtons({ organize: true });
  } else {
    el("ai-summary").textContent = `Only ${groupableCount} groupable tab${groupableCount === 1 ? "" : "s"}. Open at least 2 ungrouped web tabs.`;
    showButtons({});
  }
  setActionsDisabled(false);
}

function renderPin(state) {
  const row = el("ai-pin-row");
  const box = el("ai-pin");
  const label = el("ai-pin-label");
  if (!row || !box || !label) return;
  if (state.enabled !== true) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  box.checked = state.pinToFocus === true;
  if (state.activeFocus) {
    box.disabled = false;
    label.textContent = `Add new groups to current lens: ${state.activeFocus}`;
  } else {
    box.disabled = true;
    label.textContent = "Add new groups to current lens (none active)";
  }
}

function renderAuto(state, checked) {
  const row = el("ai-auto-row");
  const box = el("ai-auto");
  if (!row || !box) return;
  if (state.enabled !== true) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  box.checked = checked === true;
}

async function send(message) {
  return browser.runtime.sendMessage({ ...message, windowId });
}

function getActiveLensName(state) {
  const activeView = state && state.activeView;
  if (!activeView || activeView.kind === "all") {
    return "All groups";
  }
  if (activeView.kind === "transient") {
    return activeView.label || "This group";
  }
  const lens = (state.lenses || []).find((item) => item.id === activeView.lensId);
  return lens ? lens.name : "Selected lens";
}

function renderTriggerLine(state) {
  const trigger = el("lens-trigger");
  const lastActivation = state.lastActivation || {};
  if (!state.hasAppleBinding) {
    trigger.hidden = true;
    trigger.textContent = "";
    return;
  }
  if (lastActivation.trigger === "manual") {
    trigger.textContent = "Manual override";
    trigger.hidden = false;
    return;
  }
  if (lastActivation.trigger && lastActivation.trigger !== "manual") {
    trigger.textContent = "Switched by Apple Focus";
    trigger.hidden = false;
    return;
  }
  trigger.hidden = true;
  trigger.textContent = "";
}

function makeColorDot(color) {
  const dot = document.createElement("span");
  dot.className = "color-dot";
  const hex = TAB_GROUP_COLOR_HEX[color];
  if (hex) {
    dot.style.backgroundColor = hex;
  }
  return dot;
}

function renderLensChips(state) {
  const container = el("lens-chips");
  container.textContent = "";
  const lenses = state.lenses || [];
  if (lenses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No saved lenses yet.";
    container.appendChild(empty);
    return;
  }

  for (const lens of lenses) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lens-chip";
    if (lens.active || (state.activeView && state.activeView.kind === "lens" && state.activeView.lensId === lens.id)) {
      chip.classList.add("active");
      chip.setAttribute("aria-pressed", "true");
    } else {
      chip.setAttribute("aria-pressed", "false");
    }
    if (lens.color) {
      chip.appendChild(makeColorDot(lens.color));
    }
    const name = document.createElement("span");
    name.textContent = lens.name;
    chip.appendChild(name);
    chip.addEventListener("click", () => activateView({ kind: "lens", lensId: lens.id }));
    container.appendChild(chip);
  }
}

function renderCurrentGroups(state) {
  const section = el("groups-section");
  const container = el("current-groups");
  const saveWindow = el("lens-save-window");
  const groups = state.currentGroups || [];
  container.textContent = "";
  saveWindow.disabled = groups.length === 0;
  section.hidden = groups.length === 0;

  for (const group of groups) {
    const row = document.createElement("article");
    row.className = "window-group";

    const details = document.createElement("div");
    details.className = "window-group-details";
    const title = document.createElement("div");
    title.className = "group-title";
    title.appendChild(makeColorDot(group.color));
    const titleText = document.createElement("strong");
    titleText.textContent = group.title;
    title.appendChild(titleText);
    details.appendChild(title);

    const saved = document.createElement("p");
    saved.className = "group-saved";
    const savedIn = Array.isArray(group.savedIn) ? group.savedIn : [];
    saved.textContent = savedIn.length > 0 ? `Saved in: ${savedIn.join(", ")}` : "Not saved";
    details.appendChild(saved);
    row.appendChild(details);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const show = document.createElement("button");
    show.type = "button";
    show.className = "secondary compact";
    show.textContent = "Show just this";
    show.addEventListener("click", () => activateView({
      kind: "transient",
      label: group.title,
      selectors: [{ type: "title", value: group.title }],
    }));
    actions.appendChild(show);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "secondary compact";
    save.textContent = "Save as lens";
    save.addEventListener("click", () => saveGroupAsLens(group.title));
    actions.appendChild(save);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

function renderWindowProfile(state) {
  const select = el("window-profile");
  if (!select) return;
  const profile = state.windowProfile || { kind: "default" };
  select.textContent = "";
  const options = [
    { value: "default", label: "Follow active automation" },
    { value: "none", label: "Ignore automation" },
  ];
  for (const lens of state.lenses || []) {
    options.push({ value: `lens:${lens.id}`, label: `Always show ${lens.name}` });
  }
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = profile.kind === "lens" ? `lens:${profile.lensId}` : profile.kind;
}

async function setWindowProfile(value) {
  let profile = { kind: value };
  if (value.startsWith("lens:")) {
    profile = { kind: "lens", lensId: value.slice("lens:".length) };
  }
  const result = await send({ type: "window-profile-set", profile });
  if (!result || result.ok === false) {
    throw new Error(result && result.error ? result.error : "profile_failed");
  }
  await refreshLensState();
}


function renderLensState(state) {
  lensState = {
    activeView: { kind: "all" },
    lastActivation: null,
    lenses: [],
    currentGroups: [],
    hasGroups: false,
    hasAppleBinding: false,
    aiEnabled: false,
    ...state,
  };
  el("lens-showing").textContent = `Showing: ${getActiveLensName(lensState)}`;
  renderTriggerLine(lensState);
  renderLensChips(lensState);
  renderCurrentGroups(lensState);
  renderWindowProfile(lensState);
  const empty = !lensState.hasGroups && (lensState.lenses || []).length === 0;
  el("empty-state").hidden = !empty;
  setLensStatus("");
}

async function refreshLensState() {
  try {
    const state = await send({ type: "lens-state" });
    renderLensState(state || {});
  } catch (error) {
    console.error("Lens state failed:", error);
    setLensStatus("Could not load Tabloupe state.", "error");
  }
}

async function activateView(view) {
  setLensStatus("");
  try {
    const result = await send({ type: "lens-activate", view });
    if (!result || result.ok !== true) {
      setLensStatus((result && result.message) || "Could not switch lens.", "error");
      return;
    }
    await refreshLensState();
  } catch (error) {
    console.error("Lens activation failed:", error);
    setLensStatus("Could not switch lens.", "error");
  }
}

async function saveGroupAsLens(title) {
  try {
    const result = await send({
      type: "lens-save",
      source: "group",
      groupTitle: title,
      name: title,
    });
    if (!result || result.ok !== true) {
      setLensStatus((result && result.message) || "Could not save lens.", "error");
      return;
    }
    await refreshLensState();
  } catch (error) {
    console.error("Lens save failed:", error);
    setLensStatus("Could not save lens.", "error");
  }
}

function promptLensName(defaultName) {
  if (typeof window.prompt !== "function") {
    return defaultName;
  }
  const name = window.prompt("Name this lens", defaultName);
  return name && name.trim();
}

async function saveWindowAsLens() {
  const name = promptLensName("Current groups");
  if (!name) {
    return;
  }
  try {
    const result = await send({
      type: "lens-save",
      source: "window",
      name,
    });
    if (!result || result.ok !== true) {
      setLensStatus((result && result.message) || "Could not save lens.", "error");
      return;
    }
    await refreshLensState();
  } catch (error) {
    console.error("Window lens save failed:", error);
    setLensStatus("Could not save lens.", "error");
  }
}

async function runPreview() {
  proposal = null;
  el("ai-groups").hidden = true;
  showButtons({});
  setStatus("Organizing your tabs…");

  let result;
  try {
    result = await send({ type: "ai-group-preview" });
  } catch (error) {
    console.error("AI preview failed:", error);
    setStatus("Could not reach the background service.", "error");
    showButtons({ regroup: true });
    return;
  }

  if (!result || result.ok !== true) {
    setStatus((result && result.message) || "Could not organize tabs.", "error");
    showButtons({ regroup: true });
    return;
  }

  proposal = result.groups;
  renderProposal(proposal);
  setStatus(`Proposed ${proposal.length} group${proposal.length === 1 ? "" : "s"}. Review, then apply.`, "ok");
}

async function applyGroups() {
  if (!Array.isArray(proposal) || proposal.length === 0) {
    return;
  }
  setStatus("Applying…");
  setActionsDisabled(true);

  let result;
  try {
    result = await send({ type: "ai-group-apply", groups: proposal });
  } catch (error) {
    console.error("AI apply failed:", error);
    setStatus("Apply failed. See extension console.", "error");
    setActionsDisabled(false);
    return;
  }

  if (!result || result.ok !== true) {
    const failed = (result && result.failures) || [];
    setStatus((result && result.message) || `Some groups failed: ${failed.join(", ")}`, "error");
    setActionsDisabled(false);
    return;
  }

  proposal = null;
  el("ai-groups").hidden = true;
  showButtons({});
  setStatus(`Created ${result.applied.length} group${result.applied.length === 1 ? "" : "s"}.`, "ok");
  setTimeout(() => window.close(), 700);
}

async function dismiss() {
  proposal = null;
  try {
    await send({ type: "ai-group-clear" });
  } catch (error) {
    console.error("AI dismiss failed:", error);
  }
  await refreshAi({ autoPreview: false });
}

async function refreshAi({ autoPreview = false } = {}) {
  let state;
  try {
    state = await send({ type: "ai-group-state" });
  } catch (error) {
    console.error("AI state failed:", error);
    setStatus("Could not reach the background service.", "error");
    return;
  }
  state = state || {};

  el("ai-enabled").checked = state.enabled === true;
  renderPin(state);
  const autoStored = await browser.storage.local.get("aiAutoGroup");
  renderAuto(state, autoStored.aiAutoGroup === true);

  if (state.enabled !== true) {
    renderDisabled();
    return;
  }

  if (Array.isArray(state.proposal) && state.proposal.length > 0) {
    proposal = state.proposal;
    renderProposal(proposal);
    setStatus(`Proposed ${proposal.length} group${proposal.length === 1 ? "" : "s"}. Review, then apply.`, "ok");
    return;
  }

  if (autoPreview && state.groupableCount >= 2) {
    await runPreview();
    return;
  }

  renderIdle(state.groupableCount || 0);
}

async function openAiSubview() {
  el("lens-view").hidden = true;
  el("ai-view").hidden = false;
  await ensureAiInitialized();
  await refreshAi({ autoPreview: false });
}

async function closeAiSubview() {
  el("ai-view").hidden = true;
  el("lens-view").hidden = false;
  await refreshLensState();
}

async function ensureAiInitialized() {
  if (aiInitialized) {
    return;
  }
  aiInitialized = true;
  await initConnectionStatus();
  if (browser.storage.onChanged && browser.storage.onChanged.addListener) {
    browser.storage.onChanged.addListener(handleStorageChange);
  }

  el("ai-enabled").addEventListener("change", async (event) => {
    await browser.storage.local.set({ aiGroupingEnabled: event.target.checked });
    await refreshAi({ autoPreview: false });
  });
  el("ai-pin").addEventListener("change", async (event) => {
    await browser.storage.local.set({ aiPinToFocus: event.target.checked });
  });
  el("ai-auto").addEventListener("change", async (event) => {
    await browser.storage.local.set({ aiAutoGroup: event.target.checked });
  });
  el("ai-organize").addEventListener("click", runPreview);
  el("ai-regroup").addEventListener("click", runPreview);
  el("ai-apply").addEventListener("click", applyGroups);
  el("ai-dismiss").addEventListener("click", dismiss);
  el("ai-back").addEventListener("click", closeAiSubview);
  el("ai-options").addEventListener("click", (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });
}

async function init() {
  try {
    const current = await browser.windows.getCurrent();
    windowId = current.id;
  } catch (error) {
    console.error("Popup window resolve failed:", error);
  }

  el("lens-show-all").addEventListener("click", () => activateView({ kind: "all" }));
  el("lens-save-window").addEventListener("click", saveWindowAsLens);
  el("window-profile").addEventListener("change", (event) => {
    setWindowProfile(event.target.value).catch((error) => {
      console.error("Window profile save failed:", error);
      setLensStatus("Could not save this window's automation setting.", "error");
    });
  });
  el("open-ai").addEventListener("click", openAiSubview);
  el("empty-organize").addEventListener("click", openAiSubview);
  el("lens-options").addEventListener("click", (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });

  await refreshLensState();
}

document.addEventListener("DOMContentLoaded", init);
