/* global browser, getLenses, activateView, activateTabFromSearch, listTabsForSearch, normalizeHistoryUrl, handleLensSave, handleLensActivate, enqueueFocusWork, webSearchFromSearch, notify */
(() => {
  async function bookmarks(query) {
    if (typeof query !== "string" || query.trim().length < 2) return { ok: true, results: [] };
    if (!browser.bookmarks || !await browser.permissions.contains({ permissions: ["bookmarks"] })) return { ok: true, results: [], enabled: false };
    try {
      const [results, tabs, history] = await Promise.all([browser.bookmarks.search(query.trim()), browser.tabs.query({}), searchHistoryFromSearch(query.trim())]);
      const seen = new Set(tabs.map((tab) => normalizeHistoryUrl(tab.url || "")));
      const openUrls = new Set(tabs.map((tab) => tab.url));
      for (const item of (history.results || []).filter((item) => !openUrls.has(item.url)).slice(0, 3)) seen.add(normalizeHistoryUrl(item.url));
      const rows = [];
      for (const item of results) {
        if (!item.url || !/^https?:\/\//i.test(item.url)) continue;
        const key = normalizeHistoryUrl(item.url);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ title: item.title || "", url: item.url });
        if (rows.length >= 5) break;
      }
      return { ok: true, results: rows, enabled: true };
    } catch (error) { return { ok: false, error: "bookmark_search_failed", results: [] }; }
  }

  async function windowsForSearch() {
    const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
    return { ok: true, windows: windows.map((window) => ({ id: window.id, incognito: Boolean(window.incognito), title: window.tabs?.find((tab) => tab.active)?.title || `Window ${window.id}`, tabCount: window.tabs?.length || 0 })) };
  }

  async function moveToWindow(tabIds, targetWindowId) {
    if (!Array.isArray(tabIds) || !tabIds.length || tabIds.some((id) => !Number.isInteger(id)) || !Number.isInteger(targetWindowId)) {
      return { ok: false, error: "invalid_move", message: "Choose tabs and a destination window.", failed: tabIds || [], list: await listTabsForSearch() };
    }
    const ids = [...new Set(tabIds)];
    let target;
    let tabs;
    try {
      target = await browser.windows.get(targetWindowId);
      tabs = await Promise.all(ids.map((id) => browser.tabs.get(id)));
      if (target.type !== "normal" || tabs.some((tab) => Boolean(tab.incognito) !== Boolean(target.incognito))) throw new Error("incompatible_window");
    } catch (error) {
      return { ok: false, error: "invalid_window", message: "The destination is unavailable or has a different private-browsing mode.", failed: ids, list: await listTabsForSearch() };
    }
    const failed = [];
    const moved = [];
    // Per-tab moves give precise partial-failure reporting. Preserve selected order.
    for (const tab of tabs) {
      if (tab.windowId === targetWindowId) { moved.push(tab.id); continue; }
      try { await browser.tabs.move(tab.id, { windowId: targetWindowId, index: -1 }); moved.push(tab.id); }
      catch (error) { failed.push(tab.id); }
    }
    return { ok: failed.length === 0, ...(failed.length ? { error: "move_failed", message: "Some tabs could not move. They remain selected." } : {}), moved, failed, list: await listTabsForSearch() };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "tabsearch-bookmarks") return bookmarks(message.query);
    if (message?.type === "tabsearch-windows") return windowsForSearch().catch(() => ({ ok: false, windows: [], error: "window_lookup_failed" }));
    if (message?.type === "tabsearch-move-to-window") return enqueueFocusWork(() => moveToWindow(message.tabIds, message.targetWindowId));
  });

  function escape(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
  }
  let suggestionRevision = 0;
  if (browser.omnibox) {
    browser.omnibox.setDefaultSuggestion({ description: "Find tabs and lenses; type all to show all groups" });
    browser.omnibox.onInputChanged.addListener((text, suggest) => {
      const revision = ++suggestionRevision;
      Promise.all([getLenses(), listTabsForSearch()]).then(([lenses, tabs]) => {
        if (revision !== suggestionRevision) return;
        const query = text.trim().toLowerCase();
        const rows = [];
        if (!query || "show all groups".includes(query)) rows.push({ content: "all", description: "Show all groups" });
        for (const lens of lenses) {
          if (!query || lens.name.toLowerCase().includes(query)) rows.push({ content: `lens:${lens.id}`, description: `Show lens: ${escape(lens.name)}` });
        }
        for (const tab of tabs) {
          if (!query || `${tab.title} ${tab.url}`.toLowerCase().includes(query)) rows.push({ content: `tab:${tab.id}:${tab.windowId}`, description: `Switch tab: ${escape(tab.title)}` });
        }
        suggest(rows.slice(0, 8));
      }).catch(() => suggest([]));
    });
    browser.omnibox.onInputCancelled?.addListener(() => { suggestionRevision += 1; });
    browser.omnibox.onInputEntered.addListener((text) => {
      enqueueFocusWork(async () => {
        if (text === "all") return activateView({ kind: "all" }, { trigger: "manual" });
        if (text.startsWith("lens:")) {
          const id = text.slice(5);
          if ((await getLenses()).some((lens) => lens.id === id)) return activateView({ kind: "lens", lensId: id }, { trigger: "manual" });
          return;
        }
        const tab = /^tab:(\d+):(\d+)$/.exec(text);
        if (tab) return activateTabFromSearch(Number(tab[1]), Number(tab[2]));
        const lens = (await getLenses()).find((item) => item.name.toLowerCase() === text.trim().toLowerCase());
        if (lens) return activateView({ kind: "lens", lensId: lens.id }, { trigger: "manual" });
        return webSearchFromSearch(text);
      }).catch(console.error);
    });
  }

  const menus = browser.contextMenus;
  const permission = "contextMenus";
  const ids = ["lens-save-group", "lens-show-group", "lens-save-window", "lens-organize-selected"];
  let menuQueue = Promise.resolve();
  function registerMenus() {
    menuQueue = menuQueue.catch(() => {}).then(async () => {
      if (!menus || !await browser.permissions.contains({ permissions: [permission] })) return;
      await menus.removeAll();
      const stored = await browser.storage.local.get("lensContextMenusEnabled");
      if (stored.lensContextMenusEnabled !== true) return;
      const contexts = browser.runtime.getBrowserInfo ? ["tab", "page"] : ["page"];
      const names = ["Save this tab group as lens", "Show just this group", "Save current window as lens", "Organize selected tabs"];
      for (let index = 0; index < ids.length; index += 1) {
        menus.create({ id: ids[index], title: names[index], contexts, enabled: index >= 2 });
      }
      if (!menus.onShown) {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        await updateGroupMenus(tab);
      }
    });
    return menuQueue;
  }
  async function groupForTab(tab) {
    if (!tab || !Number.isInteger(tab.groupId) || tab.groupId < 0) return null;
    try { return await browser.tabGroups.get(tab.groupId); } catch (error) { return null; }
  }
  async function updateGroupMenus(tab) {
    const group = await groupForTab(tab);
    for (const id of ids.slice(0, 2)) await menus.update(id, { enabled: Boolean(group), ...(menus.onShown ? { visible: Boolean(group) } : {}) });
    if (menus.refresh) await menus.refresh();
  }
  if (menus) {
    menus.onShown?.addListener((info, tab) => { updateGroupMenus(tab).catch(() => {}); });
    if (!menus.onShown) {
      browser.tabs.onActivated.addListener(({ tabId }) => { browser.tabs.get(tabId).then(updateGroupMenus).catch(() => {}); });
      browser.tabs.onUpdated.addListener((id, change, tab) => { if (tab.active) updateGroupMenus(tab).catch(() => {}); });
    }
    menus.onClicked.addListener((info, tab) => {
      if (!ids.includes(info.menuItemId) || !tab || !Number.isInteger(tab.windowId)) return;
      enqueueFocusWork(async () => {
        const window = await browser.windows.get(tab.windowId);
        if (window.type !== "normal") return;
        const current = await browser.tabs.get(tab.id);
        const group = await groupForTab(current);
        let result;
        if (info.menuItemId === "lens-save-group" && group) {
          result = await handleLensSave({ source: "group", groupTitle: group.title || "", name: group.title || "Untitled group", color: group.color, windowId: tab.windowId });
        } else if (info.menuItemId === "lens-show-group" && group) {
          result = await handleLensActivate(tab.windowId, { kind: "transient", label: group.title || "Untitled group", selectors: [{ type: "title", value: group.title || "" }] });
        } else if (info.menuItemId === "lens-save-window") {
          result = await handleLensSave({ source: "window", name: (tab.title || "Workspace").slice(0, 80), windowId: tab.windowId });
        } else if (info.menuItemId === "lens-organize-selected") {
          const selected = await browser.tabs.query({ windowId: tab.windowId, highlighted: true });
          const tabIds = selected.some((item) => item.id === tab.id) ? selected.map((item) => item.id) : [tab.id];
          await browser.tabs.create({ windowId: tab.windowId, url: browser.runtime.getURL(`tabsearch.html?tabsearchOpen=1&selected=${tabIds.join(",")}`) });
          return;
        }
        if (result?.ok) await notify({ type: "basic", title: "Tabloupe", message: info.menuItemId === "lens-show-group" ? "Showing this group." : "Lens saved. Rename it in Options." });
        else if (result) throw new Error(result.error || "Lens action failed.");
      }).catch((error) => notify({ type: "basic", title: "Tabloupe", message: error.message }).catch(console.error));
    });
  }
  browser.permissions.onAdded?.addListener(() => { registerMenus().catch(console.error); });
  browser.permissions.onRemoved?.addListener(() => { registerMenus().catch(console.error); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lensContextMenusEnabled) registerMenus().catch(console.error);
  });
  registerMenus().catch(console.error);
})();
