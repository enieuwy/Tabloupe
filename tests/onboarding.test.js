const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const onboardingHtml = fs.readFileSync(path.join(__dirname, "..", "onboarding.html"), "utf8");
const onboardingJs = fs.readFileSync(path.join(__dirname, "..", "onboarding.js"), "utf8");
const htmlWithScript = onboardingHtml.replace(
  '<script defer src="onboarding.js"></script>',
  () => `<script>${onboardingJs}</script>`,
);

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick();
  }
}

function createHarness({
  windowId = 7,
  currentGroups = [],
  storage = {},
  respond,
  failWindowLookup = false,
  platform = "MacIntel",
} = {}) {
  const sent = [];
  const removedTabs = [];
  const optionsOpened = [];
  const storageData = { ...storage };
  const defaultRespond = (message) => {
    if (message.type === "lens-state") {
      return { activeView: { kind: "all" }, lenses: [], currentGroups, hasGroups: currentGroups.length > 0 };
    }
    if (message.type === "lens-save") {
      return { ok: true, lens: { id: "lens_saved", name: message.name } };
    }
    return {};
  };

  const browser = {
    windows: {
      async getCurrent() {
        if (failWindowLookup) throw new Error("no current window");
        return { id: windowId };
      },
    },
    tabs: {
      async getCurrent() {
        return { id: 42 };
      },
      async remove(tabId) {
        removedTabs.push(tabId);
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") {
            return keys in storageData ? { [keys]: storageData[keys] } : {};
          }
          return { ...storageData };
        },
      },
    },
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        return (respond || defaultRespond)(message);
      },
      async openOptionsPage() {
        optionsOpened.push(true);
      },
    },
  };

  const dom = new JSDOM(htmlWithScript, {
    url: "moz-extension://tabloupe/onboarding.html",
    runScripts: "dangerously",
    beforeParse(window) {
      try {
        Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
      } catch (error) {
        // Older jsdom exposes platform as non-configurable; the default is fine.
      }
      window.browser = browser;
    },
  });

  return { dom, window: dom.window, document: dom.window.document, browser, sent, removedTabs, optionsOpened };
}

function groupChips(harness) {
  return [...harness.document.querySelectorAll("#groups-list li")].map((li) => li.textContent);
}

test("the welcome page offers the current window's groups as a first lens", async () => {
  const harness = createHarness({
    currentGroups: [
      { title: "Work", color: "blue", savedIn: [] },
      { title: "Reading", color: "green", savedIn: [] },
    ],
  });
  await settle();

  assert.deepEqual(groupChips(harness), ["Work", "Reading"]);
  assert.match(harness.document.getElementById("groups-summary").textContent, /2 tab groups/);
  assert.equal(harness.document.getElementById("save-row").hidden, false);
  assert.equal(harness.document.getElementById("groups-empty").hidden, true);

  const stateMessage = harness.sent.find((message) => message.type === "lens-state");
  assert.equal(stateMessage.windowId, 7, "the page scopes its read to its own window");
});

test("untitled groups remain visible and require a lens name before saving", async () => {
  const harness = createHarness({ currentGroups: [{ title: "", color: "blue", savedIn: [] }] });
  await settle();
  assert.deepEqual(groupChips(harness), ["Untitled group"]);
  assert.equal(harness.document.getElementById("save-row").hidden, false);
  assert.equal(harness.document.getElementById("groups-empty").hidden, true);
  harness.document.getElementById("lens-name").value = "";
  harness.document.getElementById("save-lens").click();
  await settle();
  assert.equal(harness.sent.some((message) => message.type === "lens-save"), false);
  harness.document.getElementById("lens-name").value = "My groups";
  harness.document.getElementById("save-lens").click();
  await settle();
  assert.equal(harness.document.getElementById("save-lens").textContent, "Saved");
});

test("saving from the welcome page uses the real lens-save path", async () => {
  const harness = createHarness({ currentGroups: [{ title: "Work", color: "blue", savedIn: [] }] });
  await settle();

  // A single group pre-fills its own title as the lens name.
  const nameInput = harness.document.getElementById("lens-name");
  assert.equal(nameInput.value, "Work");

  harness.document.getElementById("save-lens").click();
  await settle();

  const save = harness.sent.find((message) => message.type === "lens-save");
  assert.deepEqual(
    { type: save.type, windowId: save.windowId, source: save.source, name: save.name },
    { type: "lens-save", windowId: 7, source: "window", name: "Work" },
  );
  assert.equal(harness.document.getElementById("save-lens").textContent, "Saved");
  assert.match(harness.document.getElementById("status").textContent, /open the Tabloupe toolbar icon/i);

  // A second click cannot create a duplicate lens.
  harness.document.getElementById("save-lens").click();
  await settle();
  assert.equal(harness.sent.filter((message) => message.type === "lens-save").length, 1);
});

test("a rejected save keeps the button usable and shows the failure", async () => {
  const harness = createHarness({
    currentGroups: [{ title: "Work", color: "blue", savedIn: [] }],
    respond: (message) => {
      if (message.type === "lens-state") {
        return { currentGroups: [{ title: "Work", color: "blue", savedIn: [] }] };
      }
      if (message.type === "lens-save") return { ok: false, error: "missing_window" };
      return {};
    },
  });
  await settle();

  harness.document.getElementById("save-lens").click();
  await settle();

  assert.equal(harness.document.getElementById("save-lens").disabled, false);
  assert.match(harness.document.getElementById("status").textContent, /Could not save that lens/);
});

test("a window without groups gets guidance instead of a save button", async () => {
  const harness = createHarness({ currentGroups: [] });
  await settle();

  assert.equal(harness.document.getElementById("save-row").hidden, true);
  assert.equal(harness.document.getElementById("groups-empty").hidden, false);
  assert.match(harness.document.getElementById("groups-summary").textContent, /No tab groups/);
});

test("a failed window lookup fails closed instead of saving every window's groups", async () => {
  const harness = createHarness({ failWindowLookup: true, currentGroups: [{ title: "Work", color: "blue" }] });
  await settle();

  assert.equal(harness.sent.some((message) => message.type === "lens-state"), false);
  assert.equal(harness.document.getElementById("save-row").hidden, true);
  assert.match(harness.document.getElementById("status").textContent, /Reload this page/);
});

test("the Tab Search hint reflects the stored shortcut", async () => {
  const harness = createHarness({
    storage: { tabSearchShortcut: { ctrl: false, alt: true, shift: true, meta: false, key: "k" } },
  });
  await settle();

  assert.equal(harness.document.getElementById("search-shortcut").textContent, "Option + Shift + K");

  const defaults = createHarness();
  await settle();
  assert.equal(defaults.document.getElementById("search-shortcut").textContent, "Ctrl + S");
});

test("Done closes the welcome tab and settings opens Options", async () => {
  const harness = createHarness();
  await settle();

  harness.document.getElementById("open-options").click();
  await settle();
  assert.equal(harness.optionsOpened.length, 1);

  harness.document.getElementById("done").click();
  await settle();
  assert.deepEqual(harness.removedTabs, [42]);
});
