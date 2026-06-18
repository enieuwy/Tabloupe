const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

const DEFAULT_MAPPINGS = {
  "com.apple.focus.work": ["Work"],
  "com.apple.focus.personal-time": ["Personal"],
  "com.apple.donotdisturb.mode.default": ["Do Not Disturb"],
  "com.apple.sleep.sleep-mode": ["Sleep"],
  "com.apple.donotdisturb.mode.graduationcapfill": ["Study"],
  "com.apple.focus.reduce-interruptions": ["Reduce Interruptions"],
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
  failTabMessage = false,
  fetchHandler = null,
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
  const windowUpdates = [];
  const removedTabs = [];
  const tabMessages = [];
  const commandListeners = [];
  const fetchCalls = [];
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
  let nextWindowId = 100;

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
      WINDOW_ID_CURRENT: -2,
      async getCurrent() {
        return { id: currentWindowId };
      },
      async update(id, patch) {
        windowUpdates.push({ id, patch: clone(patch) });
        return { id };
      },
      async create({ tabId } = {}) {
        const id = nextWindowId;
        nextWindowId += 1;
        if (typeof tabId === "number") {
          const tab = tabState.find((candidate) => candidate.id === tabId);
          if (tab) {
            tab.windowId = id;
          }
        }
        return { id };
      },
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
      async query(query = {}) {
        return clone(groupState.filter((group) => {
          if (query.windowId !== undefined && group.windowId !== query.windowId) return false;
          return true;
        }));
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
          if (query.active !== undefined && Boolean(tab.active) !== query.active) return false;
          if (query.currentWindow === true && tabWindowId !== currentWindowId) return false;
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
      async group({ tabIds, groupId }) {
        if (typeof groupId === "number") {
          const existing = groupState.find((group) => group.id === groupId);
          assert.ok(existing, `group ${groupId} exists`);
          for (const tabId of tabIds) {
            const tab = tabState.find((candidate) => candidate.id === tabId);
            if (tab) {
              tab.groupId = groupId;
            }
          }
          groupCreations.push({ id: groupId, tabIds: clone(tabIds), merged: true });
          return groupId;
        }
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
      async remove(id) {
        const ids = Array.isArray(id) ? id : [id];
        for (const tabId of ids) {
          const index = tabState.findIndex((candidate) => candidate.id === tabId);
          if (index !== -1) tabState.splice(index, 1);
          removedTabs.push(tabId);
        }
      },
      async ungroup(ids) {
        const tabIds = Array.isArray(ids) ? ids : [ids];
        for (const tabId of tabIds) {
          const tab = tabState.find((candidate) => candidate.id === tabId);
          if (tab) {
            tab.groupId = -1;
          }
        }
      },
      async move(ids, { windowId }) {
        const tabIds = Array.isArray(ids) ? ids : [ids];
        for (const tabId of tabIds) {
          const tab = tabState.find((candidate) => candidate.id === tabId);
          if (tab) {
            tab.windowId = windowId;
          }
        }
        return clone(tabIds.map((tabId) => tabState.find((candidate) => candidate.id === tabId)).filter(Boolean));
      },
      async discard(id) {
        const tab = tabState.find((candidate) => candidate.id === id);
        assert.ok(tab, `tab ${id} exists`);
        tab.discarded = true;
        return clone(tab);
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: clone(message) });
        if (failTabMessage) {
          throw new Error("no receiver");
        }
        return undefined;
      },
    },
    commands: {
      onCommand: {
        addListener(listener) {
          commandListeners.push(listener);
        },
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

  async function fakeFetch(url, init) {
    fetchCalls.push({ url, init });
    if (typeof fetchHandler !== "function") {
      throw new Error("unexpected fetch: " + url);
    }
    return fetchHandler(url, init);
  }

  const context = {
    browser,
    console: testConsole,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    WebSocket: FakeWebSocket,
    fetch: fakeFetch,
    AbortController,
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
    fetchCalls,
    alarms,
    clearedAlarms,
    timers,
    consoleErrors,
    firstGroupUpdate,
    windowUpdates,
    removedTabs,
    tabMessages,
    commandListeners,
    async sendMessage(message) {
      for (const listener of messageListeners) {
        const result = listener(message);
        if (result && typeof result.then === "function") {
          await result;
        }
      }
    },
    async request(message) {
      for (const listener of messageListeners) {
        const result = listener(message);
        if (result !== false && result !== undefined) {
          return await result;
        }
      }
      return undefined;
    },
    async runCommand(name) {
      for (const listener of commandListeners) {
        await listener(name);
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

  const existing = createHarness({ storage: { focusMappings: { "custom-id": ["Reading"] } } });
  await settle();
  assert.deepEqual(existing.storageData.focusMappings, { "custom-id": ["Reading"] });
});

test("mapped raw Focus ID records raw diagnostics and applies mapped tab group", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");
  assert.ok(harness.storageData.seenFocusIds["com.apple.focus.work"].firstSeen > 0);
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.deepEqual(harness.storageData.expandedGroups, ["Work"]);
  assert.deepEqual(harness.storageData.collapsedGroups, ["Other"]);
});

test("focusCatalog envelope caches the id -> {name, icon, color} table", async () => {
  const harness = createHarness(twoGroups());
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({
    type: "focusCatalog",
    schemaVersion: 1,
    ts: 0,
    payload: { entries: {
      "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#c678dd" },
      "com.apple.focus.custom": { name: "Custom", icon: "target", color: null },
    } },
  }) });

  assert.deepEqual(harness.storageData.focusCatalog["com.apple.focus.work"], { name: "Work", icon: "briefcase", color: "#c678dd" });
  assert.equal(harness.storageData.focusCatalog["com.apple.focus.custom"].name, "Custom");
});

test("enriched focus object applies grouping and caches its catalog entry", async () => {
  const harness = createHarness(twoGroups());
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({
    type: "focus",
    schemaVersion: 1,
    ts: 0,
    payload: { focus: { id: "com.apple.focus.work", name: "Work", icon: "briefcase", color: "#c678dd" } },
  }) });

  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.storageData.focusCatalog["com.apple.focus.work"].name, "Work");
  const titles = harness.notifications.map((args) => (args.length === 2 ? args[1] : args[0]).title);
  assert.ok(titles.includes("Focus: Work"), `expected a "Focus: Work" notification, got ${JSON.stringify(titles)}`);
});

test("the success notification names the Focus from the cached catalog for an id-only focus", async () => {
  const harness = createHarness({
    ...twoGroups(),
    storage: {
      focusMappings: { ...DEFAULT_MAPPINGS },
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#c678dd" } },
    },
  });
  await settle();

  // The focus object carries only an id (no name); the display name must come
  // from the catalog cached by an earlier focusCatalog broadcast.
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  const titles = harness.notifications.map((args) => (args.length === 2 ? args[1] : args[0]).title);
  assert.ok(titles.includes("Focus: Work"), `expected a "Focus: Work" notification, got ${JSON.stringify(titles)}`);
});

test("null Focus expands every tab group", async () => {
  const harness = createHarness({
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: null } }) });

  assert.equal(harness.storageData.lastFocusSeen, null);
  assert.equal(harness.storageData.lastAction, "expanded_all");
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
});

test("unmapped raw Focus ID leaves groups untouched and prompts without notification buttons", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.custom" } } }) });

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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);

  await harness.browser.storage.local.set({
    focusMappings: { ...DEFAULT_MAPPINGS, "com.apple.focus.work": ["Other"] },
  });

  await waitFor(() => {
    assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
    assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
    assert.deepEqual(harness.storageData.expandedGroups, ["Other"]);
    assert.deepEqual(harness.storageData.collapsedGroups, ["Work"]);
  });
});

test("non-focus state envelopes (bluetooth/audio/etc) are ignored", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");

  // MCC multiplexes other subsystems on the same socket; they must not reset
  // focus or expand groups.
  await harness.context.handleMessage({ data: JSON.stringify({ type: "bluetooth", schemaVersion: 1, ts: 1, payload: { available: true, devices: [] } }) });

  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");
});

test("a focus mapped to multiple groups expands all of them", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work", "Research"] } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Research", collapsed: true },
      { id: 3, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: false },
      { id: 30, groupId: 3, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.groupState.find((g) => g.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((g) => g.title === "Research").collapsed, false);
  assert.equal(harness.groupState.find((g) => g.title === "Other").collapsed, true);
  assert.equal(harness.storageData.lastAction, "applied");
  assert.deepEqual([...harness.storageData.expandedGroups].sort(), ["Research", "Work"]);
  assert.deepEqual(harness.storageData.collapsedGroups, ["Other"]);
});

test("a focus mapped to an empty list is ignored, leaving groups untouched", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": [] } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "ignored");
  assert.equal(harness.groupState.find((g) => g.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((g) => g.title === "Other").collapsed, false);
});

test("non-array focus mapping entries are ignored", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": 123 } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "ignored");
  assert.equal(harness.groupState.find((g) => g.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((g) => g.title === "Other").collapsed, false);
});

test("apply-current-focus message force-reapplies last seen Focus", async () => {
  const fixture = twoGroups();
  const harness = createHarness(fixture);
  await settle();

  // First apply Work focus via WebSocket message
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
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
      focusMappings: { "com.apple.focus.custom": [] },
      unmappedFocusId: "stale",
      expandedGroups: ["stale"],
      collapsedGroups: ["stale"],
      updateFailures: ["stale"],
    },
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.custom" } } }) });

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
    storage: { focusMappings: { "com.apple.focus.missing": ["Missing"] } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.missing" } } }) });

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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "matching_group_empty");
  assert.equal(harness.storageData.emptyGroup, "Work");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("matching groups are activated in each window before other groups collapse", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 4).collapsed, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).active, true);
});

test("focus change keeps an ungrouped active tab (options page) in the foreground", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: false },
      { id: 99, windowId: 1, groupId: -1, active: true },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 99).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, false);
  assert.equal(harness.tabUpdates.some((entry) => entry.patch.active === true), false);
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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
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

  harness.sockets[0].onmessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "activation_failed");
  assert.deepEqual(harness.storageData.updateFailures, ["Work"]);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);

  harness.tabState.find((tab) => tab.id === 10).failActivate = false;
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("partial activation failure blocks group changes and remains retryable", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "activation_failed");
  assert.deepEqual(harness.storageData.updateFailures, ["Work (window 2)"]);
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);

  harness.tabState.find((tab) => tab.id === 20).failActivate = false;
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
  assert.equal(harness.storageData.lastAction, "applied");
});

test("AI preview rejects with grouping_timeout when the daemon never replies", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const promise = harness.messageListeners[0]({ type: "ai-group-preview" });
  await settle();
  const entry = [...harness.timers.entries()].find(([, timer]) => timer.delay === 120000);
  assert.ok(entry, "grouping timeout timer scheduled");
  harness.runTimer(entry[0]);
  const result = await promise;

  assert.equal(result.ok, false);
  assert.equal(result.error, "grouping_timeout");
});

test("AI preview drops out-of-range and cross-group duplicate indices", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: true }, tabs: ungroupedTabs() });
  await settle();

  const result = await driveGrouping(harness, { type: "ai-group-preview" }, {
    ok: true,
    groups: [
      { topic: "A", tabIndices: [0, 0, 99] },
      { topic: "B", tabIndices: [0, 1] },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].tabs.map((tab) => tab.id).join(","), "10");
  assert.equal(result.groups[1].tabs.map((tab) => tab.id).join(","), "11");
});

test("AI apply skips tabs that became ungroupable after preview", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1 },
    ],
  });
  await settle();

  harness.tabState.find((tab) => tab.id === 11).pinned = true; // pinned after preview
  const groups = [{ topic: "Work", color: "blue", tabs: [{ id: 10 }, { id: 11 }] }];
  const result = await harness.messageListeners[0]({ type: "ai-group-apply", groups });

  assert.equal(result.ok, true);
  assert.equal(harness.groupCreations.length, 1);
  assert.equal(harness.groupCreations[0].tabIds.join(","), "10");
});

test("ai-group-state reports enabled flag, groupable count, and no initial proposal", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1, windowId: 3 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1, windowId: 3 },
      { id: 12, url: "about:config", title: "C", groupId: -1, windowId: 3 },
    ],
  });
  await settle();

  const state = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 3 });
  assert.equal(state.enabled, true);
  assert.equal(state.groupableCount, 2); // about: page excluded
  assert.equal(state.proposal, null);
});

test("preview caches the proposal per window and apply clears it", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1, windowId: 5 },
    ],
  });
  await settle();

  const preview = await driveGrouping(harness, { type: "ai-group-preview", windowId: 5 }, {
    ok: true,
    groups: [{ topic: "T", tabIndices: [0, 1] }],
  });
  assert.equal(preview.ok, true);

  // The proposal is now cached for window 5...
  const cached = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 5 });
  assert.ok(cached.proposal);
  assert.equal(cached.proposal[0].topic, "T");

  // ...but not for a different window.
  const other = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 9 });
  assert.equal(other.proposal, null);

  // Applying clears the cache for that window.
  const apply = await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 5, groups: cached.proposal });
  assert.equal(apply.ok, true);
  const afterApply = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 5 });
  assert.equal(afterApply.proposal, null);
});

test("ai-group-clear drops the cached proposal", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1, windowId: 5 },
    ],
  });
  await settle();

  await driveGrouping(harness, { type: "ai-group-preview", windowId: 5 }, {
    ok: true,
    groups: [{ topic: "T", tabIndices: [0, 1] }],
  });
  const cleared = await harness.messageListeners[0]({ type: "ai-group-clear", windowId: 5 });
  assert.equal(cleared.ok, true);

  const state = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 5 });
  assert.equal(state.proposal, null);
});

test("preview targets the requested window only", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1, windowId: 5 },
      { id: 20, url: "https://c.com", title: "C", groupId: -1, windowId: 6 },
    ],
  });
  await settle();

  await driveGrouping(harness, { type: "ai-group-preview", windowId: 5 }, {
    ok: true,
    groups: [{ topic: "T", tabIndices: [0, 1] }],
  });
  const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
  assert.deepEqual(sent.tabs.map((tab) => tab.url), ["https://a.com", "https://b.com"]);
});

test("tabsearch-list returns tabs with current window first and title fallback", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 10, windowId: 2, title: "GitHub", url: "https://github.com", active: false, groupId: 3 },
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true, pinned: true, groupId: -1 },
      { id: 30, windowId: 1, title: "", url: "https://example.com", active: false },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-list" });

  assert.deepEqual(list.map((tab) => tab.id), [20, 30, 10]);
  const docs = list.find((tab) => tab.id === 20);
  assert.equal(docs.currentWindow, true);
  assert.equal(docs.active, true);
  assert.equal(list.find((tab) => tab.id === 30).title, "https://example.com");
  assert.equal(list.find((tab) => tab.id === 10).currentWindow, false);
  assert.equal(docs.pinned, true);
  assert.equal(docs.grouped, false);
  assert.equal(list.find((tab) => tab.id === 10).grouped, true);
});

test("tabsearch-list includes Firefox tab group context", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    groups: [
      { id: 7, title: "Release Train", color: "purple" },
      { id: 8, title: "Empty", color: "green" },
    ],
    tabs: [
      { id: 20, windowId: 1, title: "Issue", url: "https://tracker.example.com", active: false, groupId: 7 },
      { id: 30, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true, groupId: -1 },
      { id: 40, windowId: 1, title: "Unknown", url: "https://unknown.example.com", active: false, groupId: 99 },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-list" });

  assert.deepEqual(
    list.map((tab) => ({ id: tab.id, groupTitle: tab.groupTitle, groupColor: tab.groupColor, grouped: tab.grouped })),
    [
      { id: 20, groupTitle: "Release Train", groupColor: "purple", grouped: true },
      { id: 30, groupTitle: "", groupColor: "", grouped: false },
      { id: 40, groupTitle: "", groupColor: "", grouped: true },
    ],
  );
});

test("tabsearch-activate focuses the window then activates the tab", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 10, windowId: 2, title: "GitHub", url: "https://github.com", active: false },
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
    ],
  });
  await settle();

  const result = await harness.request({ type: "tabsearch-activate", tabId: 10, windowId: 2 });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.windowUpdates, [{ id: 2, patch: { focused: true } }]);
  assert.ok(harness.tabUpdates.some((entry) => entry.id === 10 && entry.patch.active === true));
});

test("tabsearch-close removes the tab and returns the refreshed list", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-close", tabId: 30 });

  assert.deepEqual(harness.removedTabs, [30]);
  assert.deepEqual(list.map((tab) => tab.id), [20]);
});

test("tabsearch-close-many removes all listed tabs and returns the refreshed list", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false },
      { id: 40, windowId: 1, title: "Other", url: "https://other.example.com", active: false },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-close-many", tabIds: [30, "nope", 40] });

  assert.deepEqual(harness.removedTabs, [30, 40]);
  assert.deepEqual(list.map((tab) => tab.id), [20]);
});

test("tabsearch-group creates a titled group and merges into an existing same-title group", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    groups: [{ id: 7, windowId: 1, title: "Work", color: "purple" }],
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true, groupId: -1 },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false, groupId: -1 },
      { id: 40, windowId: 1, title: "Other", url: "https://other.example.com", active: false, groupId: -1 },
    ],
  });
  await settle();

  const created = await harness.request({ type: "tabsearch-group", tabIds: [20, 30], title: " Research ", windowId: 1 });
  assert.equal(created.ok, true);
  const research = harness.groupState.find((group) => group.title === "Research");
  assert.ok(research);
  assert.equal(research.color, "cyan");
  assert.equal(harness.tabState.find((tab) => tab.id === 20).groupId, research.id);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).groupId, research.id);

  const merged = await harness.request({ type: "tabsearch-group", tabIds: [40], title: "Work", windowId: 1 });
  assert.equal(merged.ok, true);
  assert.equal(harness.groupState.filter((group) => group.title === "Work").length, 1);
  assert.equal(harness.tabState.find((tab) => tab.id === 40).groupId, 7);
});

test("tabsearch-group refuses an empty group title", async () => {
  const harness = createHarness({
    tabs: [{ id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", groupId: -1 }],
  });
  await settle();

  const result = await harness.request({ type: "tabsearch-group", tabIds: [20], title: "   ", windowId: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.error, "no_title");
  assert.equal(harness.groupCreations.length, 0);
});

test("tabsearch-ungroup clears group ids and returns the refreshed list", async () => {
  const harness = createHarness({
    groups: [{ id: 7, windowId: 1, title: "Work", color: "purple" }],
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true, groupId: 7 },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false, groupId: 7 },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-ungroup", tabIds: [20, 30] });

  assert.equal(harness.tabState.find((tab) => tab.id === 20).groupId, -1);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).groupId, -1);
  assert.deepEqual(list.map((tab) => tab.grouped), [false, false]);
});

test("tabsearch-move-new-window moves selected tabs into a new window", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false },
    ],
  });
  await settle();

  const list = await harness.request({ type: "tabsearch-move-new-window", tabIds: [20, 30] });

  assert.equal(harness.tabState.find((tab) => tab.id === 20).windowId, 100);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).windowId, 100);
  assert.deepEqual(list.map((tab) => tab.windowId), [100, 100]);
});

test("tabsearch-set-pinned toggles pinned state", async () => {
  const harness = createHarness({
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true, pinned: false },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false, pinned: false },
    ],
  });
  await settle();

  let list = await harness.request({ type: "tabsearch-set-pinned", tabIds: [20, 30], pinned: true });
  assert.deepEqual(list.map((tab) => tab.pinned), [true, true]);
  list = await harness.request({ type: "tabsearch-set-pinned", tabIds: [20], pinned: false });
  assert.equal(list.find((tab) => tab.id === 20).pinned, false);
  assert.equal(list.find((tab) => tab.id === 30).pinned, true);
});

test("tabsearch-discard marks selected tabs discarded", async () => {
  const harness = createHarness({
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false },
    ],
  });
  await settle();

  await harness.request({ type: "tabsearch-discard", tabIds: [20, 30] });

  assert.equal(harness.tabState.find((tab) => tab.id === 20).discarded, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).discarded, true);
});

test("tabsearch-ai-preview clusters the selected tab subset", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1, windowId: 5 },
      { id: 12, url: "https://c.com", title: "Gamma", groupId: -1, windowId: 5 },
    ],
  });
  await settle();

  const result = await driveGrouping(harness, { type: "tabsearch-ai-preview", windowId: 5, tabIds: [10, 12] }, {
    ok: true,
    groups: [{ topic: "Pair", tabIndices: [0, 1] }],
  });

  const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
  assert.deepEqual(sent.tabs.map((tab) => tab.url), ["https://a.com", "https://c.com"]);
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].topic, "Pair");
  assert.equal(result.groups[0].color, "blue");
  assert.equal(result.groups[0].tabs.map((tab) => tab.id).join(","), "10,12");
  assert.equal(result.groups[0].tabs.map((tab) => tab.title).join(","), "Alpha,Gamma");
});

test("tabsearch-ai-preview with no selected ids clusters all groupable tabs in the window", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1, windowId: 5 },
      { id: 12, url: "https://c.com", title: "Other window", groupId: -1, windowId: 6 },
    ],
  });
  await settle();

  const result = await driveGrouping(harness, { type: "tabsearch-ai-preview", windowId: 5, tabIds: [] }, {
    ok: true,
    groups: [{ topic: "Pair", tabIndices: [0, 1] }],
  });

  const sent = harness.sentMessages.find((frame) => frame.type === "groupTabs");
  assert.equal(sent.tabs.map((tab) => tab.url).join(","), "https://a.com,https://b.com");
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].tabs.map((tab) => tab.id).join(","), "10,11");
});

test("tabsearch-ai-preview refuses when disabled", async () => {
  const harness = createHarness({ storage: { aiGroupingEnabled: false }, tabs: ungroupedTabs() });
  await settle();

  const result = await harness.request({ type: "tabsearch-ai-preview", windowId: 1, tabIds: [10, 11] });

  assert.equal(result.ok, false);
  assert.equal(result.error, "disabled");
  assert.equal(harness.sentMessages.filter((frame) => frame.type === "groupTabs").length, 0);
});

test("tabsearch-ai-preview needs at least two selected candidates", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1, windowId: 5 },
      { id: 11, url: "https://b.com", title: "Pinned", groupId: -1, pinned: true, windowId: 5 },
    ],
  });
  await settle();

  const result = await harness.request({ type: "tabsearch-ai-preview", windowId: 5, tabIds: [10, 11] });

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_enough_tabs");
  assert.equal(result.message, "Select at least 2 ungrouped tabs to organize.");
  assert.equal(harness.sentMessages.filter((frame) => frame.type === "groupTabs").length, 0);
});

test("search-tabs command relays open to the active tab", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", active: true },
      { id: 30, windowId: 1, title: "Example", url: "https://example.com", active: false },
    ],
  });
  await settle();

  await harness.runCommand("search-tabs");
  await settle();

  assert.deepEqual(harness.tabMessages, [{ tabId: 20, message: { type: "tabsearch-open" } }]);
  assert.equal(harness.notifications.length, 0);
});

test("search-tabs command notifies when the page has no content script", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    failTabMessage: true,
    tabs: [{ id: 20, windowId: 1, title: "Privileged", url: "about:addons", active: true }],
  });
  await settle();

  await harness.runCommand("search-tabs");
  await settle();

  const fired = harness.notifications.map((args) => (args.length === 2 ? args[1] : args[0]));
  assert.ok(fired.some((options) => options.title === "Tab Search"));
});

function chatCompletion(groups, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return { choices: [{ message: { content: JSON.stringify({ groups }) } }] };
    },
    async text() {
      return "";
    },
  };
}

test("custom provider routes preview through fetch, not the daemon", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1 },
    ],
    fetchHandler: async () => chatCompletion([{ topic: "Pair", tabIndices: [0, 1] }]),
  });
  await settle();

  const result = await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.groups[0].topic, "Pair");
  assert.equal(result.groups[0].tabs.map((tab) => tab.id).join(","), "10,11");
  // Went via fetch, never touched the daemon WS.
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.sentMessages.filter((m) => m.type === "groupTabs").length, 0);
  const call = harness.fetchCalls[0];
  assert.equal(call.url, "https://api.example.com/v1/chat/completions");
  assert.equal(call.init.headers.Authorization, "Bearer sk-1");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "m1");
  assert.equal(body.messages.length, 2);
});


test("custom provider appends saved instructions to the system prompt", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
      aiGroupingCustomInstructions: "Use emojis in group titles.",
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1 },
    ],
    fetchHandler: async () => chatCompletion([{ topic: "🧪 Lab", tabIndices: [0, 1] }]),
  });
  await settle();

  const result = await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });
  assert.equal(result.ok, true);
  const body = JSON.parse(harness.fetchCalls[0].init.body);
  assert.match(body.messages[0].content, /Additional user instructions:/);
  assert.match(body.messages[0].content, /Use emojis in group titles/);
});

test("custom instructions longer than 500 characters are truncated", async () => {
  const long = "x".repeat(600);
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
      aiGroupingCustomInstructions: long,
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1 },
    ],
    fetchHandler: async () => chatCompletion([{ topic: "Pair", tabIndices: [0, 1] }]),
  });
  await settle();

  await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });
  const body = JSON.parse(harness.fetchCalls[0].init.body);
  const extra = body.messages[0].content.split("Additional user instructions:\n")[1];
  assert.equal(extra.length, 500);
});

test("foundation preview forwards custom instructions to the daemon when set", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiGroupingCustomInstructions: "Group by top-level domain.",
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1 },
    ],
  });
  await settle();

  await driveGrouping(harness, { type: "ai-group-preview", windowId: 1 }, {
    ok: true,
    groups: [{ topic: "Domains", tabIndices: [0, 1] }],
  });
  const sent = harness.sentMessages.find((m) => m.type === "groupTabs");
  assert.ok(sent);
  assert.equal(sent.instructions, "Group by top-level domain.");
});

test("custom provider parses fenced JSON content", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://x.com/v1", model: "m", apiKey: "k" },
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1 },
    ],
    fetchHandler: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "```json\n{\"groups\":[{\"topic\":\"X\",\"tabIndices\":[0,1]}]}\n```" } }] };
      },
    }),
  });
  await settle();

  const result = await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].topic, "X");
});

test("custom provider surfaces an HTTP error", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m", apiKey: "k" },
    },
    tabs: [
      { id: 10, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, url: "https://b.com", title: "B", groupId: -1 },
    ],
    fetchHandler: async () => ({ ok: false, status: 401, async json() { return {}; }, async text() { return "no"; } }),
  });
  await settle();

  const result = await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "cloud_http_401");
  assert.match(result.message, /API key/);
});

test("ai-group-state reports the active provider kind", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://x.com/v1", model: "m", apiKey: "" },
    },
    tabs: [{ id: 10, url: "https://a.com", title: "A", groupId: -1 }],
  });
  await settle();

  const state = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 1 });
  assert.equal(state.providerKind, "custom");
});

test("activation preserves an ungrouped active tab while still collapsing others", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: false },
      { id: 99, windowId: 1, groupId: -1, active: true }, // e.g. the options page
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  // The ungrouped active tab is never displaced...
  assert.equal(harness.tabState.find((tab) => tab.id === 99).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, false);
  // ...yet Work expands and Other collapses.
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
});

test("concurrent AI previews for one window collapse into a single daemon request", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    tabs: [
      { id: 10, url: "https://a.com", title: "Alpha", groupId: -1, windowId: 7 },
      { id: 11, url: "https://b.com", title: "Beta", groupId: -1, windowId: 7 },
    ],
  });
  await settle();

  const first = harness.messageListeners[0]({ type: "ai-group-preview", windowId: 7 });
  const second = harness.messageListeners[0]({ type: "ai-group-preview", windowId: 7 });
  await settle();

  const frames = harness.sentMessages.filter((frame) => frame.type === "groupTabs");
  assert.equal(frames.length, 1, "duplicate previews share one in-flight daemon request");

  harness.sockets[0].onmessage({
    data: JSON.stringify({ type: "groupTabsResult", id: frames[0].id, ok: true, groups: [{ topic: "T", tabIndices: [0, 1] }] }),
  });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.ok, true);
  assert.equal(r2, r1, "both callers resolve to the same proposal object");
  assert.equal(r1.groups[0].topic, "T");

  // The in-flight slot frees once the request settles, so a later preview re-runs.
  const third = harness.messageListeners[0]({ type: "ai-group-preview", windowId: 7 });
  await settle();
  const frames2 = harness.sentMessages.filter((frame) => frame.type === "groupTabs");
  assert.equal(frames2.length, 2, "a later preview opens a fresh request once the slot clears");
  harness.sockets[0].onmessage({
    data: JSON.stringify({ type: "groupTabsResult", id: frames2[1].id, ok: true, groups: [{ topic: "T2", tabIndices: [0, 1] }] }),
  });
  const r3 = await third;
  assert.equal(r3.ok, true);
  assert.equal(r3.groups[0].topic, "T2");
});

test("applied notification truncates a long collapsed-group list but storage keeps all", async () => {
  const groups = [{ id: 1, windowId: 1, title: "Work", collapsed: true }];
  const tabs = [{ id: 100, windowId: 1, groupId: 1, active: false }];
  for (let i = 2; i <= 30; i += 1) {
    groups.push({ id: i, windowId: 1, title: `G${i}`, collapsed: false });
    tabs.push({ id: 100 + i, windowId: 1, groupId: i, active: false });
  }
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
    groups,
    tabs,
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  const applied = harness.notifications
    .map((args) => (args.length === 2 ? args[1] : args[0]))
    .find((options) => typeof options.message === "string" && options.message.startsWith("Expanded:"));
  assert.ok(applied, "an applied notification was emitted");
  // 29 collapsed groups: 12 shown, 17 summarized — the body stays bounded.
  assert.match(applied.message, /Expanded: Work/);
  assert.match(applied.message, /\(\+17 more\)/);
  assert.ok(!applied.message.includes("G30"), "overflow titles are omitted from the notification");
  // Diagnostics in storage are NOT truncated — the options page needs the full lists.
  assert.equal(harness.storageData.collapsedGroups.length, 29);
  assert.ok(harness.storageData.collapsedGroups.includes("G30"));
});

test("a glob mapping expands every tab group whose title matches", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work*"] } },
    groups: [
      { id: 1, windowId: 1, title: "Work — JIRA", collapsed: true },
      { id: 2, windowId: 1, title: "Workspace", collapsed: true },
      { id: 3, windowId: 1, title: "Personal", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: false },
      { id: 30, windowId: 1, groupId: 3, active: false },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((g) => g.id === 1).collapsed, false); // Work — JIRA matches Work*
  assert.equal(harness.groupState.find((g) => g.id === 2).collapsed, false); // Workspace matches Work*
  assert.equal(harness.groupState.find((g) => g.id === 3).collapsed, true);  // Personal does not
  assert.deepEqual([...harness.storageData.expandedGroups].sort(), ["Work — JIRA", "Workspace"]);
});

test("? glob matches a single character and combines with exact titles", async () => {
  const harness = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Exact", "Doc?"] } },
    groups: [
      { id: 1, windowId: 1, title: "Exact", collapsed: true },
      { id: 2, windowId: 1, title: "Docs", collapsed: true },
      { id: 3, windowId: 1, title: "Doc", collapsed: false },
      { id: 4, windowId: 1, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: false },
      { id: 30, windowId: 1, groupId: 3, active: false },
      { id: 40, windowId: 1, groupId: 4, active: false },
    ],
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.groupState.find((g) => g.id === 1).collapsed, false); // Exact (literal)
  assert.equal(harness.groupState.find((g) => g.id === 2).collapsed, false); // Docs matches Doc?
  assert.equal(harness.groupState.find((g) => g.id === 3).collapsed, true);  // Doc has no trailing char
  assert.equal(harness.groupState.find((g) => g.id === 4).collapsed, true);  // Other
});

test("AI apply merges into an existing same-named group instead of duplicating", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: true },
    groups: [{ id: 5, windowId: 1, title: "Research", collapsed: false }],
    tabs: [
      { id: 1, windowId: 1, groupId: 5, url: "https://r0.com", title: "R0" }, // existing member
      { id: 10, windowId: 1, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, windowId: 1, url: "https://b.com", title: "B", groupId: -1 },
    ],
  });
  await settle();

  const groups = [
    { topic: "Research", color: "blue", tabs: [{ id: 10 }] },
    { topic: "News", color: "green", tabs: [{ id: 11 }] },
  ];
  const result = await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 1, groups });

  assert.equal(result.ok, true);
  // Tab 10 joined the existing Research group (id 5), not a fresh duplicate.
  assert.equal(harness.tabState.find((t) => t.id === 10).groupId, 5);
  assert.equal(harness.groupState.filter((g) => g.title === "Research").length, 1);
  // News is a brand-new group.
  const news = harness.groupState.find((g) => g.title === "News");
  assert.ok(news);
  assert.equal(harness.tabState.find((t) => t.id === 11).groupId, news.id);
});

test("AI apply pins new group topics to the active Focus when opted in", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiPinToFocus: true,
      lastFocusSeen: "com.apple.focus.work",
      focusMappings: { "com.apple.focus.work": ["Existing"] },
    },
    tabs: [
      { id: 10, windowId: 1, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, windowId: 1, url: "https://b.com", title: "B", groupId: -1 },
    ],
  });
  await settle();

  const groups = [{ topic: "Work Docs", color: "blue", tabs: [{ id: 10 }, { id: 11 }] }];
  const result = await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 1, groups });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.storageData.focusMappings["com.apple.focus.work"], ["Existing", "Work Docs"]);
});

test("AI apply leaves focus mappings untouched when pinning is off", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      lastFocusSeen: "com.apple.focus.work",
      focusMappings: { "com.apple.focus.work": ["Existing"] },
    },
    tabs: [
      { id: 10, windowId: 1, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, windowId: 1, url: "https://b.com", title: "B", groupId: -1 },
    ],
  });
  await settle();

  await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 1, groups: [{ topic: "Work Docs", color: "blue", tabs: [{ id: 10 }, { id: 11 }] }] });
  assert.deepEqual(harness.storageData.focusMappings["com.apple.focus.work"], ["Existing"]);
});

test("ai-group-state reports pin preference and the active Focus name", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiPinToFocus: true,
      lastFocusSeen: "com.apple.focus.work",
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#c678dd" } },
    },
    tabs: [{ id: 10, url: "https://a.com", title: "A", groupId: -1, windowId: 1 }],
  });
  await settle();

  const state = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 1 });
  assert.equal(state.pinToFocus, true);
  assert.equal(state.activeFocus, "Work");
});

test("tabsearch-move joins the target group and ungroups when dropped outside one", async () => {
  const harness = createHarness({
    storage: {},
    groups: [{ id: 9, windowId: 1, title: "G", color: "blue", collapsed: false }],
    tabs: [
      { id: 1, windowId: 1, index: 0, url: "https://a.com", title: "A", active: true },
      { id: 2, windowId: 1, index: 1, url: "https://b.com", title: "B", groupId: 9 },
      { id: 3, windowId: 1, index: 2, url: "https://c.com", title: "C", groupId: 9 },
    ],
  });
  await settle();

  // Drop the ungrouped tab 1 between the two members of group 9 -> joins it.
  await harness.messageListeners[0]({ type: "tabsearch-move", tabIds: [1], windowId: 1, anchorId: 2, placeAfter: true, groupId: 9 });
  assert.equal(harness.tabState.find((tab) => tab.id === 1).groupId, 9);

  // Drop the grouped tab 3 before the ungrouped tab 1 -> leaves the group.
  await harness.messageListeners[0]({ type: "tabsearch-move", tabIds: [3], windowId: 1, anchorId: 1, placeAfter: false, groupId: -1 });
  assert.equal(harness.tabState.find((tab) => tab.id === 3).groupId, -1);
});
