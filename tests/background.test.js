const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

const DEFAULT_MAPPINGS = {
  "com.apple.focus.work": "Work",
  "com.apple.focus.personal-time": "Personal",
  "com.apple.donotdisturb.mode.default": "Do Not Disturb",
  "com.apple.sleep.sleep-mode": "Sleep",
  "com.apple.donotdisturb.mode.graduationcapfill": "Study",
  "com.apple.focus.reduce-interruptions": "Reduce Interruptions",
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await nextTick();
  await nextTick();
  await nextTick();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject, started: false };
}

async function waitFor(assertion) {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function createHarness({
  storage = {},
  groups = [],
  tabs = [],
  currentWindowId = 1,
  deferFirstGroupUpdate = false,
} = {}) {
  const storageData = clone(storage) || {};
  const groupState = clone(groups);
  const tabState = clone(tabs);
  const notifications = [];
  const tabUpdates = [];
  const openedOptions = [];
  const storageListeners = [];
  const installedListeners = [];
  const startupListeners = [];
  const clickedListeners = [];
  const buttonClickedListeners = [];
  const messageListeners = [];
  const sockets = [];
  const alarms = [];
  const clearedAlarms = [];
  const sentMessages = [];
  const groupCreations = [];
  const timers = new Map();
  const consoleErrors = [];
  const testConsole = {
    ...console,
    error(...args) {
      consoleErrors.push(args);
    },
  };
  const firstGroupUpdate = deferFirstGroupUpdate ? deferred() : null;
  let nextTimerId = 1;

  const browser = {
    alarms: {
      create(name, config) {
        alarms.push({ name, config: clone(config) });
      },
      clear(name) {
        clearedAlarms.push(name);
      },
      onAlarm: {
        addListener(listener) {
          alarms.listener = listener;
        }
      }
    },
    windows: {
      WINDOW_ID_CURRENT: -2
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return clone(storageData) || {};
          }
          if (typeof keys === "string") {
            return { [keys]: clone(storageData[keys]) };
          }
          if (Array.isArray(keys)) {
            const output = {};
            for (const key of keys) {
              output[key] = clone(storageData[key]);
            }
            return output;
          }
          const output = { ...keys };
          for (const key of Object.keys(keys)) {
            if (Object.prototype.hasOwnProperty.call(storageData, key)) {
              output[key] = clone(storageData[key]);
            }
          }
          return output;
        },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = {
              oldValue: clone(storageData[key]),
              newValue: clone(value),
            };
            storageData[key] = clone(value);
          }
          for (const listener of storageListeners) {
            Promise.resolve().then(() => listener(changes, "local"));
          }
        },
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
    runtime: {
      onInstalled: { addListener: (listener) => installedListeners.push(listener) },
      onStartup: { addListener: (listener) => startupListeners.push(listener) },
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      openOptionsPage: () => openedOptions.push(true),
    },
    notifications: {
      async create(...args) {
        const options = args.length === 2 ? args[1] : args[0];
        assert.ok(!Object.prototype.hasOwnProperty.call(options, "buttons"), "Firefox notifications must not include buttons");
        notifications.push(args);
        return args.length === 2 ? args[0] : "generated-notification-id";
      },
      async clear() {},
      onClicked: { addListener: (listener) => clickedListeners.push(listener) },
      onButtonClicked: { addListener: (listener) => buttonClickedListeners.push(listener) },
    },
    tabGroups: {
      async query() {
        return clone(groupState);
      },
      async update(id, patch) {
        const group = groupState.find((candidate) => candidate.id === id);
        assert.ok(group, `group ${id} exists`);
        if (firstGroupUpdate && !firstGroupUpdate.started) {
          firstGroupUpdate.started = true;
          await firstGroupUpdate.promise;
        }
        if (patch.collapsed === true && tabState.some((tab) => tab.groupId === id && tab.active)) {
          throw new Error(`cannot collapse active group ${id}`);
        }
        if (group.failUpdate) {
          throw new Error(`group ${id} update failed`);
        }
        Object.assign(group, patch);
        return clone(group);
      },
    },
    tabs: {
      async query(query) {
        return clone(tabState.filter((tab) => {
          if (query.groupId !== undefined && tab.groupId !== query.groupId) return false;
          const tabWindowId = typeof tab.windowId === "number" ? tab.windowId : currentWindowId;
          if (query.windowId === browser.windows.WINDOW_ID_CURRENT) {
            return tabWindowId === currentWindowId;
          }
          if (query.windowId !== undefined && tabWindowId !== query.windowId) return false;
          return true;
        }));
      },
      async update(id, patch) {
        const tab = tabState.find((candidate) => candidate.id === id);
        assert.ok(tab, `tab ${id} exists`);
        if (patch.active) {
          if (tab.failActivate) {
            throw new Error(`tab ${id} activation failed`);
          }
          const targetWindowId = typeof tab.windowId === "number" ? tab.windowId : currentWindowId;
          for (const candidate of tabState) {
            const candidateWindowId = typeof candidate.windowId === "number" ? candidate.windowId : currentWindowId;
            if (candidateWindowId === targetWindowId) {
              candidate.active = false;
            }
          }
        }
        Object.assign(tab, patch);
        tabUpdates.push({ id, patch: clone(patch) });
        return clone(tab);
      },
      async group({ tabIds }) {
        const id = groupState.reduce((max, group) => Math.max(max, group.id), 0) + 1;
        for (const tabId of tabIds) {
          const tab = tabState.find((candidate) => candidate.id === tabId);
          if (tab) {
            tab.groupId = id;
          }
        }
        groupState.push({ id, title: "", collapsed: false });
        groupCreations.push({ id, tabIds: clone(tabIds) });
        return id;
      },
    },
  };

  class FakeWebSocket {
    static CLOSED = 3;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
    }

    send(data) {
      sentMessages.push(JSON.parse(data));
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) {
        this.onclose();
      }
    }
  }

  function fakeSetTimeout(callback, delay) {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  }

  function fakeClearTimeout(id) {
    timers.delete(id);
  }

  const context = {
    browser,
    console: testConsole,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    WebSocket: FakeWebSocket,
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  return {
    context,
    browser,
    storageData,
    groupState,
    tabState,
    notifications,
    tabUpdates,
    openedOptions,
    storageListeners,
    installedListeners,
    startupListeners,
    clickedListeners,
    buttonClickedListeners,
    messageListeners,
    sockets,
    sentMessages,
    groupCreations,
    alarms,
    clearedAlarms,
    timers,
    consoleErrors,
    firstGroupUpdate,
    async sendMessage(message) {
      for (const listener of messageListeners) {
        const result = listener(message);
        if (result && typeof result.then === "function") {
          await result;
        }
      }
    },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `timer ${id} exists`);
      timers.delete(id);
      timer.callback();
    },
  };
}

function twoGroups() {
  return {
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: false },
    ],
  };
}

test("seeds default mappings only when focusMappings is absent", async () => {
  const seeded = createHarness();
  await settle();
  assert.deepEqual(seeded.storageData.focusMappings, DEFAULT_MAPPINGS);

  const existing = createHarness({ storage: { focusMappings: { "custom-id": "Reading" } } });
  await settle();
  assert.deepEqual(existing.storageData.focusMappings, { "custom-id": "Reading" });
});

test("mapped raw Focus ID records raw diagnostics and applies mapped tab group", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");
  assert.ok(harness.storageData.seenFocusIds["com.apple.focus.work"].firstSeen > 0);
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.deepEqual(harness.storageData.expandedGroups, ["Work"]);
  assert.deepEqual(harness.storageData.collapsedGroups, ["Other"]);
});

test("null Focus expands every tab group", async () => {
  const harness = createHarness({
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: null }) });

  assert.equal(harness.storageData.lastFocusSeen, null);
  assert.equal(harness.storageData.lastAction, "expanded_all");
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
});

test("unmapped raw Focus ID leaves groups untouched and prompts without notification buttons", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.custom" }) });

  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
  assert.equal(harness.storageData.lastAction, "unmapped_focus_id");
  assert.equal(harness.storageData.unmappedFocusId, "com.apple.focus.custom");
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0][0], "focus-unmapped-com.apple.focus.custom");
});

test("changing the active raw Focus mapping reapplies despite same raw ID dedupe", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);

  await harness.browser.storage.local.set({
    focusMappings: { ...DEFAULT_MAPPINGS, "com.apple.focus.work": "Other" },
  });

  await waitFor(() => {
    assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
    assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
    assert.deepEqual(harness.storageData.expandedGroups, ["Other"]);
    assert.deepEqual(harness.storageData.collapsedGroups, ["Work"]);
  });
});

test("apply-current-focus message force-reapplies last seen Focus", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  // First apply Work focus via WebSocket message
  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);

  // Manually uncollapse Other to simulate user action
  harness.groupState.find((group) => group.title === "Other").collapsed = false;

  // Send apply-current-focus message — should force-reapply Work and collapse Other again
  await harness.sendMessage({ type: "apply-current-focus" });
  await settle();

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("explicit ignore mapping records ignored action and clears stale diagnostics", async () => {
  const fixture = twoGroups();
  const harness = createHarness({
    ...fixture,
    storage: {
      focusMappings: { "com.apple.focus.custom": "" },
      unmappedFocusId: "stale",
      expandedGroups: ["stale"],
      collapsedGroups: ["stale"],
      updateFailures: ["stale"],
    },
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.custom" }) });

  assert.equal(harness.storageData.lastAction, "ignored");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
  assert.equal(harness.storageData.unmappedFocusId, null);
  assert.deepEqual(harness.storageData.expandedGroups, []);
  assert.deepEqual(harness.storageData.collapsedGroups, []);
  assert.deepEqual(harness.storageData.updateFailures, []);
});

test("missing mapped group expands existing groups and records missing group", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.missing": "Missing" } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.missing" }) });

  assert.equal(harness.storageData.lastAction, "no_matching_group");
  assert.equal(harness.storageData.missingGroup, "Missing");
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
});

test("empty matching group records empty group without collapsing others", async () => {
  const harness = createHarness({
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "matching_group_empty");
  assert.equal(harness.storageData.emptyGroup, "Work");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("matching groups are activated in each window before other groups collapse", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": "Work" } },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
      { id: 3, windowId: 2, title: "Work", collapsed: true },
      { id: 4, windowId: 2, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: true },
      { id: 30, windowId: 2, groupId: 3, active: false },
      { id: 40, windowId: 2, groupId: 4, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 4).collapsed, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).active, true);
});

test("group update failures are reported without aborting remaining updates", async () => {
  const harness = createHarness({
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false, failUpdate: true },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });
  assert.equal(harness.consoleErrors.length, 1);

  assert.equal(harness.storageData.lastAction, "applied_with_errors");
  assert.deepEqual(harness.storageData.updateFailures, ["Other"]);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("reconnect backoff doubles, caps alarm to one minute, and resets on open", async () => {
  const harness = createHarness();
  await settle();

  harness.sockets[0].close();
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, 1000);
  assert.deepEqual(harness.alarms[0], { name: "reconnect", config: { delayInMinutes: 1 } });

  const firstTimerId = [...harness.timers.keys()][0];
  harness.runTimer(firstTimerId);
  assert.equal(harness.sockets.length, 2);

  harness.sockets[1].onopen();
  harness.sockets[1].close();
  assert.equal([...harness.timers.values()][0].delay, 1000);
});

test("focus applications are serialized across websocket and manual apply", async () => {
  const fixture = twoGroups();
  const harness = createHarness({ ...fixture, deferFirstGroupUpdate: true });
  await settle();

  harness.sockets[0].onmessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });
  await waitFor(() => {
    assert.equal(harness.firstGroupUpdate.started, true);
  });

  let manualApplyFinished = false;
  const manualApply = harness.sendMessage({ type: "apply-current-focus" }).then(() => {
    manualApplyFinished = true;
  });
  await settle();
  assert.equal(manualApplyFinished, false);

  harness.firstGroupUpdate.resolve();
  await manualApply;

  assert.equal(manualApplyFinished, true);
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("activation failures are reported and same raw focus can retry", async () => {
  const harness = createHarness({
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false, failActivate: true },
      { id: 20, groupId: 2, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "activation_failed");
  assert.deepEqual(harness.storageData.updateFailures, ["Work"]);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);

  harness.tabState.find((tab) => tab.id === 10).failActivate = false;
  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("partial activation failure blocks group changes and remains retryable", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": "Work" } },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 2, title: "Work", collapsed: true },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 2, groupId: 2, active: false, failActivate: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "activation_failed");
  assert.deepEqual(harness.storageData.updateFailures, ["Work (window 2)"]);
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);

  harness.tabState.find((tab) => tab.id === 20).failActivate = false;
  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, false);
});

// ── AI tab grouping ────────────────────────────────────────

function ungroupedTabs() {
  return [
    { id: 10, url: "https://a.com", title: "Alpha", groupId: -1, active: false },
    { id: 11, url: "https://b.com", title: "Beta", groupId: -1, active: false },
    { id: 12, url: "https://c.com", title: "Gamma", groupId: -1, active: false },
  ];
}

// Invokes the background runtime message handler and, when `response` is given,
// injects a matching daemon reply so the in-flight request resolves.
async function driveGrouping(harness, message, response) {
  const promise = harness.messageListeners[0](message);
  await settle();
  if (response !== undefined) {
    const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
    assert.ok(sent, "a groupTabs frame was sent to the daemon");
    harness.sockets[0].onmessage({
      data: JSON.stringify({ type: "groupTabsResult", id: sent.id, ...response }),
    });
  }
  return promise;
}

test("AI preview maps daemon clusters back to tab ids and assigns distinct colors", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const result = await driveGrouping(harness, { type: "ai-group-preview" }, {
    ok: true,
    groups: [
      { topic: "Pair", tabIndices: [0, 1] },
      { topic: "Solo", tabIndices: [2] },
    ],
  });

  const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
  assert.equal(sent.schemaVersion, 1);
  assert.equal(sent.tabs.length, 3);
  assert.deepEqual(sent.tabs[0], { index: 0, title: "Alpha", url: "https://a.com" });

  assert.equal(result.ok, true);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].topic, "Pair");
  assert.equal(result.groups[0].tabs.map((tab) => tab.id).join(","), "10,11");
  assert.equal(result.groups[1].tabs[0].title, "Gamma");
  assert.notEqual(result.groups[0].color, result.groups[1].color);
  assert.ok(["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"].includes(result.groups[0].color));
});

test("AI preview sends only ungrouped, non-pinned web tabs", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1 },
      { id: 12, url: "https://c.com", title: "Pinned", groupId: -1, pinned: true },
      { id: 13, url: "about:config", title: "About", groupId: -1 },
      { id: 14, url: "https://d.com", title: "Grouped", groupId: 5 },
    ],
  });
  await settle();

  await driveGrouping(harness, { type: "ai-group-preview" }, { ok: true, groups: [{ topic: "X", tabIndices: [0, 1] }] });

  const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
  assert.deepEqual(sent.tabs.map((tab) => tab.url), ["https://a.com", "https://b.com"]);
});

test("AI preview refuses when the feature is disabled", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: false }, tabs: ungroupedTabs() });
  await settle();

  const result = await driveGrouping(harness, { type: "ai-group-preview" }, undefined);

  assert.equal(result.ok, false);
  assert.equal(result.error, "disabled");
  assert.equal(harness.sentMessages.filter((frame) => frame.type === "groupTabs").length, 0);
});

test("AI preview needs at least two groupable tabs", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [{ id: 10, url: "https://a.com", title: "Alpha", groupId: -1 }],
  });
  await settle();

  const result = await driveGrouping(harness, { type: "ai-group-preview" }, undefined);

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_enough_tabs");
  assert.equal(harness.sentMessages.filter((frame) => frame.type === "groupTabs").length, 0);
});

test("AI preview surfaces a daemon failure verbatim", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const result = await driveGrouping(harness, { type: "ai-group-preview" }, {
    ok: false,
    error: "apple_intelligence_disabled",
    message: "Turn on Apple Intelligence in System Settings.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "apple_intelligence_disabled");
  assert.match(result.message, /Apple Intelligence/);
});

test("AI preview fails cleanly when the socket drops mid-request", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const promise = harness.messageListeners[0]({ type: "ai-group-preview" });
  await settle();
  harness.sockets[0].close();
  const result = await promise;

  assert.equal(result.ok, false);
  assert.equal(result.error, "daemon_disconnected");
});

test("AI apply creates titled, colored groups via tabs.group", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const groups = [
    { topic: "Work", color: "blue", tabs: [{ id: 10 }, { id: 11 }] },
    { topic: "Play", color: "green", tabs: [{ id: 12 }] },
  ];
  const result = await harness.messageListeners[0]({ type: "ai-group-apply", groups });

  assert.equal(result.ok, true);
  assert.equal(result.applied.join(","), "Work,Play");
  assert.equal(harness.groupCreations.length, 2);
  const work = harness.groupState.find((group) => group.title === "Work");
  assert.ok(work);
  assert.equal(work.color, "blue");
  assert.equal(harness.tabState.find((tab) => tab.id === 10).groupId, work.id);
  assert.equal(harness.tabState.find((tab) => tab.id === 11).groupId, work.id);
});

test("AI apply refuses when the feature is disabled", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: false }, tabs: ungroupedTabs() });
  await settle();

  const result = await harness.messageListeners[0]({
    type: "ai-group-apply",
    groups: [{ topic: "X", color: "blue", tabs: [{ id: 10 }] }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "disabled");
  assert.equal(harness.groupCreations.length, 0);
});

test("grouping responses are not mistaken for focus updates", async () => {
  const harness = createHarness(twoGroups());
  await settle();

  harness.sockets[0].onmessage({
    data: JSON.stringify({ type: "groupTabsResult", id: "unknown", ok: true, groups: [] }),
  });
  await settle();
  assert.equal(harness.storageData.lastFocusSeen, undefined);
  assert.equal(harness.storageData.lastAction, undefined);

  await harness.context.handleMessage({ data: JSON.stringify({ focus: "com.apple.focus.work" }) });
  assert.equal(harness.storageData.lastAction, "applied");
});
