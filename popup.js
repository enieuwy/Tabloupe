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
let proposal = null;

const el = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const status = el("ai-status");
  status.textContent = message;
  status.className = `status${kind ? ` ${kind}` : ""}`;
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
    label.textContent = `Pin new groups to Focus: ${state.activeFocus}`;
  } else {
    box.disabled = true;
    label.textContent = "Pin new groups to active Focus (none active)";
  }
}

async function send(message) {
  return browser.runtime.sendMessage({ ...message, windowId });
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
  await refresh({ autoPreview: false });
}

async function refresh({ autoPreview = true } = {}) {
  let state;
  try {
    state = await send({ type: "ai-group-state" });
  } catch (error) {
    console.error("AI state failed:", error);
    setStatus("Could not reach the background service.", "error");
    return;
  }

  el("ai-enabled").checked = state.enabled === true;
  renderPin(state);

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

  renderIdle(state.groupableCount);
}

async function init() {
  try {
    const current = await browser.windows.getCurrent();
    windowId = current.id;
  } catch (error) {
    console.error("AI window resolve failed:", error);
  }

  el("ai-enabled").addEventListener("change", async (event) => {
    await browser.storage.local.set({ aiGroupingEnabled: event.target.checked });
    await refresh();
  });
  el("ai-pin").addEventListener("change", async (event) => {
    await browser.storage.local.set({ aiPinToFocus: event.target.checked });
  });
  el("ai-organize").addEventListener("click", runPreview);
  el("ai-regroup").addEventListener("click", runPreview);
  el("ai-apply").addEventListener("click", applyGroups);
  el("ai-dismiss").addEventListener("click", dismiss);
  el("ai-options").addEventListener("click", (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });

  await refresh();
}

document.addEventListener("DOMContentLoaded", init);
