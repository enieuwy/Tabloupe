/* global browser, TabloupeCalendar, enqueueFocusWork, handleCalendarEvents */
// Keep known event endings locally so suspension and network failures cannot strand a calendar lens.
(() => {
  const ALARM = "calendar-feed-tick";
  const cache = new Map();
  let running = null;
  let refreshPending = false;
  let sourceRevision = 0;
  let busEvents = [];
  globalThis.deliverBusCalendarEvents = async (payload) => {
    if (!payload || !Array.isArray(payload.events)) return;
    busEvents = payload.events;
    const { calendarSources = [] } = await browser.storage.local.get("calendarSources");
    if (!calendarSources.length) await handleCalendarEvents({ events: busEvents });
  };

  async function pollSources(force) {
    const revision = sourceRevision;
    const { calendarSources = [], calendarKnownEvents = {} } = await browser.storage.local.get(["calendarSources", "calendarKnownEvents"]);
    const sourcesKey = JSON.stringify(calendarSources);
    if (!calendarSources.length) return { ok: true, count: 0 };
    const now = Date.now();
    const events = [];
    const refreshErrors = [];
    const knownEvents = {};
    try {
      for (const [index, value] of calendarSources.entries()) {
        let url;
        try {
          url = TabloupeCalendar.sourceUrl(value);
          const parsed = new URL(url);
          const origin = `${parsed.protocol}//${parsed.hostname}/*`;
          if (!await browser.permissions.contains({ origins: [origin] })) throw new Error("Calendar host access is missing. Save the sources again.");
          let entry = cache.get(url);
          if (force || !entry || now - entry.at >= 15 * 60 * 1000) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
              const text = await TabloupeCalendar.fetchFeed(url, controller.signal);
              TabloupeCalendar.activeEvents(text, now, `feed-${index}`);
              entry = { text, at: now };
              if (revision === sourceRevision) cache.set(url, entry);
            } catch (error) {
              refreshErrors.push(error.name === "AbortError" ? "Calendar request timed out." : error.message);
            } finally { clearTimeout(timeout); }
          }
          knownEvents[url] = entry
            ? TabloupeCalendar.activeEvents(entry.text, now, `feed-${index}`)
            : (Array.isArray(calendarKnownEvents[url]) ? calendarKnownEvents[url] : []).filter((event) => Date.parse(event.start) <= now && now < Date.parse(event.end));
        } catch (error) {
          refreshErrors.push(error.name === "AbortError" ? "Calendar request timed out." : error.message);
          if (url) knownEvents[url] = (Array.isArray(calendarKnownEvents[url]) ? calendarKnownEvents[url] : []).filter((event) => Date.parse(event.start) <= now && now < Date.parse(event.end));
        }
        if (url) events.push(...knownEvents[url]);
      }
      return await enqueueFocusWork(async () => {
        // Check after queueing, not before: a source edit can happen while focus work waits.
        const current = await browser.storage.local.get("calendarSources");
        if (revision !== sourceRevision || JSON.stringify(current.calendarSources || []) !== sourcesKey) return { ok: false, error: "sources_changed" };
        await handleCalendarEvents({ events });
        const latest = await browser.storage.local.get("calendarSources");
        if (revision !== sourceRevision || JSON.stringify(latest.calendarSources || []) !== sourcesKey) return { ok: false, error: "sources_changed" };
        const detail = refreshErrors.length
          ? `${refreshErrors.join(" ")} Using available calendar data until the next successful refresh.`
          : `${events.length} active calendar events`;
        await browser.storage.local.set({ calendarKnownEvents: knownEvents, calendarFeedStatus: { at: now, ok: refreshErrors.length === 0, detail } });
        return { ok: refreshErrors.length === 0, count: events.length, ...(refreshErrors.length ? { error: detail } : {}) };
      });
    } catch (error) {
      const detail = error.name === "AbortError" ? "Calendar request timed out." : error.message;
      return enqueueFocusWork(async () => {
        const current = await browser.storage.local.get("calendarSources");
        if (revision !== sourceRevision || JSON.stringify(current.calendarSources || []) !== sourcesKey) return { ok: false, error: "sources_changed" };
        await browser.storage.local.set({ calendarFeedStatus: { at: now, ok: false, detail } });
        return { ok: false, error: detail };
      });
    }
  }

  function poll(force = false) {
    if (running) {
      if (force) refreshPending = true;
      return running;
    }
    running = (async () => {
      let result;
      do {
        const refresh = force || refreshPending;
        force = false;
        refreshPending = false;
        result = await pollSources(refresh);
      } while (refreshPending);
      return result;
    })().finally(() => {
      running = null;
      if (refreshPending) poll(true).catch(console.error);
    });
    return running;
  }

  async function reconcile() {
    const revision = sourceRevision;
    const { calendarSources = [] } = await browser.storage.local.get("calendarSources");
    if (revision !== sourceRevision) return;
    if (calendarSources.length) {
      await browser.alarms.create(ALARM, { periodInMinutes: 1 });
      await poll(true);
    } else {
      await browser.alarms.clear(ALARM);
      cache.clear();
      await enqueueFocusWork(async () => {
        const current = await browser.storage.local.get("calendarSources");
        if (revision !== sourceRevision || (current.calendarSources || []).length) return;
        await browser.storage.local.set({ calendarKnownEvents: {} });
      });
    }
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) poll().catch(console.error);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.calendarSources) {
      sourceRevision += 1;
      if (running) refreshPending = true;
      cache.clear();
      reconcile().catch(console.error);
      if (!(changes.calendarSources.newValue || []).length) {
        enqueueFocusWork(async () => {
          const current = await browser.storage.local.get("calendarSources");
          if (!(current.calendarSources || []).length) await handleCalendarEvents({ events: busEvents });
        }).catch(console.error);
      }
    }
  });
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "calendar-feed-refresh") return poll(true);
  });
  reconcile().catch(console.error);
})();
