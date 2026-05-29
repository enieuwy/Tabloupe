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

function createHarness({ storage = {}, groups = [] } = {}) {
  const storageData = clone(storage) || {};
  const groupState = clone(groups);
  const storageListeners = [];
  const messages = [];

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
    }
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
    messages
  };
}

test("initial render shows 'No Focus IDs' when empty", async () => {
  const { document } = createHarness();
  await settle();

  const tbody = document.getElementById("mappings-body");
  assert.match(tbody.textContent, /No Focus IDs yet/);
});

test("renders saved mappings and populates inputs", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": "Work" } }
  });
  await settle();

  const rows = document.querySelectorAll("#mappings-body tr");
  assert.equal(rows.length, 1);
  const code = rows[0].querySelector("code");
  const input = rows[0].querySelector("input[type='text']");
  
  assert.equal(code.textContent, "com.apple.focus.work");
  assert.equal(input.value, "Work");
});

test("add custom mapping updates DOM and is dirty", async () => {
  const { document } = createHarness();
  await settle();

  document.getElementById("new-focus-id").value = "com.apple.custom";
  document.getElementById("new-group-title").value = "CustomGroup";
  document.getElementById("add-mapping").click();
  
  const rows = document.querySelectorAll("#mappings-body tr");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector("code").textContent, "com.apple.custom");
  assert.equal(rows[0].querySelector("input[type='text']").value, "CustomGroup");
  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
});

test("save mappings writes to storage and clears dirty state", async () => {
  const { window, document, storageData } = createHarness();
  await settle();

  document.getElementById("new-focus-id").value = "com.apple.custom";
  document.getElementById("new-group-title").value = "CustomGroup";
  document.getElementById("add-mapping").click();
  
  const form = document.getElementById("mappings-form");
  form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await settle();

  assert.deepEqual(storageData.focusMappings, { "com.apple.custom": "CustomGroup" });
  assert.equal(document.getElementById("status").className, "ok");
  assert.match(document.getElementById("status").textContent, /Saved/);
});

test("discard changes reverts to storage state", async () => {
  const { document } = createHarness({
    storage: { focusMappings: { "com.apple.focus.work": "Work" } }
  });
  await settle();

  const inputs = document.querySelectorAll("#mappings-body input[type='text']");
  inputs[0].value = "Changed";
  inputs[0].dispatchEvent(new document.defaultView.Event("input"));
  
  assert.match(document.getElementById("status").textContent, /Unsaved changes/);
  
  document.getElementById("discard").click();
  await settle();
  
  const revertedInputs = document.querySelectorAll("#mappings-body input[type='text']");
  assert.equal(revertedInputs[0].value, "Work");
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
