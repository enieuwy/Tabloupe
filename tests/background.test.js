const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

const LEGACY_KEY = "focus" + "Mappings";

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
  history = [],
  failSearch = false,
  noHistoryApi = false,
  noSearchApi = false,
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
  const tabCreations = [];
  const tabMessages = [];
  const commandListeners = [];
  const tabCreatedListeners = [];
  const tabUpdatedListeners = [];
  const fetchCalls = [];
  const historySearches = [];
  const searchQueries = [];
  let historyResults = history;
  const timers = new Map();
  const consoleErrors = [];
  const consoleWarnings = [];
  const browserActionState = {
    badgeText: "",
    badgeBackgroundColor: null,
    title: "",
  };
  const browserActionCalls = [];
  const testConsole = {
    ...console,
    error(...args) {
      consoleErrors.push(args);
    },
    warn(...args) {
      consoleWarnings.push(args);
    },
  };
  const firstGroupUpdate = deferFirstGroupUpdate ? deferred() : null;
  let nextTimerId = 1;
  let nextWindowId = 100;

  const browser = {
    browserAction: {
      async setBadgeText({ text }) {
        browserActionState.badgeText = text;
        browserActionCalls.push({ method: "setBadgeText", text });
      },
      async setBadgeBackgroundColor({ color }) {
        browserActionState.badgeBackgroundColor = color;
        browserActionCalls.push({ method: "setBadgeBackgroundColor", color });
      },
      async setTitle({ title }) {
        browserActionState.title = title;
        browserActionCalls.push({ method: "setTitle", title });
      },
    },
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
      getURL: (path = "") => `moz-extension://tab-lens/${path}`,
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
      async create(props) {
        tabCreations.push(clone(props));
        return { id: 999, ...props };
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
      onCreated: { addListener: (listener) => tabCreatedListeners.push(listener) },
      onUpdated: { addListener: (listener) => tabUpdatedListeners.push(listener) },
    },
    commands: {
      onCommand: {
        addListener(listener) {
          commandListeners.push(listener);
        },
      },
    },
  };

  if (!noHistoryApi) {
    browser.history = {
      async search(query) {
        historySearches.push(clone(query));
        return historyResults;
      },
    };
  }

  if (!noSearchApi) {
    browser.search = {
      async query(props) {
        searchQueries.push(clone(props));
        if (failSearch) throw new Error("no engine");
      },
    };
  }

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
    URL,
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
    consoleWarnings,
    firstGroupUpdate,
    windowUpdates,
    removedTabs,
    tabCreations,
    tabMessages,
    historySearches,
    searchQueries,
    commandListeners,
    tabCreatedListeners,
    tabUpdatedListeners,
    browserActionState,
    browserActionCalls,
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
    async fireTabCreated(tab) {
      for (const listener of tabCreatedListeners) {
        await listener(tab);
      }
    },
    async fireTabUpdated(tabId, changeInfo, tab) {
      for (const listener of tabUpdatedListeners) {
        await listener(tabId, changeInfo, tab);
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

function lens(id, name, selectors, appleFocusIds = []) {
  return {
    id,
    name,
    icon: "target",
    color: null,
    groupSelectors: selectors,
    triggers: { appleFocusIds },
    createdAt: 1,
    updatedAt: 1,
  };
}

test("badge error indicator takes priority and clears back to focus badge", async () => {
  const harness = createHarness();
  await settle();

  await harness.context.setFocusBadge({ text: "W", color: "#00C853", title: "Focus: Work" });
  assert.equal(harness.browserActionState.badgeText, "W");
  assert.equal(harness.browserActionState.badgeBackgroundColor, "#00C853");
  assert.equal(harness.browserActionState.title, "Focus: Work");

  await harness.context.setLastError("cloud_http_401", "Provider returned HTTP 401. Check your API key.");
  assert.equal(harness.browserActionState.badgeText, "!");
  assert.equal(harness.browserActionState.badgeBackgroundColor, "#B71C1C");
  assert.match(harness.browserActionState.title, /Provider returned HTTP 401\. Check your API key\./);

  await harness.context.clearLastError();
  assert.equal(harness.browserActionState.badgeText, "W");
  assert.equal(harness.browserActionState.badgeBackgroundColor, "#00C853");
  assert.equal(harness.browserActionState.title, "Focus: Work");
});

test("connection state tracks websocket open and close", async () => {
  const harness = createHarness();
  await settle();
  assert.equal(harness.storageData.connectionState, "reconnecting");

  harness.sockets[0].onopen();
  await settle();
  assert.equal(harness.storageData.connectionState, "connected");

  harness.sockets[0].close();
  await settle();
  assert.equal(harness.storageData.connectionState, "reconnecting");
});

test("AI grouping failure persists lastError and next success clears it", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: {
        kind: "custom",
        baseURL: "https://provider.example/v1",
        model: "test-model",
        apiKey: "secret",
      },
    },
    tabs: ungroupedTabs(),
    fetchHandler: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "{\"groups\":[{\"topic\":\"Pair\",\"tabIndices\":[0,1]}]}" } }] };
        },
      };
    },
  });
  await settle();

  const failure = await harness.messageListeners[0]({ type: "ai-group-preview" });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "cloud_http_401");
  assert.equal(harness.storageData.lastError.code, "cloud_http_401");
  assert.equal(harness.storageData.lastError.message, "Provider returned HTTP 401. Check your API key.");
  assert.equal(harness.storageData.lastError.source, "ai");
  assert.equal(typeof harness.storageData.lastError.at, "number");

  const success = await harness.messageListeners[0]({ type: "ai-group-preview" });
  assert.equal(success.ok, true);
  assert.equal(harness.storageData.lastError, null);
});

test("fresh install leaves lenses empty and does not seed phantom defaults", async () => {
  const harness = createHarness();
  await settle();

  assert.equal(harness.storageData.lenses, undefined);
  assert.equal(harness.storageData[LEGACY_KEY], undefined);
  assert.equal(harness.storageData.schemaVersion, undefined);
});

test("upgrade migration imports legacy entries as lenses and is idempotent", async () => {
  const storage = {
    [LEGACY_KEY]: {
      "com.apple.focus.work": ["Work", "Docs*"],
      "com.apple.focus.deep-work": ["Docs*", "Work"],
      "com.apple.focus.personal": ["Personal"],
      "com.apple.focus.ignored": [],
    },
    focusCatalog: {
      "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" },
      "com.apple.focus.personal": { name: "Personal", icon: "home", color: null },
    },
  };
  const harness = createHarness({ storage });
  await settle();

  assert.equal(harness.storageData.schemaVersion, 2);
  assert.deepEqual(harness.storageData.legacyFocusMappingsBackup, storage[LEGACY_KEY]);
  assert.deepEqual(harness.storageData.ignoredAppleFocusIds, ["com.apple.focus.ignored"]);
  assert.equal(harness.storageData.lenses.length, 2);

  const work = harness.storageData.lenses.find((entry) => entry.name === "Work");
  assert.ok(work.id.startsWith("lens_"));
  assert.deepEqual(work.groupSelectors, [
    { type: "title", value: "Work" },
    { type: "glob", value: "Docs*" },
  ]);
  assert.deepEqual([...work.triggers.appleFocusIds].sort(), ["com.apple.focus.deep-work", "com.apple.focus.work"]);
  assert.deepEqual([...work.migratedFrom.focusIds].sort(), ["com.apple.focus.deep-work", "com.apple.focus.work"]);
  assert.equal(work.icon, "briefcase");
  assert.equal(work.color, "#3366ff");

  const personal = harness.storageData.lenses.find((entry) => entry.name === "Personal");
  assert.deepEqual(personal.groupSelectors, [{ type: "title", value: "Personal" }]);
  const snapshot = JSON.stringify(harness.storageData);
  await harness.context.migrateToLensesV2();
  assert.equal(JSON.stringify(harness.storageData), snapshot);
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

test("lens-activate expands matching groups, collapses non-matches, and persists the active lens", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  const result = await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(result.ok, true);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_work" });
  assert.equal(harness.storageData.lastActivation.trigger, "manual");
  assert.deepEqual(harness.storageData.expandedGroups, ["Work"]);
  assert.deepEqual(harness.storageData.collapsedGroups, ["Other"]);
  assert.ok(harness.tabUpdates.some((entry) => entry.id === 10 && entry.patch.active === true));
});

test("lens-activate all expands all groups and persists the all view", async () => {
  const harness = createHarness({
    storage: { activeView: { kind: "lens", lensId: "lens_work" } },
    groups: [
      { id: 1, title: "Work", collapsed: true },
      { id: 2, title: "Other", collapsed: true },
    ],
  });
  await settle();

  const result = await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "all" } });

  assert.equal(result.ok, true);
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
  assert.deepEqual(harness.storageData.activeView, { kind: "all" });
  assert.equal(harness.storageData.lastAction, "expanded_all");
});

test("transient activation is scoped to the window and does not change persisted activeView", async () => {
  const harness = createHarness({
    storage: { activeView: { kind: "lens", lensId: "lens_work" } },
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

  await harness.request({
    type: "lens-activate",
    windowId: 1,
    view: { kind: "transient", label: "Work only", selectors: [{ type: "title", value: "Work" }] },
  });

  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_work" });
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 4).collapsed, false);

  const state1 = await harness.request({ type: "lens-state", windowId: 1 });
  const state2 = await harness.request({ type: "lens-state", windowId: 2 });
  assert.equal(state1.activeView.kind, "transient");
  assert.deepEqual(state2.activeView, { kind: "lens", lensId: "lens_work" });
});

test("Apple Focus envelope activates the bound lens and records detected modes", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"])] },
    ...twoGroups(),
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({
    type: "focus",
    schemaVersion: 1,
    ts: 0,
    payload: { focus: { id: "com.apple.focus.work", name: "Work", icon: "briefcase", color: "#c678dd" } },
  }) });

  assert.equal(harness.storageData.lastFocusSeen, "com.apple.focus.work");
  assert.ok(harness.storageData.seenFocusIds["com.apple.focus.work"].firstSeen > 0);
  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_work" });
  assert.equal(harness.storageData.lastActivation.trigger, "appleFocus");
  assert.equal(harness.storageData.focusCatalog["com.apple.focus.work"].name, "Work");
});

test("same-id Apple Focus rebroadcast after manual activation is a no-op", async () => {
  const harness = createHarness({
    storage: {
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"]),
        lens("lens_other", "Other", [{ type: "title", value: "Other" }]),
      ],
    },
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
  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_other" } });
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 1, payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_other" });
});

test("Apple Focus off returns to fallback only while automation owns the view", async () => {
  const harness = createHarness({
    storage: {
      automationFallback: { kind: "lens", lensId: "lens_other" },
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"]),
        lens("lens_other", "Other", [{ type: "title", value: "Other" }]),
      ],
    },
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
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 1, payload: { focus: null } }) });
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_other" });
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 2, payload: { focus: { id: "com.apple.focus.work" } } }) });
  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "all" } });
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 3, payload: { focus: null } }) });
  assert.deepEqual(harness.storageData.activeView, { kind: "all" });
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
});

test("unbound Apple Focus leaves groups untouched and prompts to bind in options", async () => {
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
  assert.match(harness.notifications[0][1].message, /bind it to a lens/);
});

test("lens-state returns multi-lens savedIn annotations and feature flags", async () => {
  const harness = createHarness({
    storage: {
      activeView: { kind: "lens", lensId: "lens_work" },
      aiGroupingEnabled: true,
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"]),
        lens("lens_client", "Client", [{ type: "glob", value: "Work*" }]),
      ],
    },
    groups: [
      { id: 1, windowId: 7, title: "Work", color: "blue", collapsed: false },
      { id: 2, windowId: 7, title: "Other", color: "red", collapsed: false },
    ],
  });
  await settle();
  harness.sockets[0].onopen();
  await settle();

  const state = await harness.request({ type: "lens-state", windowId: 7 });

  assert.deepEqual(state.activeView, { kind: "lens", lensId: "lens_work" });
  assert.equal(state.lastActivation, null);
  assert.deepEqual(state.lenses.map((entry) => ({ id: entry.id, active: entry.active })), [
    { id: "lens_work", active: true },
    { id: "lens_client", active: false },
  ]);
  assert.deepEqual(state.currentGroups.find((group) => group.title === "Work").savedIn, ["Work", "Client"]);
  assert.deepEqual(state.currentGroups.find((group) => group.title === "Other").savedIn, []);
  assert.equal(state.hasGroups, true);
  assert.equal(state.hasAppleBinding, true);
  assert.equal(state.aiEnabled, true);
});

test("non-focus state envelopes are ignored", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"])] },
    ...twoGroups(),
  });
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
  await harness.context.handleMessage({ data: JSON.stringify({ type: "bluetooth", schemaVersion: 1, ts: 1, payload: { available: true, devices: [] } }) });

  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("matching lens groups are activated in each window before other groups collapse", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 4).collapsed, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).active, true);
});

test("lens activation keeps an ungrouped active tab in the foreground", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 99).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, false);
  assert.equal(harness.tabUpdates.some((entry) => entry.patch.active === true), false);
});

test("group update failures are reported without aborting remaining lens updates", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  const result = await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(result.ok, true);
  assert.equal(harness.consoleErrors.length, 1);
  assert.equal(harness.storageData.lastAction, "applied_with_errors");
  assert.deepEqual(harness.storageData.updateFailures, ["Other"]);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("lens activations are serialized across websocket and manual messages", async () => {
  const fixture = twoGroups();
  const harness = createHarness({
    ...fixture,
    deferFirstGroupUpdate: true,
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"])] },
  });
  await settle();

  harness.sockets[0].onmessage({ data: JSON.stringify({ type: "focus", schemaVersion: 1, ts: 0, payload: { focus: { id: "com.apple.focus.work" } } }) });
  await waitFor(() => {
    assert.equal(harness.firstGroupUpdate.started, true);
  });

  let manualFinished = false;
  const manual = harness.request({ type: "lens-activate", windowId: 1, view: { kind: "all" } }).then(() => {
    manualFinished = true;
  });
  await settle();
  assert.equal(manualFinished, false);

  harness.firstGroupUpdate.resolve();
  await manual;

  assert.equal(manualFinished, true);
  assert.deepEqual(harness.storageData.activeView, { kind: "all" });
});

test("activation failures are reported and remain retryable", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });
  assert.equal(harness.storageData.lastAction, "activation_failed");
  assert.deepEqual(harness.storageData.updateFailures, ["Work"]);
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);

  harness.tabState.find((tab) => tab.id === 10).failActivate = false;
  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
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

test("grouping responses are not mistaken for Apple Focus updates", async () => {
  const harness = createHarness({
    ...twoGroups(),
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"])] },
  });
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

test("tabsearch-history returns deduped mapped results", async () => {
  const harness = createHarness({
    history: [
      { title: "A", url: "https://a.test" },
      { title: "", url: "https://b.test" },
      { title: "Dup", url: "https://a.test" },
      { title: "NoUrl" },
      // Near-duplicate of a.test (scheme + www + trailing slash + noise param).
      { title: "A mirror", url: "http://www.a.test/?sei=xyz" },
    ],
  });

  const result = await harness.messageListeners[0]({ type: "tabsearch-history", query: "x" });

  assert.equal(result.ok, true);
  // a.test collapses to one entry (real title wins over the mirror); b.test stays.
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, "A");
  assert.equal(result.results[0].url, "https://a.test");
  // Title-less history returns an empty title; the client derives a label.
  assert.equal(result.results[1].title, "");
  assert.equal(result.results[1].url, "https://b.test");
  assert.equal(harness.historySearches[0].text, "x");
  assert.equal(harness.historySearches[0].maxResults, 20);
  assert.equal(harness.historySearches[0].startTime, 0);
});

test("tabsearch-history returns ok:false for blank query without calling history", async () => {
  const harness = createHarness();

  const result = await harness.messageListeners[0]({ type: "tabsearch-history", query: "  " });

  assert.equal(result.ok, false);
  assert.equal(result.results.length, 0);
  assert.equal(harness.historySearches.length, 0);
});

test("tabsearch-history returns ok:false when history api missing", async () => {
  const harness = createHarness({ noHistoryApi: true });

  const result = await harness.messageListeners[0]({ type: "tabsearch-history", query: "x" });

  assert.equal(result.ok, false);
  assert.equal(result.results.length, 0);
});

test("tabsearch-web-search calls search.query with NEW_TAB disposition", async () => {
  const harness = createHarness();

  const result = await harness.messageListeners[0]({ type: "tabsearch-web-search", query: "cats" });

  assert.equal(result.ok, true);
  assert.equal(harness.searchQueries[0].query, "cats");
  assert.equal(harness.searchQueries[0].disposition, "NEW_TAB");
});

test("tabsearch-web-search returns ok:false on blank query and when api missing/throws", async () => {
  const blankHarness = createHarness();
  const blankResult = await blankHarness.messageListeners[0]({ type: "tabsearch-web-search", query: "  " });
  assert.equal(blankResult.ok, false);
  assert.equal(blankHarness.searchQueries.length, 0);

  const missingHarness = createHarness({ noSearchApi: true });
  const missingResult = await missingHarness.messageListeners[0]({ type: "tabsearch-web-search", query: "cats" });
  assert.equal(missingResult.ok, false);

  const failingHarness = createHarness({ failSearch: true });
  const failingResult = await failingHarness.messageListeners[0]({ type: "tabsearch-web-search", query: "cats" });
  assert.equal(failingResult.ok, false);
});

test("tabsearch-open-url opens a new tab when the current tab is a real page", async () => {
  const harness = createHarness({
    tabs: [{ id: 7, windowId: 1, url: "https://real.test", active: true }],
  });

  const result = await harness.messageListeners[0]({ type: "tabsearch-open-url", url: "https://x.test" });

  assert.equal(result.ok, true);
  assert.equal(harness.tabCreations[0].url, "https://x.test");
  assert.equal(harness.tabCreations[0].active, true);
  // The real current tab is left untouched.
  assert.equal(harness.tabUpdates.some((u) => u.id === 7), false);
});

test("tabsearch-open-url reuses a blank current tab instead of stacking a new one", async () => {
  for (const blankUrl of ["about:blank", "about:newtab", "about:home"]) {
    const harness = createHarness({
      tabs: [{ id: 9, windowId: 1, url: blankUrl, active: true }],
    });

    const result = await harness.messageListeners[0]({ type: "tabsearch-open-url", url: "https://x.test" });

    assert.equal(result.ok, true, `${blankUrl} reuse ok`);
    assert.equal(harness.tabCreations.length, 0, `${blankUrl} did not create a tab`);
    assert.deepEqual(
      harness.tabUpdates.find((u) => u.id === 9),
      { id: 9, patch: { url: "https://x.test" } },
      `${blankUrl} navigated the blank tab`,
    );
  }
});

test("tabsearch-open-url returns ok:false for empty url", async () => {
  const harness = createHarness();

  const result = await harness.messageListeners[0]({ type: "tabsearch-open-url", url: "" });

  assert.equal(result.ok, false);
  assert.equal(harness.tabCreations.length, 0);
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

test("search-tabs command opens extension search page from Firefox new-tab page", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    failTabMessage: true,
    tabs: [{ id: 20, windowId: 1, title: "New Tab", url: "about:newtab", active: true }],
  });
  await settle();

  await harness.runCommand("search-tabs");
  await settle();

  assert.deepEqual(harness.tabUpdates, [
    { id: 20, patch: { url: "moz-extension://tab-lens/tabsearch.html?tabsearchOpen=1" } },
  ]);
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


test("custom provider uses the saved prompt override as the system message", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
      aiGroupingPrompt: "Cluster tabs and use emojis. Reply JSON only.",
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
  assert.equal(body.messages[0].content, "Cluster tabs and use emojis. Reply JSON only.");
});

test("custom provider falls back to the default prompt when no override is saved", async () => {
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

  await harness.messageListeners[0]({ type: "ai-group-preview", windowId: 1 });
  const body = JSON.parse(harness.fetchCalls[0].init.body);
  assert.match(body.messages[0].content, /You organize a user's open browser tabs/);
  assert.doesNotMatch(body.messages[0].content, /Safari/);
});

test("an over-long saved prompt is truncated to the 4000-char cap", async () => {
  const long = "x".repeat(5000);
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
      aiGroupingPrompt: long,
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
  assert.equal(body.messages[0].content.length, 4000);
});

test("foundation preview forwards the saved prompt override to the daemon", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiGroupingPrompt: "Group by top-level domain.",
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
  assert.equal(sent.prompt, "Group by top-level domain.");
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
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.tabState.find((tab) => tab.id === 99).active, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 10).active, false);
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

test("lens diagnostics keep the full collapsed-group list", async () => {
  const groups = [{ id: 1, windowId: 1, title: "Work", collapsed: true }];
  const tabs = [{ id: 100, windowId: 1, groupId: 1, active: false }];
  for (let i = 2; i <= 30; i += 1) {
    groups.push({ id: i, windowId: 1, title: `G${i}`, collapsed: false });
    tabs.push({ id: 100 + i, windowId: 1, groupId: i, active: false });
  }
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])] },
    groups,
    tabs,
  });
  await settle();

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.storageData.collapsedGroups.length, 29);
  assert.ok(harness.storageData.collapsedGroups.includes("G30"));
});

test("a glob selector expands every tab group whose title matches", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_work", "Work", [{ type: "glob", value: "Work*" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_work" } });

  assert.equal(harness.storageData.lastAction, "applied");
  assert.equal(harness.groupState.find((g) => g.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((g) => g.id === 2).collapsed, false);
  assert.equal(harness.groupState.find((g) => g.id === 3).collapsed, true);
  assert.deepEqual([...harness.storageData.expandedGroups].sort(), ["Work — JIRA", "Workspace"]);
});

test("? glob selectors combine with exact title selectors", async () => {
  const harness = createHarness({
    storage: { lenses: [lens("lens_docs", "Docs", [{ type: "title", value: "Exact" }, { type: "glob", value: "Doc?" }])] },
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

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_docs" } });

  assert.equal(harness.groupState.find((g) => g.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((g) => g.id === 2).collapsed, false);
  assert.equal(harness.groupState.find((g) => g.id === 3).collapsed, true);
  assert.equal(harness.groupState.find((g) => g.id === 4).collapsed, true);
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

test("AI apply pins new group topics to the active lens when opted in", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiPinToFocus: true,
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Existing" }])],
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
  assert.deepEqual(harness.storageData.lenses[0].groupSelectors, [
    { type: "title", value: "Existing" },
    { type: "title", value: "Work Docs" },
  ]);
});

test("AI apply leaves lenses untouched when pinning is off", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Existing" }])],
    },
    tabs: [
      { id: 10, windowId: 1, url: "https://a.com", title: "A", groupId: -1 },
      { id: 11, windowId: 1, url: "https://b.com", title: "B", groupId: -1 },
    ],
  });
  await settle();

  await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 1, groups: [{ topic: "Work Docs", color: "blue", tabs: [{ id: 10 }, { id: 11 }] }] });
  assert.deepEqual(harness.storageData.lenses[0].groupSelectors, [{ type: "title", value: "Existing" }]);
});

test("ai-group-state reports pin preference and the active lens name", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiPinToFocus: true,
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
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

function autoGroupHarness(overrides = {}) {
  return createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiAutoGroup: true,
      aiProvider: { kind: "custom", baseURL: "https://api.example.com/v1", model: "m1", apiKey: "sk-1" },
      ...(overrides.storage || {}),
    },
    tabs: overrides.tabs || [
      { id: 10, windowId: 1, url: "https://a.com", title: "Alpha", groupId: -1 },
      { id: 11, windowId: 1, url: "https://b.com", title: "Beta", groupId: -1 },
    ],
    fetchHandler: overrides.fetchHandler || (async () => chatCompletion([{ topic: "Work", tabIndices: [0, 1] }])),
  });
}

function findDebounceTimer(harness) {
  return [...harness.timers.entries()].find(([, timer]) => timer.delay === 5000);
}

test("auto-group: a tab event triggers a silent grouping", async () => {
  const harness = autoGroupHarness({
    storage: {
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
    },
  });
  await settle();
  await harness.context.setFocusBadge({ text: "W", color: "#00C853", title: "Tab Lens: Work" });

  await harness.fireTabCreated({ windowId: 1 });
  const entry = findDebounceTimer(harness);
  assert.ok(entry, "debounce timer scheduled");
  harness.runTimer(entry[0]);
  await waitFor(() => assert.ok(harness.groupCreations.length >= 1));

  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.browserActionState.badgeText, "W");
  assert.deepEqual(harness.storageData.lenses[0].groupSelectors, [{ type: "title", value: "Work" }]);
  assert.ok(!harness.storageData.lastError);
});

test("auto-group: debounce coalesces rapid events", async () => {
  const harness = autoGroupHarness();
  await settle();

  await harness.fireTabUpdated(10, { status: "complete" }, { windowId: 1 });
  await harness.fireTabUpdated(11, { status: "complete" }, { windowId: 1 });
  assert.equal([...harness.timers.values()].filter((timer) => timer.delay === 5000).length, 1);
  const entry = findDebounceTimer(harness);
  harness.runTimer(entry[0]);
  await waitFor(() => assert.equal(harness.groupCreations.length >= 1, true));

  assert.equal([...harness.timers.values()].filter((timer) => timer.delay === 5000).length, 0);
});

test("auto-group: cooldown blocks an immediate re-run", async () => {
  const harness = autoGroupHarness();
  await settle();

  await harness.fireTabCreated({ windowId: 1 });
  let entry = findDebounceTimer(harness);
  assert.ok(entry, "initial debounce timer scheduled");
  harness.runTimer(entry[0]);
  await waitFor(() => assert.ok(harness.groupCreations.length >= 1));
  const count = harness.groupCreations.length;

  await harness.fireTabCreated({ windowId: 1 });
  entry = findDebounceTimer(harness);
  assert.ok(entry, "second debounce timer scheduled");
  harness.runTimer(entry[0]);
  await settle();

  assert.equal(harness.groupCreations.length, count);
});

test("auto-group: disabled means no scheduling", async () => {
  const harness = autoGroupHarness({ storage: { aiAutoGroup: false } });
  await settle();

  await harness.fireTabCreated({ windowId: 1 });

  assert.equal(findDebounceTimer(harness), undefined);
  assert.equal(harness.groupCreations.length, 0);
});

test("auto-group: fewer than two groupable tabs is a silent no-op", async () => {
  const harness = autoGroupHarness({
    tabs: [{ id: 10, url: "https://a.com", title: "A", groupId: -1 }],
  });
  await settle();

  await harness.fireTabCreated({ windowId: 1 });
  const entry = findDebounceTimer(harness);
  if (entry) {
    harness.runTimer(entry[0]);
  }
  await settle();

  assert.equal(harness.groupCreations.length, 0);
  assert.ok(!harness.storageData.lastError);
});

test("auto-group: provider failure is silent, with no groups and no notification", async () => {
  const harness = autoGroupHarness({
    fetchHandler: async () => ({
      ok: false,
      status: 401,
      async json() { return {}; },
      async text() { return "no"; },
    }),
  });
  await settle();

  await harness.fireTabCreated({ windowId: 1 });
  const entry = findDebounceTimer(harness);
  assert.ok(entry, "debounce timer scheduled");
  harness.runTimer(entry[0]);
  await waitFor(() => assert.equal(harness.fetchCalls.length, 1));

  assert.equal(harness.groupCreations.length, 0);
  assert.equal(harness.notifications.length, 0);
  assert.ok(!harness.storageData.lastError);
  assert.equal(harness.browserActionState.badgeText, "");
});

test("auto-group: flipping the storage flag on schedules a run", async () => {
  const harness = autoGroupHarness({ storage: { aiAutoGroup: false } });
  await settle();

  await harness.browser.storage.local.set({ aiAutoGroup: true });
  await settle();
  const entry = findDebounceTimer(harness);
  assert.ok(entry, "debounce timer scheduled");
  harness.runTimer(entry[0]);
  await waitFor(() => assert.ok(harness.groupCreations.length >= 1));
});

test("auto-group: a second run is single-flighted while the first is still computing (compute outlives cooldown)", async () => {
  // The cooldown alone can't serialize runs because on-device clustering can
  // outlive AUTO_GROUP_COOLDOWN_MS. Hold the first compute open, expire the
  // cooldown, and fire another event: the in-flight guard must block run #2.
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  let fetchCount = 0;
  const harness = autoGroupHarness({
    fetchHandler: async () => {
      fetchCount += 1;
      await gate;
      return chatCompletion([{ topic: "Work", tabIndices: [0, 1] }]);
    },
  });
  await settle();

  await harness.fireTabCreated({ windowId: 1 });
  harness.runTimer(findDebounceTimer(harness)[0]);
  await settle();
  assert.equal(fetchCount, 1, "first run is computing");

  // Expire the 30s cooldown while run #1 is still blocked on fetch.
  const cooldown = [...harness.timers.entries()].find(([, timer]) => timer.delay === 30000);
  assert.ok(cooldown, "cooldown timer exists");
  harness.runTimer(cooldown[0]);

  await harness.fireTabUpdated(11, { status: "complete" }, { windowId: 1 });
  const second = findDebounceTimer(harness);
  assert.ok(second, "second debounce timer scheduled");
  harness.runTimer(second[0]);
  await settle();
  assert.equal(fetchCount, 1, "in-flight guard blocked the second clustering pass");

  releaseFetch();
  await waitFor(() => assert.ok(harness.groupCreations.length >= 1));
  assert.ok(!harness.storageData.lastError, "no spurious no_groups error");
});

test("auto-group: tabs grouped out from under a run do not surface a no_groups error", async () => {
  let harness;
  harness = autoGroupHarness({
    fetchHandler: async () => {
      // Simulate the candidate tabs becoming grouped between compute and the
      // commit re-validation (e.g. a concurrent grouping won the race).
      for (const tab of harness.tabState) {
        tab.groupId = 99;
      }
      return chatCompletion([{ topic: "Work", tabIndices: [0, 1] }]);
    },
  });
  await settle();

  await harness.fireTabCreated({ windowId: 1 });
  harness.runTimer(findDebounceTimer(harness)[0]);
  await settle();

  assert.equal(harness.groupCreations.length, 0, "nothing grouped — tabs were already taken");
  assert.ok(!harness.storageData.lastError, "benign empty re-validation is silent in auto mode");
});

test("lens-link-focus moves a Focus id exclusively to the target lens", async () => {
  const harness = createHarness({
    storage: {
      lenses: [
        lens("lens_a", "A", [{ type: "title", value: "A" }], ["com.apple.focus.work"]),
        lens("lens_b", "B", [{ type: "title", value: "B" }]),
      ],
    },
  });
  await settle();

  const result = await harness.request({ type: "lens-link-focus", lensId: "lens_b", focusId: "com.apple.focus.work" });

  assert.equal(result.ok, true);
  const a = harness.storageData.lenses.find((entry) => entry.id === "lens_a");
  const b = harness.storageData.lenses.find((entry) => entry.id === "lens_b");
  assert.deepEqual(a.triggers.appleFocusIds, []);
  assert.deepEqual(b.triggers.appleFocusIds, ["com.apple.focus.work"]);
});

test("lens-link-focus with no lensId unlinks the Focus id everywhere", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_a", "A", [{ type: "title", value: "A" }], ["com.apple.focus.work"])],
    },
  });
  await settle();

  const result = await harness.request({ type: "lens-link-focus", focusId: "com.apple.focus.work" });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.storageData.lenses[0].triggers.appleFocusIds, []);
});

test("lens-reorder reorders the lenses array", async () => {
  const harness = createHarness({
    storage: {
      lenses: [
        lens("lens_a", "A", [{ type: "title", value: "A" }]),
        lens("lens_b", "B", [{ type: "title", value: "B" }]),
        lens("lens_c", "C", [{ type: "title", value: "C" }]),
      ],
    },
  });
  await settle();

  const result = await harness.request({ type: "lens-reorder", orderedIds: ["lens_c", "lens_a", "lens_b"] });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.storageData.lenses.map((entry) => entry.id), ["lens_c", "lens_a", "lens_b"]);
});

test("scheduled lenses activate from the alarm tick", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
      lensSchedules: [{ lensId: "lens_work", enabled: true, days: [1], start: "09:00", end: "17:00" }],
    },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: true },
    ],
  });
  await settle();

  await harness.context.handleScheduleTick(new Date("2026-06-29T10:00:00"));

  assert.equal(harness.storageData.lastActivation.trigger, "schedule");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("window profile overrides automation per window", async () => {
  const harness = createHarness({
    storage: {
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"]),
        lens("lens_personal", "Personal", [{ type: "title", value: "Personal" }]),
      ],
    },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Personal", collapsed: false },
      { id: 3, windowId: 2, title: "Work", collapsed: false },
      { id: 4, windowId: 2, title: "Personal", collapsed: true },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false },
      { id: 20, windowId: 1, groupId: 2, active: true },
      { id: 30, windowId: 2, groupId: 3, active: true },
      { id: 40, windowId: 2, groupId: 4, active: false },
    ],
  });
  await settle();

  await harness.request({ type: "window-profile-set", windowId: 2, profile: { kind: "lens", lensId: "lens_personal" } });
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 4).collapsed, false);
});

test("switching persisted views records a session history entry", async () => {
  const harness = createHarness({
    storage: {
      activeView: { kind: "lens", lensId: "lens_work" },
      lastActivation: { trigger: "manual", at: 1000 },
      expandedGroups: ["Work"],
      collapsedGroups: ["Other"],
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }]),
        lens("lens_other", "Other", [{ type: "title", value: "Other" }]),
      ],
    },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: false },
      { id: 2, windowId: 1, title: "Other", collapsed: true },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: true },
      { id: 20, windowId: 1, groupId: 2, active: false },
    ],
  });
  await settle();

  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_other" } });

  assert.equal(harness.storageData.focusSessionHistory.length, 1);
  assert.deepEqual(harness.storageData.focusSessionHistory[0].view, { kind: "lens", lensId: "lens_work" });
  assert.deepEqual(harness.storageData.focusSessionHistory[0].expandedGroups, ["Work"]);
  assert.deepEqual(harness.storageData.focusSessionHistory[0].collapsedGroups, ["Other"]);
});
