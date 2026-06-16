const WS_URL = "ws://127.0.0.1:8767";
const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const MIN_RECONNECT_ALARM_MINUTES = 1;
const OPTIONS_NOTIFICATION_PREFIX = "focus-unmapped-";
// On-device FoundationModels can take ~1s/tab; a busy window easily exceeds 60s.
// Cloud backends return in a few seconds. Budget generously — the popup caches
// per window, so a slow run isn't lost if the user closes the popup.
const GROUPING_TIMEOUT_MS = 120000;
const AI_GROUPING_ENABLED_KEY = "aiGroupingEnabled";
const AI_PROVIDER_KEY = "aiProvider";
const GROUPING_SYSTEM_PROMPT =
  "You organize a user's open browser tabs into a small number of topic groups, like " +
  "Safari's automatic tab groups. Group tabs that share a project, task, or subject. Prefer " +
  "two to six groups. Every tab index belongs to exactly one group. Topic labels must be short " +
  '(1-4 words). Respond with ONLY a JSON object of the form ' +
  '{"groups":[{"topic":"...","tabIndices":[0,1]}]} and nothing else.';
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

// A focus maps to a list of tab-group titles. An empty list means "seen but
// intentionally ignored". Accepts legacy values: "" -> [], "Title" -> ["Title"].
function normalizeTitles(value) {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? [title] : [];
  }
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
  if (rawId === null || !hasOwn(focusMappings, rawId)) {
    return null;
  }
  return normalizeTitles(focusMappings[rawId]);
}

async function applyRawFocus(rawId, { force = false } = {}) {
  if (!force && rawId === lastDispatchedRawId) {
    return;
  }

  const stored = await browser.storage.local.get("focusMappings");
  const focusMappings = isRecord(stored.focusMappings) ? stored.focusMappings : {};
  const titles = mappedFocus(rawId, focusMappings);

  const applied = await applyFocus(titles, { rawId });
  if (applied !== false) {
    lastDispatchedRawId = rawId;
  }
}
// MCC owns the Focus catalog (id -> {name, icon, color}); cache what it
// broadcasts so the options UI and the badge can show names without hardcoding.
async function mergeFocusCatalog(entries) {
  if (!isRecord(entries)) {
    return;
  }
  const stored = await browser.storage.local.get("focusCatalog");
  const catalog = isRecord(stored.focusCatalog) ? { ...stored.focusCatalog } : {};
  let changed = false;
  for (const [id, entry] of Object.entries(entries)) {
    if (typeof id === "string" && isRecord(entry) && typeof entry.name === "string") {
      catalog[id] = {
        name: entry.name,
        icon: typeof entry.icon === "string" ? entry.icon : "target",
        color: typeof entry.color === "string" ? entry.color : null,
      };
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({ focusCatalog: catalog });
  }
}

async function focusDisplayName(rawId) {
  if (rawId === null) {
    return null;
  }
  const stored = await browser.storage.local.get("focusCatalog");
  const catalog = isRecord(stored.focusCatalog) ? stored.focusCatalog : {};
  const entry = catalog[rawId];
  return entry && typeof entry.name === "string" && entry.name ? entry.name : rawId;
}

async function handleMessage(event) {
  const msg = JSON.parse(event.data);
  // MCC multiplexes several state subsystems on this socket (focus, bluetooth,
  // wireguard, ...), each wrapped in a StateEnvelope { type, schemaVersion, ts,
  // payload }. Focus envelopes drive tab grouping; focusCatalog carries the
  // id -> {name, icon, color} table. Ignore everything else so an unrelated
  // state change can't reset focus and expand all groups.
  if (!isRecord(msg)) {
    return;
  }
  if (msg.type === "focusCatalog") {
    const payload = isRecord(msg.payload) ? msg.payload : {};
    await mergeFocusCatalog(payload.entries);
    return;
  }
  if (msg.type !== "focus") {
    return;
  }
  const payload = isRecord(msg.payload) ? msg.payload : {};
  // payload.focus is null (off), a {id, name, icon, color} object (current MCC),
  // or a bare id string (older MCC) — accept all three.
  const focus = payload.focus;
  let rawId = null;
  if (typeof focus === "string") {
    rawId = focus;
  } else if (isRecord(focus) && typeof focus.id === "string") {
    rawId = focus.id;
    await mergeFocusCatalog({ [focus.id]: focus });
  }

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
  if (message && message.type === "tabsearch-list") {
    return listTabsForSearch();
  }
  if (message && message.type === "tabsearch-activate") {
    return activateTabFromSearch(message.tabId, message.windowId);
  }
  if (message && message.type === "tabsearch-close") {
    return closeTabFromSearch(message.tabId);
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

    // Don't pull focus away from an ungrouped active tab — the options page, a
    // pinned tab, or an about: page. Ungrouped tabs never block collapsing other
    // groups, so activating a matching tab here is unnecessary and would yank the
    // user off whatever they were deliberately viewing.
    const windowQuery =
      typeof group.windowId === "number"
        ? { active: true, windowId: group.windowId }
        : { active: true };
    const [activeTab] = await browser.tabs.query(windowQuery);
    if (activeTab && isUngroupedTab(activeTab)) {
      activated = true;
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

async function applyFocus(titles, { rawId }) {
  const allGroups = await browser.tabGroups.query({});
  await browser.storage.local.set({
    groupTitles: allGroups.map((group) => group.title),
  });
  const focusName = rawId !== null ? await focusDisplayName(rawId) : null;

  const groupList = allGroups.map((group) =>
    `${group.title} (${group.collapsed ? "collapsed" : "expanded"})`
  ).join("\n");

  if (titles === null && rawId === null) {
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

  if (titles === null && rawId !== null) {
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
      message: `Unmapped Focus mode ${focusName} — click this notification to open Focus Tab Groups options and assign it`,
    }, notificationId);
    return true;
  }

  // Mapped but no titles → seen and intentionally ignored.
  if (titles.length === 0) {
    await updateBadge("", null);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "ignored",
    });
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

  const wanted = new Set(titles);
  const matching = allGroups.filter((group) => wanted.has(group.title));
  const others = allGroups.filter((group) => !wanted.has(group.title));
  const titlesText = titles.join(", ");

  if (matching.length === 0) {
    await updateBadge("!", "#FF9800"); // Orange for missing group
    const updateFailures = await setGroupsCollapsed(allGroups, false);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "no_matching_group",
      missingGroup: titlesText,
      updateFailures,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `No group called ${titles.map((title) => `"${title}"`).join(" or ")} found.\n\nYour groups:\n${groupList}`,
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
      message: `Could not activate every target tab group — not changing groups\nFailed: ${activation.failures.join(", ")}`,
    });
    return false;
  }

  if (!activation.activated) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "matching_group_empty",
      emptyGroup: titlesText,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `${titles.map((title) => `"${title}"`).join(", ")} ${matching.length === 1 ? "group is" : "groups are"} empty — not changing anything`,
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

// Resolves the active provider. A valid custom provider is used directly via
// fetch; otherwise we fall back to Foundation (on-device, routed to the daemon).
async function getProvider() {
  const stored = await browser.storage.local.get(AI_PROVIDER_KEY);
  const provider = stored[AI_PROVIDER_KEY];
  if (
    isRecord(provider) &&
    provider.kind === "custom" &&
    typeof provider.baseURL === "string" && provider.baseURL !== "" &&
    typeof provider.model === "string" && provider.model !== ""
  ) {
    return {
      kind: "custom",
      baseURL: provider.baseURL,
      model: provider.model,
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
    };
  }
  return { kind: "foundation" };
}

function buildGroupingPrompt(payload) {
  const lines = ["Tabs to organize (index: title [host]):"];
  for (const tab of payload) {
    let host = "";
    try {
      host = new URL(tab.url).host;
    } catch (error) {
      host = "";
    }
    const title = typeof tab.title === "string" && tab.title !== "" ? tab.title : tab.url;
    lines.push(`${tab.index}: ${title}${host ? ` [${host}]` : ""}`);
  }
  return lines.join("\n");
}

// Pulls the JSON object/array out of model content that may be fenced or prose-wrapped.
function extractGroupingJSON(content) {
  let text = content.trim();
  if (text.startsWith("```")) {
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      text = text.slice(newline + 1);
    }
    const fence = text.lastIndexOf("```");
    if (fence !== -1) {
      text = text.slice(0, fence);
    }
    text = text.trim();
  }
  const opens = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  const start = opens.length ? Math.min(...opens) : -1;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return start >= 0 && end >= start ? text.slice(start, end + 1) : text;
}

function parseGroupsFromContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(extractGroupingJSON(content));
  } catch (error) {
    return [];
  }
  let entries;
  if (isRecord(parsed) && Array.isArray(parsed.groups)) {
    entries = parsed.groups;
  } else if (Array.isArray(parsed)) {
    entries = parsed;
  } else {
    return [];
  }
  const groups = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.topic !== "string") {
      continue;
    }
    const indices = Array.isArray(entry.tabIndices)
      ? entry.tabIndices
          .map((value) => (typeof value === "number" ? value : parseInt(value, 10)))
          .filter((n) => Number.isInteger(n))
      : [];
    groups.push({ topic: entry.topic, tabIndices: indices });
  }
  return groups;
}

// Calls an OpenAI-compatible endpoint directly from the extension. Returns raw
// [{topic, tabIndices}]; throws an Error with a `code` and a friendly message.
async function cloudCluster(payload, provider) {
  const endpoint = provider.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROUPING_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: GROUPING_SYSTEM_PROMPT },
          { role: "user", content: buildGroupingPrompt(payload) },
        ],
      }),
    });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    const wrapped = new Error(
      aborted
        ? "The provider took too long to respond."
        : "Could not reach the provider. Check the URL and grant host access in options."
    );
    wrapped.code = aborted ? "cloud_timeout" : "cloud_unreachable";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const wrapped = new Error(
      `Provider returned HTTP ${response.status}.${response.status === 401 ? " Check your API key." : ""}`
    );
    wrapped.code = `cloud_http_${response.status}`;
    throw wrapped;
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    const wrapped = new Error("Provider returned invalid JSON.");
    wrapped.code = "cloud_bad_json";
    throw wrapped;
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined;
  if (typeof content !== "string") {
    const wrapped = new Error("Provider response was not a chat completion.");
    wrapped.code = "cloud_malformed";
    throw wrapped;
  }
  return parseGroupsFromContent(content);
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

  const provider = await getProvider();
  let raw;
  if (provider.kind === "custom") {
    try {
      raw = await cloudCluster(payload, provider);
    } catch (error) {
      return { ok: false, error: error.code || "cloud_failed", message: error.message || "Cloud provider failed." };
    }
  } else {
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
    raw = response.groups;
  }

  const groups = mapProposalToGroups(raw, candidates);
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
  const [enabled, candidates, provider] = await Promise.all([
    aiGroupingEnabled(),
    collectGroupableTabs(windowId),
    getProvider(),
  ]);
  return {
    enabled,
    groupableCount: candidates.length,
    proposal: cachedProposal(windowId),
    providerKind: provider.kind,
  };
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

// ── Tab search ─────────────────────────────────────────────
// Content scripts can't touch browser.tabs, so the search overlay (tabsearch.js)
// asks the background for the tab list and routes switch/close actions through here.

async function listTabsForSearch() {
  const currentWindow = browser.windows
    ? await browser.windows.getCurrent().catch(() => null)
    : null;
  const currentWindowId = currentWindow ? currentWindow.id : null;
  const tabs = await browser.tabs.query({});
  const mapped = tabs.map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || tab.url || "Untitled",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    active: Boolean(tab.active),
    currentWindow: tab.windowId === currentWindowId,
  }));
  // Stable sort keeps native tab order within a window; current window floats first.
  mapped.sort((a, b) => {
    if (a.currentWindow !== b.currentWindow) return a.currentWindow ? -1 : 1;
    return 0;
  });
  return mapped;
}

async function activateTabFromSearch(tabId, windowId) {
  if (typeof tabId !== "number") return { ok: false };
  if (browser.windows && typeof windowId === "number") {
    await browser.windows.update(windowId, { focused: true }).catch(() => {});
  }
  await browser.tabs.update(tabId, { active: true });
  return { ok: true };
}

async function closeTabFromSearch(tabId) {
  if (typeof tabId === "number") {
    await browser.tabs.remove(tabId).catch(() => {});
  }
  return listTabsForSearch();
}

async function openTabSearchOverlay() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active || typeof active.id !== "number") return;
  try {
    await browser.tabs.sendMessage(active.id, { type: "tabsearch-open" });
  } catch (error) {
    // No content script on this page (e.g. about:, addons, PDF viewer).
    await notify({
      type: "basic",
      title: "Tab Search",
      message: "Tab search can't open on this page. Switch to a normal web page and try again.",
    });
  }
}

if (browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener((command) => {
    if (command === "search-tabs") {
      openTabSearchOverlay().catch((error) => console.error("Tab search error:", error));
    }
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") {
    connect();
  }
});

start();
