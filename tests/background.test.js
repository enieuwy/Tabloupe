const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto");

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
  groupFailTabIds = [],
  sessionData: sessionDataInput = null,
  storageSync = null,
  containers = null,
} = {}) {
  const storageData = clone(storage) || {};
  const syncData = storageSync === null ? null : clone(storageSync) || {};
  const sessionData = sessionDataInput || {};
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
  const discardedTabs = [];
  const tabCreations = [];
  const tabMessages = [];
  const commandListeners = [];
  const tabCreatedListeners = [];
  const tabUpdatedListeners = [];
  const syncSets = [];
  const syncRemoves = [];
  const identityQueries = [];
  const identityListeners = [];
  const fetchCalls = [];
  const historySearches = [];
  const searchQueries = [];
  let historyResults = history;
  let nextTabId = Math.max(1000, ...tabState.map((tab) => (typeof tab.id === "number" ? tab.id : 0))) + 1;
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
      ...(syncData ? {
        sync: {
          async get(keys) {
            if (keys === null || keys === undefined) {
              return clone(syncData) || {};
            }
            if (typeof keys === "string") {
              return { [keys]: clone(syncData[keys]) };
            }
            if (Array.isArray(keys)) {
              const output = {};
              for (const key of keys) {
                output[key] = clone(syncData[key]);
              }
              return output;
            }
            const output = { ...keys };
            for (const key of Object.keys(keys)) {
              if (Object.prototype.hasOwnProperty.call(syncData, key)) {
                output[key] = clone(syncData[key]);
              }
            }
            return output;
          },
          async set(values) {
            const changes = {};
            syncSets.push(clone(values));
            for (const [key, value] of Object.entries(values)) {
              changes[key] = {
                oldValue: clone(syncData[key]),
                newValue: clone(value),
              };
              syncData[key] = clone(value);
            }
            for (const listener of storageListeners) {
              Promise.resolve().then(() => listener(changes, "sync"));
            }
          },
          async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            const changes = {};
            syncRemoves.push(clone(list));
            for (const key of list) {
              if (typeof key !== "string") continue;
              changes[key] = {
                oldValue: clone(syncData[key]),
                newValue: undefined,
              };
              delete syncData[key];
            }
            if (Object.keys(changes).length > 0) {
              for (const listener of storageListeners) {
                Promise.resolve().then(() => listener(changes, "sync"));
              }
            }
          },
        },
      } : {}),
      session: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return clone(sessionData) || {};
          }
          if (typeof keys === "string") {
            return { [keys]: clone(sessionData[keys]) };
          }
          if (Array.isArray(keys)) {
            const output = {};
            for (const key of keys) {
              output[key] = clone(sessionData[key]);
            }
            return output;
          }
          const output = { ...keys };
          for (const key of Object.keys(keys)) {
            if (Object.prototype.hasOwnProperty.call(sessionData, key)) {
              output[key] = clone(sessionData[key]);
            }
          }
          return output;
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            sessionData[key] = clone(value);
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
        const created = { id: nextTabId, windowId: currentWindowId, active: false, ...clone(props) };
        nextTabId += 1;
        if (created.active) {
          const targetWindowId = typeof created.windowId === "number" ? created.windowId : currentWindowId;
          for (const candidate of tabState) {
            const candidateWindowId = typeof candidate.windowId === "number" ? candidate.windowId : currentWindowId;
            if (candidateWindowId === targetWindowId) {
              candidate.active = false;
            }
          }
        }
        tabState.push(clone(created));
        tabCreations.push(clone(props));
        return clone(created);
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
        if (groupFailTabIds.length > 0 && tabIds.some((id) => groupFailTabIds.includes(id))) {
          throw new Error("tab group failed");
        }
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
        const ids = Array.isArray(id) ? id : [id];
        const discarded = [];
        for (const tabId of ids) {
          const tab = tabState.find((candidate) => candidate.id === tabId);
          assert.ok(tab, `tab ${tabId} exists`);
          tab.discarded = true;
          discardedTabs.push(tabId);
          discarded.push(clone(tab));
        }
        return Array.isArray(id) ? discarded : discarded[0];
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

  if (containers !== null) {
    const containerState = clone(containers) || [];
    const event = {
      addListener(listener) {
        identityListeners.push(listener);
      },
    };
    browser.contextualIdentities = {
      async query(query = {}) {
        identityQueries.push(clone(query));
        return clone(containerState);
      },
      onCreated: event,
      onRemoved: event,
      onUpdated: event,
    };
  }

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
        // Real Firefox requires `text`; reject the wrong param shape so a
        // regression (e.g. passing `query` instead of `text`) is caught.
        if (!props || typeof props.text !== "string" || props.text === "") {
          throw new Error("search.query requires a non-empty text");
        }
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
    crypto: crypto.webcrypto,
    TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  return {
    context,
    browser,
    storageData,
    sessionData,
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
    discardedTabs,
    tabCreations,
    tabMessages,
    historySearches,
    searchQueries,
    syncData,
    syncSets,
    syncRemoves,
    identityQueries,
    identityListeners,
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

function lens(id, name, selectors, appleFocusIds = [], calendarPatterns = []) {
  return {
    id,
    name,
    icon: "target",
    color: null,
    groupSelectors: selectors,
    triggers: { appleFocusIds, calendarPatterns },
    createdAt: 1,
    updatedAt: 1,
  };
}

function nodeHmacHex(token, message) {
  return crypto.createHmac("sha256", Buffer.from(token, "utf8")).update(message).digest("hex");
}

async function sendSocketFrame(socket, message) {
  socket.onmessage({ data: JSON.stringify(message) });
  await settle();
}

async function authenticateBus(harness, token, nonce = "00112233445566778899aabbccddeeff") {
  const socket = harness.sockets[0];
  socket.onopen();
  await settle();

  await sendSocketFrame(socket, { type: "hello", schemaVersion: 1, payload: { nonce } });
  await waitFor(() => assert.equal(harness.sentMessages[0] && harness.sentMessages[0].type, "auth"));
  const auth = harness.sentMessages[0];
  assert.equal(
    auth.payload.mac,
    nodeHmacHex(token, `tabloupe-client|${nonce}|${auth.payload.clientNonce}`)
  );

  await sendSocketFrame(socket, {
    type: "authOk",
    schemaVersion: 1,
    payload: {
      mac: nodeHmacHex(token, `tabloupe-server|${auth.payload.clientNonce}|${nonce}`),
    },
  });
  await waitFor(() => assert.equal(harness.storageData.busPairingStatus, "paired"));
  return { socket, auth };
}

const BUS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function authenticatedBusSocket(harness) {
  const { socket } = await authenticateBus(harness, BUS_TOKEN);
  return socket;
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

test("Calendar events activate glob and exact-title lenses without substring matches", async () => {
  const exactStart = "2026-07-07T09:00:00.000Z";
  const globStart = "2026-07-07T10:00:00.000Z";
  const harness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      lenses: [
        lens("lens_substring", "Substring", [{ type: "title", value: "Substring" }], [], ["Hands"]),
        lens("lens_exact", "Exact", [{ type: "title", value: "Exact" }], [], ["All Hands"]),
        lens("lens_glob", "Glob", [{ type: "title", value: "Glob" }], [], ["Sprint *"]),
      ],
    },
    groups: [
      { id: 1, title: "Substring", collapsed: false },
      { id: 2, title: "Exact", collapsed: true },
      { id: 3, title: "Glob", collapsed: true },
    ],
    tabs: [
      { id: 10, groupId: 1, active: true },
      { id: 20, groupId: 2, active: false },
      { id: 30, groupId: 3, active: false },
    ],
  });
  await settle();
  const socket = await authenticatedBusSocket(harness);

  await sendSocketFrame(socket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: { events: [{ id: "evt-exact", title: "All Hands", start: exactStart }] },
  });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_exact" }));
  assert.equal(harness.storageData.lastActivation.trigger, "calendar");
  assert.equal(harness.storageData.lastActivation.triggerId, `evt-exact|${exactStart}`);
  assert.equal(harness.storageData.lastAppliedCalendarTriggerId, `evt-exact|${exactStart}`);
  assert.equal(harness.groupState.find((group) => group.title === "Substring").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Exact").collapsed, false);

  await sendSocketFrame(socket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: { events: [{ id: "evt-glob", title: "Sprint Planning", start: globStart }] },
  });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_glob" }));
  assert.equal(harness.storageData.lastActivation.trigger, "calendar");
  assert.equal(harness.storageData.lastActivation.triggerId, `evt-glob|${globStart}`);
  assert.equal(harness.storageData.lastAppliedCalendarTriggerId, `evt-glob|${globStart}`);
  assert.equal(harness.groupState.find((group) => group.title === "Glob").collapsed, false);
});

test("Calendar events choose the earliest start and use lens order for equal starts", async () => {
  const earlyStart = "2026-07-07T08:30:00.000Z";
  const laterStart = "2026-07-07T09:30:00.000Z";
  const earliestHarness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      lenses: [
        lens("lens_later", "Later", [], [], ["Later"]),
        lens("lens_early", "Early", [], [], ["Early"]),
      ],
    },
  });
  await settle();
  const earliestSocket = await authenticatedBusSocket(earliestHarness);

  await sendSocketFrame(earliestSocket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: {
      events: [
        { id: "evt-later", title: "Later", start: laterStart },
        { id: "evt-early", title: "Early", start: earlyStart },
      ],
    },
  });
  await waitFor(() => assert.deepEqual(earliestHarness.storageData.activeView, { kind: "lens", lensId: "lens_early" }));
  assert.equal(earliestHarness.storageData.lastActivation.triggerId, `evt-early|${earlyStart}`);

  const tieStart = "2026-07-07T11:00:00.000Z";
  const tieHarness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      lenses: [
        lens("lens_first", "First", [], [], ["First"]),
        lens("lens_second", "Second", [], [], ["Second"]),
      ],
    },
  });
  await settle();
  const tieSocket = await authenticatedBusSocket(tieHarness);

  await sendSocketFrame(tieSocket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: {
      events: [
        { id: "evt-second", title: "Second", start: tieStart },
        { id: "evt-first", title: "First", start: tieStart },
      ],
    },
  });
  await waitFor(() => assert.deepEqual(tieHarness.storageData.activeView, { kind: "lens", lensId: "lens_first" }));
  assert.equal(tieHarness.storageData.lastActivation.triggerId, `evt-first|${tieStart}`);
});

test("Calendar rebroadcast does not override a manual switch for the same event", async () => {
  const start = "2026-07-07T12:00:00.000Z";
  const harness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      lenses: [
        lens("lens_calendar", "Calendar", [{ type: "title", value: "Calendar" }], [], ["Calendar Sync"]),
        lens("lens_manual", "Manual", [{ type: "title", value: "Manual" }]),
      ],
    },
    groups: [
      { id: 1, title: "Calendar", collapsed: true },
      { id: 2, title: "Manual", collapsed: true },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: false },
    ],
  });
  await settle();
  const socket = await authenticatedBusSocket(harness);
  const frame = {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: { events: [{ id: "evt-manual-guard", title: "Calendar Sync", start }] },
  };

  await sendSocketFrame(socket, frame);
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_calendar" }));
  await harness.request({ type: "lens-activate", windowId: 1, view: { kind: "lens", lensId: "lens_manual" } });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_manual" }));

  await sendSocketFrame(socket, frame);
  await settle();
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_manual" });
  assert.equal(harness.storageData.lastActivation.trigger, "manual");
  assert.equal(harness.groupState.find((group) => group.title === "Calendar").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Manual").collapsed, false);
});

test("Calendar event-gone fallback only applies while calendar owns the view", async () => {
  const start = "2026-07-07T13:00:00.000Z";
  const event = { id: "evt-fallback", title: "Calendar Sync", start };
  const harness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      automationFallback: { kind: "lens", lensId: "lens_fallback" },
      lenses: [
        lens("lens_calendar", "Calendar", [{ type: "title", value: "Calendar" }], [], ["Calendar Sync"]),
        lens("lens_fallback", "Fallback", [{ type: "title", value: "Fallback" }]),
      ],
    },
    groups: [
      { id: 1, title: "Calendar", collapsed: true },
      { id: 2, title: "Fallback", collapsed: true },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: false },
    ],
  });
  await settle();
  const socket = await authenticatedBusSocket(harness);

  await sendSocketFrame(socket, { type: "calendarEvents", schemaVersion: 1, payload: { events: [event] } });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_calendar" }));
  await sendSocketFrame(socket, { type: "calendarEvents", schemaVersion: 1, payload: { events: [] } });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_fallback" }));
  assert.equal(harness.storageData.lastAppliedCalendarTriggerId, null);
  assert.equal(harness.groupState.find((group) => group.title === "Calendar").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Fallback").collapsed, false);

  const manualHarness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      automationFallback: { kind: "lens", lensId: "lens_fallback" },
      lenses: [
        lens("lens_calendar", "Calendar", [{ type: "title", value: "Calendar" }], [], ["Calendar Sync"]),
        lens("lens_fallback", "Fallback", [{ type: "title", value: "Fallback" }]),
      ],
    },
    groups: [
      { id: 1, title: "Calendar", collapsed: true },
      { id: 2, title: "Fallback", collapsed: true },
    ],
    tabs: [
      { id: 10, groupId: 1, active: false },
      { id: 20, groupId: 2, active: false },
    ],
  });
  await settle();
  const manualSocket = await authenticatedBusSocket(manualHarness);

  await sendSocketFrame(manualSocket, { type: "calendarEvents", schemaVersion: 1, payload: { events: [event] } });
  await waitFor(() => assert.deepEqual(manualHarness.storageData.activeView, { kind: "lens", lensId: "lens_calendar" }));
  await manualHarness.request({ type: "lens-activate", windowId: 1, view: { kind: "all" } });
  await waitFor(() => assert.deepEqual(manualHarness.storageData.activeView, { kind: "all" }));
  await sendSocketFrame(manualSocket, { type: "calendarEvents", schemaVersion: 1, payload: { events: [] } });
  await settle();
  assert.deepEqual(manualHarness.storageData.activeView, { kind: "all" });
  assert.equal(manualHarness.storageData.lastActivation.trigger, "manual");
  assert.equal(manualHarness.groupState.every((group) => group.collapsed === false), true);
});

test("Malformed Calendar events are ignored without closing the bus", async () => {
  const harness = createHarness({
    storage: {
      busToken: BUS_TOKEN,
      lenses: [lens("lens_calendar", "Calendar", [], [], ["Calendar Sync"])],
    },
  });
  await settle();
  const socket = await authenticatedBusSocket(harness);

  await sendSocketFrame(socket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: { events: { id: "not-an-array", title: "Calendar Sync", start: "2026-07-07T14:00:00.000Z" } },
  });
  await sendSocketFrame(socket, {
    type: "calendarEvents",
    schemaVersion: 1,
    payload: {
      events: [
        { id: "missing-title", start: "2026-07-07T14:00:00.000Z" },
        { id: "missing-start", title: "Calendar Sync" },
        null,
      ],
    },
  });
  await settle();

  assert.equal(harness.storageData.activeView, undefined);
  assert.equal(harness.storageData.lastAppliedCalendarTriggerId, undefined);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(harness.consoleErrors, []);
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
  assert.equal(harness.searchQueries[0].text, "cats");
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

test("search-tabs command opens extension search page in a fresh tab from Firefox new-tab page", async () => {
  const harness = createHarness({
    currentWindowId: 1,
    failTabMessage: true,
    tabs: [{ id: 20, windowId: 1, title: "New Tab", url: "about:newtab", active: true }],
  });
  await settle();

  await harness.runCommand("search-tabs");
  await settle();

  // A fresh active tab lands keyboard focus in content; the blank new-tab is
  // discarded. Navigating in place would leave focus in the address bar.
  assert.deepEqual(harness.tabCreations, [
    { url: "moz-extension://tab-lens/tabsearch.html?tabsearchOpen=1", active: true },
  ]);
  assert.deepEqual(harness.removedTabs, [20]);
  assert.equal(harness.tabUpdates.some((u) => u.id === 20), false);
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
  await harness.context.setFocusBadge({ text: "W", color: "#00C853", title: "Tabloupe: Work" });

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

// ── Regression: security/robustness fixes ─────────────────────────────

function scheduledHarness(storageOverrides = {}) {
  return createHarness({
    storage: {
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
      lensSchedules: [{ lensId: "lens_work", enabled: true, days: [1], start: "09:00", end: "17:00" }],
      ...storageOverrides,
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
}

test("schedule tick is edge-triggered: no-op when a view was activated inside the current window", async () => {
  const harness = scheduledHarness({
    lastActivation: { trigger: "manual", at: new Date("2026-06-29T09:30:00").getTime() },
  });
  await settle();

  await harness.context.handleScheduleTick(new Date("2026-06-29T10:00:00"));

  // lastActivation.at is after the 09:00 window start, so the tick must not re-activate.
  assert.equal(harness.storageData.lastActivation.trigger, "manual");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("schedule tick activates when the last activation predates the window start", async () => {
  const harness = scheduledHarness({
    lastActivation: { trigger: "manual", at: new Date("2026-06-28T10:00:00").getTime() },
  });
  await settle();

  await harness.context.handleScheduleTick(new Date("2026-06-29T10:00:00"));

  assert.equal(harness.storageData.lastActivation.trigger, "schedule");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, false);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, true);
});

test("overnight schedule tick is a no-op when the window opened before the last activation", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
      lensSchedules: [{ lensId: "lens_work", enabled: true, days: [], start: "22:00", end: "06:00" }],
      lastActivation: { trigger: "manual", at: new Date("2026-06-29T23:00:00").getTime() },
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

  // Window opened at 22:00 yesterday; the 23:00 manual activation is inside it.
  await harness.context.handleScheduleTick(new Date("2026-06-30T01:00:00"));

  assert.equal(harness.storageData.lastActivation.trigger, "manual");
  assert.equal(harness.groupState.find((group) => group.title === "Work").collapsed, true);
  assert.equal(harness.groupState.find((group) => group.title === "Other").collapsed, false);
});

test("no schedule alarm is created when there are no schedules", async () => {
  const harness = createHarness();
  await settle();

  assert.ok(!harness.alarms.some((alarm) => alarm.name === "lens-schedule-tick"));
  assert.ok(harness.clearedAlarms.includes("lens-schedule-tick"));
});

test("an enabled schedule creates the minute-tick alarm at startup", async () => {
  const harness = createHarness({
    storage: { lensSchedules: [{ lensId: "lens_work", enabled: true, days: [1], start: "09:00", end: "17:00" }] },
  });
  await settle();

  const created = harness.alarms.find((alarm) => alarm.name === "lens-schedule-tick");
  assert.ok(created, "schedule alarm created");
  assert.equal(created.config.periodInMinutes, 1);
});

test("writing an enabled schedule after startup creates the alarm via onChanged", async () => {
  const harness = createHarness();
  await settle();
  assert.ok(!harness.alarms.some((alarm) => alarm.name === "lens-schedule-tick"));

  await harness.browser.storage.local.set({
    lensSchedules: [{ lensId: "lens_work", enabled: true, days: [1], start: "09:00", end: "17:00" }],
  });
  await settle();

  assert.ok(harness.alarms.some((alarm) => alarm.name === "lens-schedule-tick"));
});

test("focus-off fallback fires after event-page restart using the persisted apple focus id", async () => {
  const harness = createHarness({
    storage: {
      lastAppliedAppleFocusId: "com.apple.focus.work",
      activeView: { kind: "lens", lensId: "lens_work" },
      lastActivation: { trigger: "appleFocus", triggerId: "com.apple.focus.work", at: 1000 },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"])],
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

  // Fresh page after suspension: only storage survives. A focus-off frame must
  // still apply the automation fallback and clear the persisted key.
  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", payload: { focus: null } }) });

  assert.deepEqual(harness.storageData.activeView, { kind: "all" });
  assert.equal(harness.storageData.lastAppliedAppleFocusId, null);
  assert.ok(harness.groupState.every((group) => group.collapsed === false));
});

test("same-id focus replay after restart is ignored when the last activation was manual", async () => {
  const harness = createHarness({
    storage: {
      lastAppliedAppleFocusId: "com.apple.focus.work",
      activeView: { kind: "lens", lensId: "lens_other" },
      lastActivation: { trigger: "manual", at: 2000 },
      lenses: [
        lens("lens_work", "Work", [{ type: "title", value: "Work" }], ["com.apple.focus.work"]),
        lens("lens_other", "Other", [{ type: "title", value: "Other" }]),
      ],
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

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", payload: { focus: { id: "com.apple.focus.work" } } }) });

  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_other" });
});

test("grouping prompt uses host only for titleless tabs and never leaks URL secrets", () => {
  const harness = createHarness();
  const prompt = harness.context.buildGroupingPrompt([
    { index: 0, url: "https://app.example.com/reset?token=SECRET123", title: "" },
  ]);

  assert.match(prompt, /app\.example\.com/);
  assert.ok(!prompt.includes("SECRET123"), "the query-string token must not reach the prompt");
});

test("grouping prompt collapses whitespace and truncates long titles", () => {
  const harness = createHarness();
  const prompt = harness.context.buildGroupingPrompt([
    { index: 0, url: "https://x.example/", title: "Hello\n\tWorld\t Foo" },
    { index: 1, url: "https://y.example/", title: "A".repeat(250) },
  ]);

  assert.ok(prompt.includes("Hello World Foo"));
  assert.ok(!prompt.includes("Hello\n"));
  assert.ok(prompt.includes("A".repeat(200)));
  assert.ok(!prompt.includes("A".repeat(201)), "titles are capped at 200 chars");
});

test("partial AI apply still pins the successful topic and clears the cached proposal", async () => {
  const harness = createHarness({
    storage: {
      aiGroupingEnabled: true,
      aiPinToFocus: true,
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Existing" }])],
    },
    tabs: [
      { id: 10, windowId: 1, url: "https://a.com", title: "A", groupId: -1 },
      { id: 20, windowId: 1, url: "https://b.com", title: "B", groupId: -1 },
    ],
    groupFailTabIds: [20],
  });
  await settle();

  // Seed a cached proposal for window 1 via a preview.
  const preview = await driveGrouping(harness, { type: "ai-group-preview", windowId: 1 }, {
    ok: true,
    groups: [
      { topic: "Work Docs", tabIndices: [0] },
      { topic: "Play", tabIndices: [1] },
    ],
  });
  assert.equal(preview.ok, true);
  const cached = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 1 });
  assert.ok(cached.proposal, "proposal cached before apply");

  // The second group's tab fails to group, so the overall apply fails.
  const result = await harness.messageListeners[0]({ type: "ai-group-apply", windowId: 1, groups: preview.groups });

  assert.equal(result.ok, false);
  assert.equal(result.applied.join(","), "Work Docs");
  assert.equal(result.failures.join(","), "Play");
  // The successful topic is still pinned to the active lens...
  assert.deepEqual(harness.storageData.lenses[0].groupSelectors, [
    { type: "title", value: "Existing" },
    { type: "title", value: "Work Docs" },
  ]);
  // ...and the now-stale cached proposal is cleared despite ok:false.
  const afterApply = await harness.messageListeners[0]({ type: "ai-group-state", windowId: 1 });
  assert.equal(afterApply.proposal, null);
});

test("a focus frame with a __proto__ id pollutes neither seen ids nor Object.prototype", async () => {
  const harness = createHarness();
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({ type: "focus", payload: { focus: { id: "__proto__", name: "Evil" } } }) });

  assert.equal(harness.storageData.seenFocusIds, undefined);
  assert.equal(harness.storageData.focusCatalog, undefined);
  assert.equal(({}).name, undefined);
});

test("a focusCatalog frame with a __proto__ entry id is skipped", async () => {
  const harness = createHarness();
  await settle();

  await harness.context.handleMessage({ data: JSON.stringify({
    type: "focusCatalog",
    payload: { entries: { "__proto__": { name: "Evil", icon: "x", color: "#ffffff" } } },
  }) });

  assert.equal(harness.storageData.focusCatalog, undefined);
  assert.equal(({}).name, undefined);
});

test("window profile overrides survive suspension via storage.session", async () => {
  const shared = {};
  const harness1 = createHarness({ sessionData: shared });
  await settle();

  const set = await harness1.request({ type: "window-profile-set", windowId: 1, profile: { kind: "none" } });
  assert.equal(set.ok, true);
  await settle();

  // The override is mirrored into storage.session, not just memory.
  assert.deepEqual(shared.windowViewState.windowProfiles, { 1: { kind: "none" } });

  // A fresh harness sharing the same session store simulates an event-page restart.
  const harness2 = createHarness({ sessionData: shared });
  await settle();

  const state = await harness2.request({ type: "lens-state", windowId: 1 });
  assert.equal(state.windowProfile.kind, "none");
});

test("lens commands activate slots, cycle through lenses, and show all groups", async () => {
  const lenses = [
    lens("lens_one", "One", []),
    lens("lens_two", "Two", []),
    lens("lens_three", "Three", []),
  ];
  const harness = createHarness({ storage: { lenses } });
  await settle();

  await harness.runCommand("activate-lens-2");
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_two" }));
  assert.equal(harness.storageData.lastActivation.trigger, "manual");

  const twoLensHarness = createHarness({ storage: { lenses: lenses.slice(0, 2), activeView: { kind: "lens", lensId: "lens_one" } } });
  await settle();
  await twoLensHarness.runCommand("activate-lens-9");
  await settle();
  assert.deepEqual(twoLensHarness.storageData.activeView, { kind: "lens", lensId: "lens_one" });

  await harness.browser.storage.local.set({ activeView: { kind: "all" } });
  await settle();
  await harness.runCommand("cycle-lens-next");
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_one" }));

  await harness.browser.storage.local.set({ activeView: { kind: "lens", lensId: "lens_three" } });
  await settle();
  await harness.runCommand("cycle-lens-next");
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "all" }));

  await harness.browser.storage.local.set({ activeView: { kind: "lens", lensId: "lens_two" } });
  await settle();
  await harness.runCommand("show-all-groups");
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "all" }));
});

test("open-tab-search message acknowledges and opens the content overlay path", async () => {
  const harness = createHarness({
    tabs: [{ id: 10, windowId: 1, active: true, url: "https://example.test" }],
  });
  await settle();

  const result = await harness.request({ type: "open-tab-search" });
  await waitFor(() => assert.equal(harness.tabMessages.length, 1));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.tabMessages[0], { tabId: 10, message: { type: "tabsearch-open" } });
});

test("discardCollapsedTabs discards only eligible tabs in newly collapsed groups", async () => {
  const harness = createHarness({
    storage: {
      discardCollapsedTabs: true,
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
    },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
      { id: 3, windowId: 1, title: "Already collapsed", collapsed: true },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: true, url: "https://work.test" },
      { id: 20, windowId: 1, groupId: 2, active: false, url: "https://eligible.test" },
      { id: 21, windowId: 1, groupId: 2, active: false, pinned: true, url: "https://pinned.test" },
      { id: 22, windowId: 1, groupId: 2, active: false, audible: true, url: "https://audio.test" },
      { id: 23, windowId: 1, groupId: 2, active: false, discarded: true, url: "https://discarded.test" },
      { id: 24, windowId: 1, groupId: 2, active: false, url: "about:config" },
      { id: 30, windowId: 1, groupId: 3, active: false, url: "https://already.test" },
    ],
  });
  await settle();

  const result = await harness.request({ type: "lens-activate", view: { kind: "lens", lensId: "lens_work" } });
  await waitFor(() => assert.deepEqual(harness.discardedTabs, [20]));

  assert.equal(result.ok, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 20).discarded, true);
  assert.equal(harness.tabState.find((tab) => tab.id === 30).discarded, undefined);
});

test("discardCollapsedTabs absent leaves newly collapsed tabs loaded", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_work", "Work", [{ type: "title", value: "Work" }])],
    },
    groups: [
      { id: 1, windowId: 1, title: "Work", collapsed: true },
      { id: 2, windowId: 1, title: "Other", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: true, url: "https://work.test" },
      { id: 20, windowId: 1, groupId: 2, active: false, url: "https://eligible.test" },
    ],
  });
  await settle();

  const result = await harness.request({ type: "lens-activate", view: { kind: "lens", lensId: "lens_work" } });
  await settle();

  assert.equal(result.ok, true);
  assert.deepEqual(harness.discardedTabs, []);
  assert.equal(harness.tabState.find((tab) => tab.id === 20).discarded, undefined);
});

test("container selectors match groups containing tabs in the named container", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_work_container", "Work container", [{ type: "container", value: "Work" }])],
    },
    containers: [
      { cookieStoreId: "firefox-container-work", name: "Work", color: "blue", icon: "briefcase" },
      { cookieStoreId: "firefox-container-personal", name: "Personal", color: "red", icon: "fingerprint" },
    ],
    groups: [
      { id: 1, windowId: 1, title: "Alpha", collapsed: true },
      { id: 2, windowId: 1, title: "Beta", collapsed: false },
      { id: 3, windowId: 2, title: "Gamma", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: true, cookieStoreId: "firefox-container-work", url: "https://work.test" },
      { id: 20, windowId: 1, groupId: 2, active: false, cookieStoreId: "firefox-container-personal", url: "https://personal.test" },
      { id: 30, windowId: 2, groupId: 3, active: false, cookieStoreId: "firefox-default", url: "https://default.test" },
    ],
  });
  await settle();

  const result = await harness.request({ type: "lens-activate", view: { kind: "lens", lensId: "lens_work_container" } });

  assert.equal(result.ok, true);
  assert.equal(harness.groupState.find((group) => group.id === 1).collapsed, false);
  assert.equal(harness.groupState.find((group) => group.id === 2).collapsed, true);
  assert.equal(harness.groupState.find((group) => group.id === 3).collapsed, true);
  assert.deepEqual(harness.storageData.expandedGroups, ["Alpha"]);
});

test("container selectors are ignored safely when contextualIdentities is unavailable", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lens("lens_work_container", "Work container", [{ type: "container", value: "Work" }])],
    },
    groups: [
      { id: 1, windowId: 1, title: "Alpha", collapsed: true },
      { id: 2, windowId: 1, title: "Beta", collapsed: true },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false, cookieStoreId: "firefox-container-work", url: "https://work.test" },
      { id: 20, windowId: 1, groupId: 2, active: false, cookieStoreId: "firefox-default", url: "https://default.test" },
    ],
  });
  await settle();

  const result = await harness.request({ type: "lens-activate", view: { kind: "lens", lensId: "lens_work_container" } });

  assert.equal(result.ok, true);
  assert.equal(harness.storageData.lastAction, "no_matching_group");
  assert.equal(harness.groupState.every((group) => group.collapsed === false), true);
});

test("tabsearch-move-container recreates only http tabs in the target container and returns a fresh list", async () => {
  const harness = createHarness({
    containers: [{ cookieStoreId: "firefox-container-work", name: "Work", color: "blue", icon: "briefcase" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: "One", url: "https://one.test", active: false, cookieStoreId: "firefox-default" },
      { id: 2, windowId: 1, index: 1, title: "About", url: "about:config", active: false, cookieStoreId: "firefox-default" },
      { id: 3, windowId: 1, index: 2, title: "Two", url: "http://two.test", active: false, pinned: true, cookieStoreId: "firefox-default" },
    ],
  });
  await settle();

  const result = await harness.request({
    type: "tabsearch-move-container",
    tabIds: [1, 2, 3],
    cookieStoreId: "firefox-container-work",
  });

  assert.deepEqual(harness.tabCreations.map((entry) => ({
    url: entry.url,
    cookieStoreId: entry.cookieStoreId,
    pinned: entry.pinned,
    index: entry.index,
  })), [
    { url: "https://one.test", cookieStoreId: "firefox-container-work", pinned: false, index: 1 },
    { url: "http://two.test", cookieStoreId: "firefox-container-work", pinned: true, index: 3 },
  ]);
  assert.deepEqual(harness.removedTabs, [1, 3]);
  assert.equal(result.some((tab) => tab.id === 1 || tab.id === 3), false);
  assert.equal(result.some((tab) => tab.id === 2 && tab.url === "about:config"), true);
  assert.equal(result.filter((tab) => tab.cookieStoreId === "firefox-container-work").length, 2);
});

test("lens sync pushes edited lenses and lens order to storage.sync when enabled", async () => {
  const localLens = lens("lens_sync", "Sync me", [{ type: "title", value: "Sync" }]);
  const harness = createHarness({
    storage: { syncLenses: true, lenses: [localLens] },
    storageSync: {},
  });
  await waitFor(() => assert.ok(harness.syncData.lensOrder));
  harness.syncSets.length = 0;

  const result = await harness.request({
    type: "lens-update",
    lensId: "lens_sync",
    patch: { name: "Synced name" },
  });
  await settle();
  assert.equal(result.ok, true);
  const timer = [...harness.timers.entries()].find(([, entry]) => entry.delay === 2000);
  assert.ok(timer, "lens sync push is debounced");
  harness.runTimer(timer[0]);
  await waitFor(() => assert.equal(harness.syncData["lens/lens_sync"].lens.name, "Synced name"));

  assert.deepEqual(harness.syncData.lensOrder.ids, ["lens_sync"]);
  assert.ok(harness.syncSets.some((values) => values["lens/lens_sync"] && values.lensOrder));
});

test("lens sync applies newer inbound lenses, ignores older inbound lenses, and stays quiet when disabled", async () => {
  const localLens = { ...lens("lens_sync", "Local", [{ type: "title", value: "Local" }]), updatedAt: 1000 };
  const harness = createHarness({
    storage: { syncLenses: true, lenses: [localLens], lensSyncMeta: { lensOrderUpdatedAt: 1000 } },
    storageSync: { lensOrder: { ids: ["lens_sync"], updatedAt: 1000 } },
  });
  await settle();

  await harness.browser.storage.sync.set({
    "lens/lens_sync": { lens: { ...localLens, name: "Remote newer", updatedAt: 2000 }, schedule: null },
  });
  await waitFor(() => assert.equal(harness.storageData.lenses[0].name, "Remote newer"));

  await harness.browser.storage.sync.set({
    "lens/lens_sync": { lens: { ...localLens, name: "Remote older", updatedAt: 1500 }, schedule: null },
  });
  await settle();
  assert.equal(harness.storageData.lenses[0].name, "Remote newer");

  const disabled = createHarness({
    storage: { lenses: [localLens] },
    storageSync: {},
  });
  await settle();
  await disabled.request({
    type: "lens-update",
    lensId: "lens_sync",
    patch: { name: "Local only" },
  });
  await settle();
  assert.deepEqual(disabled.syncSets, []);
  assert.deepEqual(disabled.syncData, {});
});

test("bus pairing authenticates hello, handles focus and activateView envelopes, and publishes lensState", async () => {
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const harness = createHarness({
    storage: {
      busToken: token,
      lenses: [
        lens("lens_focus", "Focus", [{ type: "title", value: "Focus" }], ["com.apple.focus.work"]),
        lens("lens_unique", "Unique", [{ type: "title", value: "Unique" }]),
      ],
    },
    groups: [
      { id: 1, windowId: 1, title: "Focus", collapsed: true },
      { id: 2, windowId: 1, title: "Unique", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false, url: "https://focus.test" },
      { id: 20, windowId: 1, groupId: 2, active: true, url: "https://unique.test" },
    ],
  });
  await settle();

  const { socket } = await authenticateBus(harness, token);
  await waitFor(() => assert.ok(harness.sentMessages.some((message) => message.type === "lensState")));

  await sendSocketFrame(socket, {
    type: "focus",
    schemaVersion: 1,
    payload: { focus: { id: "com.apple.focus.work", name: "Work" } },
  });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_focus" }));
  assert.equal(harness.storageData.lastActivation.trigger, "appleFocus");

  harness.sentMessages.length = 0;
  await sendSocketFrame(socket, {
    type: "activateView",
    schemaVersion: 1,
    payload: { view: { kind: "lens", name: "Unique" } },
  });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_unique" }));
  await waitFor(() => assert.equal(harness.sentMessages.filter((message) => message.type === "lensState").length, 1));
  assert.equal(harness.storageData.lastActivation.trigger, "external");
  assert.equal(harness.storageData.lastActivation.triggerId, "ws");
  assert.deepEqual(harness.sentMessages[0], {
    type: "lensState",
    schemaVersion: 1,
    payload: {
      activeView: { kind: "lens", lensId: "lens_unique" },
      lens: { id: "lens_unique", name: "Unique", icon: "target", color: null },
      lastActivation: harness.storageData.lastActivation,
    },
  });
});

test("bus pairing rejects wrong server MACs and missing tokens", async () => {
  const token = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const wrongMacHarness = createHarness({ storage: { busToken: token } });
  await settle();
  const wrongSocket = wrongMacHarness.sockets[0];
  wrongSocket.onopen();
  await sendSocketFrame(wrongSocket, {
    type: "hello",
    schemaVersion: 1,
    payload: { nonce: "11112222333344445555666677778888" },
  });
  await waitFor(() => assert.equal(wrongMacHarness.sentMessages[0] && wrongMacHarness.sentMessages[0].type, "auth"));

  await sendSocketFrame(wrongSocket, { type: "authOk", schemaVersion: 1, payload: { mac: "00" } });
  await waitFor(() => assert.equal(wrongMacHarness.storageData.busPairingStatus, "pairing_failed"));
  assert.equal(wrongSocket.readyState, wrongMacHarness.context.WebSocket.CLOSED);

  const missingTokenHarness = createHarness();
  await settle();
  const missingTokenSocket = missingTokenHarness.sockets[0];
  missingTokenSocket.onopen();
  await sendSocketFrame(missingTokenSocket, {
    type: "hello",
    schemaVersion: 1,
    payload: { nonce: "99990000111122223333444455556666" },
  });
  await waitFor(() => assert.equal(missingTokenHarness.storageData.busPairingStatus, "pairing_required"));
  assert.equal(missingTokenSocket.readyState, missingTokenHarness.context.WebSocket.CLOSED);
  assert.deepEqual(missingTokenHarness.sentMessages, []);
});

test("legacy bus frames still handle focus but ignore unauthenticated activateView", async () => {
  const harness = createHarness({
    storage: {
      lenses: [
        lens("lens_focus", "Focus", [{ type: "title", value: "Focus" }], ["com.apple.focus.work"]),
        lens("lens_unique", "Unique", [{ type: "title", value: "Unique" }]),
      ],
    },
    groups: [
      { id: 1, windowId: 1, title: "Focus", collapsed: true },
      { id: 2, windowId: 1, title: "Unique", collapsed: false },
    ],
    tabs: [
      { id: 10, windowId: 1, groupId: 1, active: false, url: "https://focus.test" },
      { id: 20, windowId: 1, groupId: 2, active: true, url: "https://unique.test" },
    ],
  });
  await settle();
  const socket = harness.sockets[0];
  socket.onopen();

  await sendSocketFrame(socket, {
    type: "focus",
    schemaVersion: 1,
    payload: { focus: { id: "com.apple.focus.work", name: "Work" } },
  });
  await waitFor(() => assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_focus" }));
  assert.equal(harness.storageData.busPairingStatus, "legacy (unpaired)");

  await sendSocketFrame(socket, {
    type: "activateView",
    schemaVersion: 1,
    payload: { view: { kind: "lens", name: "Unique" } },
  });
  await settle();
  assert.deepEqual(harness.storageData.activeView, { kind: "lens", lensId: "lens_focus" });
  assert.equal(harness.consoleWarnings.length, 1);
});
