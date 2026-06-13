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

function createHarness({ windowId = 7, respond = () => ({}), storage = {} } = {}) {
  const sent = [];
  const storageData = { ...storage };
  const optionsOpened = [];

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
          return { ...storageData };
        },
        async set(values) {
          Object.assign(storageData, values);
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

test("disabled state renders toggle off and does not preview", async () => {
  const harness = createHarness({
    respond: (message) =>
      message.type === "ai-group-state" ? { enabled: false, groupableCount: 5, proposal: null } : {},
  });
  await settle();

  assert.equal(harness.document.getElementById("ai-enabled").checked, false);
  assert.match(harness.document.getElementById("ai-summary").textContent, /Turn on/);
  assert.equal(harness.sent.filter((m) => m.type === "ai-group-preview").length, 0);

  const stateMsg = harness.sent.find((m) => m.type === "ai-group-state");
  assert.equal(stateMsg.windowId, 7);
});

test("enabled with groupable tabs auto-previews and renders the proposal", async () => {
  const groups = [{ topic: "Work", color: "blue", tabs: [{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }] }];
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "ai-group-state") return { enabled: true, groupableCount: 2, proposal: null };
      if (message.type === "ai-group-preview") return { ok: true, groups };
      return {};
    },
  });
  await settle();

  const preview = harness.sent.find((m) => m.type === "ai-group-preview");
  assert.ok(preview, "auto-preview ran");
  assert.equal(preview.windowId, 7);

  const container = harness.document.getElementById("ai-groups");
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /Work \(2\)/);
  assert.match(container.textContent, /Alpha/);
  assert.equal(harness.document.getElementById("ai-apply").hidden, false);
});

test("cached proposal renders without running a fresh preview", async () => {
  const groups = [{ topic: "Reading", color: "green", tabs: [{ id: 1, title: "Doc" }] }];
  const harness = createHarness({
    respond: (message) =>
      message.type === "ai-group-state" ? { enabled: true, groupableCount: 3, proposal: groups } : {},
  });
  await settle();

  assert.equal(harness.sent.filter((m) => m.type === "ai-group-preview").length, 0);
  assert.match(harness.document.getElementById("ai-groups").textContent, /Reading/);
});

test("apply sends the proposal with the window id and reports success", async () => {
  const groups = [{ topic: "Work", color: "blue", tabs: [{ id: 1, title: "Alpha" }] }];
  const harness = createHarness({
    respond: (message) => {
      if (message.type === "ai-group-state") return { enabled: true, groupableCount: 2, proposal: groups };
      if (message.type === "ai-group-apply") return { ok: true, applied: ["Work"], failures: [] };
      return {};
    },
  });
  await settle();

  harness.document.getElementById("ai-apply").click();
  await settle();

  const apply = harness.sent.find((m) => m.type === "ai-group-apply");
  assert.ok(apply, "apply message sent");
  assert.equal(apply.windowId, 7);
  assert.equal(apply.groups[0].topic, "Work");
  assert.match(harness.document.getElementById("ai-status").textContent, /Created 1 group/);
});

test("toggling the checkbox on writes the enabled flag to storage", async () => {
  const harness = createHarness({
    storage: { aiGroupingEnabled: false },
    respond: (message) =>
      message.type === "ai-group-state" ? { enabled: false, groupableCount: 0, proposal: null } : {},
  });
  await settle();

  const box = harness.document.getElementById("ai-enabled");
  box.checked = true;
  box.dispatchEvent(new harness.window.Event("change"));
  await settle();

  assert.equal(harness.storageData.aiGroupingEnabled, true);
});
