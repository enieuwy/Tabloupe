const WS_URL = "ws://127.0.0.1:8767";
const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const MIN_RECONNECT_ALARM_MINUTES = 1;
const OPTIONS_NOTIFICATION_PREFIX = "focus-unmapped-";
const GROUPING_TIMEOUT_MS = 30000;
const AI_GROUPING_ENABLED_KEY = "aiGroupingEnabled";
const GROUPABLE_URL = /^https?:\/\//i;
// Firefox tab-group colors. Assigned round-robin so adjacent groups differ;
// the model only proposes topics + members, never presentation.
const TAB_GROUP_COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"];

const DEFAULT_FOCUS_MAPPINGS = Object.freeze({
  "com.apple.focus.work": "Work",
  "com.apple.focus.personal-time": "Personal",
  "com.apple.donotdisturb.mode.default": "Do Not Disturb",
  "com.apple.sleep.sleep-mode": "Sleep",
  "com.apple.donotdisturb.mode.graduationcapfill": "Study",
  "com.apple.focus.reduce-interruptions": "Reduce Interruptions",
});

let lastDispatchedRawId;
let socket = null;
let reconnectDelay = MIN_RECONNECT_MS;
let reconnectTimer = null;
let messageQueue = Promise.resolve();
let groupingRequestSeq = 0;
const pendingGroupingRequests = new Map();
// Per-window cache of the last preview so the ephemeral popup can show a result
// instantly on reopen (and survive being closed mid-compute). Cleared on apply,
// dismiss, window close, or TTL expiry.
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const lastProposalByWindow = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function enqueueFocusWork(task) {
  const queued = messageQueue.then(task, task);
  messageQueue = queued.catch(() => {});
  return queued;
}

async function ensureDefaultMappings() {
  const stored = await browser.storage.local.get("focusMappings");
  if (!isRecord(stored.focusMappings)) {
    await browser.storage.local.set({ focusMappings: { ...DEFAULT_FOCUS_MAPPINGS } });
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  browser.alarms.clear("reconnect");
}

function scheduleReconnect() {
  clearReconnectTimer();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  // setTimeout is the primary mechanism; the alarm is a fallback in case
  // Firefox suspends the background page. Firefox alarms are minute-granular,
  // so keep the timer fast and only use the alarm as a conservative wake-up.
  browser.alarms.create("reconnect", {
    delayInMinutes: Math.max(delay / 60000, MIN_RECONNECT_ALARM_MINUTES),
  });
  reconnectTimer = setTimeout(connect, delay);
}

async function recordSeen(rawId) {
  if (rawId === null) {
    await browser.storage.local.set({ lastFocusSeen: null });
    return;
  }

  const now = Date.now();
  const stored = await browser.storage.local.get("seenFocusIds");
  const seenFocusIds = isRecord(stored.seenFocusIds) ? { ...stored.seenFocusIds } : {};
  const previous = isRecord(seenFocusIds[rawId]) ? seenFocusIds[rawId] : {};
  seenFocusIds[rawId] = {
    firstSeen: typeof previous.firstSeen === "number" ? previous.firstSeen : now,
    lastSeen: now,
  };

  await browser.storage.local.set({
    lastFocusSeen: rawId,
    seenFocusIds,
  });
}

function mappedFocus(rawId, focusMappings) {
  if (rawId === null) {
    return null;
  }

  if (!hasOwn(focusMappings, rawId)) {
    return null;
  }

  const mappedTitle = focusMappings[rawId];
  if (mappedTitle === "") return ""; // Explicitly ignored
  return typeof mappedTitle === "string" && mappedTitle.length > 0 ? mappedTitle : null;
}

async function applyRawFocus(rawId, { force = false } = {}) {
  if (!force && rawId === lastDispatchedRawId) {
    return;
  }

  const stored = await browser.storage.local.get("focusMappings");
  const focusMappings = isRecord(stored.focusMappings) ? stored.focusMappings : {};
  const focusName = mappedFocus(rawId, focusMappings);

  const applied = await applyFocus(focusName, { rawId });
  if (applied !== false) {
    lastDispatchedRawId = rawId;
  }
}

async function handleMessage(event) {
  const msg = JSON.parse(event.data);
  const rawId = msg && typeof msg.focus === "string" ? msg.focus : null;

  await recordSeen(rawId);
  await applyRawFocus(rawId);
}

async function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return;
  }

  clearReconnectTimer();
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = MIN_RECONNECT_MS;
    clearReconnectTimer();
  };
  ws.onmessage = (event) => {
    if (tryResolveGroupingResponse(event)) {
      return;
    }
    enqueueFocusWork(() => handleMessage(event)).catch((error) => {
      console.error("Focus message error:", error);
    });
  };

  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      rejectPendingGrouping(new Error("daemon_disconnected"));
      scheduleReconnect();
    }
  };
  ws.onerror = () => ws.close();
}

function start() {
  ensureDefaultMappings()
    .catch((error) => {
      console.error("Default focus mapping seed error:", error);
    })
    .finally(() => {
      connect();
    });
}

// Initialization is handled by invoking start() at script evaluation.
// Do not bind to onInstalled/onStartup to prevent duplicate execution
// since this is a persistent background page.

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "apply-current-focus") {
    return enqueueFocusWork(() =>
      browser.storage.local.get("lastFocusSeen").then((stored) => {
        const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
        return applyRawFocus(rawId, { force: true });
      })
    );
  }
  if (message && message.type === "ai-group-state") {
    return handleGroupState(message.windowId);
  }
  if (message && message.type === "ai-group-preview") {
    return handleGroupPreview(message.windowId);
  }
  if (message && message.type === "ai-group-apply") {
    return handleGroupApply(message.windowId, message.groups);
  }
  if (message && message.type === "ai-group-clear") {
    return Promise.resolve(handleGroupClear(message.windowId));
  }
  return false;
});

if (browser.windows && browser.windows.onRemoved) {
  browser.windows.onRemoved.addListener((windowId) => {
    lastProposalByWindow.delete(windowId);
  });
}

browser.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith(OPTIONS_NOTIFICATION_PREFIX)) {
    browser.runtime.openOptionsPage();
    browser.notifications.clear(notificationId);
  }
});

if (browser.notifications.onButtonClicked) {
  browser.notifications.onButtonClicked.addListener((notificationId) => {
    if (notificationId.startsWith(OPTIONS_NOTIFICATION_PREFIX)) {
      browser.runtime.openOptionsPage();
      browser.notifications.clear(notificationId);
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.focusMappings) {
    return;
  }

  enqueueFocusWork(() =>
    browser.storage.local.get("lastFocusSeen").then((stored) => {
      const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
      lastDispatchedRawId = undefined;
      if (rawId !== null) {
        return applyRawFocus(rawId, { force: true });
      }
      return undefined;
    })
  ).catch((error) => {
    console.error("Focus mapping refresh error:", error);
  });
});

// ── Tab group logic ────────────────────────────────────────

async function updateBadge(text, color) {
  try {
    if (browser.browserAction) {
      await browser.browserAction.setBadgeText({ text });
      if (color) {
        await browser.browserAction.setBadgeBackgroundColor({ color });
      }
    }
  } catch (error) {
    console.error("Badge error:", error);
  }
}

async function notify(options, notificationId) {
  try {
    if (notificationId) {
      await browser.notifications.create(notificationId, options);
    } else {
      await browser.notifications.create(options);
    }
  } catch (error) {
    console.error("Notification error:", error);
  }
}

const CLEAR_ACTION_DIAGNOSTICS = Object.freeze({
  unmappedFocusId: null,
  missingGroup: null,
  emptyGroup: null,
  expandedGroups: [],
  collapsedGroups: [],
  updateFailures: [],
});

function groupLabel(group) {
  const title = typeof group.title === "string" && group.title.length > 0 ? group.title : `#${group.id}`;
  return typeof group.windowId === "number" ? `${title} (window ${group.windowId})` : title;
}

async function setGroupCollapsed(group, collapsed) {
  if (group.collapsed === collapsed) {
    return null;
  }

  try {
    await browser.tabGroups.update(group.id, { collapsed });
    group.collapsed = collapsed;
    return null;
  } catch (error) {
    console.error("Tab group update error:", group.id, group.title, error);
    return groupLabel(group);
  }
}

async function setGroupsCollapsed(groups, collapsed) {
  const failures = await Promise.all(groups.map((group) => setGroupCollapsed(group, collapsed)));
  return failures.filter((failure) => failure !== null);
}

async function activateMatchingGroups(groups) {
  let activated = false;
  const failures = [];

  for (const group of groups) {
    const tabs = await browser.tabs.query({ groupId: group.id });
    if (tabs.length === 0) {
      continue;
    }

    const target = tabs.find((tab) => tab.active) || tabs[0];
    try {
      await browser.tabs.update(target.id, { active: true });
      activated = true;
    } catch (error) {
      console.error("Tab activation error:", group.id, group.title, error);
      failures.push(groupLabel(group));
    }
  }

  return { activated, failures };
}

async function applyFocus(focusName, { rawId }) {
  const allGroups = await browser.tabGroups.query({});
  await browser.storage.local.set({
    groupTitles: allGroups.map((group) => group.title),
  });

  const groupList = allGroups.map((group) =>
    `${group.title} (${group.collapsed ? "collapsed" : "expanded"})`
  ).join("\n");

  if (focusName === "") {
    await updateBadge("", null);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "ignored",
    });
    return true;
  }

  if (focusName === null && rawId === null) {
    await updateBadge("", null);
    const updateFailures = await setGroupsCollapsed(allGroups, false);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: updateFailures.length === 0 ? "expanded_all" : "expanded_all_with_errors",
      updateFailures,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Focus off — ${
        updateFailures.length === 0 ? `expanded all ${allGroups.length} groups` : "some groups could not be expanded"
      }${groupList ? `:\n${groupList}` : ""}${updateFailures.length === 0 ? "" : `\nFailed: ${updateFailures.join(", ")}`}`,
    });
    return updateFailures.length === 0;
  }

  if (focusName === null && rawId !== null) {
    await updateBadge("?", "#D50000"); // Red for unmapped
    const notificationId = `${OPTIONS_NOTIFICATION_PREFIX}${rawId}`;
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "unmapped_focus_id",
      unmappedFocusId: rawId,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Unmapped Focus mode ${rawId} — click this notification to open Focus Tab Groups options and assign it`,
    }, notificationId);
    return true;
  }

  if (allGroups.length === 0) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "no_groups",
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: "No tab groups found in Firefox",
    });
    return true;
  }

  const matching = allGroups.filter((group) => group.title === focusName);
  const others = allGroups.filter((group) => group.title !== focusName);

  if (matching.length === 0) {
    await updateBadge("!", "#FF9800"); // Orange for missing group
    const updateFailures = await setGroupsCollapsed(allGroups, false);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "no_matching_group",
      missingGroup: focusName,
      updateFailures,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `No group called "${focusName}" found.\n\nYour groups:\n${groupList}`,
    });
    return updateFailures.length === 0;
  }

  // Activate a tab inside every target group before collapsing other groups.
  // Firefox rejects collapsing a group that contains its window's active tab;
  // activating matching groups first prevents one window from aborting the batch.
  const activation = await activateMatchingGroups(matching);

  if (activation.failures.length > 0) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "activation_failed",
      updateFailures: activation.failures,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Could not activate every "${focusName}" tab group — not changing groups\nFailed: ${activation.failures.join(", ")}`,
    });
    return false;
  }

  if (!activation.activated) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "matching_group_empty",
      emptyGroup: focusName,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `"${focusName}" group is empty — not changing anything`,
    });
    return true;
  }

  const [expandFailures, collapseFailures] = await Promise.all([
    setGroupsCollapsed(matching, false),
    setGroupsCollapsed(others, true),
  ]);
  const updateFailures = expandFailures.concat(collapseFailures);
  const lastAction = updateFailures.length === 0 ? "applied" : "applied_with_errors";

  await updateBadge(
    updateFailures.length === 0 ? focusName.substring(0, 1).toUpperCase() : "!",
    updateFailures.length === 0 ? "#00C853" : "#FF9800",
  );

  const expanded = matching.map((group) => group.title).join(", ");
  const collapsed = others.map((group) => group.title).join(", ") || "(none)";
  const failureText = updateFailures.length === 0 ? "" : `\nFailed: ${updateFailures.join(", ")}`;

  await browser.storage.local.set({
    ...CLEAR_ACTION_DIAGNOSTICS,
    lastAction,
    expandedGroups: matching.map((group) => group.title),
    collapsedGroups: others.map((group) => group.title),
    updateFailures,
  });

  await notify({
    type: "basic",
    title: `Focus: ${focusName}`,
    message: `Expanded: ${expanded}\nCollapsed: ${collapsed}${failureText}`,
  });
  return updateFailures.length === 0;
}

// ── AI tab grouping ────────────────────────────────────────
// Sends ungrouped-tab metadata to mac-command-centre, which clusters them with
// Apple's on-device model (FoundationModels) and returns named topic groups.

function nextGroupingRequestId() {
  groupingRequestSeq += 1;
  return `g${groupingRequestSeq}-${Date.now()}`;
}

function tryResolveGroupingResponse(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (error) {
    return false;
  }
  if (!isRecord(msg) || msg.type !== "groupTabsResult") {
    return false;
  }
  resolveGroupingResponse(msg);
  return true;
}

function resolveGroupingResponse(msg) {
  if (typeof msg.id !== "string") {
    return;
  }
  const pending = pendingGroupingRequests.get(msg.id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingGroupingRequests.delete(msg.id);
  pending.resolve(msg);
}

function rejectPendingGrouping(error) {
  const entries = Array.from(pendingGroupingRequests.values());
  pendingGroupingRequests.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function requestTabGrouping(tabsPayload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("daemon_disconnected"));
  }
  const id = nextGroupingRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingGroupingRequests.delete(id);
      reject(new Error("grouping_timeout"));
    }, GROUPING_TIMEOUT_MS);
    pendingGroupingRequests.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ type: "groupTabs", schemaVersion: 1, id, tabs: tabsPayload }));
    } catch (error) {
      clearTimeout(timer);
      pendingGroupingRequests.delete(id);
      reject(error);
    }
  });
}

function isUngroupedTab(tab) {
  // Firefox (139+) reports groupId === -1 for tabs not in any group. Fail closed:
  // an unknown group state is treated as grouped and left untouched.
  return tab.groupId === -1;
}

async function collectGroupableTabs(windowId) {
  const targetWindow = typeof windowId === "number" ? windowId : browser.windows.WINDOW_ID_CURRENT;
  const tabs = await browser.tabs.query({ windowId: targetWindow });
  // Only touch ungrouped, non-pinned web tabs so existing manual groups and
  // privileged pages (about:, moz-extension:, …) are never disturbed.
  return tabs.filter((tab) =>
    !tab.pinned &&
    isUngroupedTab(tab) &&
    typeof tab.url === "string" &&
    GROUPABLE_URL.test(tab.url)
  );
}

function mapProposalToGroups(proposalGroups, candidates) {
  if (!Array.isArray(proposalGroups)) {
    return [];
  }
  const groups = [];
  const seen = new Set();
  let colorIndex = 0;
  for (const proposal of proposalGroups) {
    if (!isRecord(proposal) || typeof proposal.topic !== "string") {
      continue;
    }
    const topic = proposal.topic.trim();
    if (topic === "") {
      continue;
    }
    const indices = Array.isArray(proposal.tabIndices) ? proposal.tabIndices : [];
    const tabs = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length || seen.has(index)) {
        continue;
      }
      const tab = candidates[index];
      if (tab && typeof tab.id === "number") {
        seen.add(index);
        tabs.push({ id: tab.id, title: typeof tab.title === "string" && tab.title !== "" ? tab.title : tab.url });
      }
    }
    if (tabs.length === 0) {
      continue;
    }
    groups.push({
      topic,
      color: TAB_GROUP_COLORS[colorIndex % TAB_GROUP_COLORS.length],
      tabs,
    });
    colorIndex += 1;
  }
  return groups;
}

function describeGroupingError(code) {
  switch (code) {
    case "daemon_disconnected":
      return "Not connected to mac-command-centre.";
    case "grouping_timeout":
      return "The on-device model took too long to respond.";
    default:
      return "Could not reach the AI tab grouping service.";
  }
}

async function computeTabGrouping(windowId) {
  const candidates = await collectGroupableTabs(windowId);
  if (candidates.length < 2) {
    return { ok: false, error: "not_enough_tabs", message: "Open at least 2 ungrouped tabs to organize." };
  }

  const payload = candidates.map((tab, index) => ({
    index,
    title: typeof tab.title === "string" ? tab.title : "",
    url: tab.url,
  }));

  let response;
  try {
    response = await requestTabGrouping(payload);
  } catch (error) {
    return { ok: false, error: error.message || "grouping_failed", message: describeGroupingError(error.message) };
  }

  if (!isRecord(response) || response.ok !== true) {
    return {
      ok: false,
      error: (response && response.error) || "grouping_failed",
      message: (response && response.message) || "Could not organize tabs.",
    };
  }

  const groups = mapProposalToGroups(response.groups, candidates);
  if (groups.length === 0) {
    return { ok: false, error: "empty_result", message: "No groups were returned for these tabs." };
  }
  return { ok: true, groups };
}

async function applyTabGrouping(groups) {
  const applied = [];
  const failures = [];
  for (const group of groups) {
    const tabIds = group.tabs.map((tab) => tab.id).filter((id) => typeof id === "number");
    if (tabIds.length === 0) {
      continue;
    }
    const color = TAB_GROUP_COLORS.includes(group.color) ? group.color : TAB_GROUP_COLORS[0];
    try {
      const groupId = await browser.tabs.group({ tabIds });
      await browser.tabGroups.update(groupId, { title: group.topic, color });
      applied.push(group.topic);
    } catch (error) {
      console.error("AI tab group apply error:", group.topic, error);
      failures.push(group.topic);
    }
  }
  return { applied, failures };
}

async function aiGroupingEnabled() {
  const stored = await browser.storage.local.get(AI_GROUPING_ENABLED_KEY);
  return stored[AI_GROUPING_ENABLED_KEY] === true;
}

function cachedProposal(windowId) {
  const entry = lastProposalByWindow.get(windowId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > PROPOSAL_TTL_MS) {
    lastProposalByWindow.delete(windowId);
    return null;
  }
  return entry.groups;
}

async function handleGroupState(windowId) {
  const [enabled, candidates] = await Promise.all([
    aiGroupingEnabled(),
    collectGroupableTabs(windowId),
  ]);
  return { enabled, groupableCount: candidates.length, proposal: cachedProposal(windowId) };
}

function handleGroupClear(windowId) {
  if (typeof windowId === "number") {
    lastProposalByWindow.delete(windowId);
  }
  return { ok: true };
}

async function handleGroupPreview(windowId) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  const result = await computeTabGrouping(windowId);
  if (result.ok && typeof windowId === "number") {
    lastProposalByWindow.set(windowId, { groups: result.groups, ts: Date.now() });
  }
  return result;
}

async function handleGroupApply(windowId, groups) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  // Re-validate against live tab state: between preview and apply a tab may have
  // been closed, pinned, manually grouped, or navigated off http(s). Only group
  // ids that are still groupable right now.
  const groupableIds = new Set((await collectGroupableTabs(windowId)).map((tab) => tab.id));
  const normalized = (Array.isArray(groups) ? groups : [])
    .filter((group) => isRecord(group) && typeof group.topic === "string" && Array.isArray(group.tabs))
    .map((group) => ({
      topic: group.topic,
      color: group.color,
      tabs: group.tabs.filter((tab) => isRecord(tab) && typeof tab.id === "number" && groupableIds.has(tab.id)),
    }))
    .filter((group) => group.tabs.length > 0);
  if (normalized.length === 0) {
    return { ok: false, error: "no_groups", message: "Those tabs are no longer available to group." };
  }

  const outcome = await applyTabGrouping(normalized);
  const ok = outcome.failures.length === 0;
  if (ok && typeof windowId === "number") {
    lastProposalByWindow.delete(windowId);
  }
  await updateBadge(ok ? "AI" : "!", ok ? "#00C853" : "#FF9800");
  await notify({
    type: "basic",
    title: "AI Tab Groups",
    message: ok
      ? `Created ${outcome.applied.length} group(s): ${outcome.applied.join(", ")}`
      : `Created ${outcome.applied.length}; failed: ${outcome.failures.join(", ")}`,
  });
  return { ok, applied: outcome.applied, failures: outcome.failures };
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") {
    connect();
  }
});

start();
