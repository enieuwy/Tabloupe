/* global browser, TabloupeCalendar, enqueueFocusWork, handleCalendarEvents */
// Keep known event endings locally so suspension and network failures cannot strand a calendar lens.
(() => {
  const ALARM = "calendar-feed-tick";
  const cache = new Map();
  let running = null;
  let busEvents = [];
  globalThis.deliverBusCalendarEvents = async (payload) => {
    if (!payload || !Array.isArray(payload.events)) return;
    busEvents = payload.events;
    const { calendarSources = [] } = await browser.storage.local.get("calendarSources");
    if (!calendarSources.length) await handleCalendarEvents({ events: busEvents });
  };

  async function poll(force = false) {
    if (running) return running;
    running = (async () => {
      const { calendarSources = [], calendarKnownEvents = {} } = await browser.storage.local.get(["calendarSources", "calendarKnownEvents"]);
      if (!calendarSources.length) return { ok: true, count: 0 };
      const now = Date.now();
      const events = [];
      const refreshErrors = [];
      const knownEvents = {};
      try {
        for (const [index, value] of calendarSources.entries()) {
          const url = TabloupeCalendar.sourceUrl(value);
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
              cache.set(url, entry);
            } catch (error) {
              refreshErrors.push(error.name === "AbortError" ? "Calendar request timed out." : error.message);
              if (!entry) {
                if (!Array.isArray(calendarKnownEvents[url])) throw error;
                knownEvents[url] = calendarKnownEvents[url].filter((event) => Date.parse(event.start) <= now && now < Date.parse(event.end));
                events.push(...knownEvents[url]);
                continue;
              }
            } finally { clearTimeout(timeout); }
          }
          knownEvents[url] = TabloupeCalendar.activeEvents(entry.text, now, `feed-${index}`);
          events.push(...knownEvents[url]);
        }
        // A feed edit during a fetch must not activate its old events.
        const current = await browser.storage.local.get("calendarSources");
        if (JSON.stringify(current.calendarSources || []) !== JSON.stringify(calendarSources)) return { ok: false, error: "sources_changed" };
        await enqueueFocusWork(() => handleCalendarEvents({ events }));
        const detail = refreshErrors.length
          ? `${refreshErrors.join(" ")} Using the last valid calendar until the next successful refresh.`
          : `${events.length} active calendar events`;
        await browser.storage.local.set({ calendarKnownEvents: knownEvents, calendarFeedStatus: { at: now, ok: refreshErrors.length === 0, detail } });
        return { ok: refreshErrors.length === 0, count: events.length, ...(refreshErrors.length ? { error: detail } : {}) };
      } catch (error) {
        // Do not treat a failed feed as an empty calendar and revert the user's view.
        const detail = error.name === "AbortError" ? "Calendar request timed out." : error.message;
        await browser.storage.local.set({ calendarFeedStatus: { at: now, ok: false, detail } });
        return { ok: false, error: detail };
      }
    })().finally(() => { running = null; });
    return running;
  }

  async function reconcile() {
    const { calendarSources = [] } = await browser.storage.local.get("calendarSources");
    if (calendarSources.length) {
      await browser.alarms.create(ALARM, { periodInMinutes: 1 });
      await poll(true);
    } else {
      await browser.alarms.clear(ALARM);
      cache.clear();
      await browser.storage.local.set({ calendarKnownEvents: {} });
    }
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) poll().catch(console.error);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.calendarSources) {
      cache.clear();
      reconcile().catch(console.error);
      if (!(changes.calendarSources.newValue || []).length) {
        enqueueFocusWork(() => handleCalendarEvents({ events: busEvents })).catch(console.error);
      }
    }
  });
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "calendar-feed-refresh") return poll(true);
  });
  reconcile().catch(console.error);
})();
