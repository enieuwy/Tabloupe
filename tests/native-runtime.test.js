const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../native-runtime.js"), "utf8");

function harness({ privateTarget = false, failId = null, bookmarkPermission = false } = {}) {
  let onMessage;
  const tabs = new Map([[1, { id: 1, windowId: 10, incognito: false, url: "https://open.example/page" }], [2, { id: 2, windowId: 10, incognito: false, url: "https://other.example/page" }]]);
  let moveCount = 0;
  const context = {
    console,
    browser: {
      runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
      permissions: { async contains({ permissions }) { return permissions.includes("bookmarks") && bookmarkPermission; } },
      storage: { onChanged: { addListener() {} } },
      tabs: {
        async get(id) { if (!tabs.has(id)) throw new Error("missing_tab"); return tabs.get(id); },
        async query() { return [...tabs.values()]; },
        async move(id, { windowId }) { moveCount += 1; if (id === failId) throw new Error("move_failed"); tabs.get(id).windowId = windowId; },
      },
      windows: { async get(id) { if (id !== 20) throw new Error("missing_window"); return { id, type: "normal", incognito: privateTarget }; } },
      bookmarks: { async search() { return [
        { title: "Open duplicate", url: "https://open.example/page#fragment" },
        { title: "History duplicate", url: "https://history.example/page" },
        { title: "Saved page", url: "https://saved.example/page" },
        { title: "Saved duplicate", url: "https://saved.example/page#part" },
        { title: "Executable bookmark", url: "javascript:alert(1)" },
      ]; } },
    },
    enqueueFocusWork: (fn) => fn(),
    listTabsForSearch: async () => [...tabs.values()],
    normalizeHistoryUrl: (value) => { const url = new URL(value); return url.host + url.pathname; },
    searchHistoryFromSearch: async () => ({ ok: true, results: [{ title: "History", url: "https://history.example/page" }] }),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { request: (message) => onMessage(message), tabs, moves: () => moveCount };
}

test("existing-window move rejects missing and private destinations before moving any tabs", async () => {
  for (const [config, targetWindowId] of [[{}, 99], [{ privateTarget: true }, 20]]) {
    const run = harness(config);
    const result = await run.request({ type: "tabsearch-move-to-window", tabIds: [1, 2], targetWindowId });
    assert.equal(result.error, "invalid_window");
    assert.equal(run.moves(), 0);
    assert.equal(run.tabs.get(1).windowId, 10);
  }
});

test("existing-window partial move reports only the unmoved tab and keeps the refreshed state", async () => {
  const run = harness({ failId: 2 });
  const result = await run.request({ type: "tabsearch-move-to-window", tabIds: [1, 2], targetWindowId: 20 });
  assert.equal(result.ok, false);
  assert.deepEqual(Array.from(result.failed), [2]);
  assert.equal(result.list.find((tab) => tab.id === 1).windowId, 20);
  assert.equal(result.list.find((tab) => tab.id === 2).windowId, 10);
});

test("bookmark results omit open/history duplicates and non-web URLs; denial returns no results", async () => {
  const allowed = await harness({ bookmarkPermission: true }).request({ type: "tabsearch-bookmarks", query: "page" });
  assert.deepEqual(Array.from(allowed.results, (item) => item.url), ["https://saved.example/page"]);
  const denied = await harness().request({ type: "tabsearch-bookmarks", query: "page" });
  assert.equal(denied.enabled, false);
  assert.deepEqual(Array.from(denied.results), []);
});
