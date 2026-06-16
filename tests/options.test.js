const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");
const optionsJs = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const htmlWithScript = optionsHtml.replace('<script defer src="options.js"></script>', `<script>${optionsJs}</script>`);

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

function createHarness({ storage = {}, groups = [], grantPermission = true } = {}) {
  const storageData = clone(storage) || {};
  const groupState = clone(groups);
  const storageListeners = [];
  const messages = [];
  const permissionRequests = [];

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
    runtime: {
      async sendMessage(msg) {
        messages.push(msg);
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
      window.browser = browser;
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
  };
}

test("initial render shows 'No Focus IDs' when empty", async () => {
  const { document } = createHarness();
  await settle();

  const tbody = document.getElementById("mappings-body");
  assert.match(tbody.textContent, /No Focus IDs yet/);
});

test("renders saved mappings with name and group chips", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work", "Research"] } }
  });
  await settle();

  const rows = document.querySelectorAll("#mappings-body tr:not(.unassigned-row)");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector(".focus-name").textContent, "Work");
  assert.equal(rows[0].querySelector(".focus-name").title, "com.apple.focus.work");
  const chips = [...rows[0].querySelectorAll(".group-chip-label")].map((c) => c.textContent);
  assert.deepEqual(chips, ["Work", "Research"]);
});

test("legacy string mappings load as a single group chip", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": "Work" } }
  });
  await settle();

  const chips = [...document.querySelectorAll("#mappings-body .group-chip-label")].map((c) => c.textContent);
  assert.deepEqual(chips, ["Work"]);
});

test("known focus id renders its catalog name and an icon", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.personal-time": ["Personal"] } }
  });
  await settle();

  const row = document.querySelector("#mappings-body tr");
  assert.equal(row.querySelector(".focus-name").textContent, "Personal");
  assert.ok(row.querySelector(".focus-icon"));
});

test("add custom mapping updates DOM and is dirty", async () => {
  const { document } = createHarness();
  await settle();

  document.getElementById("new-focus-id").value = "com.apple.custom";
  document.getElementById("new-group-title").value = "CustomGroup";
  document.getElementById("add-mapping").click();

  const rows = document.querySelectorAll("#mappings-body tr:not(.unassigned-row)");
  assert.equal(rows.length, 1);
  // Unknown id falls back to showing the raw id as the name.
  assert.equal(rows[0].querySelector(".focus-name").textContent, "com.apple.custom");
  assert.deepEqual([...rows[0].querySelectorAll(".group-chip-label")].map((c) => c.textContent), ["CustomGroup"]);
  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
});

test("add custom mapping with empty title creates an ignored mapping", async () => {
  const { document } = createHarness();
  await settle();

  document.getElementById("new-focus-id").value = "com.apple.ignore";
  document.getElementById("new-group-title").value = "";
  document.getElementById("add-mapping").click();

  const row = document.querySelector("#mappings-body tr");
  assert.equal(row.querySelector(".focus-name").textContent, "com.apple.ignore");
  assert.equal(row.querySelectorAll(".group-chip").length, 0);
  assert.match(row.textContent, /ignored/);
});

test("the row add input adds a group chip via Enter", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": [] } }
  });
  await settle();

  const input = document.querySelector("#mappings-body .group-chip-input");
  input.value = "Deep Work";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  assert.deepEqual([...document.querySelectorAll("#mappings-body .group-chip-label")].map((c) => c.textContent), ["Deep Work"]);
  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
});

test("removing a group chip updates the draft", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work", "Research"] } }
  });
  await settle();

  document.querySelectorAll("#mappings-body .group-chip-remove")[0].click();

  assert.deepEqual([...document.querySelectorAll("#mappings-body .group-chip-label")].map((c) => c.textContent), ["Research"]);
});

test("save mappings writes arrays to storage and clears dirty state", async () => {
  const { window, document, storageData } = createHarness();
  await settle();

  document.getElementById("new-focus-id").value = "com.apple.custom";
  document.getElementById("new-group-title").value = "CustomGroup";
  document.getElementById("add-mapping").click();

  const form = document.getElementById("mappings-form");
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await settle();

  assert.deepEqual(storageData.focusMappings, { "com.apple.custom": ["CustomGroup"] });
  assert.equal(document.getElementById("status").className, "ok");
  assert.match(document.getElementById("status").textContent, /Saved/);
});

test("discard changes reverts to storage state", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } }
  });
  await settle();

  const input = document.querySelector("#mappings-body .group-chip-input");
  input.value = "Research";
  input.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
  assert.deepEqual([...document.querySelectorAll("#mappings-body .group-chip-label")].map((c) => c.textContent), ["Work", "Research"]);

  document.getElementById("discard").click();
  await settle();

  assert.deepEqual([...document.querySelectorAll("#mappings-body .group-chip-label")].map((c) => c.textContent), ["Work"]);
  assert.match(document.getElementById("status").textContent, /Discarded changes/);
});

test("unmapped callout is displayed and map-it-now pre-fills form", async () => {
  const { document } = createHarness({
    storage: { 
      lastAction: "unmapped_focus_id",
      unmappedFocusId: "com.apple.focus.new"
    }
  });
  await settle();

  const callout = document.getElementById("unmapped-callout");
  assert.equal(callout.hidden, false);
  assert.equal(document.getElementById("callout-focus-id").textContent, "com.apple.focus.new");

  // Click 'Map it now'
  // jsdom doesn't fully implement scrollIntoView, so mock it on the input
  const idInput = document.getElementById("new-focus-id");
  idInput.scrollIntoView = () => {};
  
  document.getElementById("callout-map-btn").click();
  
  assert.equal(idInput.value, "com.apple.focus.new");
  assert.equal(document.getElementById("new-group-title").value, "");
  assert.equal(document.activeElement, document.getElementById("new-group-title"));
});

test("apply-now button sends message", async () => {
  const { document, messages } = createHarness();
  await settle();

  document.getElementById("apply-now").click();
  await settle();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "apply-current-focus");
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

test("reset button restores the default shortcut", async () => {
  const harness = createHarness({
    storage: { tabSearchShortcut: { ctrl: true, alt: false, shift: true, meta: false, key: "j" } },
  });
  await settle();

  harness.document.getElementById("shortcut-reset").click();
  await settle();

  assert.deepEqual({ ...harness.storageData.tabSearchShortcut }, {
    ctrl: true,
    alt: false,
    shift: false,
    meta: false,
    key: "s",
  });
  assert.equal(harness.document.getElementById("shortcut-record").textContent, "Ctrl + S");
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
  assert.match(harness.document.getElementById("provider-status").textContent, /denied/i);
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

function dragChipTo(window, chip, target, { alt = false } = {}) {
  chip.dispatchEvent(new window.Event("dragstart", { bubbles: true }));
  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  if (alt) Object.defineProperty(drop, "altKey", { value: true });
  target.dispatchEvent(drop);
}

function rowForFocus(document, id) {
  return [...document.querySelectorAll("#mappings-body tr")].find(
    (row) => row.querySelector(".focus-name") && row.querySelector(".focus-name").title === id
  );
}

function chipLabels(scope) {
  return [...scope.querySelectorAll(".group-chip-label")].map((c) => c.textContent);
}

test("cached MCC catalog overrides the bundled focus name", async () => {
  const { document } = createHarness({
    storage: {
      focusMappings: { "com.apple.focus.work": ["Work"] },
      focusCatalog: { "com.apple.focus.work": { name: "Deep Work", icon: "briefcase", color: "#abc" } },
    },
  });
  await settle();

  assert.equal(document.querySelector("#mappings-body .focus-name").textContent, "Deep Work");
});

test("unassigned list shows Firefox groups not assigned to any focus", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
    groups: [{ id: 1, title: "Work" }, { id: 2, title: "Reading" }, { id: 3, title: "News" }],
  });
  await settle();

  assert.deepEqual(chipLabels(document.getElementById("unassigned-list")), ["News", "Reading"]);
});

test("dragging a chip onto another Focus row moves the group", async () => {
  const { window, document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"], "com.apple.focus.personal-time": [] } },
    groups: [{ id: 1, title: "Work" }],
  });
  await settle();

  const chip = rowForFocus(document, "com.apple.focus.work").querySelector(".group-chip");
  dragChipTo(window, chip, rowForFocus(document, "com.apple.focus.personal-time"));

  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.work")), []);
  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.personal-time")), ["Work"]);
  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
});

test("dragging a chip to the unassigned list unassigns the group", async () => {
  const { window, document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"] } },
    groups: [{ id: 1, title: "Work" }],
  });
  await settle();

  const chip = rowForFocus(document, "com.apple.focus.work").querySelector(".group-chip");
  dragChipTo(window, chip, document.getElementById("unassigned-list"));

  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.work")), []);
  assert.deepEqual(chipLabels(document.getElementById("unassigned-list")), ["Work"]);
});

test("dragging an unassigned group onto a Focus row assigns it", async () => {
  const { window, document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": [] } },
    groups: [{ id: 1, title: "Reading" }],
  });
  await settle();

  const chip = document.getElementById("unassigned-list").querySelector(".group-chip");
  dragChipTo(window, chip, rowForFocus(document, "com.apple.focus.work"));

  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.work")), ["Reading"]);
  assert.deepEqual(chipLabels(document.getElementById("unassigned-list")), []);
});

test("the row add input suggests groups from other modes, excluding its own", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"], "com.apple.focus.personal-time": [] } },
    groups: [{ id: 1, title: "Work" }, { id: 2, title: "Research" }, { id: 3, title: "Reading" }],
  });
  await settle();

  const personalList = rowForFocus(document, "com.apple.focus.personal-time")
    .querySelector(".group-chip-input").getAttribute("list");
  const personalOptions = [...document.getElementById(personalList).querySelectorAll("option")].map((o) => o.value);
  assert.deepEqual(personalOptions, ["Reading", "Research", "Work"]);

  const workList = rowForFocus(document, "com.apple.focus.work")
    .querySelector(".group-chip-input").getAttribute("list");
  const workOptions = [...document.getElementById(workList).querySelectorAll("option")].map((o) => o.value);
  assert.deepEqual(workOptions, ["Reading", "Research"]);
});

test("Alt-dragging a chip copies the group to another mode, keeping the source", async () => {
  const { window, document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": ["Work"], "com.apple.focus.personal-time": [] } },
    groups: [{ id: 1, title: "Work" }],
  });
  await settle();

  const chip = rowForFocus(document, "com.apple.focus.work").querySelector(".group-chip");
  dragChipTo(window, chip, rowForFocus(document, "com.apple.focus.personal-time"), { alt: true });

  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.work")), ["Work"]);
  assert.deepEqual(chipLabels(rowForFocus(document, "com.apple.focus.personal-time")), ["Work"]);
});
