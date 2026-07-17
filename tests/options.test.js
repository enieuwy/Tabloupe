const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");
const optionsJs = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const htmlWithScript = optionsHtml.replace('<script defer src="options.js"></script>', () => `<script>${optionsJs}</script>`);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  await nextTick();
  await nextTick();
  await nextTick();
}

function createHarness({ storage = {}, groups = [], grantPermission = true, platform = "MacIntel", fetchHandler = null } = {}) {
  const storageData = clone(storage) || {};
  const groupState = clone(groups);
  const storageListeners = [];
  const messages = [];
  const permissionRequests = [];
  const fetchCalls = [];
  const clipboardWrites = [];
  const prompts = [];

  const browser = {
    storage: {
      local: {
        async get(keys) {
          if (!keys) return clone(storageData);
          if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (k in storageData) out[k] = clone(storageData[k]);
            }
            return out;
          }
          return clone(storageData);
        },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: clone(storageData[key]), newValue: clone(value) };
            storageData[key] = clone(value);
          }
          for (const listener of storageListeners) {
            listener(changes, "local");
          }
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of list) {
            changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
            delete storageData[key];
          }
          for (const listener of storageListeners) {
            listener(changes, "local");
          }
        }
      },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); }
      }
    },
    tabGroups: {
      async query() {
        return clone(groupState);
      }
    },
    windows: {
      async getCurrent() {
        return { id: 7 };
      }
    },
    runtime: {
      async sendMessage(msg) {
        messages.push(msg);
        if (msg.type === "lens-state") {
          const lenses = clone(storageData.lenses) || [];
          return {
            activeView: clone(storageData.activeView) || { kind: "all" },
            lastActivation: clone(storageData.lastActivation) || null,
            lenses: lenses.map((lens) => ({
              id: lens.id,
              name: lens.name,
              icon: lens.icon,
              color: lens.color,
              active: storageData.activeView && storageData.activeView.kind === "lens" && storageData.activeView.lensId === lens.id,
            })),
            currentGroups: groupState.map((group) => ({ title: group.title, color: group.color || null, savedIn: clone(group.savedIn) || [], active: Boolean(group.active) })),
            hasGroups: groupState.length > 0,
            hasAppleBinding: lenses.some((lens) => lens.triggers && lens.triggers.appleFocusIds && lens.triggers.appleFocusIds.length > 0),
            aiEnabled: true,
          };
        }
        if (msg.type === "lens-save") {
          const titles = [...new Set(groupState.map((group) => group.title).filter(Boolean))];
          const now = Date.now();
          const lens = {
            id: msg.source === "empty" ? "lens_empty" : "lens_saved",
            name: msg.name,
            icon: "circle",
            color: msg.color || null,
            groupSelectors: msg.source === "window" ? titles.map((title) => ({ type: "title", value: title })) : [],
            triggers: { appleFocusIds: [] },
            createdAt: now,
            updatedAt: now,
          };
          storageData.lenses = [...(storageData.lenses || []), clone(lens)];
          return { ok: true, lens: clone(lens) };
        }
        if (msg.type === "lens-update") {
          storageData.lenses = (storageData.lenses || []).map((lens) => (
            lens.id === msg.lensId ? { ...lens, ...clone(msg.patch) } : lens
          ));
          return { ok: true };
        }
        if (msg.type === "lens-delete") {
          storageData.lenses = (storageData.lenses || []).filter((lens) => lens.id !== msg.lensId);
          return { ok: true };
        }
        if (msg.type === "lens-link-focus") {
          storageData.lenses = (storageData.lenses || []).map((lens) => {
            const ids = (lens.triggers && lens.triggers.appleFocusIds ? lens.triggers.appleFocusIds : [])
              .filter((id) => id !== msg.focusId);
            if (msg.lensId && lens.id === msg.lensId) {
              ids.push(msg.focusId);
            }
            return { ...lens, triggers: { ...(lens.triggers || {}), appleFocusIds: [...new Set(ids)].sort() } };
          });
          return { ok: true };
        }
        if (msg.type === "lens-activate") {
          storageData.activeView = clone(msg.view);
          return { ok: true };
        }
        if (msg.type === "lens-reorder") {
          const byId = new Map((storageData.lenses || []).map((lens) => [lens.id, lens]));
          storageData.lenses = msg.orderedIds.map((id) => byId.get(id)).filter(Boolean);
          return { ok: true };
        }
        if (msg.type === "lens-import") {
          let parsed;
          try {
            parsed = JSON.parse(String(msg.code).trim());
          } catch (error) {
            return { ok: false, error: "invalid_code" };
          }
          if (!parsed || typeof parsed !== "object" || parsed.tabloupeLens !== 1 || !parsed.lens || typeof parsed.lens !== "object") {
            return { ok: false, error: "invalid_code" };
          }
          const name = typeof parsed.lens.name === "string" ? parsed.lens.name.trim() : "";
          if (!name) {
            return { ok: false, error: "invalid_code" };
          }
          const now = Date.now();
          const existingIds = new Set((storageData.lenses || []).map((lens) => lens.id));
          let id = "lens_import_" + ((storageData.lenses || []).length + 1);
          while (existingIds.has(id)) id += "x";
          const lens = {
            id,
            name,
            icon: typeof parsed.lens.icon === "string" ? parsed.lens.icon : "circle",
            color: typeof parsed.lens.color === "string" ? parsed.lens.color : null,
            groupSelectors: Array.isArray(parsed.lens.groupSelectors) ? clone(parsed.lens.groupSelectors) : [],
            triggers: { appleFocusIds: [], calendarPatterns: [] },
            createdAt: now,
            updatedAt: now,
          };
          storageData.lenses = [...(storageData.lenses || []), clone(lens)];
          return { ok: true, lens: clone(lens) };
        }
      }
    },
    permissions: {
      async request(request) {
        permissionRequests.push(request);
        return grantPermission;
      },
    },
  };

  const dom = new JSDOM(htmlWithScript, {
    url: "http://localhost/",
    runScripts: "dangerously",
    beforeParse(window) {
      try {
        Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
      } catch (error) {
        // Older jsdom versions may expose platform as non-configurable.
      }
      window.browser = browser;
      Object.defineProperty(window.navigator, "clipboard", {
        value: {
          async writeText(text) {
            clipboardWrites.push(text);
          },
        },
        configurable: true,
      });
      window.prompt = (message, value) => {
        prompts.push({ message, value });
        return value;
      };
      window.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (typeof fetchHandler !== "function") {
          throw new Error("unexpected fetch: " + url);
        }
        return fetchHandler(String(url), init);
      };
      window.AbortController = AbortController;
      // Polyfill requestAnimationFrame for jsdom if needed, but setTimeout works for settle
    }
  });

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    browser,
    storageData,
    groupState,
    messages,
    permissionRequests,
    fetchCalls,
    clipboardWrites,
    prompts,
  };
}

function lastMessageOfType(messages, type) {
  return [...messages].reverse().find((message) => message.type === type);
}

function lensFixture(overrides = {}) {
  return {
    id: "lens_work",
    name: "Work lens",
    icon: "briefcase",
    color: "#3366ff",
    groupSelectors: [{ type: "title", value: "Work" }],
    triggers: { appleFocusIds: [] },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function lensCard(document, lensId = "lens_work") {
  return document.querySelector(`.lens-card[data-lens-id="${lensId}"]`);
}

test("empty state renders first-run copy and no drag trays", async () => {
  const { document, messages } = createHarness();
  await settle();

  const list = document.getElementById("lenses-list");
  assert.match(list.textContent, /No lenses yet/);
  assert.match(list.textContent, /A lens shows only the tab groups you pick/);
  assert.equal(list.querySelector(".lens-palette"), null);
  assert.equal(list.querySelector(".focus-strip"), null);
  assert.equal(messages[0].type, "lens-state");
  assert.equal(messages[0].windowId, 7);
});

test("renders a lens row with group chips, trigger pills, and palette annotations", async () => {
  const { document } = createHarness({
    storage: {
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lensFixture({
        groupSelectors: [{ type: "title", value: "Work" }, { type: "glob", value: "Client *" }],
        triggers: { appleFocusIds: ["com.apple.focus.work"] },
      })],
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" } },
      seenFocusIds: { "com.apple.focus.work": { firstSeen: 1, lastSeen: 2 } },
    },
    groups: [
      { id: 1, title: "Work", savedIn: ["lens_work"] },
      { id: 2, title: "Scratch", savedIn: [] },
      { id: 3, title: "Client A", savedIn: ["lens_work", "lens_client"] },
    ],
  });
  await settle();

  const card = lensCard(document);
  assert.ok(card);
  assert.equal(card.querySelector(".lens-name-input").value, "Work lens");
  assert.equal(card.querySelector(".lens-active-pill").textContent, "● active");
  assert.equal(document.querySelector(".active-view-summary").textContent.includes("Showing: Work lens"), true);
  assert.deepEqual(chipLabels(card.querySelector(".shows-zone")), ["Work", "Client *"]);
  assert.equal(card.querySelector(".group-chip-pattern .group-chip-badge").textContent, "pattern");
  assert.match(card.querySelector(".focus-pill").textContent, /Work/);
  assert.match(document.querySelector(".lens-palette").textContent, /Scratch.*unused/s);
  assert.match(document.querySelector(".lens-palette").textContent, /Client A.*in 2 lenses/s);
});

test("Save current window's groups as a lens uses the active group name and enters edit mode", async () => {
  const { document, messages } = createHarness({
    groups: [{ id: 1, title: "Work", active: true }, { id: 2, title: "Research" }],
  });
  await settle();

  document.getElementById("save-window-lens").click();
  await settle();

  const save = lastMessageOfType(messages, "lens-save");
  assert.ok(save);
  assert.equal(save.windowId, 7);
  assert.equal(save.source, "window");
  assert.equal(save.name, "Work");
  assert.ok(save.color);
  const nameInput = lensCard(document, "lens_saved").querySelector(".lens-name-input");
  assert.equal(document.activeElement, nameInput);
  assert.equal(nameInput.selectionStart, 0);
  assert.equal(nameInput.selectionEnd, "Work".length);
});

test("Save current window's groups falls back to Window lens without an active group", async () => {
  const { document, messages } = createHarness({
    groups: [{ id: 1, title: "Work" }, { id: 2, title: "Research" }],
  });
  await settle();

  document.getElementById("save-window-lens").click();
  await settle();

  const save = lastMessageOfType(messages, "lens-save");
  assert.ok(save);
  assert.equal(save.source, "window");
  assert.equal(save.name, "Window lens");
});

test("+ New lens sends lens-save for an empty lens and edits its default name", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [lensFixture()],
    },
  });
  await settle();

  document.getElementById("new-empty-lens").click();
  await settle();

  const save = lastMessageOfType(messages, "lens-save");
  assert.ok(save);
  assert.equal(save.source, "empty");
  assert.equal(save.name, "Lens 2");
  assert.ok(save.color);
  const nameInput = lensCard(document, "lens_empty").querySelector(".lens-name-input");
  assert.equal(document.activeElement, nameInput);
  assert.equal(nameInput.selectionStart, 0);
  assert.equal(nameInput.selectionEnd, "Lens 2".length);
});

test("+ add group sends lens-update with an appended title selector", async () => {
  const { document, messages } = createHarness({
    storage: { lenses: [lensFixture({ groupSelectors: [] })] },
    groups: [{ id: 1, title: "Deep Work" }],
  });
  await settle();

  const input = lensCard(document).querySelector(".group-chip-input");
  input.value = "Deep Work";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  const update = lastMessageOfType(messages, "lens-update");
  assert.ok(update);
  assert.equal(update.lensId, "lens_work");
  assert.deepEqual(clone(update.patch.groupSelectors), [{ type: "title", value: "Deep Work" }]);
});

test("adding the first group to a default-named lens auto-renames it", async () => {
  const { document, messages } = createHarness({
    storage: { lenses: [lensFixture({ name: "Lens 1", groupSelectors: [] })] },
    groups: [{ id: 1, title: "Deep Work" }],
  });
  await settle();

  const input = lensCard(document).querySelector(".group-chip-input");
  input.value = "Deep Work";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  const update = lastMessageOfType(messages, "lens-update");
  assert.ok(update);
  assert.deepEqual(clone(update.patch), {
    groupSelectors: [{ type: "title", value: "Deep Work" }],
    name: "Deep Work",
  });
});

test("typing a wildcard in + add group appends a glob selector", async () => {
  const { document, messages } = createHarness({
    storage: { lenses: [lensFixture({ groupSelectors: [{ type: "title", value: "Work" }] })] },
  });
  await settle();

  const input = lensCard(document).querySelector(".group-chip-input");
  input.value = "Client *";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  const update = lastMessageOfType(messages, "lens-update");
  assert.deepEqual(clone(update.patch.groupSelectors), [
    { type: "title", value: "Work" },
    { type: "glob", value: "Client *" },
  ]);
});

test("chip remove sends lens-update without that selector", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [lensFixture({
        groupSelectors: [{ type: "title", value: "Work" }, { type: "glob", value: "Client *" }],
      })],
    },
  });
  await settle();

  lensCard(document).querySelector('[aria-label="Remove Work"]').click();
  await settle();

  const update = lastMessageOfType(messages, "lens-update");
  assert.deepEqual(clone(update.patch.groupSelectors), [{ type: "glob", value: "Client *" }]);
});

test("Calendar events editor adds and removes patterns with lens-update patches", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [lensFixture({
        triggers: {
          appleFocusIds: ["com.apple.focus.work"],
          calendarPatterns: ["Daily Sync"],
        },
      })],
    },
  });
  await settle();

  const input = lensCard(document).querySelector(".calendar-editor .group-chip-input");
  input.value = "Client *";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  const addUpdate = lastMessageOfType(messages, "lens-update");
  assert.ok(addUpdate);
  assert.equal(addUpdate.lensId, "lens_work");
  assert.deepEqual(clone(addUpdate.patch.triggers), {
    appleFocusIds: ["com.apple.focus.work"],
    calendarPatterns: ["Daily Sync", "Client *"],
  });

  lensCard(document).querySelector('[aria-label="Remove calendar pattern Daily Sync"]').click();
  await settle();

  const removeUpdate = lastMessageOfType(messages, "lens-update");
  assert.ok(removeUpdate);
  assert.equal(removeUpdate.lensId, "lens_work");
  assert.deepEqual(clone(removeUpdate.patch.triggers), {
    appleFocusIds: ["com.apple.focus.work"],
    calendarPatterns: ["Client *"],
  });
});

test("selector chips show no-match and glob match indicators", async () => {
  const { document } = createHarness({
    storage: {
      lenses: [lensFixture({
        groupSelectors: [
          { type: "title", value: "Missing" },
          { type: "glob", value: "Client *" },
          { type: "glob", value: "Doc?" },
          { type: "glob", value: "work*" },
          { type: "title", value: "Work" },
        ],
      })],
    },
    groups: [
      { id: 1, title: "Work" },
      { id: 2, title: "Work" },
      { id: 3, title: "Client A" },
      { id: 4, title: "Client B" },
      { id: 5, title: "Client C" },
      { id: 6, title: "Client D" },
      { id: 7, title: "Docs" },
    ],
  });
  await settle();

  const chips = [...lensCard(document).querySelectorAll(".group-chip")];
  assert.ok(chips.find((chip) => chip.textContent.includes("Missing")).classList.contains("is-muted"));
  assert.match(chips.find((chip) => chip.textContent.includes("Missing")).textContent, /no match/);
  assert.match(chips.find((chip) => chip.textContent.includes("Client *")).textContent, /pattern.*matches 4/s);
  assert.match(chips.find((chip) => chip.textContent.includes("Doc?")).textContent, /pattern.*matches 1/s);
  assert.ok(chips.find((chip) => chip.textContent.includes("work*")).classList.contains("is-muted"));
  assert.match(chips.find((chip) => chip.textContent.includes("work*")).textContent, /no match/);
  assert.match(chips.find((chip) => chip.textContent.includes("Work")).textContent, /in 2 groups/);
});

test("Activate when picker sends lens-link-focus", async () => {
  const { document, messages } = createHarness({
    storage: {
      connectionState: "connected",
      lenses: [lensFixture()],
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" } },
      seenFocusIds: { "com.apple.focus.work": { firstSeen: 1, lastSeen: 2 } },
    },
  });
  await settle();

  lensCard(document).querySelector(".focus-picker-toggle").click();
  await settle();
  const select = lensCard(document).querySelector(".focus-picker");
  assert.equal(select.hidden, false);
  select.value = "com.apple.focus.work";
  select.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
  await settle();

  const link = lastMessageOfType(messages, "lens-link-focus");
  assert.ok(link);
  assert.equal(link.lensId, "lens_work");
  assert.equal(link.focusId, "com.apple.focus.work");
});

test("unlinking a trigger pill sends lens-link-focus without lensId", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [lensFixture({ triggers: { appleFocusIds: ["com.apple.focus.work"] } })],
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" } },
    },
  });
  await settle();

  lensCard(document).querySelector(".focus-pill-remove").click();
  await settle();

  const unlink = lastMessageOfType(messages, "lens-link-focus");
  assert.ok(unlink);
  assert.equal("lensId" in unlink, false);
  assert.equal(unlink.focusId, "com.apple.focus.work");
});

test("lens Show button activates a lens and marks the row active", async () => {
  const { document, messages } = createHarness({
    storage: {
      activeView: { kind: "all" },
      lenses: [
        lensFixture(),
        lensFixture({ id: "lens_personal", name: "Personal", groupSelectors: [{ type: "title", value: "Personal" }] }),
      ],
    },
  });
  await settle();

  lensCard(document).querySelector(".lens-show-button").click();
  await settle();

  const activate = lastMessageOfType(messages, "lens-activate");
  assert.ok(activate);
  assert.equal(activate.windowId, 7);
  assert.deepEqual(clone(activate.view), { kind: "lens", lensId: "lens_work" });
  assert.ok(lensCard(document).classList.contains("is-active"));
  assert.equal(lensCard(document).querySelector(".lens-active-pill").textContent, "● active");
});

test("Show all groups control activates the all-groups view", async () => {
  const { document, messages } = createHarness({
    storage: {
      activeView: { kind: "lens", lensId: "lens_work" },
      lenses: [lensFixture()],
    },
  });
  await settle();

  document.querySelector(".show-all-groups").click();
  await settle();

  const activate = lastMessageOfType(messages, "lens-activate");
  assert.ok(activate);
  assert.equal(activate.windowId, 7);
  assert.deepEqual(clone(activate.view), { kind: "all" });
  assert.match(document.querySelector(".active-view-summary").textContent, /Showing: All groups/);
});

test("delete offers Undo and Undo restores through lens messages", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [
        lensFixture({
          icon: "briefcase",
          color: "#123456",
          groupSelectors: [{ type: "title", value: "Work" }, { type: "glob", value: "Client *" }],
          triggers: { appleFocusIds: ["com.apple.focus.work"] },
        }),
        lensFixture({ id: "lens_personal", name: "Personal", groupSelectors: [{ type: "title", value: "Personal" }] }),
      ],
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" } },
    },
  });
  await settle();

  lensCard(document).querySelector('[aria-label="Delete lens Work lens"]').click();
  await settle();
  const status = document.getElementById("status");
  const undo = status.querySelector("button");
  assert.match(status.textContent, /Deleted Work lens · Undo/);
  assert.ok(undo);

  undo.click();
  await settle();

  const save = [...messages].reverse().find((message) => message.type === "lens-save" && message.name === "Work lens");
  assert.ok(save);
  assert.equal(save.source, "empty");
  const update = [...messages].reverse().find((message) => message.type === "lens-update" && message.lensId === "lens_empty");
  assert.deepEqual(clone(update.patch), {
    icon: "briefcase",
    color: "#123456",
    groupSelectors: [{ type: "title", value: "Work" }, { type: "glob", value: "Client *" }],
  });
  const link = [...messages].reverse().find((message) => message.type === "lens-link-focus" && message.lensId === "lens_empty");
  assert.equal(link.focusId, "com.apple.focus.work");
  const reorder = lastMessageOfType(messages, "lens-reorder");
  assert.deepEqual(clone(reorder.orderedIds), ["lens_empty", "lens_personal"]);
});

test("Activate when collapses to compact plus when a Focus pill exists", async () => {
  const { document } = createHarness({
    storage: {
      lenses: [lensFixture({ triggers: { appleFocusIds: ["com.apple.focus.work"] } })],
      focusCatalog: {
        "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" },
        "com.apple.focus.personal-time": { name: "Personal", icon: "person", color: "#aa66ff" },
      },
      seenFocusIds: {
        "com.apple.focus.work": { firstSeen: 1, lastSeen: 2 },
        "com.apple.focus.personal-time": { firstSeen: 1, lastSeen: 2 },
      },
    },
  });
  await settle();

  const card = lensCard(document);
  const toggle = card.querySelector(".focus-picker-toggle");
  assert.equal(toggle.textContent, "+");
  assert.equal(toggle.title, "Link a macOS Focus mode");
  assert.equal(toggle.getAttribute("aria-label"), "Link a macOS Focus mode to Work lens");
  assert.equal(card.querySelector(".focus-pill").title, "When macOS Focus “Work” turns on → show this lens");
});

test("icon-only lens controls expose aria-labels", async () => {
  const { document } = createHarness({
    storage: {
      lenses: [lensFixture({ triggers: { appleFocusIds: ["com.apple.focus.work"] } })],
      focusCatalog: { "com.apple.focus.work": { name: "Work", icon: "briefcase", color: "#3366ff" } },
    },
  });
  await settle();

  const card = lensCard(document);
  assert.equal(card.querySelector(".drag-handle").getAttribute("aria-label"), "Reorder Work lens");
  assert.equal(card.querySelector('[aria-label="Move Work lens up"]').tagName, "BUTTON");
  assert.equal(card.querySelector('[aria-label="Move Work lens down"]').tagName, "BUTTON");
  assert.equal(card.querySelector(".lens-icon-button").getAttribute("aria-label"), "Edit icon and color for Work lens");
  assert.equal(card.querySelector(".icon-btn-options").getAttribute("aria-label"), "Advanced options for Work lens");
  assert.equal(card.querySelector('[aria-label="Delete lens Work lens"]').tagName, "BUTTON");
  assert.equal(card.querySelector(".focus-picker-toggle").getAttribute("aria-label"), "Link a macOS Focus mode to Work lens");
});

test("reorder fallback sends lens-reorder", async () => {
  const { document, messages } = createHarness({
    storage: {
      lenses: [
        lensFixture(),
        lensFixture({ id: "lens_personal", name: "Personal", groupSelectors: [{ type: "title", value: "Personal" }] }),
      ],
    },
  });
  await settle();

  lensCard(document).querySelector('[aria-label="Move Work lens down"]').click();
  await settle();

  const reorder = lastMessageOfType(messages, "lens-reorder");
  assert.ok(reorder);
  assert.deepEqual(reorder.orderedIds, ["lens_personal", "lens_work"]);
});

test("trigger UI is hidden without Apple signals on non-macOS", async () => {
  const { document } = createHarness({
    platform: "Win32",
    storage: { lenses: [lensFixture()] },
  });
  await settle();

  assert.equal(lensCard(document).querySelector(".lens-trigger"), null);
  assert.equal(document.querySelector(".focus-strip"), null);
  assert.doesNotMatch(document.getElementById("lenses-list").textContent, /Activate when/);
});

test("migration summary reports imported legacy mappings", async () => {
  const { document } = createHarness({
    storage: {
      legacyFocusMappingsBackup: {
        "com.apple.focus.work": ["Work"],
        "com.apple.focus.personal-time": ["Personal"],
      },
    },
  });
  await settle();

  const summary = document.getElementById("migration-summary");
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /Imported 2 lenses/);
});

test("diagnostics card is a collapsed details element", async () => {
  const { document } = createHarness();
  await settle();

  const details = document.querySelector(".diagnostics");
  assert.equal(details.tagName, "DETAILS");
  assert.equal(details.hasAttribute("open"), false);
  assert.equal(details.querySelector("summary").textContent.trim(), "Diagnostics");
});

test("apply-now is removed and no apply-current-focus message is sent", async () => {
  const { document, messages } = createHarness();
  await settle();

  assert.equal(document.getElementById("apply-now"), null);
  assert.equal(messages.some((message) => message.type === "apply-current-focus"), false);
});

test("diagnostics render daemon connection state live", async () => {
  const { document, browser } = createHarness({
    storage: { connectionState: "reconnecting" },
  });
  await settle();

  assert.equal(document.getElementById("diag-connection").textContent, "Reconnecting");

  await browser.storage.local.set({ connectionState: "connected" });
  await settle();

  assert.equal(document.getElementById("diag-connection").textContent, "Helper connected");
});

test("diagnostics render last error live", async () => {
  const lastError = {
    code: "cloud_http_401",
    message: "Provider returned HTTP 401. Check your API key.",
    at: Date.now(),
    source: "ai",
  };
  const { document, browser } = createHarness({ storage: { lastError } });
  await settle();

  assert.match(document.getElementById("diag-last-error").textContent, /Provider returned HTTP 401\. Check your API key\./);

  await browser.storage.local.set({ lastError: null });
  await settle();

  assert.equal(document.getElementById("diag-last-error").textContent, "None");
});

test("diagnostics render update failures live", async () => {
  const { document, browser } = createHarness({
    storage: { updateFailures: ["Work (window 1)"] },
  });
  await settle();

  assert.match(document.getElementById("diag-update-failures").textContent, /Work \(window 1\)/);

  await browser.storage.local.set({ updateFailures: [] });
  await settle();

  assert.equal(document.getElementById("diag-update-failures").textContent, "None");
});

test("diagnostics render failed tab-group updates", async () => {
  const { document } = createHarness({
    storage: {
      lastAction: "applied_with_errors",
      expandedGroups: ["Work"],
      collapsedGroups: ["Other"],
      updateFailures: ["Other"],
    },
  });
  await settle();

  const details = document.getElementById("diag-action-details").textContent;
  assert.match(details, /expanded: Work/);
  assert.match(details, /collapsed: Other/);
  assert.match(details, /failed updates: Other/);
});

function pressKeyOn(harness, el, init) {
  el.dispatchEvent(new harness.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("tab search shortcut shows the default Ctrl + S", async () => {
  const harness = createHarness();
  await settle();
  assert.equal(harness.document.getElementById("shortcut-record").textContent, "Ctrl + S");
});

test("loads a saved tab search shortcut on init", async () => {
  const harness = createHarness({
    storage: { tabSearchShortcut: { ctrl: true, alt: false, shift: true, meta: false, key: "j" } },
  });
  await settle();
  assert.equal(harness.document.getElementById("shortcut-record").textContent, "Ctrl + Shift + J");
});

test("recording a shortcut writes it to storage and updates the label", async () => {
  const harness = createHarness();
  await settle();

  const button = harness.document.getElementById("shortcut-record");
  button.click();
  pressKeyOn(harness, button, { key: "k", ctrlKey: true, shiftKey: true });
  await settle();

  assert.deepEqual({ ...harness.storageData.tabSearchShortcut }, {
    ctrl: true,
    alt: false,
    shift: true,
    meta: false,
    key: "k",
  });
  assert.equal(button.textContent, "Ctrl + Shift + K");
});

test("recording rejects a key pressed without a modifier", async () => {
  const harness = createHarness();
  await settle();

  const button = harness.document.getElementById("shortcut-record");
  button.click();
  pressKeyOn(harness, button, { key: "k" });
  await settle();

  assert.ok(!("tabSearchShortcut" in harness.storageData), "nothing written to storage");
  assert.match(harness.document.getElementById("shortcut-status").textContent, /modifier/i);
});

test("disable button stores null and shows Disabled", async () => {
  const harness = createHarness();
  await settle();

  harness.document.getElementById("shortcut-clear").click();
  await settle();

  assert.equal(harness.storageData.tabSearchShortcut, null);
  assert.equal(harness.document.getElementById("shortcut-record").textContent, "Disabled");
});

test("selecting Custom reveals the provider fields", async () => {
  const harness = createHarness();
  await settle();

  assert.equal(harness.document.getElementById("provider-custom").hidden, true);
  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  assert.equal(harness.document.getElementById("provider-custom").hidden, false);
});

test("a preset selects Custom and prefills URL and model", async () => {
  const harness = createHarness();
  await settle();

  harness.document.getElementById("preset-groq").click();
  assert.equal(harness.document.querySelector('input[name="provider-kind"][value="custom"]').checked, true);
  assert.equal(harness.document.getElementById("provider-custom").hidden, false);
  assert.equal(harness.document.getElementById("provider-url").value, "https://api.groq.com/openai/v1");
  assert.ok(harness.document.getElementById("provider-model").value.length > 0);
});

test("saving Foundation stores the on-device provider without a permission prompt", async () => {
  const harness = createHarness({ storage: { aiProvider: { kind: "custom", baseURL: "https://x/v1", model: "m", apiKey: "k" } } });
  await settle();

  const foundation = harness.document.querySelector('input[name="provider-kind"][value="foundation"]');
  foundation.checked = true;
  foundation.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.deepEqual(harness.storageData.aiProvider, { kind: "foundation" });
  assert.equal(harness.permissionRequests.length, 0);
});

test("saving a custom provider requests host permission and stores it", async () => {
  const harness = createHarness();
  await settle();

  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-url").value = "https://api.groq.com/openai/v1";
  harness.document.getElementById("provider-model").value = "llama-3.3-70b-versatile";
  harness.document.getElementById("provider-key").value = "gsk-123";
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.permissionRequests.length, 1);
  assert.equal(harness.permissionRequests[0].origins.length, 1);
  assert.equal(harness.permissionRequests[0].origins[0], "https://api.groq.com/*");
  assert.deepEqual(harness.storageData.aiProvider, {
    kind: "custom",
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiKey: "gsk-123",
  });
});

test("denied host permission does not store a custom provider", async () => {
  const harness = createHarness({ grantPermission: false });
  await settle();

  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-url").value = "https://api.openai.com/v1";
  harness.document.getElementById("provider-model").value = "gpt-4o-mini";
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.storageData.aiProvider, undefined);
  assert.match(harness.document.querySelector("#toast-host .toast").textContent, /denied/i);
});

test("loads an existing custom provider into the form", async () => {
  const harness = createHarness({
    storage: { aiProvider: { kind: "custom", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-x" } },
  });
  await settle();

  assert.equal(harness.document.querySelector('input[name="provider-kind"][value="custom"]').checked, true);
  assert.equal(harness.document.getElementById("provider-url").value, "https://api.openai.com/v1");
  assert.equal(harness.document.getElementById("provider-model").value, "gpt-4o-mini");
  assert.equal(harness.document.getElementById("provider-key").value, "sk-x");
});

function chipLabels(scope) {
  return [...scope.querySelectorAll(".group-chip-label")].map((c) => c.textContent);
}

test("lens add input suggests live groups excluding its own title selectors", async () => {
  const { document } = createHarness({
    storage: { lenses: [lensFixture({ groupSelectors: [{ type: "title", value: "Work" }] })] },
    groups: [{ id: 1, title: "Work" }, { id: 2, title: "Research" }, { id: 3, title: "Reading" }],
  });
  await settle();

  const listId = lensCard(document).querySelector(".group-chip-input").getAttribute("list");
  const options = [...document.getElementById(listId).querySelectorAll("option")].map((o) => o.value);
  assert.deepEqual(options, ["Reading", "Research"]);
});

test("glob selectors render as visible pattern chips in Shows", async () => {
  const { document } = createHarness({
    storage: {
      lenses: [lensFixture({
        groupSelectors: [{ type: "title", value: "Work" }, { type: "glob", value: "Work-*" }],
      })],
    },
  });
  await settle();

  const card = lensCard(document);
  assert.deepEqual(chipLabels(card.querySelector(".shows-zone")), ["Work", "Work-*"]);
  assert.equal(card.querySelector(".group-chip-pattern .group-chip-badge").textContent, "pattern");
  assert.equal(card.querySelector(".row-options").hidden, true);
});

test("the lens advanced panel toggles open and closed", async () => {
  const { document } = createHarness({
    storage: { lenses: [lensFixture({ groupSelectors: [{ type: "glob", value: "Work-*" }] })] },
  });
  await settle();

  let card = lensCard(document);
  let optionsBtn = card.querySelector(".icon-btn-options");
  assert.equal(card.querySelector(".row-options").hidden, true);

  optionsBtn.click();
  await settle();
  card = lensCard(document);
  optionsBtn = card.querySelector(".icon-btn-options");
  assert.equal(card.querySelector(".row-options").hidden, false);
  assert.equal(optionsBtn.getAttribute("aria-expanded"), "true");
  assert.ok(optionsBtn.classList.contains("is-open"));

  optionsBtn.click();
  await settle();
  card = lensCard(document);
  assert.equal(card.querySelector(".row-options").hidden, true);
  assert.equal(card.querySelector(".icon-btn-options").getAttribute("aria-expanded"), "false");
});

test("editing a schedule preserves a schedule written outside the stale UI snapshot", async () => {
  const harness = createHarness({
    storage: {
      lenses: [lensFixture()],
      lensSchedules: [
        { lensId: "lens_work", enabled: false, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      ],
    },
  });
  await settle();

  // A schedule for another lens lands in storage without the Options page's
  // change listener seeing it, so state.lensSchedules is now stale.
  harness.storageData.lensSchedules = [
    { lensId: "lens_work", enabled: false, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
    { lensId: "lens_play", enabled: true, days: [0, 6], start: "10:00", end: "12:00" },
  ];

  lensCard(harness.document).querySelector(".icon-btn-options").click();
  await settle();
  const toggle = lensCard(harness.document).querySelector(".schedule-editor .toggle input[type='checkbox']");
  assert.ok(toggle, "schedule enable toggle is present");
  toggle.checked = true;
  toggle.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await settle();

  const written = harness.storageData.lensSchedules;
  assert.equal(written.length, 2, "the concurrently-stored lens_play schedule must not be dropped");
  assert.ok(written.find((schedule) => schedule.lensId === "lens_play"), "lens_play schedule preserved");
  assert.equal(written.find((schedule) => schedule.lensId === "lens_work").enabled, true);
});

test("advanced panel shows glob help and icon color editors", async () => {
  const { document } = createHarness({
    storage: { lenses: [lensFixture()] },
  });
  await settle();

  lensCard(document).querySelector(".icon-btn-options").click();
  await settle();

  const panel = lensCard(document).querySelector(".row-options");
  assert.match(panel.textContent, /\* = any text, \? = one character, e\.g\. Client \*/);
  assert.ok(panel.querySelector('input[aria-label="Icon for Work lens"]'));
  assert.ok(panel.querySelector('input[aria-label="Color for Work lens"]'));
});

test("saving an edited grouping prompt stores it as the override", async () => {
  const harness = createHarness();
  await settle();

  harness.document.getElementById("ai-grouping-prompt").value = "Group tabs by domain. JSON only.";
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.storageData.aiGroupingPrompt, "Group tabs by domain. JSON only.");
  assert.match(harness.document.querySelector("#toast-host .toast").textContent, /Saved/);
});

test("loads a saved grouping prompt override into the textarea", async () => {
  const harness = createHarness({ storage: { aiGroupingPrompt: "Custom: cluster by project." } });
  await settle();

  assert.equal(harness.document.getElementById("ai-grouping-prompt").value, "Custom: cluster by project.");
});

test("the prompt field shows the built-in default when no override is stored", async () => {
  const harness = createHarness();
  await settle();

  const value = harness.document.getElementById("ai-grouping-prompt").value;
  assert.match(value, /^You organize a user's open browser tabs/);
  assert.doesNotMatch(value, /Safari/);
});

test("saving the unchanged default prompt stores an empty override", async () => {
  const harness = createHarness();
  await settle();

  // The field loads pre-filled with the default; saving it unchanged should not
  // persist a literal copy, so it keeps tracking the default.
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.storageData.aiGroupingPrompt, "");
});

test("reset clears the override and restores the default prompt text", async () => {
  const harness = createHarness({ storage: { aiGroupingPrompt: "Custom override." } });
  await settle();
  assert.equal(harness.document.getElementById("ai-grouping-prompt").value, "Custom override.");

  harness.document.getElementById("ai-prompt-reset").click();
  await settle();

  assert.equal(harness.storageData.aiGroupingPrompt, "");
  assert.match(harness.document.getElementById("ai-grouping-prompt").value, /^You organize a user's open browser tabs/);
});

test("an over-long prompt is truncated to 4000 chars on save", async () => {
  const harness = createHarness();
  await settle();

  harness.document.getElementById("ai-grouping-prompt").value = "y".repeat(5000);
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.storageData.aiGroupingPrompt.length, 4000);
});


// ── Regression: settings import/export + provider URL hardening ────────

test("import never overwrites the stored AI provider and shows the extended toast", async () => {
  const harness = createHarness({
    storage: { aiProvider: { kind: "custom", baseURL: "https://good.example/v1", model: "m", apiKey: "k" } },
  });
  await settle();

  const incoming = JSON.stringify({
    lenses: [],
    aiProvider: { kind: "custom", baseURL: "https://evil.example/v1", model: "x", apiKey: "leak" },
  });
  await harness.window.importSettingsFile({ text: async () => incoming });
  await settle();

  assert.deepEqual(harness.storageData.aiProvider, {
    kind: "custom",
    baseURL: "https://good.example/v1",
    model: "m",
    apiKey: "k",
  });
  assert.match(harness.document.querySelector("#toast-host .toast").textContent, /are not imported\./);
});

test("import without an aiProvider key shows the plain imported toast", async () => {
  const harness = createHarness();
  await settle();

  await harness.window.importSettingsFile({ text: async () => JSON.stringify({ lenses: [] }) });
  await settle();

  assert.equal(harness.document.querySelector("#toast-host .toast").textContent, "Settings imported.");
});

test("export payload omits the AI provider key", async () => {
  const harness = createHarness({
    storage: {
      aiProvider: { kind: "custom", baseURL: "https://good.example/v1", model: "m", apiKey: "k" },
      aiGroupingPrompt: "Group by domain.",
    },
  });
  await settle();

  let captured = null;
  harness.window.URL.createObjectURL = (blob) => { captured = blob; return "blob:mock"; };
  harness.window.URL.revokeObjectURL = () => {};

  harness.window.exportSettings();
  await settle();

  assert.ok(captured, "export created a blob");
  const payload = JSON.parse(await captured.text());
  assert.ok(!("aiProvider" in payload), "export must not include aiProvider");
});

test("saveProvider rejects a non-loopback http:// URL and stores nothing", async () => {
  const harness = createHarness();
  await settle();

  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-url").value = "http://api.example.com/v1";
  harness.document.getElementById("provider-model").value = "m";
  harness.document.getElementById("provider-save").click();
  await settle();

  assert.equal(harness.storageData.aiProvider, undefined);
  assert.equal(harness.permissionRequests.length, 0);
  assert.equal(
    harness.document.querySelector("#toast-host .toast").textContent,
    "Use an https:// URL. Plain http is only allowed for localhost.",
  );
});

test("saveProvider accepts loopback http:// URLs and requests a port-less host pattern", async () => {
  const cases = [
    { baseURL: "http://localhost:11434/v1", origin: "http://localhost/*" },
    { baseURL: "http://127.0.0.1:8080/v1", origin: "http://127.0.0.1/*" },
  ];
  for (const { baseURL, origin } of cases) {
    const harness = createHarness();
    await settle();

    const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
    custom.checked = true;
    custom.dispatchEvent(new harness.window.Event("change"));
    harness.document.getElementById("provider-url").value = baseURL;
    harness.document.getElementById("provider-model").value = "m";
    harness.document.getElementById("provider-key").value = "k";
    harness.document.getElementById("provider-save").click();
    await settle();

    assert.deepEqual(harness.storageData.aiProvider, { kind: "custom", baseURL, model: "m", apiKey: "k" });
    assert.equal(harness.permissionRequests.length, 1);
    assert.equal(harness.permissionRequests[0].origins[0], origin);
  }
});

test("lens share exports only portable lens fields", async () => {
  const harness = createHarness({
    storage: {
      lenses: [{
        id: "lens_work",
        name: "Work",
        icon: "briefcase",
        color: "#3366ff",
        groupSelectors: [{ type: "title", value: "Work" }],
        triggers: { appleFocusIds: ["com.apple.focus.work"], calendarPatterns: ["Planning *"] },
        createdAt: 1,
        updatedAt: 2,
      }],
    },
  });
  await settle();

  harness.document.querySelector(".lens-share-button").click();
  await settle();

  const payload = JSON.parse(harness.clipboardWrites[0]);
  assert.deepEqual(Object.keys(payload).sort(), ["lens", "tabloupeLens"]);
  assert.equal(payload.tabloupeLens, 1);
  assert.deepEqual(payload.lens, {
    name: "Work",
    icon: "briefcase",
    color: "#3366ff",
    groupSelectors: [{ type: "title", value: "Work" }],
  });
});

test("lens import appends a fresh lens and rejects malformed codes without writing", async () => {
  const existing = lensFixture({ id: "lens_existing", name: "Existing" });
  const harness = createHarness({ storage: { lenses: [existing] } });
  await settle();

  const setKeys = [];
  const originalSet = harness.browser.storage.local.set;
  harness.browser.storage.local.set = async (values) => {
    setKeys.push(...Object.keys(values));
    return originalSet(values);
  };

  const importedCode = JSON.stringify({
    tabloupeLens: 1,
    lens: {
      id: "lens_stolen",
      name: "Imported",
      icon: "star",
      color: "#ff00aa",
      groupSelectors: [{ type: "glob", value: "Client*" }],
      triggers: { appleFocusIds: ["com.apple.focus.personal"] },
      calendarPatterns: ["Private *"],
    },
  });
  harness.document.getElementById("lens-import-code").value = importedCode;
  harness.document.getElementById("lens-import-add").click();
  await settle();

  const importMessage = lastMessageOfType(harness.messages, "lens-import");
  assert.ok(importMessage, "sent a lens-import message");
  assert.equal(importMessage.code, importedCode);
  assert.ok(!setKeys.includes("lenses"), "did not write lenses via storage.local.set");

  assert.equal(harness.storageData.lenses.length, 2);
  const imported = harness.state ? harness.state.lenses[1] : harness.storageData.lenses[1];
  assert.ok(imported.id.startsWith("lens_"));
  assert.notEqual(imported.id, "lens_stolen");
  assert.equal(imported.name, "Imported");
  assert.equal(imported.icon, "star");
  assert.equal(imported.color, "#ff00aa");
  assert.deepEqual(imported.groupSelectors, [{ type: "glob", value: "Client*" }]);
  assert.deepEqual(imported.triggers.appleFocusIds, []);
  assert.deepEqual(imported.triggers.calendarPatterns, []);
  assert.equal(harness.document.getElementById("lens-import-code").value, "");

  harness.messages.length = 0;
  const before = JSON.stringify(harness.storageData.lenses);
  harness.document.getElementById("lens-import-code").value = "{not json";
  harness.document.getElementById("lens-import-add").click();
  await settle();

  assert.equal(JSON.stringify(harness.storageData.lenses), before);
  assert.equal(harness.document.getElementById("lens-import-code").value, "{not json");
  assert.ok(!setKeys.includes("lenses"), "malformed import did not write lenses");
  assert.equal(harness.document.querySelector("#toast-host .toast").textContent, "Not a valid lens code.");
});

test("loadAll keeps a concurrent storage.onChanged update instead of reverting it", async () => {
  const harness = createHarness({ storage: { aiGroupingPrompt: "OLD prompt from disk" } });
  await settle();
  assert.equal(harness.document.getElementById("ai-grouping-prompt").value, "OLD prompt from disk");

  const oldSnapshot = clone(harness.storageData);
  let resolveGet;
  harness.browser.storage.local.get = () => new Promise((resolve) => {
    resolveGet = () => resolve(clone(oldSnapshot));
  });

  const loadPromise = harness.window.loadAll();
  await nextTick();

  // A newer value arrives via storage.onChanged while loadAll's read is in flight.
  await harness.browser.storage.local.set({ aiGroupingPrompt: "NEW prompt via onChanged" });
  await nextTick();

  // loadAll's stale read now resolves with the OLD value; it must not clobber the newer one.
  resolveGet();
  await loadPromise;
  await settle();

  assert.equal(
    harness.document.getElementById("ai-grouping-prompt").value,
    "NEW prompt via onChanged",
  );
});

test("a superseded loadAll does not clobber a newer load's committed state", async () => {
  const harness = createHarness({ storage: { aiGroupingPrompt: "disk value" } });
  await settle();

  let firstResolve;
  let getCount = 0;
  harness.browser.storage.local.get = (keys) => {
    getCount += 1;
    if (getCount === 1) {
      return new Promise((resolve) => { firstResolve = () => resolve({ aiGroupingPrompt: "STALE" }); });
    }
    return Promise.resolve({ aiGroupingPrompt: "FRESH" });
  };

  const first = harness.window.loadAll();      // stale snapshot, read gated
  await nextTick();
  const second = harness.window.loadAll();     // newer load reads FRESH and commits
  await second;
  firstResolve();                              // the superseded load resolves late
  await first;
  await settle();

  assert.equal(harness.document.getElementById("ai-grouping-prompt").value, "FRESH");
});

test("out-of-order group refreshes apply only the latest snapshot", async () => {
  const harness = createHarness();
  await settle();

  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let queryCount = 0;
  harness.browser.tabGroups.query = async () => {
    queryCount += 1;
    if (queryCount === 1) {
      await firstGate;
      return [{ id: 1, title: "Stale", windowId: 7 }];
    }
    return [{ id: 2, title: "Fresh", windowId: 7 }];
  };

  const first = harness.window.refreshFirefoxGroups();  // stale query, gated
  await nextTick();
  const second = harness.window.refreshFirefoxGroups(); // fresh query applies
  await second;
  releaseFirst();                                       // stale resolves late, dropped
  await first;
  await settle();

  const diag = harness.document.getElementById("diag-current-groups").textContent;
  assert.match(diag, /Fresh/);
  assert.doesNotMatch(diag, /Stale/);
});

test("provider test connection lists models and persists successful diagnostics", async () => {
  const harness = createHarness({
    fetchHandler: async (url) => {
      assert.equal(url, "https://api.example.com/v1/models");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "model-a" }, { id: "model-b" }] };
        },
      };
    },
  });
  await settle();

  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-url").value = "https://api.example.com/v1";
  harness.document.getElementById("provider-model").value = "model-a";
  harness.document.getElementById("provider-key").value = "sk-test";
  harness.document.getElementById("provider-test").click();
  await settle();

  assert.deepEqual([...harness.document.querySelectorAll("#provider-models option")].map((option) => option.value), ["model-a", "model-b"]);
  assert.equal(harness.document.getElementById("provider-test-status").textContent, "Found 2 models.");
  assert.equal(harness.storageData.lastProviderCheck.ok, true);
  assert.equal(harness.storageData.lastProviderCheck.detail, "Found 2 models.");
});

test("provider test connection falls back to completions and records HTTP failures", async () => {
  const harness = createHarness({
    fetchHandler: async (url) => {
      if (url === "https://api.example.com/v1/models") {
        return { ok: false, status: 404 };
      }
      assert.equal(url, "https://api.example.com/v1/chat/completions");
      return { ok: false, status: 500 };
    },
  });
  await settle();

  const custom = harness.document.querySelector('input[name="provider-kind"][value="custom"]');
  custom.checked = true;
  custom.dispatchEvent(new harness.window.Event("change"));
  harness.document.getElementById("provider-url").value = "https://api.example.com/v1";
  harness.document.getElementById("provider-model").value = "model-a";
  harness.document.getElementById("provider-test").click();
  await settle();

  assert.deepEqual(harness.fetchCalls.map((call) => call.url), [
    "https://api.example.com/v1/models",
    "https://api.example.com/v1/chat/completions",
  ]);
  assert.equal(harness.document.getElementById("provider-test-status").textContent, "Connection failed: HTTP 500");
  assert.equal(harness.storageData.lastProviderCheck.ok, false);
  assert.equal(harness.storageData.lastProviderCheck.detail, "Connection failed: HTTP 500");
});

test("sync toggle persists syncLenses and renders syncLastError", async () => {
  const harness = createHarness({ storage: { syncLastError: "quota exceeded" } });
  await settle();

  const error = harness.document.getElementById("sync-last-error");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Sync issue: quota exceeded");

  const checkbox = harness.document.getElementById("sync-lenses");
  checkbox.checked = true;
  checkbox.dispatchEvent(new harness.window.Event("change"));
  await settle();
  assert.equal(harness.storageData.syncLenses, true);

  await harness.browser.storage.local.set({ syncLastError: "network down" });
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "Sync issue: network down");
});

test("pairing token field saves lowercase hex, rejects invalid input, and clears empty saves", async () => {
  const harness = createHarness();
  await settle();

  const input = harness.document.getElementById("bus-token");
  input.value = "A".repeat(64);
  harness.document.getElementById("bus-token-save").click();
  await settle();
  assert.equal(harness.storageData.busToken, "a".repeat(64));
  assert.equal(input.value, "a".repeat(64));

  input.value = "g".repeat(64);
  harness.document.getElementById("bus-token-save").click();
  await settle();
  assert.equal(harness.storageData.busToken, "a".repeat(64));
  assert.equal(harness.document.querySelector("#toast-host .toast").textContent, "Pairing token must be 64 lowercase hex characters.");

  input.value = "";
  harness.document.getElementById("bus-token-save").click();
  await settle();
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageData, "busToken"), false);
  assert.equal(harness.document.querySelector("#toast-host .toast").textContent, "Pairing token cleared.");
});

test("a rejected lens edit reverts the optimistic UI instead of reporting success", async () => {
  const harness = createHarness({
    storage: { lenses: [lensFixture({ groupSelectors: [] })] },
    groups: [{ id: 1, title: "Deep Work" }],
  });
  const { document, browser } = harness;
  await settle();

  // Force the background to reject the edit without persisting it.
  const realSend = browser.runtime.sendMessage;
  browser.runtime.sendMessage = async (msg) => {
    if (msg.type === "lens-update") return { ok: false, error: "missing_lens" };
    return realSend(msg);
  };

  const input = lensCard(document).querySelector(".group-chip-input");
  input.value = "Deep Work";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  const chipLabels = [...lensCard(document).querySelectorAll(".group-chip-label")].map((el) => el.textContent);
  assert.ok(!chipLabels.includes("Deep Work"), "optimistic selector reverted after backend rejection");
  assert.match(document.getElementById("status").textContent, /failed/i);
});
