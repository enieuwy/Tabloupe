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
const AI_PIN_TO_FOCUS_KEY = "aiPinToFocus";
const AI_GROUPING_PROMPT_KEY = "aiGroupingPrompt";
const AI_GROUPING_PROMPT_MAX = 4000;
// Default system prompt. The user can replace it wholesale from Options (stored
// in aiGroupingPrompt); an empty override falls back to this default.
const GROUPING_SYSTEM_PROMPT =
  "You organize a user's open browser tabs into a small number of topic groups. " +
  "Group tabs that share a project, task, or subject. Prefer " +
  "two to six groups. Every tab index belongs to exactly one group. Topic labels must be short " +
  '(1-4 words). Respond with ONLY a JSON object of the form ' +
  '{"groups":[{"topic":"...","tabIndices":[0,1]}]} and nothing else.';
const GROUPABLE_URL = /^https?:\/\//i;
// Firefox tab-group colors. Assigned round-robin so adjacent groups differ;
// the model only proposes topics + members, never presentation.
const TAB_GROUP_COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"];

// macOS notifications silently truncate (or drop) very long bodies. Cap the
// variable-length group/title lists embedded in messages so a window with many
// tab groups still produces a readable, deliverable notification.
const NOTIFICATION_LIST_MAX = 12;

const DEFAULT_FOCUS_MAPPINGS = Object.freeze({
  "com.apple.focus.work": ["Work"],
  "com.apple.focus.personal-time": ["Personal"],
  "com.apple.donotdisturb.mode.default": ["Do Not Disturb"],
  "com.apple.sleep.sleep-mode": ["Sleep"],
  "com.apple.donotdisturb.mode.graduationcapfill": ["Study"],
  "com.apple.focus.reduce-interruptions": ["Reduce Interruptions"],
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

// AI previews collapse onto one in-flight request per window so re-opening the
// popup or clicking Regroup mid-compute can't fan out duplicate daemon/LLM calls.
const inflightPreviews = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// A focus maps to a list of tab-group titles. An empty list means "seen but
// intentionally ignored".
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

// A mapping entry containing * or ? is a glob: * matches any run of characters,
// ? matches exactly one. Plain entries match a tab-group title exactly.
function isGlobPattern(entry) {
  return /[*?]/.test(entry);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${body}$`);
}

// Build a predicate over tab-group titles from a focus's mapped entries (a mix
// of exact titles and globs). A title matches if it equals an exact entry or
// matches any glob.
function buildTitleMatcher(titles) {
  const exact = new Set();
  const globs = [];
  for (const entry of titles) {
    if (isGlobPattern(entry)) {
      try {
        globs.push(globToRegExp(entry));
      } catch (error) {
        console.error("Invalid focus mapping glob:", entry, error);
      }
    } else {
      exact.add(entry);
    }
  }
  return (title) => exact.has(title) || globs.some((re) => re.test(title));
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
  // payload.focus is null (Focus off) or an enriched { id, name, icon, color }
  // object. Cache the enriched entry so the badge/notifications can name it.
  const focus = payload.focus;
  let rawId = null;
  if (isRecord(focus) && typeof focus.id === "string") {
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
  if (message && message.type === "tabsearch-close-many") {
    return closeManyTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-group") {
    return groupTabsFromSearch(message.tabIds, message.title, message.windowId, message.groupId);
  }
  if (message && message.type === "tabsearch-ungroup") {
    return ungroupTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-move-new-window") {
    return moveTabsToNewWindow(message.tabIds);
  }
  if (message && message.type === "tabsearch-set-pinned") {
    return setTabsPinnedFromSearch(message.tabIds, message.pinned);
  }
  if (message && message.type === "tabsearch-discard") {
    return discardTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-move") {
    return moveTabsFromSearch(message.tabIds, message.windowId, message.anchorId, message.placeAfter, message.groupId);
  }
  if (message && message.type === "tabsearch-ai-preview") {
    return tabsearchAiPreview(message.windowId, message.tabIds);
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

function truncateList(items, separator = ", ") {
  if (items.length <= NOTIFICATION_LIST_MAX) {
    return items.join(separator);
  }
  const hidden = items.length - NOTIFICATION_LIST_MAX;
  return `${items.slice(0, NOTIFICATION_LIST_MAX).join(separator)}${separator}… (+${hidden} more)`;
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

  // One tabs.query instead of N+1: bucket every tab by group and remember each
  // window's active tab in memory, so a focus mapped to many groups doesn't fan
  // out a query per group plus a per-group active-tab lookup.
  const allTabs = await browser.tabs.query({});
  const tabsByGroup = new Map();
  const activeByWindow = new Map();
  let firstActiveTab = null;
  for (const tab of allTabs) {
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const bucket = tabsByGroup.get(tab.groupId);
      if (bucket) {
        bucket.push(tab);
      } else {
        tabsByGroup.set(tab.groupId, [tab]);
      }
    }
    if (tab.active) {
      if (firstActiveTab === null) {
        firstActiveTab = tab;
      }
      if (typeof tab.windowId === "number" && !activeByWindow.has(tab.windowId)) {
        activeByWindow.set(tab.windowId, tab);
      }
    }
  }

  for (const group of groups) {
    const tabs = tabsByGroup.get(group.id) || [];
    if (tabs.length === 0) {
      continue;
    }

    // Don't pull focus away from an ungrouped active tab — the options page, a
    // pinned tab, or an about: page. Ungrouped tabs never block collapsing other
    // groups, so activating a matching tab here is unnecessary and would yank the
    // user off whatever they were deliberately viewing.
    const activeTab = typeof group.windowId === "number"
      ? activeByWindow.get(group.windowId) || null
      : firstActiveTab;
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

  const groupList = truncateList(
    allGroups.map((group) => `${group.title} (${group.collapsed ? "collapsed" : "expanded"})`),
    "\n",
  );

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
      }${groupList ? `:\n${groupList}` : ""}${updateFailures.length === 0 ? "" : `\nFailed: ${truncateList(updateFailures)}`}`,
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

  const matches = buildTitleMatcher(titles);
  const matching = allGroups.filter((group) => matches(group.title));
  const others = allGroups.filter((group) => !matches(group.title));
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
      message: `Could not activate every target tab group — not changing groups\nFailed: ${truncateList(activation.failures)}`,
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

  const expanded = truncateList(matching.map((group) => group.title));
  const collapsed = truncateList(others.map((group) => group.title)) || "(none)";
  const failureText = updateFailures.length === 0 ? "" : `\nFailed: ${truncateList(updateFailures)}`;

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

function requestTabGrouping(tabsPayload, promptOverride) {
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
      const message = { type: "groupTabs", schemaVersion: 1, id, tabs: tabsPayload };
      const prompt = normalizeGroupingPrompt(promptOverride);
      if (prompt) {
        message.prompt = prompt;
      }
      socket.send(JSON.stringify(message));
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

async function getGroupingPromptOverride() {
  const stored = await browser.storage.local.get(AI_GROUPING_PROMPT_KEY);
  return normalizeGroupingPrompt(stored[AI_GROUPING_PROMPT_KEY]);
}

// The user's stored prompt fully replaces the default when set; an empty
// override uses the built-in GROUPING_SYSTEM_PROMPT.
function buildGroupingSystemPrompt(promptOverride) {
  const override = normalizeGroupingPrompt(promptOverride);
  return override || GROUPING_SYSTEM_PROMPT;
}
// Calls an OpenAI-compatible endpoint directly from the extension. Returns raw
// [{topic, tabIndices}]; throws an Error with a `code` and a friendly message.
async function cloudCluster(payload, provider, systemPrompt) {
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
          { role: "system", content: systemPrompt || GROUPING_SYSTEM_PROMPT },
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

async function computeTabGrouping(windowId, explicitTabs) {
  const candidates = Array.isArray(explicitTabs) ? explicitTabs : await collectGroupableTabs(windowId);
  if (candidates.length < 2) {
    const message = Array.isArray(explicitTabs)
      ? "Select at least 2 ungrouped tabs to organize."
      : "Open at least 2 ungrouped tabs to organize.";
    return { ok: false, error: "not_enough_tabs", message };
  }

  const payload = candidates.map((tab, index) => ({
    index,
    title: typeof tab.title === "string" ? tab.title : "",
    url: tab.url,
  }));

  const provider = await getProvider();
  const promptOverride = await getGroupingPromptOverride();
  const systemPrompt = buildGroupingSystemPrompt(promptOverride);
  let raw;
  if (provider.kind === "custom") {
    try {
      raw = await cloudCluster(payload, provider, systemPrompt);
    } catch (error) {
      return { ok: false, error: error.code || "cloud_failed", message: error.message || "Cloud provider failed." };
    }
  } else {
    let response;
    try {
      response = await requestTabGrouping(payload, promptOverride);
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

async function applyTabGrouping(groups, windowId) {
  const applied = [];
  const failures = [];
  // Merge into an existing same-named group (manual or a prior AI run) instead
  // of spawning a duplicate. Snapshot existing groups once, scoped to the window.
  const existingByTitle = new Map();
  if (browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const query = typeof windowId === "number" ? { windowId } : {};
    const existing = await browser.tabGroups.query(query).catch(() => []);
    for (const group of existing) {
      if (typeof group.title === "string" && group.title !== "" && !existingByTitle.has(group.title)) {
        existingByTitle.set(group.title, group);
      }
    }
  }
  for (const group of groups) {
    const tabIds = group.tabs.map((tab) => tab.id).filter((id) => typeof id === "number");
    if (tabIds.length === 0) {
      continue;
    }
    const color = TAB_GROUP_COLORS.includes(group.color) ? group.color : TAB_GROUP_COLORS[0];
    try {
      const existing = existingByTitle.get(group.topic);
      if (existing) {
        // Append to the existing group; leave its title and color intact.
        await browser.tabs.group({ groupId: existing.id, tabIds });
      } else {
        const groupId = await browser.tabs.group({ tabIds });
        await browser.tabGroups.update(groupId, { title: group.topic, color });
      }
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

async function aiPinToFocusEnabled() {
  const stored = await browser.storage.local.get(AI_PIN_TO_FOCUS_KEY);
  return stored[AI_PIN_TO_FOCUS_KEY] === true;
}

async function activeFocusName() {
  const stored = await browser.storage.local.get("lastFocusSeen");
  const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
  return rawId === null ? null : await focusDisplayName(rawId);
}

// When the user opts in, append freshly applied AI topics to the active Focus's
// mapping so the new groups aren't collapsed on the next Focus change.
async function pinTopicsToActiveFocus(topics) {
  if (topics.length === 0 || !(await aiPinToFocusEnabled())) {
    return;
  }
  const stored = await browser.storage.local.get(["lastFocusSeen", "focusMappings"]);
  const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
  if (rawId === null) {
    return;
  }
  const mappings = isRecord(stored.focusMappings) ? { ...stored.focusMappings } : {};
  const titles = Array.isArray(mappings[rawId]) ? mappings[rawId].slice() : [];
  let changed = false;
  for (const topic of topics) {
    if (!titles.includes(topic)) {
      titles.push(topic);
      changed = true;
    }
  }
  if (changed) {
    mappings[rawId] = titles;
    await browser.storage.local.set({ focusMappings: mappings });
  }
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
  const [enabled, candidates, provider, pinToFocus, activeFocus] = await Promise.all([
    aiGroupingEnabled(),
    collectGroupableTabs(windowId),
    getProvider(),
    aiPinToFocusEnabled(),
    activeFocusName(),
  ]);
  return {
    enabled,
    groupableCount: candidates.length,
    proposal: cachedProposal(windowId),
    providerKind: provider.kind,
    pinToFocus,
    activeFocus,
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
  // Collapse concurrent previews for the same window onto one in-flight request
  // so re-opening the popup or clicking Regroup mid-compute can't fan out
  // duplicate daemon/LLM calls. The cache key tolerates an absent windowId.
  const key = typeof windowId === "number" ? windowId : "current";
  const existing = inflightPreviews.get(key);
  if (existing) {
    return existing;
  }
  const work = (async () => {
    const result = await computeTabGrouping(windowId);
    if (result.ok && typeof windowId === "number") {
      lastProposalByWindow.set(windowId, { groups: result.groups, ts: Date.now() });
    }
    return result;
  })();
  inflightPreviews.set(key, work);
  try {
    return await work;
  } finally {
    inflightPreviews.delete(key);
  }
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

  const outcome = await applyTabGrouping(normalized, windowId);
  const ok = outcome.failures.length === 0;
  if (ok) {
    await pinTopicsToActiveFocus(outcome.applied);
    if (typeof windowId === "number") {
      lastProposalByWindow.delete(windowId);
    }
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
  let groupsById = null;
  const hasGroupedTabs = tabs.some((tab) => typeof tab.groupId === "number" && tab.groupId !== -1);
  if (hasGroupedTabs && browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const groups = await browser.tabGroups.query({}).catch(() => []);
    groupsById = new Map(groups.map((group) => [group.id, group]));
  }
  const mapped = tabs.map((tab) => {
    const group = groupsById && typeof tab.groupId === "number" && tab.groupId !== -1
      ? groupsById.get(tab.groupId)
      : null;
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || tab.url || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      active: Boolean(tab.active),
      currentWindow: tab.windowId === currentWindowId,
      groupTitle: group && group.title ? group.title : "",
      groupColor: group && group.color ? group.color : "",
      pinned: Boolean(tab.pinned),
      grouped: typeof tab.groupId === "number" && tab.groupId !== -1,
      groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    };
  });
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

function validTabIds(tabIds) {
  return Array.isArray(tabIds) ? tabIds.filter((id) => typeof id === "number") : [];
}

async function closeManyTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0) {
    await browser.tabs.remove(validIds).catch(() => {});
  }
  return listTabsForSearch();
}

async function groupTabsFromSearch(tabIds, title, windowId, groupId) {
  const validIds = validTabIds(tabIds);
  if (validIds.length === 0) {
    return { ok: false, error: "no_tabs", message: "No tabs to group.", list: await listTabsForSearch() };
  }
  // Drag-onto-section: add tabs to an existing group by id — no title needed,
  // and the group's existing title/color are preserved.
  if (typeof groupId === "number") {
    try {
      await browser.tabs.group({ groupId, tabIds: validIds });
    } catch (error) {
      return { ok: false, error: "group_failed", message: "Could not add tabs to the group.", list: await listTabsForSearch() };
    }
    return { ok: true, list: await listTabsForSearch() };
  }
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") {
    return { ok: false, error: "no_title", message: "Enter a group name." };
  }
  let existingGroupCount = 0;
  if (browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const query = typeof windowId === "number" ? { windowId } : {};
    const existing = await browser.tabGroups.query(query).catch(() => []);
    existingGroupCount = Array.isArray(existing) ? existing.length : 0;
  }
  const group = {
    topic: trimmed,
    color: TAB_GROUP_COLORS[existingGroupCount % TAB_GROUP_COLORS.length] || TAB_GROUP_COLORS[0],
    tabs: validIds.map((id) => ({ id })),
  };
  const outcome = await applyTabGrouping([group], windowId);
  const ok = outcome.failures.length === 0;
  const result = { ok, list: await listTabsForSearch() };
  if (!ok) {
    result.error = "group_failed";
    result.message = "Could not group some tabs.";
  }
  return result;
}

async function ungroupTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0 && browser.tabs && typeof browser.tabs.ungroup === "function") {
    await browser.tabs.ungroup(validIds).catch(() => {});
  }
  return listTabsForSearch();
}

async function moveTabsToNewWindow(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length < 1) {
    return listTabsForSearch();
  }
  try {
    const win = await browser.windows.create({ tabId: validIds[0] });
    if (validIds.length > 1 && win && typeof win.id === "number") {
      await browser.tabs.move(validIds.slice(1), { windowId: win.id, index: -1 });
    }
  } catch (error) {
    // Keep the overlay responsive if one of the selected tabs no longer exists.
  }
  return listTabsForSearch();
}

async function moveTabsFromSearch(tabIds, windowId, anchorId, placeAfter, groupId) {
  const validIds = validTabIds(tabIds);
  if (validIds.length === 0 || typeof windowId !== "number") {
    return listTabsForSearch();
  }
  try {
    const winTabs = (await browser.tabs.query({ windowId }))
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0));
    const moveSet = new Set(validIds);
    let anchorIdx = winTabs.findIndex((tab) => tab.id === anchorId);
    if (anchorIdx === -1) anchorIdx = winTabs.length - 1;
    let target = placeAfter ? anchorIdx + 1 : anchorIdx;
    // Discount moved tabs already positioned before the target slot so the tab
    // lands exactly where it was dropped (the classic reorder off-by-one).
    const movedBefore = winTabs.slice(0, target).filter((tab) => moveSet.has(tab.id)).length;
    target = Math.max(0, target - movedBefore);
    await browser.tabs.move(validIds, { windowId, index: target });
    // Group membership follows the drop position: join the target group, or drop
    // out of any group when the position isn't inside one.
    if (typeof groupId === "number" && groupId !== -1) {
      await browser.tabs.group({ groupId, tabIds: validIds });
    } else if (typeof browser.tabs.ungroup === "function") {
      await browser.tabs.ungroup(validIds);
    }
  } catch (error) {
    // Keep the overlay responsive if a tab vanished mid-drag.
  }
  return listTabsForSearch();
}

async function setTabsPinnedFromSearch(tabIds, pinned) {
  const validIds = validTabIds(tabIds);
  await Promise.all(validIds.map((id) => browser.tabs.update(id, { pinned: Boolean(pinned) }).catch(() => {})));
  return listTabsForSearch();
}

async function discardTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (browser.tabs && typeof browser.tabs.discard === "function") {
    await Promise.all(validIds.map((id) => browser.tabs.discard(id).catch(() => {})));
  }
  return listTabsForSearch();
}

async function tabsearchAiPreview(windowId, tabIds) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  let candidates;
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0) {
    const wanted = new Set(validIds);
    const tabs = await browser.tabs.query({});
    candidates = tabs.filter((tab) =>
      wanted.has(tab.id) &&
      (typeof windowId !== "number" || tab.windowId === windowId) &&
      !tab.pinned &&
      isUngroupedTab(tab) &&
      typeof tab.url === "string" &&
      GROUPABLE_URL.test(tab.url)
    );
  } else {
    candidates = await collectGroupableTabs(windowId);
  }
  const result = await computeTabGrouping(windowId, candidates);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    groups: result.groups.map((group) => ({
      topic: group.topic,
      color: group.color,
      tabs: group.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
    })),
  };
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
