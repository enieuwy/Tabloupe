// Chromium 123+ supplies promise APIs. Adapt namespace, event replies, and bulk
// tab discard; Firefox keeps its native browser object unchanged.
(() => {
  if (typeof globalThis.browser !== "undefined" || typeof globalThis.chrome === "undefined") return;
  const api = globalThis.chrome;
  const listeners = new WeakMap();
  const onMessage = {
    addListener(listener) {
      const wrapped = (message, sender, sendResponse) => {
        let result;
        try { result = listener(message, sender); }
        catch (error) { sendResponse({ ok: false, error: error.message }); return false; }
        if (result && typeof result.then === "function") {
          result.then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }
        if (result !== false && result !== undefined) sendResponse(result);
        return false;
      };
      listeners.set(listener, wrapped);
      api.runtime.onMessage.addListener(wrapped);
    },
    removeListener(listener) {
      const wrapped = listeners.get(listener);
      if (wrapped) api.runtime.onMessage.removeListener(wrapped);
      listeners.delete(listener);
    },
    hasListener(listener) { return api.runtime.onMessage.hasListener(listeners.get(listener)); },
  };
  const runtime = new Proxy(api.runtime, {
    get(target, key) {
      if (key === "onMessage") return onMessage;
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  async function discard(tabIds) {
    if (Array.isArray(tabIds)) {
      // Start every scalar request in input order, without hiding any failure.
      return Promise.all(tabIds.map(async (tabId) => api.tabs.discard(tabId)));
    }
    return api.tabs.discard(tabIds);
  }
  const tabs = new Proxy(api.tabs, {
    get(target, key) {
      if (key === "discard") return discard;
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  globalThis.browser = new Proxy(api, {
    get(target, key) {
      if (key === "runtime") return runtime;
      if (key === "tabs") return tabs;
      if (key === "browserAction") return target.action;
      return target[key];
    },
  });
})();
