const test = require("node:test");
const assert = require("node:assert/strict");
const { activeEvents, sourceUrl } = require("../calendar.js");
const vm = require("node:vm");
const fs = require("node:fs");
const feed = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR\r\n`;
const event = (extra = "") => `BEGIN:VEVENT\r\nUID:work\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:Deep work\r\n${extra}\r\nEND:VEVENT`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createRuntimeHarness({ calendarSources, calendarKnownEvents = {}, fetchFeed, now = Date.parse("2026-10-03T01:30:00Z") }) {
  const storage = { calendarSources, calendarKnownEvents };
  const applied = [];
  const writes = [];
  const fetched = [];
  let request;
  let onChanged;
  let focusQueue = Promise.resolve();
  let focusBlock = null;
  const local = {
    async get() { return structuredClone(storage); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(storage[key]) !== JSON.stringify(value)) {
          changes[key] = { oldValue: structuredClone(storage[key]), newValue: structuredClone(value) };
        }
      }
      Object.assign(storage, structuredClone(values));
      writes.push(structuredClone(values));
      if (Object.keys(changes).length) onChanged(changes, "local");
    },
  };
  const context = {
    URL, Date: class extends Date { static now() { return now; } }, AbortController, setTimeout, clearTimeout, console,
    TabloupeCalendar: {
      sourceUrl, activeEvents,
      async fetchFeed(url, signal) {
        fetched.push(url);
        return fetchFeed(url, signal);
      },
    },
    enqueueFocusWork(fn) {
      const block = focusBlock;
      if (block) block.queued.resolve();
      const queued = focusQueue.then(async () => {
        if (block) await block.gate.promise;
        return fn();
      });
      focusQueue = queued.catch(() => {});
      return queued;
    },
    handleCalendarEvents: async (payload) => applied.push(structuredClone(payload.events)),
    browser: {
      storage: { local, onChanged: { addListener(fn) { onChanged = fn; } } },
      permissions: { async contains() { return true; } },
      alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { request = fn; } } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../calendar-runtime.js"), "utf8"), context);
  return {
    storage, applied, writes, fetched,
    refresh: () => request({ type: "calendar-feed-refresh" }),
    setNow(value) { now = Date.parse(value); },
    setSources: (sources) => local.set({ calendarSources: sources }),
    deliverBus: (events) => context.deliverBusCalendarEvents({ events }),
    drainFocus: () => focusQueue,
    blockFocus() {
      const block = { gate: deferred(), queued: deferred() };
      focusBlock = block;
      return {
        queued: block.queued.promise,
        release() {
          focusBlock = null;
          block.gate.resolve();
        },
      };
    },
  };
}

test("calendar includes start, excludes end, and preserves the matching title", () => {
  const text = feed(event());
  assert.equal(activeEvents(text, Date.parse("2026-10-03T00:59:59Z")).length, 0);
  assert.deepEqual(activeEvents(text, Date.parse("2026-10-03T01:00:00Z")), [{ id: "ics:work", title: "Deep work", start: "2026-10-03T01:00:00.000Z", end: "2026-10-03T02:00:00.000Z" }]);
  assert.equal(activeEvents(text, Date.parse("2026-10-03T02:00:00Z")).length, 0);
});

test("calendar recurring events honor exclusion dates and cancelled exceptions", () => {
  const text = feed(event("RRULE:FREQ=DAILY;COUNT=4\r\nEXDATE:20261004T010000Z") + "\r\n" + event("RECURRENCE-ID:20261005T010000Z\r\nSTATUS:CANCELLED").replace("DTSTART:20261003", "DTSTART:20261005").replace("DTEND:20261003", "DTEND:20261005"));
  assert.equal(activeEvents(text, Date.parse("2026-10-04T01:30:00Z")).length, 0);
  assert.equal(activeEvents(text, Date.parse("2026-10-05T01:30:00Z")).length, 0);
  assert.equal(activeEvents(text, Date.parse("2026-10-06T01:30:00Z"))[0].start, "2026-10-06T01:00:00.000Z");
});

test("calendar preserves folded and escaped summary text", () => {
  const text = feed(event().replace("SUMMARY:Deep work", "SUMMARY:Deep\\, work and\r\n research"));
  assert.equal(activeEvents(text, Date.parse("2026-10-03T01:30:00Z"))[0].title, "Deep, work andresearch");
});

test("calendar rejects unknown time zones instead of treating them as local", () => {
  const text = feed(event().replace("DTSTART:20261003T010000Z", "DTSTART;TZID=Missing/Zone:20261003T010000"));
  assert.throws(() => activeEvents(text), /VTIMEZONE/);
});

test("calendar subscription URLs keep secret query tokens but reject unsafe transports", () => {
  assert.equal(sourceUrl("webcal://calendar.example/private.ics?token=abc"), "https://calendar.example/private.ics?token=abc");
  assert.equal(sourceUrl("http://127.0.0.1:18767/test.ics"), "http://127.0.0.1:18767/test.ics");
  for (const url of ["http://calendar.example/x", "https://user:pass@calendar.example/x", "file:///tmp/x", "https://calendar.example/x#part"]) assert.throws(() => sourceUrl(url));
});

test("malformed events do not masquerade as a successful empty calendar", () => {
  assert.throws(() => activeEvents(feed(event().replace("UID:work\r\n", ""))), /UID or DTSTART/);
  assert.throws(() => activeEvents(feed(event().replace("DTSTART:20261003T010000Z\r\n", ""))), /UID or DTSTART/);
});

test("a failed calendar fetch after worker suspension still expires known events", async () => {
  const url = "https://calendar.example/events.ics";
  const harness = createRuntimeHarness({
    calendarSources: [url],
    calendarKnownEvents: { [url]: [{ id: "feed-0:work", title: "Deep work", start: "2020-01-01T01:00:00Z", end: "2020-01-01T02:00:00Z" }] },
    async fetchFeed() { throw new Error("offline"); },
  });
  const result = await harness.refresh();
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
  assert.deepEqual(harness.applied.at(-1), []);
  assert.equal(harness.storage.calendarFeedStatus.ok, false);
});

test("an uncached failed source does not block another source's activation or expiry", async () => {
  const missing = "https://missing.example/events.ics";
  const valid = "https://calendar.example/events.ics";
  let offline = false;
  const harness = createRuntimeHarness({
    calendarSources: [missing, valid],
    async fetchFeed(url) {
      if (url === missing || offline) throw new Error("offline");
      return feed(event());
    },
  });
  const active = await harness.refresh();
  assert.equal(active.ok, false);
  assert.equal(active.count, 1);
  assert.deepEqual(harness.applied.at(-1), [{ id: "feed-1:work", title: "Deep work", start: "2026-10-03T01:00:00.000Z", end: "2026-10-03T02:00:00.000Z" }]);
  assert.deepEqual(harness.storage.calendarKnownEvents[missing], []);
  assert.equal(harness.storage.calendarFeedStatus.ok, false);
  offline = true;
  harness.setNow("2026-10-03T02:00:00Z");
  const ended = await harness.refresh();
  assert.equal(ended.ok, false);
  assert.equal(ended.count, 0);
  assert.match(ended.error, /offline/);
  assert.deepEqual(harness.applied.at(-1), []);
  assert.deepEqual(harness.storage.calendarKnownEvents[valid], []);
  assert.equal(harness.storage.calendarFeedStatus.ok, false);
});

test("an uncached failed source does not strand an ended event after worker suspension", async () => {
  const missing = "https://missing.example/events.ics";
  const known = "https://calendar.example/events.ics";
  const harness = createRuntimeHarness({
    calendarSources: [missing, known],
    calendarKnownEvents: { [known]: [{ id: "feed-1:work", title: "Deep work", start: "2026-10-03T01:00:00Z", end: "2026-10-03T02:00:00Z" }] },
    now: Date.parse("2026-10-03T02:00:00Z"),
    async fetchFeed() { throw new Error("offline"); },
  });
  const result = await harness.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.deepEqual(harness.applied.at(-1), []);
  assert.deepEqual(harness.storage.calendarKnownEvents[known], []);
  assert.equal(harness.storage.calendarFeedStatus.ok, false);
  assert.match(harness.storage.calendarFeedStatus.detail, /offline/);
});

test("a source edit in the focus queue drops old events and refreshes the current source", async () => {
  const oldSource = "https://old.example/events.ics";
  const newSource = "https://new.example/events.ics";
  const harness = createRuntimeHarness({
    calendarSources: [oldSource],
    async fetchFeed(url) {
      return feed(event().replace("UID:work", url === oldSource ? "UID:old" : "UID:new").replace("Deep work", url === oldSource ? "Old work" : "New work"));
    },
  });
  await harness.refresh();
  harness.applied.length = 0;
  harness.writes.length = 0;
  harness.fetched.length = 0;
  const block = harness.blockFocus();
  const refresh = harness.refresh();
  await block.queued;
  await harness.setSources([newSource]);
  block.release();
  const result = await refresh;
  assert.equal(result.ok, true);
  assert.deepEqual(harness.applied, [[{ id: "feed-0:new", title: "New work", start: "2026-10-03T01:00:00.000Z", end: "2026-10-03T02:00:00.000Z" }]]);
  assert.deepEqual(harness.fetched, [oldSource, newSource]);
  assert.deepEqual(Object.keys(harness.storage.calendarKnownEvents), [newSource]);
  assert.deepEqual(harness.writes.filter((values) => values.calendarKnownEvents).map((values) => Object.keys(values.calendarKnownEvents)), [[newSource]]);
  assert.equal(harness.storage.calendarFeedStatus.ok, true);
});

test("a source edit during a fetch starts a refresh for the current source", async () => {
  const oldSource = "https://old.example/events.ics";
  const newSource = "https://new.example/events.ics";
  const started = deferred();
  const fetched = deferred();
  let holdOld = false;
  const harness = createRuntimeHarness({
    calendarSources: [oldSource],
    async fetchFeed(url) {
      if (url === oldSource && holdOld) {
        started.resolve();
        await fetched.promise;
      }
      return feed(event().replace("UID:work", url === oldSource ? "UID:old" : "UID:new"));
    },
  });
  await harness.refresh();
  harness.applied.length = 0;
  harness.writes.length = 0;
  harness.fetched.length = 0;
  holdOld = true;
  const refresh = harness.refresh();
  await started.promise;
  await harness.setSources([newSource]);
  fetched.resolve();
  const result = await refresh;
  assert.equal(result.ok, true);
  assert.deepEqual(harness.applied, [[{ id: "feed-0:new", title: "Deep work", start: "2026-10-03T01:00:00.000Z", end: "2026-10-03T02:00:00.000Z" }]]);
  assert.deepEqual(harness.fetched, [oldSource, newSource]);
  assert.deepEqual(harness.writes.filter((values) => values.calendarKnownEvents).map((values) => Object.keys(values.calendarKnownEvents)), [[newSource]]);
});

test("clearing sources drops queued feed events and returns to the saved bus events", async () => {
  const url = "https://calendar.example/events.ics";
  const harness = createRuntimeHarness({ calendarSources: [url], async fetchFeed() { return feed(event()); } });
  await harness.refresh();
  harness.applied.length = 0;
  const busEvents = [{ id: "bus:event", title: "Bus work", start: "2026-10-03T01:00:00Z" }];
  await harness.deliverBus(busEvents);
  assert.deepEqual(harness.applied, []);
  const block = harness.blockFocus();
  const refresh = harness.refresh();
  await block.queued;
  await harness.setSources([]);
  block.release();
  await refresh;
  await harness.drainFocus();
  assert.deepEqual(harness.applied, [busEvents]);
  assert.deepEqual(harness.storage.calendarKnownEvents, {});
});
