/* global ICAL */
// ICS parsing is shared by the event page, service worker, and fixture checks.
(function (root) {
  const parser = typeof ICAL !== "undefined" ? ICAL : require("ical.js");
  const MAX_BYTES = 2 * 1024 * 1024;

  function sourceUrl(value) {
    const url = new URL(String(value).trim().replace(/^webcal:/i, "https:"));
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.hash) {
      throw new Error("Use an HTTPS calendar URL without credentials or a fragment.");
    }
    return url.href;
  }

  function activeEvents(text, now = Date.now(), sourceId = "ics") {
    if (typeof text !== "string" || text.length > MAX_BYTES) throw new Error("Calendar exceeds 2 MiB.");
    const component = new parser.Component(parser.parse(text));
    if (component.name !== "vcalendar") throw new Error("The feed is not an iCalendar calendar.");
    const zones = new Set(["UTC", "GMT", "Z"]);
    for (const zone of component.getAllSubcomponents("vtimezone")) {
      const id = zone.getFirstPropertyValue("tzid");
      if (id) {
        parser.TimezoneService.register(id, new parser.Timezone(zone));
        zones.add(id);
      }
    }
    const records = component.getAllSubcomponents("vevent");
    if (records.length > 5000) throw new Error("Calendar exceeds 5000 events.");
    for (const record of records) {
      for (const name of ["dtstart", "dtend", "recurrence-id", "exdate", "rdate"]) {
        for (const property of record.getAllProperties(name)) {
          const zone = property.getParameter("tzid");
          if (zone && !zones.has(zone)) throw new Error(`Calendar must include VTIMEZONE for ${zone}.`);
        }
      }
    }
    const byUid = new Map();
    for (const record of records) {
      const event = new parser.Event(record);
      const uid = event.uid;
      if (!uid || !record.hasProperty("dtstart")) throw new Error("Calendar event is missing UID or DTSTART.");
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(event);
    }
    const active = [];
    let iterations = 0;
    function add(event, start, end) {
      if (event.component.getFirstPropertyValue("status") === "CANCELLED") return;
      const startMs = start.toJSDate().getTime();
      const endMs = end.toJSDate().getTime();
      if (startMs <= now && now < endMs && event.summary) {
        active.push({ id: `${sourceId}:${event.uid}`, title: event.summary, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
      }
    }
    for (const events of byUid.values()) {
      const master = events.find((event) => !event.isRecurrenceException());
      if (!master || master.component.getFirstPropertyValue("status") === "CANCELLED") continue;
      for (const exception of events) if (exception !== master) master.relateException(exception);
      if (!master.isRecurring()) {
        add(master, master.startDate, master.endDate);
        continue;
      }
      const iterator = master.iterator();
      let occurrence;
      while ((occurrence = iterator.next())) {
        if (++iterations > 50000) throw new Error("Calendar recurrence limit exceeded. Use a shorter subscription range.");
        // Exception start times can move backwards, so also inspect exceptions below.
        if (occurrence.toJSDate().getTime() > now) break;
        const detail = master.getOccurrenceDetails(occurrence);
        add(detail.item, detail.startDate, detail.endDate);
      }
      for (const exception of events) if (exception !== master) add(exception, exception.startDate, exception.endDate);
    }
    return [...new Map(active.map((event) => [`${event.id}|${event.start}`, event])).values()];
  }

  async function fetchFeed(url, signal) {
    const response = await fetch(sourceUrl(url), { signal, credentials: "omit", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error(`Calendar HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Calendar exceeds 2 MiB.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("Calendar exceeds 2 MiB.");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const api = { sourceUrl, activeEvents, fetchFeed };
  root.TabloupeCalendar = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
