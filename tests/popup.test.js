const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
const htmlWithScript = popupHtml.replace('<script defer src="popup.js"></script>', `<script>${popupJs}</script>`);

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await nextTick();
  }
}

function defaultLensState(overrides = {}) {
  return {
    activeView: { kind: "all" },
    lastActivation: { trigger: "manual" },
    lenses: [],
    currentGroups: [],
    hasGroups: false,
    hasAppleBinding: false,
    aiEnabled: true,
    ...overrides,
  };
}

function createHarness({ windowId = 7, respond = () => ({}), storage = {} } = {}) {
  const sent = [];
  const storageData = { ...storage };
  const optionsOpened = [];
  const storageListeners = [];

  const browser = {
    windows: {
      async getCurrent() {
        return { id: windowId };
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return { [keys]: storageData[keys] };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
          }
          return { ...storageData };
        },
        async set(values) {
          const changes = Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, { oldValue: storageData[key], newValue: value }]),
          );
          Object.assign(storageData, values);
          for (const listener of storageListeners) {
            listener(changes, "local");
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
      async sendMessage(message) {
        sent.push(message);
        return respond(message);
      },
      openOptionsPage() {
        optionsOpened.push(true);
      },
    },
  };

  const dom = new JSDOM(htmlWithScript, {
    url: "http://localhost/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.browser = browser;
      window.close = () => {};
    },
  });

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    browser,
    sent,
    storageData,
    optionsOpened,
  };
}

async function openAi(harness) {
  harness.document.getElementById("open-ai").click();
  await settle();
}

function assertRuntimeMessagesHaveWindowId(harness, windowId = 7) {
  for (const message of harness.sent) {
    assert.equal(message.windowId, windowId, `${message.type} carries windowId`);
  }
}

test("popup renders the active lens from lens-state", async () => {
  const harness = createHarness({
    respond: (message) =>
      message.type === "lens-state"
        ? defaultLensState({
            activeView: { kind: "lens", lensId: "lens_work" },
            lenses: [{ id: "lens_work", name: "Work", icon: "briefcase", color: "blue", active: true }],
            hasGroups: true,
          })
        : {},
  });
  await settle();

  assert.equal(harness.document.querySelector("h1").textContent, "Tab Lens");
  assert.equal(harness.document.getElementById("lens-showing").textContent, "Showing: Work");
  const stateMsg = harness.sent.find((message) => message.type === "lens-state");
  assert.equal(stateMsg.windowId, 7);
});

test("clicking a lens chip activates that lens for the current window", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") {
        return defaultLensState({
          activeView: { kind: "all" },
          lenses: [
            { id: "lens_work", name: "Work", icon: "briefcase", color: "blue", active: false },
            { id: "lens_play", name: "Play", icon: "sparkle", color: "purple", active: false },
          ],
          hasGroups: true,
        });
      }
      if (message.type === "lens-activate") return { ok: true };
      return {};
    },
  });
  await settle();

  const work = [...harness.document.querySelectorAll(".lens-chip")].find((button) => button.textContent === "Work");
  work.click();
  await settle();

  const activate = harness.sent.find((message) => message.type === "lens-activate");
  assert.equal(activate.view.kind, "lens");
  assert.equal(activate.view.lensId, "lens_work");
  assert.equal(activate.windowId, 7);
});

test("show all groups activates the all-groups view", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") {
        return defaultLensState({
          activeView: { kind: "lens", lensId: "lens_work" },
          lenses: [{ id: "lens_work", name: "Work", icon: "briefcase", color: "blue", active: true }],
          hasGroups: true,
        });
      }
      if (message.type === "lens-activate") return { ok: true };
      return {};
    },
  });
  await settle();

  harness.document.getElementById("lens-show-all").click();
  await settle();

  const activate = harness.sent.find((message) => message.type === "lens-activate");
  assert.equal(activate.view.kind, "all");
  assert.equal(activate.windowId, 7);
});

test("show just this activates a transient group view", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") {
        return defaultLensState({
          hasGroups: true,
          currentGroups: [{ title: "Scratch", color: "yellow", savedIn: [] }],
        });
      }
      if (message.type === "lens-activate") return { ok: true };
      return {};
    },
  });
  await settle();

  harness.document.querySelector(".window-group button").click();
  await settle();

  const activate = harness.sent.find((message) => message.type === "lens-activate");
  assert.equal(activate.view.kind, "transient");
  assert.equal(activate.view.label, "Scratch");
  assert.equal(activate.view.selectors[0].type, "title");
  assert.equal(activate.view.selectors[0].value, "Scratch");
  assert.equal(activate.windowId, 7);
});

test("save as lens saves the group title as a lens", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") {
        return defaultLensState({
          hasGroups: true,
          currentGroups: [{ title: "Research", color: "green", savedIn: ["Reading"] }],
        });
      }
      if (message.type === "lens-save") return { ok: true, lens: { id: "lens_research", name: "Research" } };
      return {};
    },
  });
  await settle();

  const save = [...harness.document.querySelectorAll(".window-group button")].find(
    (button) => button.textContent === "Save as lens",
  );
  save.click();
  await settle();

  const saveMessage = harness.sent.find((message) => message.type === "lens-save");
  assert.equal(saveMessage.source, "group");
  assert.equal(saveMessage.groupTitle, "Research");
  assert.equal(saveMessage.name, "Research");
  assert.equal(saveMessage.windowId, 7);
});

test("empty state renders when there are no groups and no lenses", async () => {
  const harness = createHarness({
    respond: (message) => (message.type === "lens-state" ? defaultLensState() : {}),
  });
  await settle();

  const empty = harness.document.getElementById("empty-state");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Tab Lens works with Firefox tab groups/);
  assert.match(empty.textContent, /Organize tabs/);
});

test("popup does not send ai-group-preview on open", async () => {
  const harness = createHarness({
    respond: (message) =>
      message.type === "lens-state"
        ? defaultLensState({
            hasGroups: true,
            lenses: [{ id: "lens_work", name: "Work", icon: "briefcase", color: "blue", active: false }],
          })
        : {},
  });
  await settle();

  assert.equal(harness.document.getElementById("ai-view").hidden, true);
  assert.equal(harness.sent.some((message) => message.type === "ai-group-preview"), false);
  assert.equal(harness.sent.some((message) => message.type === "ai-group-state"), false);
  assertRuntimeMessagesHaveWindowId(harness);
});

test("primary view does not render the daemon warning", async () => {
  const harness = createHarness({
    storage: { connectionState: "reconnecting", lastError: null },
    respond: (message) => (message.type === "lens-state" ? defaultLensState({ hasGroups: true }) : {}),
  });
  await settle();

  assert.doesNotMatch(harness.document.getElementById("lens-view").textContent, /Not connected to mac-command-centre/);
});

test("connection warning renders inside the AI subview when daemon is reconnecting", async () => {
  const harness = createHarness({
    storage: { connectionState: "reconnecting", lastError: null },
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: false, groupableCount: 0, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const connection = harness.document.getElementById("popup-connection");
  assert.match(connection.textContent, /Not connected to mac-command-centre/);
  assert.ok(connection.classList.contains("conn-warn"));
});

test("connection status follows storage changes while AI subview is open", async () => {
  const harness = createHarness({
    storage: { connectionState: "reconnecting", lastError: null },
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: false, groupableCount: 0, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  await harness.browser.storage.local.set({ connectionState: "connected" });
  await settle();

  const connection = harness.document.getElementById("popup-connection");
  assert.equal(connection.textContent, "");
  assert.equal(connection.className, "conn");
});

test("persisted last error renders once and clears when AI subview opens", async () => {
  const message = "Provider returned HTTP 401. Check your API key.";
  const harness = createHarness({
    storage: {
      connectionState: "connected",
      lastError: { code: "provider-http", message, at: Date.now(), source: "ai" },
    },
    respond: (msg) => {
      if (msg.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (msg.type === "ai-group-state") return { enabled: false, groupableCount: 0, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const connection = harness.document.getElementById("popup-connection");
  assert.equal(connection.textContent, message);
  assert.equal(harness.storageData.lastError, null);
});

test("disabled AI state renders toggle off and does not preview", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: false, groupableCount: 5, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  assert.equal(harness.document.getElementById("ai-enabled").checked, false);
  assert.match(harness.document.getElementById("ai-summary").textContent, /Turn on/);
  assert.equal(harness.sent.filter((m) => m.type === "ai-group-preview").length, 0);

  const stateMsg = harness.sent.find((m) => m.type === "ai-group-state");
  assert.equal(stateMsg.windowId, 7);
});

test("enabled AI waits for an explicit organize click before previewing", async () => {
  const groups = [{ topic: "Work", color: "blue", tabs: [{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }] }];
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: true, groupableCount: 2, proposal: null };
      if (message.type === "ai-group-preview") return { ok: true, groups };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  assert.equal(harness.sent.filter((m) => m.type === "ai-group-preview").length, 0);

  harness.document.getElementById("ai-organize").click();
  await settle();

  const preview = harness.sent.find((m) => m.type === "ai-group-preview");
  assert.ok(preview, "preview ran after explicit organize click");
  assert.equal(preview.windowId, 7);

  const container = harness.document.getElementById("ai-groups");
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /Work \(2\)/);
  assert.match(container.textContent, /Alpha/);
  assert.equal(harness.document.getElementById("ai-apply").hidden, false);
});

test("cached AI proposal renders without running a fresh preview", async () => {
  const groups = [{ topic: "Reading", color: "green", tabs: [{ id: 1, title: "Doc" }] }];
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: true, groupableCount: 3, proposal: groups };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  assert.equal(harness.sent.filter((m) => m.type === "ai-group-preview").length, 0);
  assert.match(harness.document.getElementById("ai-groups").textContent, /Reading/);
});

test("apply sends the AI proposal with the window id and reports success", async () => {
  const groups = [{ topic: "Work", color: "blue", tabs: [{ id: 1, title: "Alpha" }] }];
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: true, groupableCount: 2, proposal: groups };
      if (message.type === "ai-group-apply") return { ok: true, applied: ["Work"], failures: [] };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  harness.document.getElementById("ai-apply").click();
  await settle();

  const apply = harness.sent.find((m) => m.type === "ai-group-apply");
  assert.ok(apply, "apply message sent");
  assert.equal(apply.windowId, 7);
  assert.equal(apply.groups[0].topic, "Work");
  assert.match(harness.document.getElementById("ai-status").textContent, /Created 1 group/);
});

test("toggling the AI checkbox writes the enabled flag to storage", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: false },
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: false, groupableCount: 0, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const box = harness.document.getElementById("ai-enabled");
  box.checked = true;
  box.dispatchEvent(new harness.window.Event("change"));
  await settle();

  assert.equal(harness.storageData.aiGroupingEnabled, true);
});

test("auto-group row is visible and checked when enabled and aiAutoGroup is stored", async () => {
  const harness = createHarness({
    storage: { aiAutoGroup: true },
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") {
        return { enabled: true, groupableCount: 2, proposal: null, autoGroup: true };
      }
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const row = harness.document.getElementById("ai-auto-row");
  assert.equal(row.hidden, false);
  assert.equal(harness.document.getElementById("ai-auto").checked, true);
});

test("auto-group checkbox reflects stored flag even if the background omits autoGroup", async () => {
  const harness = createHarness({
    storage: { aiAutoGroup: true },
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") {
        return { enabled: true, groupableCount: 0, proposal: null };
      }
      return {};
    },
  });
  await settle();
  await openAi(harness);

  assert.equal(harness.document.getElementById("ai-auto-row").hidden, false);
  assert.equal(harness.document.getElementById("ai-auto").checked, true);
});

test("auto-group row is hidden when AI grouping is disabled", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") return { enabled: false, groupableCount: 0, proposal: null };
      return {};
    },
  });
  await settle();
  await openAi(harness);

  assert.equal(harness.document.getElementById("ai-auto-row").hidden, true);
});

test("toggling auto-group writes aiAutoGroup to storage", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") {
        return { enabled: true, groupableCount: 0, proposal: null, autoGroup: false };
      }
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const box = harness.document.getElementById("ai-auto");
  box.checked = true;
  box.dispatchEvent(new harness.window.Event("change"));
  await settle();

  assert.equal(harness.storageData.aiAutoGroup, true);
});

test("AI pin row uses current-lens copy when a lens is active", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") {
        return { enabled: true, groupableCount: 0, proposal: null, pinToFocus: true, activeFocus: "Work" };
      }
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const label = harness.document.getElementById("ai-pin-label");
  assert.equal(label.textContent, "Add new groups to current lens: Work");
  assert.equal(harness.document.getElementById("ai-pin").disabled, false);
});

test("AI pin row disables with a hint when no lens is active", async () => {
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "lens-state") return defaultLensState({ hasGroups: true });
      if (message.type === "ai-group-state") {
        return { enabled: true, groupableCount: 0, proposal: null, pinToFocus: false, activeFocus: null };
      }
      return {};
    },
  });
  await settle();
  await openAi(harness);

  const label = harness.document.getElementById("ai-pin-label");
  assert.equal(label.textContent, "Add new groups to current lens (none active)");
  assert.equal(harness.document.getElementById("ai-pin").disabled, true);
});
