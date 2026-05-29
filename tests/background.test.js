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

function createHarness({ storage = {}, groups = [], tabs = [] } = {}) {
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
  const sockets = [];

  const browser = {
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
        Object.assign(group, patch);
        return clone(group);
      },
    },
    tabs: {
      async query(query) {
        return clone(tabState.filter((tab) => tab.groupId === query.groupId));
      },
      async update(id, patch) {
        const tab = tabState.find((candidate) => candidate.id === id);
        assert.ok(tab, `tab ${id} exists`);
        Object.assign(tab, patch);
        tabUpdates.push({ id, patch: clone(patch) });
        return clone(tab);
      },
    },
  };

  class FakeWebSocket {
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) {
        this.onclose();
      }
    }
  }

  const context = {
    browser,
    console,
    setTimeout,
    clearTimeout,
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
    sockets,
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
