const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const tabsearchJs = fs.readFileSync(path.join(__dirname, "..", "tabsearch.js"), "utf8");

const SAMPLE_TABS = [
  { id: 20, windowId: 1, title: "Docs", url: "https://docs.example.com", favIconUrl: "", active: true, currentWindow: true, pinned: false, grouped: false },
  { id: 30, windowId: 1, title: "GitHub", url: "https://github.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupTitle: "Work", groupColor: "blue" },
  { id: 10, windowId: 2, title: "Mozilla", url: "https://mozilla.org", favIconUrl: "", active: false, currentWindow: false, pinned: true, grouped: false },
];

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await nextTick();
  }
}

function createHarness({ tabs = SAMPLE_TABS, respond, shortcut, url = "https://host.example/" } = {}) {
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
      getURL(path = "") {
        return `moz-extension://tab-lens/${path}`;
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
    url,
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

function rows(harness) {
  return Array.from(overlayRoot(harness).querySelectorAll(".row"));
}

function markedRows(harness) {
  return rows(harness).filter((row) => row.classList.contains("marked"));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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
    ctrlKey: Boolean(init.ctrl),
    metaKey: Boolean(init.meta),
    shiftKey: Boolean(init.shift),
    altKey: Boolean(init.alt),
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

  assert.deepEqual(rowTitles(harness).filter((title) => title !== "Search the web"), ["GitHub"]);
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

  assert.deepEqual(rowTitles(harness).filter((title) => title !== "Search the web"), ["Issue"]);
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
  assert.equal(root.querySelectorAll(".row:not(.action-row)").length, 50);

  const input = root.querySelector(".search");
  input.value = "example";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  assert.equal(root.querySelectorAll(".row:not(.action-row)").length, 50);
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

test("extension-hosted tabsearch page opens the overlay on load", async () => {
  const harness = createHarness({ url: "moz-extension://tab-lens/tabsearch.html?tabsearchOpen=1" });
  for (let i = 0; i < 20 && !overlayRoot(harness); i += 1) {
    await settle();
  }

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

test("marking via checkbox, Ctrl-click, and Shift-click shows and clears the action bar", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  assert.equal(markedRows(harness).length, 1);
  assert.equal(overlayRoot(harness).querySelector(".actions .count").textContent, "1 selected");

  rows(harness)[1].dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.equal(markedRows(harness).length, 2);

  rows(harness)[2].dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
  assert.equal(markedRows(harness).length, 3);
  assert.equal(overlayRoot(harness).querySelector(".actions .count").textContent, "3 selected");

  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "Clear").click();
  assert.equal(markedRows(harness).length, 0);
  assert.equal(overlayRoot(harness).querySelector(".hint") !== null, true);
});

test("Escape first clears marks, then closes the overlay", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  pressKey(harness, "Escape");
  await settle();

  assert.ok(overlayRoot(harness), "overlay remains open after clearing marks");
  assert.equal(markedRows(harness).length, 0);

  pressKey(harness, "Escape");
  await settle();
  assert.equal(overlayRoot(harness), null);
});

test("same-window grouping gate disables group actions for cross-window marks", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  rows(harness)[2].querySelector(".mark").click();

  const buttons = Array.from(overlayRoot(harness).querySelectorAll(".actions button"));
  assert.equal(buttons.find((button) => button.textContent === "Group").disabled, true);
  assert.equal(buttons.find((button) => button.textContent === "AI group").disabled, true);
  assert.match(overlayRoot(harness).querySelector(".actions .message").textContent, /one window/);
});

test("manual group sends selected tab ids, title, and shared window id then refreshes", async () => {
  const refreshed = SAMPLE_TABS.map((tab) =>
    tab.windowId === 1 ? { ...tab, grouped: true, groupId: 7, groupTitle: "Reading", groupColor: "purple" } : tab
  );
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-group") return { ok: true, list: refreshed };
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  rows(harness)[1].querySelector(".mark").click();
  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "Group").click();
  const input = overlayRoot(harness).querySelector(".actions input");
  input.value = "Reading";
  input.closest("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  const sent = harness.sent.find((message) => message.type === "tabsearch-group");
  assert.deepEqual(plain(sent), { type: "tabsearch-group", tabIds: [20, 30], title: "Reading", windowId: 1 });
  assert.equal(markedRows(harness).length, 0);
  assert.equal(overlayRoot(harness).querySelector(".group-header .group-badge").textContent, "Reading");
});

test("AI preview renders topic sections and apply sends reduced groups", async () => {
  const previewGroups = [
    { topic: "Research", color: "green", tabs: [{ id: 20, title: "Docs" }, { id: 30, title: "GitHub" }] },
  ];
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-ai-preview") return { ok: true, groups: previewGroups };
      if (message.type === "ai-group-apply") return { ok: true, applied: 1, failures: [] };
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  rows(harness)[1].querySelector(".mark").click();
  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "AI group").click();
  await settle();

  assert.equal(overlayRoot(harness).querySelector(".preview-topic .group-badge").textContent, "Research");
  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "Apply").click();
  await settle();

  const preview = harness.sent.find((message) => message.type === "tabsearch-ai-preview");
  assert.deepEqual(plain(preview), { type: "tabsearch-ai-preview", windowId: 1, tabIds: [20, 30] });
  const apply = harness.sent.find((message) => message.type === "ai-group-apply");
  assert.deepEqual(plain(apply), {
    type: "ai-group-apply",
    windowId: 1,
    groups: [{ topic: "Research", color: "green", tabs: [{ id: 20 }, { id: 30 }] }],
  });
  assert.equal(overlayRoot(harness), null);
});

test("bulk close sends tabsearch-close-many and refreshes the list", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-close-many") return SAMPLE_TABS.filter((tab) => !message.tabIds.includes(tab.id));
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  rows(harness)[1].querySelector(".mark").click();
  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "Close").click();
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-close-many")), {
    type: "tabsearch-close-many",
    tabIds: [20, 30],
  });
  assert.deepEqual(rowTitles(harness), ["Mozilla"]);
  assert.equal(markedRows(harness).length, 0);
});

test("More menu Pin sends tabsearch-set-pinned with the derived target", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-set-pinned") {
        return SAMPLE_TABS.map((tab) => (message.tabIds.includes(tab.id) ? { ...tab, pinned: message.pinned } : tab));
      }
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  const pin = Array.from(overlayRoot(harness).querySelectorAll(".actions .menu button")).find((button) => button.textContent === "Pin");
  pin.click();
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-set-pinned")), {
    type: "tabsearch-set-pinned",
    tabIds: [20],
    pinned: true,
  });
  assert.equal(markedRows(harness).length, 0);
});

test("Ctrl+Enter marks the highlighted row, advances, and plain Enter still activates", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  pressKey(harness, "Enter", { ctrl: true });
  assert.deepEqual(markedRows(harness).map((row) => row.querySelector(".name").textContent), ["Docs"]);
  assert.equal(rows(harness)[1].getAttribute("aria-selected"), "true");

  pressKey(harness, "Enter");
  await settle();

  const activate = harness.sent.find((message) => message.type === "tabsearch-activate");
  assert.deepEqual({ ...activate }, { type: "tabsearch-activate", tabId: 30, windowId: 1 });
  assert.equal(overlayRoot(harness), null);
});

test("marks survive filtering and are pruned when a marked tab disappears", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-close") return SAMPLE_TABS.filter((tab) => tab.id !== message.tabId);
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  const input = overlayRoot(harness).querySelector(".search");
  input.value = "git";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  assert.equal(overlayRoot(harness).querySelector(".actions .count").textContent, "1 selected");
  assert.equal(markedRows(harness).length, 0, "marked tab can be hidden by the current filter");

  input.value = "";
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  rows(harness)[0].querySelector(".close").click();
  await settle();

  assert.deepEqual(rowTitles(harness), ["GitHub", "Mozilla"]);
  assert.equal(overlayRoot(harness).querySelector(".hint") !== null, true);
});

test("AI preview failure leaves selection and shows the returned message", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-ai-preview") {
        return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
      }
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  rows(harness)[0].querySelector(".mark").click();
  rows(harness)[1].querySelector(".mark").click();
  Array.from(overlayRoot(harness).querySelectorAll(".actions button")).find((button) => button.textContent === "AI group").click();
  await settle();

  assert.equal(overlayRoot(harness).querySelector(".actions .message").textContent, "AI tab grouping is turned off.");
  assert.equal(markedRows(harness).length, 2);
});

test("browse mode renders a collapsible group section and collapsing hides its members", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Docs", url: "https://docs.example.com", favIconUrl: "", active: true, currentWindow: true, pinned: false, grouped: false, groupId: -1 },
    { id: 2, windowId: 1, title: "HN", url: "https://news.ycombinator.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "Read", groupColor: "green" },
    { id: 3, windowId: 1, title: "Lobsters", url: "https://lobste.rs", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "Read", groupColor: "green" },
  ];
  const harness = createHarness({ tabs });
  pressCtrlS(harness);
  await settle();

  const root = overlayRoot(harness);
  const header = root.querySelector(".group-header");
  assert.ok(header, "a group section header is rendered in browse mode");
  assert.equal(header.querySelector(".group-badge").textContent, "Read");
  assert.equal(header.querySelector(".gcount").textContent, "2");
  // Members render, indented, with the per-row pill suppressed under the header.
  assert.equal(rows(harness).length, 3);
  assert.equal(root.querySelectorAll(".row.in-group").length, 2);
  assert.equal(root.querySelector(".row.in-group .group-badge"), null);

  // Collapsing keeps the header but hides (and de-navigates) the members.
  header.click();
  assert.ok(root.querySelector(".group-header.collapsed"));
  assert.equal(rows(harness).length, 1);
});

test("dragging a row onto a group header groups it via the target groupId", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Docs", url: "https://docs.example.com", favIconUrl: "", active: true, currentWindow: true, pinned: false, grouped: false, groupId: -1 },
    { id: 2, windowId: 1, title: "HN", url: "https://news.ycombinator.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "Read", groupColor: "green" },
  ];
  const harness = createHarness({
    tabs,
    respond(message) {
      if (message.type === "tabsearch-list") return tabs.slice();
      if (message.type === "tabsearch-group") return { ok: true, list: tabs.slice() };
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  const root = overlayRoot(harness);
  const docsRow = rows(harness)[0];
  docsRow.dispatchEvent(new harness.window.Event("dragstart", { bubbles: true }));
  const header = root.querySelector(".group-header");
  header.dispatchEvent(new harness.window.Event("drop", { bubbles: true, cancelable: true }));
  await settle();

  const sent = harness.sent.find((message) => message.type === "tabsearch-group");
  assert.ok(sent, "a group message was sent");
  assert.equal(sent.groupId, 5);
  assert.deepEqual(plain(sent.tabIds), [1]);
  assert.equal(sent.windowId, 1);
});

test("dropping a row inside a group (between two members) moves it into that group", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Docs", url: "https://d.com", favIconUrl: "", active: true, currentWindow: true, pinned: false, grouped: false, groupId: -1 },
    { id: 2, windowId: 1, title: "A", url: "https://a.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "G", groupColor: "green" },
    { id: 3, windowId: 1, title: "B", url: "https://b.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "G", groupColor: "green" },
  ];
  const harness = createHarness({
    tabs,
    respond(message) {
      if (message.type === "tabsearch-list") return tabs.slice();
      if (message.type === "tabsearch-move") return tabs.slice();
      return undefined;
    },
  });
  pressCtrlS(harness);
  await settle();

  // Visible order: Docs, [G header], A, B. Drop Docs onto A's bottom half -> between A and B.
  const rowsArr = rows(harness);
  rowsArr[0].dispatchEvent(new harness.window.Event("dragstart", { bubbles: true }));
  rowsArr[1].dispatchEvent(new harness.window.MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 100 }));
  await settle();

  const sent = harness.sent.find((message) => message.type === "tabsearch-move");
  assert.ok(sent, "a move message was sent");
  assert.deepEqual(plain(sent.tabIds), [1]);
  assert.equal(sent.anchorId, 2);
  assert.equal(sent.placeAfter, true);
  assert.equal(sent.groupId, 5);
});

test("dropping a grouped row among ungrouped rows drags it out of the group", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Docs", url: "https://d.com", favIconUrl: "", active: true, currentWindow: true, pinned: false, grouped: false, groupId: -1 },
    { id: 2, windowId: 1, title: "News", url: "https://n.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: false, groupId: -1 },
    { id: 3, windowId: 1, title: "A", url: "https://a.com", favIconUrl: "", active: false, currentWindow: true, pinned: false, grouped: true, groupId: 5, groupTitle: "G", groupColor: "green" },
  ];
  const harness = createHarness({
    tabs,
    respond(message) {
      if (message.type === "tabsearch-list") return tabs.slice();
      return tabs.slice();
    },
  });
  pressCtrlS(harness);
  await settle();

  // Visible order: Docs, News, [G header], A. Drop A onto Docs's top half -> before Docs (ungrouped).
  const rowsArr = rows(harness);
  rowsArr[2].dispatchEvent(new harness.window.Event("dragstart", { bubbles: true }));
  rowsArr[0].dispatchEvent(new harness.window.MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 0 }));
  await settle();

  const sent = harness.sent.find((message) => message.type === "tabsearch-move");
  assert.ok(sent, "a move message was sent");
  assert.deepEqual(plain(sent.tabIds), [3]);
  assert.equal(sent.anchorId, 1);
  assert.equal(sent.placeAfter, false);
  assert.equal(sent.groupId, -1);
});

test("typing in the overlay does not leak key events to the host page (focus-steal guard)", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  // Simulate a page-level bubble keydown handler like @github/hotkey on document.
  let pageSawKey = false;
  harness.document.addEventListener("keydown", () => {
    pageSawKey = true;
  });

  // A real keyboard event is composed:true, so it crosses the shadow boundary and
  // is retargeted to the host <div> on its way to document.
  const input = overlayRoot(harness).querySelector(".search");
  const event = new harness.window.KeyboardEvent("keydown", {
    key: "s",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  input.dispatchEvent(event);

  assert.equal(pageSawKey, false, "the host page never sees the keystroke while the overlay is open");
});

async function typeTabSearchQuery(harness, query) {
  const input = overlayRoot(harness).querySelector(".search");
  input.value = query;
  input.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 220));
  await settle();
}

test("web fallback row always appears for a non-empty query", async () => {
  const harness = createHarness();
  const query = "zzzznotab";
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, query);

  const root = overlayRoot(harness);
  const renderedRows = Array.from(root.querySelectorAll(".row"));
  const lastRow = renderedRows[renderedRows.length - 1];
  assert.equal(root.querySelectorAll(".row:not(.action-row)").length, 0, "no tabs match the query");
  assert.ok(lastRow.classList.contains("action-row"), "the last rendered row is an action row");
  assert.equal(lastRow.querySelector(".name").textContent, "Search the web");
  assert.match(lastRow.querySelector(".url").textContent, new RegExp(query));
  assert.ok(
    Array.from(root.querySelectorAll(".row.action-row")).some(
      (row) => row.querySelector(".name").textContent === "Search the web" && row.querySelector(".url").textContent.includes(query),
    ),
    "a web action row is rendered even when no tabs match",
  );
});

test("history rows render before the web row", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "Rust Book", url: "https://doc.rust-lang.org/book/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "rust");

  const actionRows = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row"));
  assert.equal(actionRows.length, 2);
  assert.equal(actionRows[0].querySelector(".name").textContent, "Rust Book");
  assert.equal(actionRows[0].querySelector(".url").textContent, "https://doc.rust-lang.org/book/");
  assert.equal(actionRows[1].querySelector(".name").textContent, "Search the web");

  const manyHistoryResults = Array.from({ length: 8 }, (_, index) => ({
    title: `History ${index + 1}`,
    url: `https://example.com/history/${index + 1}`,
  }));
  const cappedHarness = createHarness({
    respond(message) {
      if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
      if (message.type === "tabsearch-history") return { ok: true, results: manyHistoryResults };
      return undefined;
    },
  });
  pressCtrlS(cappedHarness);
  await settle();

  await typeTabSearchQuery(cappedHarness, "rust");

  const cappedActionRows = Array.from(overlayRoot(cappedHarness).querySelectorAll(".row.action-row"));
  const cappedHistoryRows = cappedActionRows.filter((row) => row.querySelector(".name").textContent !== "Search the web");
  assert.equal(cappedHistoryRows.length, 3);
  assert.deepEqual(
    cappedHistoryRows.map((row) => row.querySelector(".name").textContent),
    ["History 1", "History 2", "History 3"],
  );
  assert.equal(cappedActionRows[cappedActionRows.length - 1].querySelector(".name").textContent, "Search the web");
});
test("sections label open tabs, history, and search", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "Rust Book", url: "https://doc.rust-lang.org/book/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  // "git" matches the GitHub tab, so all three sections are present.
  await typeTabSearchQuery(harness, "git");

  const headers = Array.from(overlayRoot(harness).querySelectorAll(".divider.section-header")).map(
    (el) => el.textContent,
  );
  assert.deepEqual(headers, ["Open tabs", "History", "Search"]);
});

test("history entries already open as tabs are dropped", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      // https://github.com is SAMPLE_TABS' GitHub tab -> must be filtered out.
      return {
        ok: true,
        results: [
          { title: "GitHub", url: "https://github.com" },
          { title: "Rust Book", url: "https://doc.rust-lang.org/book/" },
        ],
      };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "git");

  const historyRows = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).filter(
    (row) => row.querySelector(".name").textContent !== "Search the web",
  );
  assert.deepEqual(
    historyRows.map((row) => row.querySelector(".name").textContent),
    ["Rust Book"],
  );
});

test("single-char query shows the web row but no history", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "Rust Book", url: "https://doc.rust-lang.org/book/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "z");

  const actionRows = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row"));
  assert.equal(actionRows.length, 1);
  assert.equal(actionRows[0].querySelector(".name").textContent, "Search the web");
});

test("title-less history renders a single readable label line", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "", url: "https://youtube.com/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "you");

  const historyRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).find(
    (row) => row.querySelector(".name").textContent !== "Search the web",
  );
  assert.equal(historyRow.querySelector(".name").textContent, "youtube.com");
  assert.equal(historyRow.querySelector(".url"), null, "no second URL line when the title is derived");
});

test("empty query shows no action rows", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  assert.equal(overlayRoot(harness).querySelectorAll(".row.action-row").length, 0);
});

test("activating the web row sends tabsearch-web-search and closes", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "foo");

  const webRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).find(
    (row) => row.querySelector(".name").textContent === "Search the web",
  );
  webRow.click();
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-web-search")), {
    type: "tabsearch-web-search",
    query: "foo",
  });
  assert.equal(overlayRoot(harness), null, "overlay closed after web search activation");
});

test("activating a history row sends tabsearch-open-url with the url", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "Rust Book", url: "https://doc.rust-lang.org/book/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "rust");

  const historyRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).find(
    (row) => row.querySelector(".name").textContent === "Rust Book",
  );
  historyRow.click();
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-open-url")), {
    type: "tabsearch-open-url",
    url: "https://doc.rust-lang.org/book/",
  });
});

test("action rows are not markable", async () => {
  const respond = (message) => {
    if (message.type === "tabsearch-list") return SAMPLE_TABS.slice();
    if (message.type === "tabsearch-history") {
      return { ok: true, results: [{ title: "Rust Book", url: "https://doc.rust-lang.org/book/" }] };
    }
    return undefined;
  };
  const harness = createHarness({ respond });
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "rust");

  const root = overlayRoot(harness);
  const actionRows = Array.from(root.querySelectorAll(".row.action-row"));
  assert.equal(actionRows.length, 2);
  assert.equal(root.querySelectorAll(".row.action-row .mark").length, 0, "action rows do not render mark checkboxes");
  assert.equal(root.querySelectorAll(".row.marked").length, 0);

  const webRow = actionRows.find((row) => row.querySelector(".name").textContent === "Search the web");
  webRow.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  await settle();

  assert.equal(root.querySelectorAll(".row.marked").length, 0, "Ctrl-click did not mark an action row");
  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-web-search")), {
    type: "tabsearch-web-search",
    query: "rust",
  });
});

test("Enter on the web row activates it", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "foo");
  assert.equal(overlayRoot(harness).querySelectorAll(".row.action-row").length, 1);

  pressKey(harness, "Enter");
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-web-search")), {
    type: "tabsearch-web-search",
    query: "foo",
  });
});

test("Shift+Enter runs the web search from any selection", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "git");
  // The top tab (GitHub) is selected; Shift+Enter must still hit the web row.
  assert.equal(overlayRoot(harness).querySelector(".row[aria-selected='true'] .name").textContent, "GitHub");

  pressKey(harness, "Enter", { shift: true });
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-web-search")), {
    type: "tabsearch-web-search",
    query: "git",
  });
});

test("a bare domain query becomes a Go to row and opens directly", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "github.com");

  const webRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).at(-1);
  assert.equal(webRow.querySelector(".name").textContent, "Go to github.com");
  assert.equal(webRow.querySelector(".url").textContent, "https://github.com/");

  webRow.click();
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-open-url")), {
    type: "tabsearch-open-url",
    url: "https://github.com/",
  });
  assert.equal(harness.sent.some((message) => message.type === "tabsearch-web-search"), false);
});

test("an explicit URL query opens directly, preserving the path", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "https://example.com/docs/page");

  const webRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).at(-1);
  assert.equal(webRow.querySelector(".name").textContent, "Go to example.com/docs/page");

  pressKey(harness, "Enter", { shift: true });
  await settle();

  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-open-url")), {
    type: "tabsearch-open-url",
    url: "https://example.com/docs/page",
  });
});

test("a plain word query stays a web search, not a Go to", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "git");

  const webRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).at(-1);
  assert.equal(webRow.querySelector(".name").textContent, "Search the web");

  webRow.click();
  await settle();

  assert.equal(harness.sent.some((message) => message.type === "tabsearch-open-url"), false);
  assert.deepEqual(plain(harness.sent.find((message) => message.type === "tabsearch-web-search")), {
    type: "tabsearch-web-search",
    query: "git",
  });
});

test("a query with an unknown TLD stays a web search", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  await typeTabSearchQuery(harness, "test.foo");

  const webRow = Array.from(overlayRoot(harness).querySelectorAll(".row.action-row")).at(-1);
  assert.equal(webRow.querySelector(".name").textContent, "Search the web");
});

test("opening the overlay focuses the search input", async () => {
  const harness = createHarness();
  pressCtrlS(harness);
  await settle();

  const root = overlayRoot(harness);
  assert.ok(root, "overlay is open");
  assert.equal(root.activeElement, root.querySelector(".search"), "the search input holds focus");
});
