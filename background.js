const WS_URL = "ws://127.0.0.1:8767";
const RECONNECT_MS = 3000;
const OPTIONS_NOTIFICATION_PREFIX = "focus-unmapped-";

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
let reconnectTimer = null;
let messageQueue = Promise.resolve();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
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

  const mappedTitle = focusMappings[rawId];
  return typeof mappedTitle === "string" && mappedTitle.length > 0 ? mappedTitle : null;
}

async function applyRawFocus(rawId, { force = false } = {}) {
  if (!force && rawId === lastDispatchedRawId) {
    return;
  }

  const stored = await browser.storage.local.get("focusMappings");
  const focusMappings = isRecord(stored.focusMappings) ? stored.focusMappings : {};
  const focusName = mappedFocus(rawId, focusMappings);

  lastDispatchedRawId = rawId;
  await applyFocus(focusName, { rawId });
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

  ws.onopen = () => clearReconnectTimer();
  ws.onmessage = (event) => {
    messageQueue = messageQueue
      .then(() => handleMessage(event))
      .catch((error) => {
        console.error("Focus message error:", error);
      });
  };

  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
    }
    scheduleReconnect();
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

browser.runtime.onInstalled.addListener(start);
browser.runtime.onStartup.addListener(start);

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "apply-current-focus") {
    return browser.storage.local.get("lastFocusSeen").then((stored) => {
      const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
      return applyRawFocus(rawId, { force: true });
    });
  }
  return false;
});

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

  browser.storage.local.get("lastFocusSeen")
    .then((stored) => {
      const rawId = typeof stored.lastFocusSeen === "string" ? stored.lastFocusSeen : null;
      lastDispatchedRawId = undefined;
      if (rawId !== null) {
        return applyRawFocus(rawId, { force: true });
      }
      return undefined;
    })
    .catch((error) => {
      console.error("Focus mapping refresh error:", error);
    });
});

// ── Tab group logic ────────────────────────────────────────

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

async function applyFocus(focusName, { rawId }) {
  const allGroups = await browser.tabGroups.query({});
  await browser.storage.local.set({
    lastFocusSeen: rawId,
    groupTitles: allGroups.map((group) => group.title),
  });

  const groupList = allGroups.map((group) =>
    `${group.title} (${group.collapsed ? "collapsed" : "expanded"})`
  ).join("\n");

  if (focusName === null && rawId === null) {
    for (const group of allGroups) {
      if (group.collapsed) {
        await browser.tabGroups.update(group.id, { collapsed: false });
      }
    }
    await browser.storage.local.set({ lastAction: "expanded_all" });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Focus off — expanded all ${allGroups.length} groups${groupList ? `:\n${groupList}` : ""}`,
    });
    return;
  }

  if (focusName === null && rawId !== null) {
    const notificationId = `${OPTIONS_NOTIFICATION_PREFIX}${rawId}`;
    await browser.storage.local.set({
      lastAction: "unmapped_focus_id",
      unmappedFocusId: rawId,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Unmapped Focus mode ${rawId} — click this notification to open Focus Tab Groups options and assign it`,
    }, notificationId);
    return;
  }

  if (allGroups.length === 0) {
    await browser.storage.local.set({ lastAction: "no_groups" });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: "No tab groups found in Firefox",
    });
    return;
  }

  const matching = allGroups.filter((group) => group.title === focusName);
  const others = allGroups.filter((group) => group.title !== focusName);

  if (matching.length === 0) {
    for (const group of allGroups) {
      if (group.collapsed) {
        await browser.tabGroups.update(group.id, { collapsed: false });
      }
    }
    await browser.storage.local.set({
      lastAction: "no_matching_group",
      missingGroup: focusName,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `No group called "${focusName}" found.\n\nYour groups:\n${groupList}`,
    });
    return;
  }

  // Activate a tab inside the target group BEFORE collapsing others.
  let activated = false;
  for (const group of matching) {
    const tabs = await browser.tabs.query({ groupId: group.id });
    if (tabs.length > 0) {
      const target = tabs.find((tab) => !tab.active) || tabs[0];
      await browser.tabs.update(target.id, { active: true });
      activated = true;
      break;
    }
  }

  if (!activated) {
    await browser.storage.local.set({
      lastAction: "matching_group_empty",
      emptyGroup: focusName,
    });
    await notify({
      type: "basic",
      title: "Focus Tab Groups",
      message: `"${focusName}" group is empty — not changing anything`,
    });
    return;
  }

  // Expand matching groups.
  for (const group of matching) {
    if (group.collapsed) {
      await browser.tabGroups.update(group.id, { collapsed: false });
    }
  }

  // Collapse all others.
  for (const group of others) {
    if (!group.collapsed) {
      await browser.tabGroups.update(group.id, { collapsed: true });
    }
  }

  const expanded = matching.map((group) => group.title).join(", ");
  const collapsed = others.map((group) => group.title).join(", ") || "(none)";

  await browser.storage.local.set({
    lastAction: "applied",
    expandedGroups: matching.map((group) => group.title),
    collapsedGroups: others.map((group) => group.title),
  });

  await notify({
    type: "basic",
    title: `Focus: ${focusName}`,
    message: `Expanded: ${expanded}\nCollapsed: ${collapsed}`,
  });
}

// ── Start ──────────────────────────────────────────────────

start();
