const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const tabsearchJs = fs.readFileSync(path.join(__dirname, "..", "tabsearch.js"), "utf8");

const SAMPLE_TABS = [
  { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", favIconUrl: "", active: true, currentWindow: true },
  { id: 30, windowId: 1, title: "GitHub", url: "https://github.com", favIconUrl: "", active: false, currentWindow: true },
  { id: 10, windowId: 2, title: "Mozilla", url: "https://mozilla.org", favIconUrl: "", active: false, currentWindow: false },
];

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await nextTick();
  }
}

function createHarness({ tabs = SAMPLE_TABS, respond, shortcut } = {}) {
  const sent = [];
  const messageListeners = [];
  const storageListeners = [];
  const storageData = {};
  if (shortcut !== undefined) storageData.tabSearchShortcut = shortcut;
  const defaultRespond = (message) => {
    if (message.type === "tabsearch-list") return tabs.slice();
    if (message.type === "tabsearch-close") {
      return tabs.filter((tab) => tab.id !== message.tabId);
    }
    return undefined;
  };
  const browser = {
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        return (respond || defaultRespond)(message);
      },
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        },
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
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
  };

  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "https://host.example/",
    runScripts: "dangerously",
    beforeParse(window) {
      window.browser = browser;
    },
  });
  const scriptEl = dom.window.document.createElement("script");
  scriptEl.textContent = tabsearchJs;
  dom.window.document.body.appendChild(scriptEl);

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    browser,
    sent,
    messageListeners,
    storageListeners,
    setShortcut(value) {
      const changes = { tabSearchShortcut: { newValue: value } };
      for (const listener of storageListeners) listener(changes, "local");
    },
  };
}

function overlayRoot(harness) {
  const hostEl = harness.document.getElementById("focus-tab-search-overlay");
  return hostEl ? hostEl.shadowRoot : null;
}

function rowTitles(harness) {
  const root = overlayRoot(harness);
  if (!root) return [];
  // The title's first child is the tab-title text node; a ".badge" span may follow.
  return Array.from(root.querySelectorAll(".row .title")).map((el) =>
    el.firstChild ? el.firstChild.textContent : ""
  );
}

function pressCtrlS(harness) {
  const event = new harness.window.KeyboardEvent("keydown", {
    key: "s",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  harness.document.body.dispatchEvent(event);
}

function pressKey(harness, key, init = {}) {
  const input = overlayRoot(harness).querySelector(".search");
  const event = new harness.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  if ("isComposing" in init) Object.defineProperty(event, "isComposing", { value: init.isComposing });
  if ("keyCode" in init) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  input.dispatchEvent(event);
}

function pressCombo(harness, combo) {
  const event = new harness.window.KeyboardEvent("keydown", {
    key: combo.key,
    ctrlKey: Boolean(combo.ctrl),
    shiftKey: Boolean(combo.shift),
    altKey: Boolean(combo.alt),
    metaKey: Boolean(combo.meta),
    bubbles: true,
    cancelable: true,
  });
  harness.document.body.dispatchEvent(event);
}

test("filterTabs AND-matches tokens across the precomputed title/url/group haystack", () => {
  const { window } = createHarness();
  const tabs = window.prepareTabsForSearch([
    ...SAMPLE_TABS,
    { id: 40, windowId: 1, title: "Bug", url: "https://tracker.example.com", groupTitle: "Release Train" },
  ]);
  assert.deepEqual(window.filterTabs(tabs, "git").map((t) => t.id), [30]);
  assert.deepEqual(window.filterTabs(tabs, "EXAMPLE").map((t) => t.id), [20, 40]);
  assert.deepEqual(window.filterTabs(tabs, "docs example").map((t) => t.id), [20]);
  assert.deepEqual(window.filterTabs(tabs, "release").map((t) => t.id), [40]);
  assert.deepEqual(window.filterTabs(tabs, "  ").map((t) => t.id), [20, 30, 10, 40]);
  assert.deepEqual(window.filterTabs(tabs, "nope").map((t) => t.id), []);
});

test("Ctrl+S opens the overlay and lists tabs from the background", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  assert.ok(overlayRoot(harness), "overlay host exists");
  assert.deepEqual(rowTitles(harness), ["Docs", "GitHub", "Mozilla"]);
  assert.ok(harness.sent.some((m) => m.type === "tabsearch-list"));
});

test("typing filters the rendered rows", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  const input = overlayRoot(harness).querySelector(".search");
  input.value = "git";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));

  assert.deepEqual(rowTitles(harness), ["GitHub"]);
});

test("group titles are searchable and rendered as badges", async () => {
  const harness = createHarness({
    tabs: [
      { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", favIconUrl: "", active: false, currentWindow: true },
      {
        id: 30,
        windowId: 1,
        title: "Issue",
        url: "https://tracker.example.com",
        favIconUrl: "",
        active: false,
        currentWindow: true,
        groupTitle: "Release Train",
        groupColor: "purple",
      },
    ],
  });
  pressCtrlS(harness);
  await settle();

  const root = overlayRoot(harness);
  const input = root.querySelector(".search");
  input.value = "release";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));

  assert.deepEqual(rowTitles(harness), ["Issue"]);
  const badge = root.querySelector(".row .group-badge");
  assert.equal(badge.textContent, "Release Train");
  assert.equal(badge.dataset.color, "purple");
});

test("rendering is bounded for large tab lists", async () => {
  const tabs = Array.from({ length: 75 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    title: `Example ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    favIconUrl: "",
    active: index === 0,
    currentWindow: true,
  }));
  const harness = createHarness({ tabs });
  assert.equal(
    harness.window.filterTabs(harness.window.prepareTabsForSearch(tabs), "example", 50).length,
    50,
  );
  pressCtrlS(harness);
  await settle();

  const root = overlayRoot(harness);
  assert.equal(root.querySelectorAll(".row").length, 50);

  const input = root.querySelector(".search");
  input.value = "example";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  assert.equal(root.querySelectorAll(".row").length, 50);
});

test("Enter activates the selected tab and closes the overlay", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  pressKey(harness, "ArrowDown"); // select GitHub (index 1)
  pressKey(harness, "Enter");
  await settle();

  const activate = harness.sent.find((m) => m.type === "tabsearch-activate");
  assert.deepEqual({ ...activate }, { type: "tabsearch-activate", tabId: 30, windowId: 1 });
  assert.equal(overlayRoot(harness), null, "overlay closed after activation");
});

test("IME composition Enter does not activate the selected tab", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  pressKey(harness, "Enter", { isComposing: true });
  pressKey(harness, "Enter", { keyCode: 229 });
  await settle();

  assert.ok(overlayRoot(harness), "overlay remains open during composition confirmation");
  assert.ok(!harness.sent.some((m) => m.type === "tabsearch-activate"));
});

test("Escape closes the overlay without activating", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  pressKey(harness, "Escape");
  await settle();

  assert.equal(overlayRoot(harness), null);
  assert.ok(!harness.sent.some((m) => m.type === "tabsearch-activate"));
});

test("close button removes a tab and keeps the overlay open", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  const firstClose = overlayRoot(harness).querySelector(".row .close");
  firstClose.click();
  await settle();

  assert.ok(harness.sent.some((m) => m.type === "tabsearch-close" && m.tabId === 20));
  assert.deepEqual(rowTitles(harness), ["GitHub", "Mozilla"]);
  assert.ok(overlayRoot(harness), "overlay stays open after closing a tab");
});

test("Ctrl+S toggles the overlay closed when already open", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();
  assert.ok(overlayRoot(harness));

  pressCtrlS(harness);
  await settle();
  assert.equal(overlayRoot(harness), null);
});

test("tabsearch-open message from the command relay opens the overlay", async () => {
  const harness = createHarness();
  assert.equal(harness.messageListeners.length, 1);

  harness.messageListeners[0]({ type: "tabsearch-open" });
  await settle();

  assert.ok(overlayRoot(harness));
  assert.deepEqual(rowTitles(harness), ["Docs", "GitHub", "Mozilla"]);
});

test("uses the configured shortcut instead of Ctrl+S", async () => {
  const harness = createHarness({ shortcut: { ctrl: true, alt: false, shift: true, meta: false, key: "k" } });
  await settle();

  pressCombo(harness, { ctrl: true, key: "s" });
  await settle();
  assert.equal(overlayRoot(harness), null, "Ctrl+S no longer opens the overlay");

  pressCombo(harness, { ctrl: true, shift: true, key: "k" });
  await settle();
  assert.ok(overlayRoot(harness), "configured Ctrl+Shift+K opens the overlay");
});

test("a null shortcut disables the in-page trigger", async () => {
  const harness = createHarness({ shortcut: null });
  await settle();

  pressCombo(harness, { ctrl: true, key: "s" });
  await settle();
  assert.equal(overlayRoot(harness), null);
});

test("a live storage change swaps the active shortcut", async () => {
  const harness = createHarness();
  await settle();

  harness.setShortcut({ ctrl: true, alt: true, shift: false, meta: false, key: "p" });
  pressCombo(harness, { ctrl: true, key: "s" });
  await settle();
  assert.equal(overlayRoot(harness), null, "old Ctrl+S no longer fires");

  pressCombo(harness, { ctrl: true, alt: true, key: "p" });
  await settle();
  assert.ok(overlayRoot(harness), "new Ctrl+Alt+P fires");
});
