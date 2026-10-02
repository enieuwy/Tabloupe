/* global browser */
(() => {
  const card = document.getElementById("automation-card");
  const panel = document.createElement("div");
  panel.className = "setting-group";
  const heading = document.createElement("h3");
  heading.textContent = "Calendar subscriptions";
  const description = document.createElement("p");
  description.textContent = "Add up to five HTTPS or webcal ICS URLs, one per line. Google Calendar secret ICS addresses work here. URLs stay on this device. Feeds refresh every 15 minutes; lens matching runs each minute. While enabled, feeds replace the helper's calendar source.";
  const input = document.createElement("textarea");
  input.id = "calendar-sources";
  input.rows = 3;
  input.style.width = "100%";
  input.setAttribute("aria-label", "Calendar subscription URLs");
  input.spellcheck = false;
  const save = document.createElement("button");
  save.textContent = "Save calendar sources";
  save.id = "calendar-sources-save";
  const refresh = document.createElement("button");
  refresh.textContent = "Refresh calendars";
  refresh.id = "calendar-refresh";
  const status = document.createElement("p");
  status.id = "calendar-feed-status";
  status.setAttribute("role", "status");
  panel.append(heading, description, input, save, refresh, status);
  card.append(panel);
  function renderStatus(value) {
    status.textContent = value ? `${value.ok ? "Ready" : "Error"}: ${value.detail}` : "No calendar check yet.";
  }
  browser.storage.local.get(["calendarSources", "calendarFeedStatus"]).then((stored) => {
    input.value = (stored.calendarSources || []).join("\n");
    renderStatus(stored.calendarFeedStatus);
  }).catch((error) => { status.textContent = error.message; });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const urls = [...new Set(input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
      if (urls.length > 5) throw new Error("Use no more than five calendar sources.");
      const normalized = urls.map((value) => {
        const url = new URL(value.replace(/^webcal:/i, "https:"));
        const local = ["localhost", "127.0.0.1"].includes(url.hostname);
        if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.hash) {
          throw new Error("Use HTTPS URLs without credentials or fragments. HTTP is only available for localhost and 127.0.0.1.");
        }
        return url.href;
      });
      const origins = [...new Set(normalized.map((value) => {
        const url = new URL(value);
        return `${url.protocol}//${url.hostname}/*`;
      }))];
      if (origins.length && !await browser.permissions.request({ origins })) throw new Error("Calendar host access was not granted.");
      await browser.storage.local.set({ calendarSources: normalized });
      input.value = normalized.join("\n");
      status.textContent = normalized.length ? "Saved. Checking calendar feeds…" : "Calendar subscriptions disabled.";
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    try {
      const result = await browser.runtime.sendMessage({ type: "calendar-feed-refresh" });
      status.textContent = result?.ok ? `${result.count} active calendar events` : result?.error || "Calendar refresh failed.";
    } catch (error) { status.textContent = error.message; }
    finally { refresh.disabled = false; }
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.calendarFeedStatus) renderStatus(changes.calendarFeedStatus.newValue);
  });

  const native = document.createElement("div");
  native.className = "setting-group";
  const title = document.createElement("h3");
  title.textContent = "Browser integrations";
  native.append(title);
  for (const [permission, label] of [["bookmarks", "Enable bookmark search"], ["sessions", "Enable recently closed tabs"]]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.id = `enable-${permission}`;
    const result = document.createElement("span");
    result.setAttribute("role", "status");
    browser.permissions.contains({ permissions: [permission] }).then((allowed) => { result.textContent = allowed ? " Enabled" : " Off"; }).catch(() => {});
    button.addEventListener("click", async () => {
      try {
        const allowed = await browser.permissions.request({ permissions: [permission] });
        result.textContent = allowed ? " Enabled" : " Permission not granted";
      } catch (error) { result.textContent = ` ${error.message}`; }
    });
    const row = document.createElement("p");
    row.append(button, result);
    native.append(row);
  }
  const menuRow = document.createElement("label");
  const menuToggle = document.createElement("input");
  menuToggle.type = "checkbox";
  menuToggle.id = "enable-contextMenus";
  const menuStatus = document.createElement("span");
  menuStatus.setAttribute("role", "status");
  menuRow.append(menuToggle, " Enable lens context menus ", menuStatus);
  native.append(menuRow);
  browser.storage.local.get("lensContextMenusEnabled").then((stored) => {
    menuToggle.checked = stored.lensContextMenusEnabled === true;
  }).catch((error) => { menuStatus.textContent = error.message; });
  menuToggle.addEventListener("change", async () => {
    const enabled = menuToggle.checked;
    menuToggle.disabled = true;
    try {
      // Firefox cannot request menus as an optional permission. Its manifest
      // declares the API, but this explicit preference keeps the feature opt-in.
      if (enabled && !browser.runtime.getBrowserInfo &&
          !await browser.permissions.request({ permissions: ["contextMenus"] })) {
        throw new Error("Context menu permission was not granted.");
      }
      await browser.storage.local.set({ lensContextMenusEnabled: enabled });
      menuStatus.textContent = enabled ? "Enabled" : "Off";
    } catch (error) {
      menuToggle.checked = !enabled;
      menuStatus.textContent = error.message;
    } finally { menuToggle.disabled = false; }
  });
  const palette = document.createElement("p");
  palette.textContent = "Address bar: type tl, press Space, then find a tab or lens. This also works on browser settings pages.";
  native.append(palette);
  document.getElementById("general-card").append(native);
})();
