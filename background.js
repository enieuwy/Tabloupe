const WS_URL = "ws://127.0.0.1:8767";
const RECONNECT_MS = 3000;
const RECONNECT_ALARM = "focus-reconnect";

let lastFocus = null;
let lastFocusLoad = null;
let socket = null;
let reconnectTimer = null;

function loadLastFocus() {
  if (!lastFocusLoad) {
    lastFocusLoad = browser.storage.local.get("lastFocusSeen")
      .then((stored) => {
        if (typeof stored.lastFocusSeen === "string") {
          lastFocus = stored.lastFocusSeen;
        }
      })
      .catch((e) => {
        console.error("Stored focus read error:", e);
      });
  }
  return lastFocusLoad;
}

function clearReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  browser.alarms.clear(RECONNECT_ALARM);
}

function scheduleReconnect() {
  clearReconnect();
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
  browser.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_MS / 60000 });
}

async function connect() {
  await loadLastFocus();

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return;
  }

  clearReconnect();
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => clearReconnect();
  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      const focus = typeof msg.focus === "string" ? msg.focus : "none";
      if (focus !== lastFocus) {
        lastFocus = focus;
        await applyFocus(focus);
      }
    } catch (e) {
      console.error("Parse error:", e);
    }
  };

  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
    }
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    connect();
  }
});


// ── Tab group logic ────────────────────────────────────────

async function applyFocus(focusName) {
  const allGroups = await browser.tabGroups.query({});
  await browser.storage.local.set({
    lastFocusSeen: focusName,
    groupTitles: allGroups.map((group) => group.title),
  });

  if (allGroups.length === 0) {
    browser.notifications.create({
      type: "basic",
      title: "Focus Tab Groups",
      message: `No tab groups found in Firefox`
    });
    return;
  }

  const groupList = allGroups.map(g =>
    `${g.title} (${g.collapsed ? "collapsed" : "expanded"})`
  ).join("\n");

  // "none" → expand everything
  if (focusName === "none") {
    for (const group of allGroups) {
      if (group.collapsed) {
        await browser.tabGroups.update(group.id, { collapsed: false });
      }
    }
    await browser.storage.local.set({ lastAction: "expanded_all" });
    browser.notifications.create({
      type: "basic",
      title: "Focus Tab Groups",
      message: `Focus off — expanded all ${allGroups.length} groups:\n${groupList}`
    });
    return;
  }

  const matching = allGroups.filter(g => g.title === focusName);
  const others = allGroups.filter(g => g.title !== focusName);

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
    browser.notifications.create({
      type: "basic",
      title: "Focus Tab Groups",
      message: `No group called "${focusName}" found.\n\nYour groups:\n${groupList}`
    });
    return;
  }

  // Activate a tab inside the target group BEFORE collapsing others.
  let activated = false;
  for (const group of matching) {
    const tabs = await browser.tabs.query({ groupId: group.id });
    if (tabs.length > 0) {
      const target = tabs.find(t => !t.active) || tabs[0];
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
    browser.notifications.create({
      type: "basic",
      title: "Focus Tab Groups",
      message: `"${focusName}" group is empty — not changing anything`
    });
    return;
  }

  // Expand matching groups
  for (const group of matching) {
    if (group.collapsed) {
      await browser.tabGroups.update(group.id, { collapsed: false });
    }
  }

  // Collapse all others
  for (const group of others) {
    if (!group.collapsed) {
      await browser.tabGroups.update(group.id, { collapsed: true });
    }
  }

  const expanded = matching.map(g => g.title).join(", ");
  const collapsed = others.map(g => g.title).join(", ") || "(none)";

  await browser.storage.local.set({
    lastAction: "applied",
    expandedGroups: matching.map((group) => group.title),
    collapsedGroups: others.map((group) => group.title),
  });

  browser.notifications.create({
    type: "basic",
    title: `Focus: ${focusName}`,
    message: `Expanded: ${expanded}\nCollapsed: ${collapsed}`
  });
}

// ── Start ──────────────────────────────────────────────────

connect();
