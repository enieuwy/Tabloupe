const test = require("node:test");
const assert = require("node:assert/strict");
const { activeEvents, sourceUrl } = require("../calendar.js");
const feed = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR\r\n`;
const event = (extra = "") => `BEGIN:VEVENT\r\nUID:work\r\nDTSTART:20261003T010000Z\r\nDTEND:20261003T020000Z\r\nSUMMARY:Deep work\r\n${extra}\r\nEND:VEVENT`;

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
  const vm = require("node:vm");
  const fs = require("node:fs");
  const url = "https://calendar.example/events.ics";
  const storage = { calendarSources: [url], calendarKnownEvents: { [url]: [{ id: "feed-0:work", title: "Deep work", start: "2020-01-01T01:00:00Z", end: "2020-01-01T02:00:00Z" }] } };
  const applied = [];
  let request;
  const context = {
    URL, Date, AbortController, setTimeout, clearTimeout, console,
    TabloupeCalendar: { sourceUrl, activeEvents, async fetchFeed() { throw new Error("offline"); } },
    enqueueFocusWork: (fn) => fn(),
    handleCalendarEvents: async (payload) => applied.push(payload.events),
    browser: {
      storage: { local: { async get() { return storage; }, async set(values) { Object.assign(storage, values); } }, onChanged: { addListener() {} } },
      permissions: { async contains() { return true; } },
      alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { request = fn; } } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../calendar-runtime.js"), "utf8"), context);
  const result = await request({ type: "calendar-feed-refresh" });
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
  assert.equal(applied.at(-1).length, 0);
  assert.equal(storage.calendarFeedStatus.ok, false);
});
