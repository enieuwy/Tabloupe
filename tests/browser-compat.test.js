const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const calendar = require("../calendar.js");

const compatSource = fs.readFileSync(path.join(__dirname, "../browser-compat.js"), "utf8");
const nativeSource = fs.readFileSync(path.join(__dirname, "../native-runtime.js"), "utf8");
const calendarSource = fs.readFileSync(path.join(__dirname, "../calendar-runtime.js"), "utf8");

function createHarness(chrome = {}) {
  const listeners = [];
  chrome.tabs ||= {};
  chrome.runtime = {
    onMessage: {
      addListener(listener) { listeners.push(listener); },
      removeListener(listener) {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
      hasListener(listener) { return listeners.includes(listener); },
    },
    sendMessage(message) {
      return new Promise((resolve) => {
        let responded = false;
        let pending = false;
        const sendResponse = (response) => {
          if (responded) return;
          responded = true;
          resolve(response);
        };
        for (const listener of listeners) {
          if (listener(message, {}, sendResponse) === true) pending = true;
        }
        if (!responded && !pending) resolve(undefined);
      });
    },
  };
  const context = vm.createContext({ chrome, console });
  vm.runInContext(compatSource, context, { filename: "browser-compat.js" });
  return { chrome, context, browser: context.browser };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createDiscardHarness({ failures = new Map(), gates = new Map() } = {}) {
  const tabs = new Map([5, 7, 9].map((id) => [id, { id, discarded: false }]));
  const calls = [];
  const chrome = {
    tabs: {
      discard(id) {
        if (!Number.isInteger(id)) throw new TypeError("Chromium discard requires a scalar tab ID");
        calls.push(id);
        const failure = failures.get(id);
        if (failure?.synchronous) throw failure.error;
        if (failure) return Promise.reject(failure.error);
        const finish = () => {
          const tab = tabs.get(id);
          tab.discarded = true;
          return { ...tab };
        };
        return gates.has(id) ? gates.get(id).promise.then(finish) : Promise.resolve(finish());
      },
    },
  };
  return { ...createHarness(chrome), tabs, calls };
}

function discardState(run) {
  return Array.from(run.tabs.values(), (tab) => [tab.id, tab.discarded]);
}

test("false and undefined listeners do not replace native bookmark or window replies", async () => {
  const run = createHarness({
    permissions: { async contains() { return true; } },
    storage: { onChanged: { addListener() {} } },
    tabs: { async query() { return [{ url: "https://open.example/page" }]; } },
    bookmarks: { async search() { return [
      { title: "Already open", url: "https://open.example/page" },
      { title: "Saved page", url: "https://saved.example/page" },
    ]; } },
    windows: { async getAll() { return [{ id: 10, incognito: false, tabs: [{ active: true, title: "Work" }] }]; } },
  });
  run.context.normalizeHistoryUrl = (value) => {
    const url = new URL(value);
    return url.host + url.pathname;
  };
  run.context.searchHistoryFromSearch = async () => ({ results: [] });
  run.browser.runtime.onMessage.addListener(() => false);
  run.browser.runtime.onMessage.addListener(() => undefined);
  vm.runInContext(nativeSource, run.context, { filename: "native-runtime.js" });

  const bookmarks = await run.browser.runtime.sendMessage({ type: "tabsearch-bookmarks", query: "page" });
  assert.equal(bookmarks.ok, true);
  assert.equal(bookmarks.enabled, true);
  assert.deepEqual(Array.from(bookmarks.results, (item) => item.url), ["https://saved.example/page"]);
  const windows = await run.browser.runtime.sendMessage({ type: "tabsearch-windows" });
  assert.equal(windows.ok, true);
  assert.deepEqual(Array.from(windows.windows, (item) => [item.id, item.title, item.tabCount]), [[10, "Work", 1]]);
});

test("an unhandled first listener does not swallow a calendar refresh reply", async () => {
  const url = "https://calendar.example/events.ics";
  const storage = { calendarSources: [url], calendarKnownEvents: {} };
  const applied = [];
  const fetch = deferred();
  const run = createHarness({
    permissions: { async contains() { return true; } },
    storage: {
      local: {
        async get() { return storage; },
        async set(values) { Object.assign(storage, values); },
      },
      onChanged: { addListener() {} },
    },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
  });
  run.context.URL = URL;
  run.context.Date = class extends Date { static now() { return Date.parse("2026-10-03T01:30:00Z"); } };
  run.context.AbortController = AbortController;
  run.context.setTimeout = setTimeout;
  run.context.clearTimeout = clearTimeout;
  run.context.TabloupeCalendar = { ...calendar, fetchFeed: () => fetch.promise };
  run.context.enqueueFocusWork = (fn) => fn();
  run.context.handleCalendarEvents = async ({ events }) => { applied.push(events); };
  run.browser.runtime.onMessage.addListener(() => false);
  run.browser.runtime.onMessage.addListener(() => undefined);
  vm.runInContext(calendarSource, run.context, { filename: "calendar-runtime.js" });

  const reply = run.browser.runtime.sendMessage({ type: "calendar-feed-refresh" });
  fetch.resolve("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:work\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:Deep work\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  const result = await reply;
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(Array.from(applied.at(-1), (event) => event.title), ["Deep work"]);
  assert.equal(storage.calendarFeedStatus.ok, true);
});

test("message replies preserve asynchronous false values and report thrown or rejected errors", async () => {
  const run = createHarness();
  run.browser.runtime.onMessage.addListener((message) => {
    if (message.type === "disabled") return Promise.resolve(false);
    if (message.type === "sync-error") throw new Error("Synchronous failure");
    if (message.type === "async-error") return Promise.reject(new Error("Asynchronous failure"));
  });
  assert.equal(await run.browser.runtime.sendMessage({ type: "disabled" }), false);
  for (const [type, message] of [["sync-error", "Synchronous failure"], ["async-error", "Asynchronous failure"]]) {
    const response = await run.browser.runtime.sendMessage({ type });
    assert.equal(response.ok, false);
    assert.equal(response.error, message);
  }
});

test("scalar discard preserves success and a failure that consumers can catch", async () => {
  const failure = new Error("Cannot discard the active tab");
  const run = createDiscardHarness({ failures: new Map([[7, { error: failure }]]) });
  const result = await run.browser.tabs.discard(5);
  assert.equal(result.id, 5);
  assert.equal(result.discarded, true);
  await assert.rejects(run.browser.tabs.discard(7), (error) => error === failure);
  assert.deepEqual(run.calls, [5, 7]);
  assert.deepEqual(discardState(run), [[5, true], [7, false], [9, false]]);
});

test("array discard calls Chromium in input order and keeps result order despite reverse completion", async () => {
  const gates = new Map([5, 7, 9].map((id) => [id, deferred()]));
  const run = createDiscardHarness({ gates });
  const reply = run.browser.tabs.discard([9, 5, 7]);
  assert.deepEqual(run.calls, [9, 5, 7]);
  for (const id of [7, 5, 9]) gates.get(id).resolve();
  const results = await reply;
  assert.deepEqual(Array.from(results, (tab) => [tab.id, tab.discarded]), [[9, true], [5, true], [7, true]]);
  assert.deepEqual(discardState(run), [[5, true], [7, true], [9, true]]);
});

test("array discard exposes the original failure and still attempts later tabs", async () => {
  for (const synchronous of [false, true]) {
    const failure = new Error("Cannot discard the active tab");
    const run = createDiscardHarness({ failures: new Map([[5, { error: failure, synchronous }]]) });
    await assert.rejects(run.browser.tabs.discard([9, 5, 7]), (error) => error === failure);
    assert.deepEqual(run.calls, [9, 5, 7]);
    assert.deepEqual(discardState(run), [[5, false], [7, true], [9, true]]);
  }
});

test("an existing Firefox browser object and its native discard API remain unchanged", () => {
  const browser = { tabs: { discard() { throw new Error("Native Firefox API"); } } };
  const context = vm.createContext({ browser, chrome: {} });
  vm.runInContext(compatSource, context, { filename: "browser-compat.js" });
  assert.equal(context.browser, browser);
  assert.equal(context.browser.tabs.discard, browser.tabs.discard);
});
