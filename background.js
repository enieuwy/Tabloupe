const WS_URL = "ws://127.0.0.1:8767";
const MIN_RECONNECT_MS = 1000;
// Cap the alarm-backed retry at 10 minutes: while the optional daemon is
// offline, a 1-minute alarm would wake the suspended event page forever
// (battery drain). Every wake also calls connect() from start(), and any
// popup/options interaction wakes the page, so recovery stays prompt.
const MAX_RECONNECT_MS = 600000;
const MIN_RECONNECT_ALARM_MINUTES = 1;
const OPTIONS_NOTIFICATION_PREFIX = "focus-unmapped-";
// On-device FoundationModels can take ~1s/tab; a busy window easily exceeds 60s.
// Cloud backends return in a few seconds. Budget generously — the popup caches
// per window, so a slow run isn't lost if the user closes the popup.
const GROUPING_TIMEOUT_MS = 120000;
const BUS_TOKEN_KEY = "busToken";
const BUS_PAIRING_STATUS_KEY = "busPairingStatus";
const AUTH_OK_TIMEOUT_MS = 5000;
const BUS_AUTH_STATES = Object.freeze({
  UNAUTHENTICATED: "unauthenticated",
  AWAITING_AUTH_OK: "awaitingAuthOk",
  AUTHENTICATED: "authenticated",
  LEGACY: "legacy",
});
const BUS_PAIRING_STATUSES = Object.freeze({
  PAIRED: "paired",
  PAIRING_FAILED: "pairing_failed",
  PAIRING_REQUIRED: "pairing_required",
  LEGACY: "legacy (unpaired)",
});
const AI_GROUPING_ENABLED_KEY = "aiGroupingEnabled";
const AI_PROVIDER_KEY = "aiProvider";
const AI_PIN_TO_FOCUS_KEY = "aiPinToFocus";
const AI_GROUPING_PROMPT_KEY = "aiGroupingPrompt";
const AI_GROUPING_PROMPT_MAX = 4000;
const AI_AUTO_GROUP_KEY = "aiAutoGroup";
const DEFAULT_TAB_SEARCH_SHORTCUT = Object.freeze({ ctrl: true, alt: false, shift: false, meta: false, key: "s" });
const DISCARD_COLLAPSED_TABS_KEY = "discardCollapsedTabs";
const AUTO_GROUP_DEBOUNCE_MS = 5000;
const AUTO_GROUP_COOLDOWN_MS = 30000;
const SCHEDULE_ALARM_NAME = "lens-schedule-tick";
const FOCUS_SESSION_HISTORY_KEY = "focusSessionHistory";
const SYNC_LENSES_KEY = "syncLenses";
const SYNC_LAST_ERROR_KEY = "syncLastError";
const LENS_SYNC_META_KEY = "lensSyncMeta";
const LENS_SYNC_PUSH_DEBOUNCE_MS = 2000;
const MAX_SYNC_LENS_ITEM_BYTES = 7500;
const MAX_FOCUS_SESSION_HISTORY = 1000;
// Default system prompt. The user can replace it wholesale from Options (stored
// in aiGroupingPrompt); an empty override falls back to this default.
const GROUPING_SYSTEM_PROMPT =
  "You organize a user's open browser tabs into a small number of topic groups. " +
  "Group tabs that share a project, task, or subject. Prefer " +
  "two to six groups. Every tab index belongs to exactly one group. Topic labels must be short " +
  '(1-4 words). Respond with ONLY a JSON object of the form ' +
  '{"groups":[{"topic":"...","tabIndices":[0,1]}]} and nothing else.';
const GROUPABLE_URL = /^https?:\/\//i;
const DEFAULT_COOKIE_STORE_ID = "firefox-default";
const PRIVATE_COOKIE_STORE_ID = "firefox-private";
// Firefox tab-group colors. Assigned round-robin so adjacent groups differ;
// the model only proposes topics + members, never presentation.
const TAB_GROUP_COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"];

// macOS notifications silently truncate (or drop) very long bodies. Cap the
// variable-length group/title lists embedded in messages so a window with many
// tab groups still produces a readable, deliverable notification.
const NOTIFICATION_LIST_MAX = 12;

const LEGACY_MAP_KEY = "focus" + "Mappings";

// Which Apple Focus id automation last applied. Persisted in storage.local
// (not memory) so a focus-off arriving after the event page suspended, or a
// stale same-id replay on reconnect, is still handled correctly.
const LAST_APPLIED_APPLE_FOCUS_KEY = "lastAppliedAppleFocusId";
let focusBadge = { text: "", color: null, title: "Tabloupe" };
const transientViewsByWindow = new Map();
let lastError = null;
let socket = null;
let reconnectDelay = MIN_RECONNECT_MS;
let reconnectTimer = null;
let messageQueue = Promise.resolve();
let groupingRequestSeq = 0;
const pendingGroupingRequests = new Map();
let socketAuthState = BUS_AUTH_STATES.UNAUTHENTICATED;
let socketAuthTimer = null;
let socketAuthContext = null;
let pairingStatus = null;
let loggedLegacyActivateView = false;
// Per-window cache of the last preview so the ephemeral popup can show a result
// instantly on reopen (and survive being closed mid-compute). Cleared on apply,
// dismiss, window close, or TTL expiry.
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const lastProposalByWindow = new Map();

// AI previews collapse onto one in-flight request per window so re-opening the
// popup or clicking Regroup mid-compute can't fan out duplicate daemon/LLM calls.
const inflightPreviews = new Map();
let autoGroupEnabled = false;
const autoGroupDebounceTimers = new Map();
const autoGroupCooldown = new Set();
// True single-flight guard: a per-window run holds this for the whole
// compute+commit. The cooldown alone can't serialize runs because on-device
// clustering can outlive AUTO_GROUP_COOLDOWN_MS, letting a later run start and
// then fail re-validation ("no_groups") on tabs the first run already grouped.
const autoGroupInflight = new Set();
const windowProfileOverrides = new Map();
let containersCache = null;
let lensSyncEnabled = false;
let applyingInboundLensSync = false;
let lensSyncPushTimer = null;
let pendingLensSyncAll = false;
let pendingLensSyncPrefs = false;
let pendingLensSyncOrder = false;
const pendingLensSyncIds = new Set();
const pendingLensSyncRemovedIds = new Set();

// Per-window ephemeral view state (transient views, automation overrides).
// windowIds are only stable within one browser session, so this is mirrored
// to storage.session: it survives event-page suspension but is cleared on
// browser exit. Falls back to memory-only where storage.session is missing.
const sessionStore = typeof browser !== "undefined" && browser.storage && browser.storage.session
  ? browser.storage.session
  : null;
const SESSION_WINDOW_STATE_KEY = "windowViewState";

async function loadSessionWindowState() {
  if (!sessionStore) {
    return;
  }
  try {
    const stored = await sessionStore.get(SESSION_WINDOW_STATE_KEY);
    const state = isRecord(stored[SESSION_WINDOW_STATE_KEY]) ? stored[SESSION_WINDOW_STATE_KEY] : {};
    const transientViews = isRecord(state.transientViews) ? state.transientViews : {};
    for (const [key, view] of Object.entries(transientViews)) {
      const windowId = Number(key);
      if (Number.isInteger(windowId) && isRecord(view) && view.kind === "transient") {
        transientViewsByWindow.set(windowId, view);
      }
    }
    const windowProfiles = isRecord(state.windowProfiles) ? state.windowProfiles : {};
    for (const [key, profile] of Object.entries(windowProfiles)) {
      const windowId = Number(key);
      const normalized = normalizeWindowProfile(profile);
      if (Number.isInteger(windowId) && normalized.kind !== "default") {
        windowProfileOverrides.set(windowId, normalized);
      }
    }
  } catch (error) {
    console.error("Session window state load error:", error);
  }
}

function persistSessionWindowState() {
  if (!sessionStore) {
    return;
  }
  const state = { transientViews: {}, windowProfiles: {} };
  for (const [windowId, view] of transientViewsByWindow) {
    state.transientViews[windowId] = view;
  }
  for (const [windowId, profile] of windowProfileOverrides) {
    state.windowProfiles[windowId] = profile;
  }
  sessionStore.set({ [SESSION_WINDOW_STATE_KEY]: state }).catch((error) => {
    console.error("Session window state save error:", error);
  });
}

const sessionStateReady = loadSessionWindowState();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// Externally-supplied ids (Apple Focus ids from the daemon) are used as plain
// object keys in storage; never let them name prototype machinery.
function isUnsafeKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

// A focus maps to a list of tab-group titles. An empty list means "seen but
// intentionally ignored".
function normalizeTitles(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const titles = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const title = item.trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      titles.push(title);
    }
  }
  return titles;
}

function enqueueFocusWork(task) {
  const queued = messageQueue.then(task, task);
  messageQueue = queued.catch(() => {});
  return queued;
}


function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  browser.alarms.clear("reconnect");
}

function scheduleReconnect() {
  clearReconnectTimer();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  // setTimeout is the primary mechanism; the alarm is a fallback in case
  // Firefox suspends the background page. Firefox alarms are minute-granular,
  // so keep the timer fast and only use the alarm as a conservative wake-up.
  browser.alarms.create("reconnect", {
    delayInMinutes: Math.max(delay / 60000, MIN_RECONNECT_ALARM_MINUTES),
  });
  reconnectTimer = setTimeout(connect, delay);
}

function clearSocketAuthTimer() {
  if (socketAuthTimer !== null) {
    clearTimeout(socketAuthTimer);
    socketAuthTimer = null;
  }
}

function resetSocketAuthState() {
  clearSocketAuthTimer();
  socketAuthState = BUS_AUTH_STATES.UNAUTHENTICATED;
  socketAuthContext = null;
}

async function setPairingStatus(status) {
  pairingStatus = status;
  await browser.storage.local.set({ [BUS_PAIRING_STATUS_KEY]: status });
}

function normalizeBusToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

async function getBusToken() {
  const stored = await browser.storage.local.get(BUS_TOKEN_KEY);
  return normalizeBusToken(stored[BUS_TOKEN_KEY]);
}

function authCryptoAvailable() {
  return typeof crypto !== "undefined" &&
    crypto &&
    crypto.subtle &&
    typeof crypto.subtle.importKey === "function" &&
    typeof crypto.subtle.sign === "function" &&
    typeof crypto.getRandomValues === "function" &&
    typeof TextEncoder === "function";
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hmacHex(token, input) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return bytesToHex(new Uint8Array(signature));
}

function canUseBusSocket() {
  return socket &&
    socket.readyState === WebSocket.OPEN &&
    (socketAuthState === BUS_AUTH_STATES.AUTHENTICATED || socketAuthState === BUS_AUTH_STATES.LEGACY);
}

function sendBusEnvelope(envelope) {
  if (!canUseBusSocket()) {
    return;
  }
  try {
    socket.send(JSON.stringify(envelope));
  } catch (error) {
    console.error("Bus send error:", error);
  }
}

async function lensStatePayload() {
  const [activeView, stored, lenses] = await Promise.all([
    getActiveView(),
    browser.storage.local.get("lastActivation"),
    getLenses(),
  ]);
  const lens = activeView.kind === "lens"
    ? lenses.find((entry) => entry.id === activeView.lensId)
    : null;
  return {
    activeView,
    lens: lens ? {
      id: lens.id,
      name: lens.name,
      icon: lens.icon,
      color: lens.color,
    } : null,
    lastActivation: isRecord(stored.lastActivation) ? stored.lastActivation : null,
  };
}

async function publishLensState() {
  if (!canUseBusSocket()) {
    return;
  }
  sendBusEnvelope({
    type: "lensState",
    schemaVersion: 1,
    payload: await lensStatePayload(),
  });
}

function publishLensStateSoon() {
  publishLensState().catch((error) => {
    console.error("Lens state publish error:", error);
  });
}

async function resolveExternalView(view) {
  if (!isRecord(view)) {
    return null;
  }
  if (view.kind === "all") {
    return { kind: "all" };
  }
  if (view.kind !== "lens") {
    return null;
  }
  const lenses = await getLenses();
  if (typeof view.lensId === "string") {
    return lenses.some((lens) => lens.id === view.lensId)
      ? { kind: "lens", lensId: view.lensId }
      : null;
  }
  if (typeof view.name === "string" && view.name.trim()) {
    const wanted = view.name.trim().toLowerCase();
    const matches = lenses.filter((lens) => lens.name.toLowerCase() === wanted);
    return matches.length === 1 ? { kind: "lens", lensId: matches[0].id } : null;
  }
  return null;
}

async function handleActivateViewEnvelope(msg) {
  if (socketAuthState !== BUS_AUTH_STATES.AUTHENTICATED) {
    if (socketAuthState === BUS_AUTH_STATES.LEGACY && !loggedLegacyActivateView) {
      loggedLegacyActivateView = true;
      console.warn("Ignoring activateView from unauthenticated legacy helper.");
    }
    return;
  }
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const view = await resolveExternalView(payload.view);
  if (!view) {
    return;
  }
  await activateView(view, { trigger: "external", triggerId: "ws" });
}

async function recordSeen(rawId) {
  if (rawId === null) {
    await browser.storage.local.set({ lastFocusSeen: null });
    return;
  }

  if (isUnsafeKey(rawId)) {
    return;
  }

  const now = Date.now();
  const stored = await browser.storage.local.get("seenFocusIds");
  const seenFocusIds = isRecord(stored.seenFocusIds) ? { ...stored.seenFocusIds } : {};
  const previous = isRecord(seenFocusIds[rawId]) ? seenFocusIds[rawId] : {};
  seenFocusIds[rawId] = {
    firstSeen: typeof previous.firstSeen === "number" ? previous.firstSeen : now,
    lastSeen: now,
  };

  await browser.storage.local.set({
    lastFocusSeen: rawId,
    seenFocusIds,
  });
}

function isSelectorType(type) {
  return type === "title" || type === "glob" || type === "container";
}

function normalizedSelectors(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const selectors = [];
  for (const selector of value) {
    if (!isRecord(selector) || !isSelectorType(selector.type)) {
      continue;
    }
    const raw = typeof selector.value === "string" ? selector.value.trim() : "";
    if (raw === "") {
      continue;
    }
    const key = `${selector.type}\u0000${raw}`;
    if (!seen.has(key)) {
      seen.add(key);
      selectors.push({ type: selector.type, value: raw });
    }
  }
  return selectors;
}

function isSpecialCookieStoreId(cookieStoreId) {
  return cookieStoreId === DEFAULT_COOKIE_STORE_ID || cookieStoreId === PRIVATE_COOKIE_STORE_ID;
}

function normalizeContainer(identity) {
  if (!isRecord(identity) || typeof identity.cookieStoreId !== "string" || isSpecialCookieStoreId(identity.cookieStoreId)) {
    return null;
  }
  return {
    cookieStoreId: identity.cookieStoreId,
    name: typeof identity.name === "string" ? identity.name : "",
    color: typeof identity.color === "string" ? identity.color : "",
    icon: typeof identity.icon === "string" ? identity.icon : "",
  };
}

function invalidateContainersCache() {
  containersCache = null;
}

async function getContainers() {
  if (containersCache) {
    return containersCache;
  }
  const api = browser.contextualIdentities;
  if (!api || typeof api.query !== "function") {
    containersCache = [];
    return containersCache;
  }
  try {
    const identities = await api.query({});
    containersCache = (Array.isArray(identities) ? identities : [])
      .map(normalizeContainer)
      .filter(Boolean);
  } catch (error) {
    containersCache = [];
  }
  return containersCache;
}

function containersByCookieStore(containers) {
  return new Map((Array.isArray(containers) ? containers : []).map((container) => [container.cookieStoreId, container]));
}

async function containersForSearch() {
  const containers = await getContainers();
  return { ok: true, containers: containers.map((container) => ({ ...container })) };
}

function normalizeLens(lens) {
  if (!isRecord(lens) || typeof lens.id !== "string" || typeof lens.name !== "string") {
    return null;
  }
  const triggers = isRecord(lens.triggers) ? lens.triggers : {};
  return {
    id: lens.id,
    name: lens.name,
    icon: typeof lens.icon === "string" && lens.icon ? lens.icon : "target",
    color: typeof lens.color === "string" ? lens.color : null,
    groupSelectors: normalizedSelectors(lens.groupSelectors),
    triggers: {
      appleFocusIds: Array.isArray(triggers.appleFocusIds)
        ? [...new Set(triggers.appleFocusIds.filter((id) => typeof id === "string" && id !== ""))]
        : [],
    },
    createdAt: typeof lens.createdAt === "number" ? lens.createdAt : Date.now(),
    updatedAt: typeof lens.updatedAt === "number" ? lens.updatedAt : Date.now(),
    ...(isRecord(lens.migratedFrom) && Array.isArray(lens.migratedFrom.focusIds)
      ? { migratedFrom: { focusIds: lens.migratedFrom.focusIds.filter((id) => typeof id === "string") } }
      : {}),
  };
}

async function getLenses() {
  const stored = await browser.storage.local.get("lenses");
  return Array.isArray(stored.lenses) ? stored.lenses.map(normalizeLens).filter(Boolean) : [];
}

async function saveLenses(arr) {
  await browser.storage.local.set({ lenses: Array.isArray(arr) ? arr.map(normalizeLens).filter(Boolean) : [] });
}

function generateLensId() {
  return `lens_${Math.random().toString(36).slice(2, 10) || Date.now().toString(36)}`;
}

function isPersistedView(view) {
  return isRecord(view) && (view.kind === "all" || (view.kind === "lens" && typeof view.lensId === "string"));
}

async function getActiveView() {
  const stored = await browser.storage.local.get("activeView");
  return isPersistedView(stored.activeView) ? stored.activeView : { kind: "all" };
}

async function setActiveView(view, lastActivation) {
  if (!isPersistedView(view)) {
    return;
  }
  await browser.storage.local.set({
    activeView: view,
    lastActivation: {
      trigger: lastActivation && typeof lastActivation.trigger === "string" ? lastActivation.trigger : "manual",
      ...(lastActivation && typeof lastActivation.triggerId === "string" ? { triggerId: lastActivation.triggerId } : {}),
      at: Date.now(),
    },
  });
}

function viewKey(view) {
  if (!isRecord(view)) return "all";
  if (view.kind === "lens") return `lens:${view.lensId}`;
  return view.kind || "all";
}

async function recordActivationSession(view, lastActivation) {
  if (!isPersistedView(view)) return;
  const now = Date.now();
  const stored = await browser.storage.local.get([FOCUS_SESSION_HISTORY_KEY, "activeView", "lastActivation", "expandedGroups", "collapsedGroups"]);
  const history = Array.isArray(stored[FOCUS_SESSION_HISTORY_KEY]) ? stored[FOCUS_SESSION_HISTORY_KEY].filter(isRecord) : [];
  const previousView = isPersistedView(stored.activeView) ? stored.activeView : null;
  const previousActivation = isRecord(stored.lastActivation) ? stored.lastActivation : {};
  const previousStartedAt = typeof previousActivation.at === "number" ? previousActivation.at : null;
  if (previousView && previousStartedAt && viewKey(previousView) !== viewKey(view)) {
    history.push({
      view: previousView,
      trigger: typeof previousActivation.trigger === "string" ? previousActivation.trigger : "manual",
      ...(typeof previousActivation.triggerId === "string" ? { triggerId: previousActivation.triggerId } : {}),
      startedAt: previousStartedAt,
      endedAt: now,
      expandedGroups: Array.isArray(stored.expandedGroups) ? stored.expandedGroups.filter((item) => typeof item === "string") : [],
      collapsedGroups: Array.isArray(stored.collapsedGroups) ? stored.collapsedGroups.filter((item) => typeof item === "string") : [],
    });
  }
  if (history.length > MAX_FOCUS_SESSION_HISTORY) {
    history.splice(0, history.length - MAX_FOCUS_SESSION_HISTORY);
  }
  await browser.storage.local.set({ [FOCUS_SESSION_HISTORY_KEY]: history });
}


async function getAutomationFallback() {
  const stored = await browser.storage.local.get("automationFallback");
  return isPersistedView(stored.automationFallback) ? stored.automationFallback : { kind: "all" };
}

function normalizeWindowProfile(value) {
  if (!isRecord(value)) return { kind: "default" };
  if (value.kind === "none") return { kind: "none" };
  if (value.kind === "lens" && typeof value.lensId === "string") return { kind: "lens", lensId: value.lensId };
  return { kind: "default" };
}

function getWindowProfile(windowId) {
  return typeof windowId === "number" ? (windowProfileOverrides.get(windowId) || { kind: "default" }) : { kind: "default" };
}

async function handleWindowProfileSet(message) {
  if (!message || typeof message.windowId !== "number") {
    return { ok: false, error: "missing_window" };
  }
  await sessionStateReady;
  const profile = normalizeWindowProfile(message.profile);
  if (profile.kind === "default") {
    windowProfileOverrides.delete(message.windowId);
  } else {
    windowProfileOverrides.set(message.windowId, profile);
  }
  persistSessionWindowState();
  return { ok: true, profile: getWindowProfile(message.windowId) };
}

function normalizeLensSchedules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((schedule) => ({
      lensId: typeof schedule.lensId === "string" ? schedule.lensId : "",
      enabled: schedule.enabled === true,
      days: Array.isArray(schedule.days)
        ? [...new Set(schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [],
      start: typeof schedule.start === "string" && /^\d{2}:\d{2}$/.test(schedule.start) ? schedule.start : "09:00",
      end: typeof schedule.end === "string" && /^\d{2}:\d{2}$/.test(schedule.end) ? schedule.end : "17:00",
    }))
    .filter((schedule) => schedule.lensId);
}

async function getLensSchedules() {
  const stored = await browser.storage.local.get("lensSchedules");
  return normalizeLensSchedules(stored.lensSchedules);
}

function syncStorageArea() {
  if (
    browser.storage &&
    browser.storage.sync &&
    typeof browser.storage.sync.get === "function" &&
    typeof browser.storage.sync.set === "function" &&
    typeof browser.storage.sync.remove === "function"
  ) {
    return browser.storage.sync;
  }
  return null;
}

function isQuotaExceeded(error) {
  const name = error && typeof error.name === "string" ? error.name : "";
  const message = error && typeof error.message === "string" ? error.message : "";
  return name.includes("Quota") || /quota/i.test(message);
}

function syncErrorMessage(error, fallback) {
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

async function setLensSyncLastError(message) {
  try {
    await browser.storage.local.set({ [SYNC_LAST_ERROR_KEY]: typeof message === "string" ? message : "" });
  } catch (error) {
    console.error("Lens sync error state failed:", error);
  }
}

async function safeSyncGet(keys) {
  const sync = syncStorageArea();
  if (!sync) {
    return null;
  }
  return sync.get(keys).catch((error) => {
    if (isQuotaExceeded(error)) {
      setLensSyncLastError(syncErrorMessage(error, "Firefox Sync quota exceeded.")).catch(() => {});
    }
    return null;
  });
}

async function safeSyncSet(values) {
  const sync = syncStorageArea();
  if (!sync || !isRecord(values) || Object.keys(values).length === 0) {
    return sync ? true : null;
  }
  return sync.set(values)
    .then(() => true)
    .catch((error) => {
      if (isQuotaExceeded(error)) {
        setLensSyncLastError(syncErrorMessage(error, "Firefox Sync quota exceeded.")).catch(() => {});
      }
      return false;
    });
}

async function safeSyncRemove(keys) {
  const sync = syncStorageArea();
  const list = Array.isArray(keys) ? keys.filter((key) => typeof key === "string" && key) : [];
  if (!sync || list.length === 0) {
    return sync ? true : null;
  }
  return sync.remove(list)
    .then(() => true)
    .catch((error) => {
      if (isQuotaExceeded(error)) {
        setLensSyncLastError(syncErrorMessage(error, "Firefox Sync quota exceeded.")).catch(() => {});
      }
      return false;
    });
}

function normalizeLensSyncMeta(value) {
  return {
    lensOrderUpdatedAt: isRecord(value) && typeof value.lensOrderUpdatedAt === "number" ? value.lensOrderUpdatedAt : 0,
    prefsUpdatedAt: isRecord(value) && typeof value.prefsUpdatedAt === "number" ? value.prefsUpdatedAt : 0,
  };
}

function maxLensUpdatedAt(lenses) {
  return (Array.isArray(lenses) ? lenses : []).reduce((max, lens) => (
    lens && typeof lens.updatedAt === "number" && lens.updatedAt > max ? lens.updatedAt : max
  ), 0);
}

function lensSyncJsonSize(value) {
  try {
    return encodeURIComponent(JSON.stringify(value)).replace(/%[0-9A-F]{2}/g, "x").length;
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function scheduleByLensId(schedules) {
  const byId = new Map();
  for (const schedule of normalizeLensSchedules(schedules)) {
    byId.set(schedule.lensId, schedule);
  }
  return byId;
}

function normalizeSyncLensEntry(value) {
  if (!isRecord(value)) {
    return null;
  }
  const lens = normalizeLens(value.lens);
  if (!lens) {
    return null;
  }
  const schedule = value.schedule === null
    ? null
    : normalizeLensSchedules([{ ...(isRecord(value.schedule) ? value.schedule : {}), lensId: lens.id }])[0] || null;
  return { lens, schedule };
}

function normalizeSyncLensOrder(value) {
  if (!isRecord(value) || !Array.isArray(value.ids) || typeof value.updatedAt !== "number") {
    return null;
  }
  return {
    ids: value.ids.filter((id) => typeof id === "string" && id),
    updatedAt: value.updatedAt,
  };
}

function normalizeTabSearchShortcut(value) {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.key !== "string" || value.key.length === 0) {
    return { ...DEFAULT_TAB_SEARCH_SHORTCUT };
  }
  return {
    ctrl: Boolean(value.ctrl),
    alt: Boolean(value.alt),
    shift: Boolean(value.shift),
    meta: Boolean(value.meta),
    key: value.key.length === 1 ? value.key.toLowerCase() : value.key,
  };
}

function normalizeSyncPrefs(value) {
  if (!isRecord(value) || typeof value.updatedAt !== "number") {
    return null;
  }
  return {
    aiGroupingPrompt: typeof value.aiGroupingPrompt === "string" ? value.aiGroupingPrompt.slice(0, AI_GROUPING_PROMPT_MAX) : "",
    tabSearchShortcut: normalizeTabSearchShortcut(value.tabSearchShortcut),
    updatedAt: value.updatedAt,
  };
}

function queueLensSyncPushFromLocalChange(changes) {
  if (changes.lenses) {
    pendingLensSyncOrder = true;
    const oldIds = new Set(normalizeLensesFromStorageChange(changes.lenses.oldValue).map((lens) => lens.id));
    const newIds = new Set(normalizeLensesFromStorageChange(changes.lenses.newValue).map((lens) => lens.id));
    for (const id of newIds) {
      pendingLensSyncIds.add(id);
      pendingLensSyncRemovedIds.delete(id);
    }
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        pendingLensSyncRemovedIds.add(id);
        pendingLensSyncIds.delete(id);
      }
    }
  }
  if (changes.lensSchedules) {
    const oldSchedules = scheduleByLensId(changes.lensSchedules.oldValue);
    const newSchedules = scheduleByLensId(changes.lensSchedules.newValue);
    for (const id of new Set([...oldSchedules.keys(), ...newSchedules.keys()])) {
      pendingLensSyncIds.add(id);
    }
  }
  if (changes.aiGroupingPrompt || changes.tabSearchShortcut) {
    pendingLensSyncPrefs = true;
  }
}

function normalizeLensesFromStorageChange(value) {
  return Array.isArray(value) ? value.map(normalizeLens).filter(Boolean) : [];
}

async function recordLocalLensSyncTimestamps(changes) {
  if (applyingInboundLensSync || (!changes.lenses && !changes.aiGroupingPrompt && !changes.tabSearchShortcut)) {
    return;
  }
  const stored = await browser.storage.local.get(LENS_SYNC_META_KEY);
  const meta = normalizeLensSyncMeta(stored[LENS_SYNC_META_KEY]);
  const now = Date.now();
  const next = { ...meta };
  if (changes.lenses) {
    next.lensOrderUpdatedAt = now;
  }
  if (changes.aiGroupingPrompt || changes.tabSearchShortcut) {
    next.prefsUpdatedAt = now;
  }
  if (next.lensOrderUpdatedAt !== meta.lensOrderUpdatedAt || next.prefsUpdatedAt !== meta.prefsUpdatedAt) {
    await browser.storage.local.set({ [LENS_SYNC_META_KEY]: next });
  }
}

function scheduleLensSyncPush(options = {}) {
  if (!lensSyncEnabled || applyingInboundLensSync) {
    return;
  }
  if (options.all) {
    pendingLensSyncAll = true;
  }
  clearTimeout(lensSyncPushTimer);
  lensSyncPushTimer = setTimeout(() => {
    lensSyncPushTimer = null;
    pushLensSync().catch((error) => console.error("Lens sync push failed:", error));
  }, LENS_SYNC_PUSH_DEBOUNCE_MS);
}

function cancelLensSyncPush() {
  if (lensSyncPushTimer !== null) {
    clearTimeout(lensSyncPushTimer);
    lensSyncPushTimer = null;
  }
}

async function pushLensSync() {
  if (!lensSyncEnabled || applyingInboundLensSync || !syncStorageArea()) {
    return;
  }
  const all = pendingLensSyncAll;
  const idsToPush = all ? null : new Set(pendingLensSyncIds);
  const removedIds = all ? new Set() : new Set(pendingLensSyncRemovedIds);
  const pushPrefs = all || pendingLensSyncPrefs;
  const pushOrder = all || pendingLensSyncOrder || pendingLensSyncIds.size > 0 || pendingLensSyncRemovedIds.size > 0;
  const stored = await browser.storage.local.get([
    "lenses",
    "lensSchedules",
    AI_GROUPING_PROMPT_KEY,
    "tabSearchShortcut",
    LENS_SYNC_META_KEY,
  ]);
  const lenses = normalizeLensesFromStorageChange(stored.lenses);
  const lensById = new Map(lenses.map((lens) => [lens.id, lens]));
  const schedules = scheduleByLensId(stored.lensSchedules);
  const meta = normalizeLensSyncMeta(stored[LENS_SYNC_META_KEY]);
  const now = Date.now();
  const values = {};
  const removeKeys = [];
  const errors = [];

  if (pushOrder) {
    values.lensOrder = {
      ids: lenses.map((lens) => lens.id),
      updatedAt: meta.lensOrderUpdatedAt || maxLensUpdatedAt(lenses) || now,
    };
  }

  const lensIds = all ? lenses.map((lens) => lens.id) : [...idsToPush].filter((id) => lensById.has(id));
  for (const id of lensIds) {
    const lens = lensById.get(id);
    const item = { lens, schedule: schedules.get(id) || null };
    const key = `lens/${id}`;
    if (lensSyncJsonSize(item) > MAX_SYNC_LENS_ITEM_BYTES) {
      removeKeys.push(key);
      errors.push(`Lens "${lens.name}" is too large for Firefox Sync and was skipped.`);
      continue;
    }
    values[key] = item;
  }

  for (const id of removedIds) {
    removeKeys.push(`lens/${id}`);
  }

  if (all) {
    const remote = await safeSyncGet(null);
    if (remote) {
      const localIds = new Set(lenses.map((lens) => lens.id));
      for (const key of Object.keys(remote)) {
        if (key.startsWith("lens/") && !localIds.has(key.slice(5))) {
          removeKeys.push(key);
        }
      }
    }
  }

  if (pushPrefs) {
    values.prefs = {
      aiGroupingPrompt: typeof stored[AI_GROUPING_PROMPT_KEY] === "string" ? stored[AI_GROUPING_PROMPT_KEY] : "",
      tabSearchShortcut: normalizeTabSearchShortcut(stored.tabSearchShortcut),
      updatedAt: meta.prefsUpdatedAt || now,
    };
  }

  const setOk = await safeSyncSet(values);
  const removeOk = await safeSyncRemove([...new Set(removeKeys)]);
  if (errors.length > 0) {
    await setLensSyncLastError(errors.join(" "));
  } else if (setOk !== false && removeOk !== false && (setOk === true || removeOk === true)) {
    await setLensSyncLastError("");
  }

  if (all) {
    pendingLensSyncAll = false;
    pendingLensSyncIds.clear();
    pendingLensSyncRemovedIds.clear();
    pendingLensSyncOrder = false;
    pendingLensSyncPrefs = false;
  } else {
    for (const id of idsToPush) pendingLensSyncIds.delete(id);
    for (const id of removedIds) pendingLensSyncRemovedIds.delete(id);
    if (pushOrder) pendingLensSyncOrder = false;
    if (pushPrefs) pendingLensSyncPrefs = false;
  }
}

function syncSnapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function pullLensSync() {
  if (!lensSyncEnabled || applyingInboundLensSync || !syncStorageArea()) {
    return false;
  }
  const remote = await safeSyncGet(null);
  if (!remote) {
    return false;
  }
  const stored = await browser.storage.local.get([
    "lenses",
    "lensSchedules",
    AI_GROUPING_PROMPT_KEY,
    "tabSearchShortcut",
    LENS_SYNC_META_KEY,
  ]);
  const localLenses = normalizeLensesFromStorageChange(stored.lenses);
  const localSchedules = normalizeLensSchedules(stored.lensSchedules);
  const meta = normalizeLensSyncMeta(stored[LENS_SYNC_META_KEY]);
  const remoteOrder = normalizeSyncLensOrder(remote.lensOrder);
  const remotePrefs = normalizeSyncPrefs(remote.prefs);
  const remoteEntries = new Map();
  for (const [key, value] of Object.entries(remote)) {
    if (!key.startsWith("lens/")) continue;
    const entry = normalizeSyncLensEntry(value);
    if (entry) {
      remoteEntries.set(entry.lens.id, entry);
    }
  }

  const localById = new Map(localLenses.map((lens) => [lens.id, lens]));
  const mergedById = new Map(localById);
  const mergedSchedules = scheduleByLensId(localSchedules);
  for (const [id, entry] of remoteEntries) {
    const local = localById.get(id);
    if (!local || entry.lens.updatedAt > local.updatedAt) {
      mergedById.set(id, entry.lens);
      if (entry.schedule) {
        mergedSchedules.set(id, entry.schedule);
      } else {
        mergedSchedules.delete(id);
      }
    } else if (entry.lens.updatedAt === local.updatedAt) {
      if (entry.schedule) {
        mergedSchedules.set(id, entry.schedule);
      } else if (remoteOrder && remoteOrder.ids.includes(id)) {
        mergedSchedules.delete(id);
      }
    }
  }

  const localOrderUpdatedAt = meta.lensOrderUpdatedAt || maxLensUpdatedAt(localLenses);
  let nextLenses = localLenses.map((lens) => mergedById.get(lens.id)).filter(Boolean);
  let nextMeta = { ...meta };
  if (remoteOrder && remoteOrder.updatedAt > localOrderUpdatedAt) {
    const ordered = [];
    let keptOutsideRemoteOrder = false;
    const used = new Set();
    for (const id of remoteOrder.ids) {
      const lens = mergedById.get(id);
      if (lens) {
        ordered.push(lens);
        used.add(id);
      }
    }
    for (const lens of localLenses) {
      if (used.has(lens.id)) continue;
      if (lens.updatedAt > remoteOrder.updatedAt) {
        const merged = mergedById.get(lens.id);
        if (merged) {
          ordered.push(merged);
          used.add(lens.id);
          keptOutsideRemoteOrder = true;
        }
      } else {
        mergedById.delete(lens.id);
        mergedSchedules.delete(lens.id);
      }
    }
    for (const [id, entry] of remoteEntries) {
      if (!used.has(id) && entry.lens.updatedAt > remoteOrder.updatedAt) {
        ordered.push(entry.lens);
        used.add(id);
        keptOutsideRemoteOrder = true;
      }
    }
    nextLenses = ordered;
    nextMeta.lensOrderUpdatedAt = keptOutsideRemoteOrder ? Math.max(remoteOrder.updatedAt, maxLensUpdatedAt(ordered)) : remoteOrder.updatedAt;
  } else {
    const used = new Set(nextLenses.map((lens) => lens.id));
    let appendedNewerLens = false;
    for (const [id, lens] of mergedById) {
      if (!used.has(id) && lens.updatedAt > localOrderUpdatedAt) {
        nextLenses.push(lens);
        used.add(id);
        appendedNewerLens = true;
      }
    }
    if (appendedNewerLens) {
      nextMeta.lensOrderUpdatedAt = Math.max(localOrderUpdatedAt, maxLensUpdatedAt(nextLenses));
    }
  }

  const retainedIds = new Set(nextLenses.map((lens) => lens.id));
  const nextSchedules = [...mergedSchedules.values()].filter((schedule) => retainedIds.has(schedule.lensId));
  const localPrefsUpdatedAt = meta.prefsUpdatedAt || 0;
  const localPrompt = typeof stored[AI_GROUPING_PROMPT_KEY] === "string" ? stored[AI_GROUPING_PROMPT_KEY] : "";
  const localShortcut = normalizeTabSearchShortcut(stored.tabSearchShortcut);
  const values = {};
  if (!syncSnapshotsEqual(nextLenses, localLenses)) {
    values.lenses = nextLenses;
  }
  if (!syncSnapshotsEqual(nextSchedules, localSchedules)) {
    values.lensSchedules = nextSchedules;
  }
  if (remotePrefs && remotePrefs.updatedAt > localPrefsUpdatedAt) {
    if (remotePrefs.aiGroupingPrompt !== localPrompt) {
      values[AI_GROUPING_PROMPT_KEY] = remotePrefs.aiGroupingPrompt;
    }
    if (!syncSnapshotsEqual(remotePrefs.tabSearchShortcut, localShortcut)) {
      values.tabSearchShortcut = remotePrefs.tabSearchShortcut;
    }
    nextMeta.prefsUpdatedAt = remotePrefs.updatedAt;
  }
  if (!syncSnapshotsEqual(nextMeta, meta)) {
    values[LENS_SYNC_META_KEY] = nextMeta;
  }
  if (Object.keys(values).length === 0) {
    return false;
  }
  applyingInboundLensSync = true;
  try {
    await browser.storage.local.set(values);
  } finally {
    applyingInboundLensSync = false;
  }
  return true;
}

async function reconcileLensSync() {
  if (!lensSyncEnabled || !syncStorageArea()) {
    return;
  }
  await pullLensSync();
  pendingLensSyncAll = true;
  await pushLensSync();
}

function minutesForTime(value) {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function scheduleMatchesNow(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  const day = now.getDay();
  if (schedule.days.length > 0 && !schedule.days.includes(day)) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesForTime(schedule.start);
  const end = minutesForTime(schedule.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

// A matching schedule fires only when nothing has activated a view since the
// schedule window opened: the first tick inside the window applies the lens
// once, and any later manual/automation switch wins for the rest of the
// window. Without this edge-trigger the minute tick would yank the user back
// and overwrite lastActivation.at, destroying session history durations.
function scheduleWindowStartMs(schedule, now) {
  const start = minutesForTime(schedule.start);
  const end = minutesForTime(schedule.end);
  const current = now.getHours() * 60 + now.getMinutes();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (start > end && current < end) {
    // Overnight window entered yesterday.
    startDay.setDate(startDay.getDate() - 1);
  }
  return startDay.getTime() + start * 60000;
}

async function handleScheduleTick(now = new Date()) {
  const schedules = await getLensSchedules();
  const match = schedules.find((schedule) => scheduleMatchesNow(schedule, now));
  if (!match) {
    return;
  }
  const stored = await browser.storage.local.get("lastActivation");
  const lastActivation = isRecord(stored.lastActivation) ? stored.lastActivation : {};
  if (typeof lastActivation.at === "number" && lastActivation.at >= scheduleWindowStartMs(match, now)) {
    return;
  }
  await activateView({ kind: "lens", lensId: match.lensId }, { trigger: "schedule", triggerId: match.lensId });
}

// The minute tick only exists while at least one schedule is enabled; an
// unconditional periodic alarm would wake the event page forever for a
// feature most installs never opt into.
async function syncScheduleAlarm() {
  const schedules = await getLensSchedules();
  if (schedules.some((schedule) => schedule.enabled)) {
    browser.alarms.create(SCHEDULE_ALARM_NAME, { periodInMinutes: 1 });
  } else {
    browser.alarms.clear(SCHEDULE_ALARM_NAME);
  }
}

function titleSelectorMatcher(selectors) {
  const exact = new Set();
  const globValues = [];
  for (const selector of normalizedSelectors(selectors)) {
    if (selector.type === "glob") {
      globValues.push(selector.value);
    } else if (selector.type === "title") {
      exact.add(selector.value);
    }
  }
  const globMatches = buildTitleMatcher(globValues);
  return (title) => exact.has(title) || globMatches(title);
}

function selectorMatcher(selectors) {
  return titleSelectorMatcher(selectors);
}

function lensSelectorsMatch(lens, title) {
  return titleSelectorMatcher(lens && lens.groupSelectors)(title);
}

async function selectorMatcherForGroups(selectors, groups) {
  const normalized = normalizedSelectors(selectors);
  const titleMatches = titleSelectorMatcher(normalized);
  const containerNames = new Set(
    normalized
      .filter((selector) => selector.type === "container")
      .map((selector) => selector.value.toLowerCase())
  );
  if (containerNames.size === 0) {
    return (group) => titleMatches(group.title);
  }

  const matchingStoreIds = new Set();
  for (const container of await getContainers()) {
    if (containerNames.has(container.name.toLowerCase())) {
      matchingStoreIds.add(container.cookieStoreId);
    }
  }
  if (matchingStoreIds.size === 0) {
    return (group) => titleMatches(group.title);
  }

  const candidateGroupIds = new Set((Array.isArray(groups) ? groups : [])
    .map((group) => group && group.id)
    .filter((id) => typeof id === "number"));
  const windowIds = [...new Set((Array.isArray(groups) ? groups : [])
    .map((group) => group && group.windowId)
    .filter((id) => typeof id === "number"))];
  const tabsByWindow = await Promise.all(windowIds.map((windowId) =>
    browser.tabs.query({ windowId }).catch(() => [])
  ));
  const matchingContainerGroups = new Set();
  for (const tabs of tabsByWindow) {
    for (const tab of tabs) {
      if (
        typeof tab.groupId === "number" &&
        candidateGroupIds.has(tab.groupId) &&
        typeof tab.cookieStoreId === "string" &&
        matchingStoreIds.has(tab.cookieStoreId)
      ) {
        matchingContainerGroups.add(tab.groupId);
      }
    }
  }

  return (group) => titleMatches(group.title) || matchingContainerGroups.has(group.id);
}

function lensesMatchingTitle(title, lenses) {
  return (Array.isArray(lenses) ? lenses : [])
    .filter((lens) => lensSelectorsMatch(lens, title))
    .map((lens) => lens.name);
}

function selectorsFromTitles(titles) {
  return normalizeTitles(titles).map((title) => ({
    type: isGlobPattern(title) ? "glob" : "title",
    value: title,
  }));
}

function selectorSetKey(selectors) {
  return normalizedSelectors(selectors)
    .map((selector) => `${selector.type}:${selector.value}`)
    .sort()
    .join("\n");
}

function readableFallbackName(id) {
  const tail = id.split(".").filter(Boolean).pop() || id;
  return tail
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function migrateToLensesV2() {
  const stored = await browser.storage.local.get(null);
  if (!hasOwn(stored, LEGACY_MAP_KEY) || stored.schemaVersion === 2) {
    return;
  }
  const now = Date.now();
  const legacy = isRecord(stored[LEGACY_MAP_KEY]) ? stored[LEGACY_MAP_KEY] : {};
  const catalog = isRecord(stored.focusCatalog) ? stored.focusCatalog : {};
  const merged = new Map();
  const ignoredAppleFocusIds = [];

  for (const [id, value] of Object.entries(legacy)) {
    const titles = normalizeTitles(value);
    if (titles.length === 0) {
      if (Array.isArray(value) && value.length === 0) {
        ignoredAppleFocusIds.push(id);
      }
      continue;
    }
    const selectors = selectorsFromTitles(titles);
    const key = selectorSetKey(selectors);
    const catalogEntry = isRecord(catalog[id]) ? catalog[id] : {};
    let lens = merged.get(key);
    if (!lens) {
      lens = {
        id: generateLensId(),
        name: typeof catalogEntry.name === "string" && catalogEntry.name ? catalogEntry.name : readableFallbackName(id),
        icon: typeof catalogEntry.icon === "string" && catalogEntry.icon ? catalogEntry.icon : "target",
        color: typeof catalogEntry.color === "string" ? catalogEntry.color : null,
        groupSelectors: selectors,
        triggers: { appleFocusIds: [] },
        createdAt: now,
        updatedAt: now,
        migratedFrom: { focusIds: [] },
      };
      merged.set(key, lens);
    }
    lens.triggers.appleFocusIds.push(id);
    lens.migratedFrom.focusIds.push(id);
  }

  await browser.storage.local.set({
    lenses: [...merged.values()],
    ignoredAppleFocusIds,
    legacyFocusMappingsBackup: stored[LEGACY_MAP_KEY],
    schemaVersion: 2,
  });
}

// A mapping entry containing * or ? is a glob: * matches any run of characters,
// ? matches exactly one. Plain entries match a tab-group title exactly.
function isGlobPattern(entry) {
  return /[*?]/.test(entry);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${body}$`);
}

function buildTitleMatcher(titles) {
  const exact = new Set();
  const globs = [];
  for (const entry of titles) {
    if (isGlobPattern(entry)) {
      try {
        globs.push(globToRegExp(entry));
      } catch (error) {
        console.error("Invalid title selector glob:", entry, error);
      }
    } else {
      exact.add(entry);
    }
  }
  return (title) => exact.has(title) || globs.some((re) => re.test(title));
}

// MCC owns the Focus catalog (id -> {name, icon, color}); cache what it
// broadcasts so the options UI and the badge can show names without hardcoding.
async function mergeFocusCatalog(entries) {
  if (!isRecord(entries)) {
    return;
  }
  const stored = await browser.storage.local.get("focusCatalog");
  const catalog = isRecord(stored.focusCatalog) ? { ...stored.focusCatalog } : {};
  let changed = false;
  for (const [id, entry] of Object.entries(entries)) {
    if (typeof id === "string" && !isUnsafeKey(id) && isRecord(entry) && typeof entry.name === "string") {
      catalog[id] = {
        name: entry.name,
        icon: typeof entry.icon === "string" ? entry.icon : "target",
        color: typeof entry.color === "string" ? entry.color : null,
      };
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({ focusCatalog: catalog });
  }
}

async function focusDisplayName(rawId) {
  if (rawId === null) {
    return null;
  }
  const stored = await browser.storage.local.get("focusCatalog");
  const catalog = isRecord(stored.focusCatalog) ? stored.focusCatalog : {};
  const entry = hasOwn(catalog, rawId) ? catalog[rawId] : undefined;
  return entry && typeof entry.name === "string" && entry.name ? entry.name : rawId;
}

async function findLensForAppleFocusId(rawId) {
  const lenses = await getLenses();
  return lenses.find((lens) => lens.triggers.appleFocusIds.includes(rawId)) || null;
}

async function notifyUnboundAppleFocus(rawId) {
  const focusName = await focusDisplayName(rawId);
  await setFocusBadge({ text: "?", color: "#D50000", title: `Tabloupe: ${focusName}` });
  await browser.storage.local.set({
    ...CLEAR_ACTION_DIAGNOSTICS,
    lastAction: "unmapped_focus_id",
    unmappedFocusId: rawId,
  });
  await notify({
    type: "basic",
    title: "Tabloupe",
    message: `Unbound automation mode ${focusName} — open options to bind it to a lens`,
  }, `${OPTIONS_NOTIFICATION_PREFIX}${rawId}`);
}

async function getLastAppliedAppleFocusId() {
  const stored = await browser.storage.local.get(LAST_APPLIED_APPLE_FOCUS_KEY);
  const value = stored[LAST_APPLIED_APPLE_FOCUS_KEY];
  return typeof value === "string" ? value : null;
}

async function handleAppleFocusOff() {
  const triggerId = await getLastAppliedAppleFocusId();
  await browser.storage.local.set({ [LAST_APPLIED_APPLE_FOCUS_KEY]: null });
  if (typeof triggerId !== "string") {
    return;
  }
  const stored = await browser.storage.local.get(["activeView", "lastActivation"]);
  const lastActivation = isRecord(stored.lastActivation) ? stored.lastActivation : {};
  if (lastActivation.trigger !== "appleFocus" || lastActivation.triggerId !== triggerId) {
    return;
  }
  await activateView(await getAutomationFallback(), { trigger: "appleFocus", triggerId });
}

async function handleAppleFocus(rawId) {
  if (rawId === null) {
    await handleAppleFocusOff();
    return;
  }
  const stored = await browser.storage.local.get(["lastActivation", LAST_APPLIED_APPLE_FOCUS_KEY]);
  const lastActivation = isRecord(stored.lastActivation) ? stored.lastActivation : {};
  if (rawId === stored[LAST_APPLIED_APPLE_FOCUS_KEY] && lastActivation.trigger === "manual") {
    return;
  }
  const lens = await findLensForAppleFocusId(rawId);
  if (!lens) {
    await notifyUnboundAppleFocus(rawId);
    return;
  }
  const applied = await activateView({ kind: "lens", lensId: lens.id }, { trigger: "appleFocus", triggerId: rawId });
  if (applied !== false) {
    await browser.storage.local.set({ [LAST_APPLIED_APPLE_FOCUS_KEY]: rawId });
  }
}

async function handleMessage(event) {
  const msg = isRecord(event) && hasOwn(event, "data") ? JSON.parse(event.data) : event;
  // MCC multiplexes several state subsystems on this socket (focus, bluetooth,
  // wireguard, ...), each wrapped in a StateEnvelope { type, schemaVersion, ts,
  // payload }. Apple Focus envelopes optionally trigger a lens; focusCatalog
  // carries the id -> {name, icon, color} table.
  if (!isRecord(msg)) {
    return;
  }
  if (msg.type === "activateView") {
    await handleActivateViewEnvelope(msg);
    return;
  }
  if (msg.type === "focusCatalog") {
    const payload = isRecord(msg.payload) ? msg.payload : {};
    await mergeFocusCatalog(payload.entries);
    return;
  }
  if (msg.type !== "focus") {
    return;
  }
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const focus = payload.focus;
  let rawId = null;
  if (isRecord(focus) && typeof focus.id === "string") {
    rawId = focus.id;
    await mergeFocusCatalog({ [focus.id]: focus });
  }

  await recordSeen(rawId);
  await handleAppleFocus(rawId);
}

async function sendAuthFrame(ws, hello) {
  const payload = isRecord(hello.payload) ? hello.payload : {};
  if (typeof payload.nonce !== "string" || !/^[0-9a-f]{32}$/.test(payload.nonce)) {
    await setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED);
    ws.close();
    return;
  }
  const token = await getBusToken();
  if (!token) {
    await setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_REQUIRED);
    ws.close();
    return;
  }
  if (!authCryptoAvailable()) {
    await setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED);
    ws.close();
    return;
  }
  const clientNonce = randomHex(16);
  const nonce = payload.nonce;
  const mac = await hmacHex(token, `tabloupe-client|${nonce}|${clientNonce}`);
  const expectedServerMac = await hmacHex(token, `tabloupe-server|${clientNonce}|${nonce}`);
  socketAuthContext = { nonce, clientNonce, expectedServerMac };
  socketAuthState = BUS_AUTH_STATES.AWAITING_AUTH_OK;
  socketAuthTimer = setTimeout(() => {
    if (socket === ws && socketAuthState === BUS_AUTH_STATES.AWAITING_AUTH_OK) {
      setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED).catch((error) => {
        console.error("Pairing status error:", error);
      });
      ws.close();
    }
  }, AUTH_OK_TIMEOUT_MS);
  ws.send(JSON.stringify({
    type: "auth",
    schemaVersion: 1,
    payload: { clientNonce, mac },
  }));
}

async function handleAuthOk(ws, msg) {
  if (msg.type === "authFail") {
    clearSocketAuthTimer();
    await setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED);
    ws.close();
    return;
  }
  if (msg.type !== "authOk") {
    return;
  }
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const expected = socketAuthContext && socketAuthContext.expectedServerMac;
  if (typeof payload.mac !== "string" || payload.mac !== expected) {
    clearSocketAuthTimer();
    await setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED);
    ws.close();
    return;
  }
  clearSocketAuthTimer();
  socketAuthState = BUS_AUTH_STATES.AUTHENTICATED;
  socketAuthContext = null;
  await setPairingStatus(BUS_PAIRING_STATUSES.PAIRED);
  publishLensStateSoon();
}

function handleEstablishedFrame(msg) {
  if (tryResolveGroupingResponse(msg)) {
    return;
  }
  enqueueFocusWork(() => handleMessage(msg)).catch((error) => {
    console.error("Focus message error:", error);
  });
}

async function handleSocketFrame(ws, event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (error) {
    return;
  }
  if (socket !== ws || !isRecord(msg)) {
    return;
  }
  if (socketAuthState === BUS_AUTH_STATES.UNAUTHENTICATED) {
    if (msg.type === "hello") {
      await sendAuthFrame(ws, msg);
      return;
    }
    socketAuthState = BUS_AUTH_STATES.LEGACY;
    await setPairingStatus(BUS_PAIRING_STATUSES.LEGACY);
    publishLensStateSoon();
    handleEstablishedFrame(msg);
    return;
  }
  if (socketAuthState === BUS_AUTH_STATES.AWAITING_AUTH_OK) {
    await handleAuthOk(ws, msg);
    return;
  }
  handleEstablishedFrame(msg);
}

async function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    return;
  }

  clearReconnectTimer();
  resetSocketAuthState();
  setConnectionState("reconnecting").catch((error) => {
    console.error("Connection state error:", error);
  });
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = MIN_RECONNECT_MS;
    clearReconnectTimer();
    setConnectionState("connected").catch((error) => {
      console.error("Connection state error:", error);
    });
  };
  ws.onmessage = (event) => {
    handleSocketFrame(ws, event).catch((error) => {
      console.error("Bus message error:", error);
      if (socket === ws) {
        setPairingStatus(BUS_PAIRING_STATUSES.PAIRING_FAILED).catch((statusError) => {
          console.error("Pairing status error:", statusError);
        });
        ws.close();
      }
    });
  };

  ws.onclose = () => {
    if (socket === ws) {
      socket = null;
      resetSocketAuthState();
      rejectPendingGrouping(new Error(groupingUnavailableCode()));
      setConnectionState("reconnecting").catch((error) => {
        console.error("Connection state error:", error);
      });
      scheduleReconnect();
    }
  };
  ws.onerror = () => ws.close();
}

async function handleLensState(windowId) {
  await sessionStateReady;
  const [lenses, persistedActiveView, stored, aiEnabled] = await Promise.all([
    getLenses(),
    getActiveView(),
    browser.storage.local.get("lastActivation"),
    aiGroupingEnabled(),
  ]);
  const activeView = typeof windowId === "number" && transientViewsByWindow.has(windowId)
    ? transientViewsByWindow.get(windowId)
    : persistedActiveView;
  const query = typeof windowId === "number" ? { windowId } : {};
  const groups = await browser.tabGroups.query(query);
  const hasAppleBinding = lenses.some((lens) => lens.triggers.appleFocusIds.length > 0) ||
    Boolean(socket && socket.readyState === WebSocket.OPEN);
  return {
    activeView,
    windowProfile: getWindowProfile(windowId),
    lastActivation: isRecord(stored.lastActivation) ? stored.lastActivation : null,
    lenses: lenses.map((lens) => ({
      id: lens.id,
      name: lens.name,
      icon: lens.icon,
      color: lens.color,
      active: activeView.kind === "lens" && activeView.lensId === lens.id,
    })),
    currentGroups: groups.map((group) => ({
      title: typeof group.title === "string" ? group.title : "",
      color: typeof group.color === "string" ? group.color : null,
      savedIn: lensesMatchingTitle(typeof group.title === "string" ? group.title : "", lenses),
    })),
    hasGroups: groups.length > 0,
    hasAppleBinding,
    aiEnabled,
    busPairingStatus: pairingStatus,
  };
}

async function handleLensActivate(windowId, view) {
  const ok = await activateView(view, { trigger: "manual", windowId });
  return ok === false ? { ok: false } : { ok: true };
}

async function handleLensSave(msg) {
  const source = msg && msg.source;
  const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : "";
  if (name === "") {
    return { ok: false, error: "missing_name" };
  }
  let titles = [];
  if (source === "window") {
    const query = typeof msg.windowId === "number" ? { windowId: msg.windowId } : {};
    titles = (await browser.tabGroups.query(query)).map((group) => group.title);
  } else if (source === "group" && typeof msg.groupTitle === "string") {
    titles = [msg.groupTitle];
  }
  const now = Date.now();
  const lens = {
    id: generateLensId(),
    name,
    icon: typeof msg.icon === "string" && msg.icon ? msg.icon : "target",
    color: typeof msg.color === "string" ? msg.color : null,
    groupSelectors: selectorsFromTitles(titles),
    triggers: { appleFocusIds: [] },
    createdAt: now,
    updatedAt: now,
  };
  const lenses = await getLenses();
  lenses.push(lens);
  await saveLenses(lenses);
  return { ok: true, lens };
}

async function handleLensUpdate(msg) {
  if (!msg || typeof msg.lensId !== "string" || !isRecord(msg.patch)) {
    return { ok: false, error: "invalid_lens" };
  }
  const lenses = await getLenses();
  const index = lenses.findIndex((lens) => lens.id === msg.lensId);
  if (index === -1) {
    return { ok: false, error: "missing_lens" };
  }
  const patch = msg.patch;
  const updated = { ...lenses[index] };
  if (typeof patch.name === "string" && patch.name.trim()) updated.name = patch.name.trim();
  if (typeof patch.icon === "string" && patch.icon) updated.icon = patch.icon;
  if (hasOwn(patch, "color")) updated.color = typeof patch.color === "string" ? patch.color : null;
  if (hasOwn(patch, "groupSelectors")) updated.groupSelectors = normalizedSelectors(patch.groupSelectors);
  if (isRecord(patch.triggers)) {
    updated.triggers = {
      appleFocusIds: Array.isArray(patch.triggers.appleFocusIds)
        ? [...new Set(patch.triggers.appleFocusIds.filter((id) => typeof id === "string" && id !== ""))]
        : updated.triggers.appleFocusIds,
    };
  }
  updated.updatedAt = Date.now();
  lenses[index] = updated;
  await saveLenses(lenses);
  return { ok: true };
}

async function handleLensDelete(msg) {
  const lensId = msg && typeof msg.lensId === "string" ? msg.lensId : null;
  if (lensId === null) {
    return { ok: false, error: "invalid_lens" };
  }
  const lenses = await getLenses();
  await saveLenses(lenses.filter((lens) => lens.id !== lensId));
  const activeView = await getActiveView();
  if (activeView.kind === "lens" && activeView.lensId === lensId) {
    await setActiveView({ kind: "all" }, { trigger: "manual" });
  }
  return { ok: true };
}

async function handleLensLinkFocus(msg) {
  const focusId = msg && typeof msg.focusId === "string" && msg.focusId !== "" ? msg.focusId : null;
  if (focusId === null) {
    return { ok: false, error: "invalid_focus" };
  }
  const lensId = msg && typeof msg.lensId === "string" && msg.lensId !== "" ? msg.lensId : null;
  const lenses = await getLenses();
  let changed = false;
  // Exclusivity: a Focus mode links to exactly one lens. Strip it everywhere first.
  for (const lens of lenses) {
    const ids = Array.isArray(lens.triggers?.appleFocusIds) ? lens.triggers.appleFocusIds : [];
    if (ids.includes(focusId)) {
      lens.triggers = { appleFocusIds: ids.filter((id) => id !== focusId) };
      lens.updatedAt = Date.now();
      changed = true;
    }
  }
  if (lensId !== null) {
    const target = lenses.find((lens) => lens.id === lensId);
    if (!target) {
      return { ok: false, error: "missing_lens" };
    }
    const ids = Array.isArray(target.triggers?.appleFocusIds) ? target.triggers.appleFocusIds : [];
    target.triggers = { appleFocusIds: [...new Set([...ids, focusId])] };
    target.updatedAt = Date.now();
    changed = true;
  }
  if (changed) {
    await saveLenses(lenses);
  }
  return { ok: true };
}

async function handleLensReorder(msg) {
  const orderedIds = msg && Array.isArray(msg.orderedIds)
    ? msg.orderedIds.filter((id) => typeof id === "string")
    : null;
  if (orderedIds === null) {
    return { ok: false, error: "invalid_order" };
  }
  const lenses = await getLenses();
  const byId = new Map(lenses.map((lens) => [lens.id, lens]));
  const reordered = [];
  for (const id of orderedIds) {
    const lens = byId.get(id);
    if (lens) {
      reordered.push(lens);
      byId.delete(id);
    }
  }
  for (const lens of lenses) {
    if (byId.has(lens.id)) {
      reordered.push(lens);
    }
  }
  await saveLenses(reordered);
  return { ok: true };
}

function start() {
  setConnectionState("reconnecting").catch((error) => {
    console.error("Connection state error:", error);
  });
  browser.storage.local.get("lastError")
    .then((stored) => {
      lastError = normalizeLastError(stored.lastError);
      return refreshBadge();
    })
    .catch((error) => {
      console.error("Last error init error:", error);
    });
  browser.storage.local.get(AI_AUTO_GROUP_KEY)
    .then((stored) => { autoGroupEnabled = stored[AI_AUTO_GROUP_KEY] === true; })
    .catch((error) => console.error("Auto-group init error:", error));
  const lensSyncInit = browser.storage.local.get(SYNC_LENSES_KEY)
    .then((stored) => { lensSyncEnabled = stored[SYNC_LENSES_KEY] === true; })
    .catch((error) => console.error("Lens sync init error:", error));
  syncScheduleAlarm().catch((error) => console.error("Schedule alarm init error:", error));
  migrateToLensesV2()
    .catch((error) => {
      console.error("Lens migration error:", error);
    })
    .finally(() => {
      connect();
      lensSyncInit
        .then(() => {
          if (lensSyncEnabled) {
            return reconcileLensSync();
          }
          return undefined;
        })
        .catch((error) => console.error("Lens sync reconcile failed:", error));
    });
}

// Initialization is handled by invoking start() at script evaluation. In MV2
// event-page mode the script is re-evaluated on wake, so startup work must stay
// idempotent and durable state must live in storage.local.

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "lens-state") {
    return handleLensState(message.windowId);
  }
  if (message && message.type === "lens-activate") {
    return enqueueFocusWork(() => handleLensActivate(message.windowId, message.view));
  }
  if (message && message.type === "lens-save") {
    return enqueueFocusWork(() => handleLensSave(message));
  }
  if (message && message.type === "lens-update") {
    return enqueueFocusWork(() => handleLensUpdate(message));
  }
  if (message && message.type === "lens-delete") {
    return enqueueFocusWork(() => handleLensDelete(message));
  }
  if (message && message.type === "lens-link-focus") {
    return enqueueFocusWork(() => handleLensLinkFocus(message));
  }
  if (message && message.type === "lens-reorder") {
    return enqueueFocusWork(() => handleLensReorder(message));
  }
  if (message && message.type === "window-profile-set") {
    return enqueueFocusWork(() => handleWindowProfileSet(message));
  }
  if (message && message.type === "ai-group-state") {
    return handleGroupState(message.windowId);
  }
  if (message && message.type === "ai-group-preview") {
    return handleGroupPreview(message.windowId);
  }
  if (message && message.type === "ai-group-apply") {
    return enqueueFocusWork(() => handleGroupApply(message.windowId, message.groups));
  }
  if (message && message.type === "ai-group-clear") {
    return Promise.resolve(handleGroupClear(message.windowId));
  }
  if (message && message.type === "open-tab-search") {
    openTabSearchOverlay().catch((error) => console.error("Tab search error:", error));
    return { ok: true };
  }
  if (message && message.type === "tabsearch-list") {
    return listTabsForSearch();
  }
  if (message && message.type === "tabsearch-containers") {
    return containersForSearch();
  }
  if (message && message.type === "tabsearch-activate") {
    return activateTabFromSearch(message.tabId, message.windowId);
  }
  if (message && message.type === "tabsearch-close") {
    return closeTabFromSearch(message.tabId);
  }
  if (message && message.type === "tabsearch-close-many") {
    return closeManyTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-group") {
    return groupTabsFromSearch(message.tabIds, message.title, message.windowId, message.groupId);
  }
  if (message && message.type === "tabsearch-ungroup") {
    return ungroupTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-move-new-window") {
    return moveTabsToNewWindow(message.tabIds);
  }
  if (message && message.type === "tabsearch-set-pinned") {
    return setTabsPinnedFromSearch(message.tabIds, message.pinned);
  }
  if (message && message.type === "tabsearch-discard") {
    return discardTabsFromSearch(message.tabIds);
  }
  if (message && message.type === "tabsearch-move") {
    return moveTabsFromSearch(message.tabIds, message.windowId, message.anchorId, message.placeAfter, message.groupId);
  }
  if (message && message.type === "tabsearch-move-container") {
    return moveTabsToContainerFromSearch(message.tabIds, message.cookieStoreId);
  }
  if (message && message.type === "tabsearch-ai-preview") {
    return tabsearchAiPreview(message.windowId, message.tabIds);
  }
  if (message && message.type === "tabsearch-history") {
    return searchHistoryFromSearch(message.query);
  }
  if (message && message.type === "tabsearch-web-search") {
    return webSearchFromSearch(message.query);
  }
  if (message && message.type === "tabsearch-open-url") {
    return openUrlFromSearch(message.url);
  }
  return false;
});

if (browser.windows && browser.windows.onRemoved) {
  browser.windows.onRemoved.addListener((windowId) => {
    lastProposalByWindow.delete(windowId);
    const removedTransient = transientViewsByWindow.delete(windowId);
    const removedProfile = windowProfileOverrides.delete(windowId);
    if (removedTransient || removedProfile) {
      persistSessionWindowState();
    }
    const timer = autoGroupDebounceTimers.get(windowId);
    if (timer) { clearTimeout(timer); autoGroupDebounceTimers.delete(windowId); }
    autoGroupCooldown.delete(windowId);
    autoGroupInflight.delete(windowId);
  });
}

if (browser.tabs && browser.tabs.onCreated && browser.tabs.onCreated.addListener) {
  browser.tabs.onCreated.addListener((tab) => {
    if (tab && typeof tab.windowId === "number") {
      scheduleAutoGroup(tab.windowId);
    }
  });
}
if (browser.tabs && browser.tabs.onUpdated && browser.tabs.onUpdated.addListener) {
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo && changeInfo.status === "complete" && tab && typeof tab.windowId === "number") {
      scheduleAutoGroup(tab.windowId);
    }
  });
}
if (browser.contextualIdentities) {
  for (const eventName of ["onCreated", "onRemoved", "onUpdated"]) {
    const event = browser.contextualIdentities[eventName];
    if (event && typeof event.addListener === "function") {
      event.addListener(invalidateContainersCache);
    }
  }
}


browser.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith(OPTIONS_NOTIFICATION_PREFIX)) {
    browser.runtime.openOptionsPage();
    browser.notifications.clear(notificationId);
  }
});

if (browser.notifications.onButtonClicked) {
  browser.notifications.onButtonClicked.addListener((notificationId) => {
    if (notificationId.startsWith(OPTIONS_NOTIFICATION_PREFIX)) {
      browser.runtime.openOptionsPage();
      browser.notifications.clear(notificationId);
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync") {
    if (lensSyncEnabled) {
      pullLensSync().catch((error) => console.error("Lens sync pull failed:", error));
    }
    return;
  }
  if (areaName !== "local") {
    return;
  }

  if (changes.lastError) {
    lastError = normalizeLastError(changes.lastError.newValue);
    refreshBadge().catch((error) => {
      console.error("Badge error:", error);
    });
  }

  if (changes.aiAutoGroup) {
    autoGroupEnabled = changes.aiAutoGroup.newValue === true;
    if (autoGroupEnabled) {
      browser.tabs.query({})
        .then((tabs) => {
          const windowIds = new Set(tabs.map((tab) => tab.windowId).filter((id) => typeof id === "number"));
          for (const id of windowIds) { scheduleAutoGroup(id); }
        })
        .catch((error) => console.error("Auto-group enable error:", error));
    }
  }

  if (changes.lensSchedules) {
    syncScheduleAlarm().catch((error) => console.error("Schedule alarm sync error:", error));
  }

  if (changes[BUS_TOKEN_KEY]) {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    } else {
      connect();
    }
  }

  const hasLensSyncChange = changes.lenses ||
    changes.lensSchedules ||
    changes[AI_GROUPING_PROMPT_KEY] ||
    changes.tabSearchShortcut;
  if (changes[SYNC_LENSES_KEY]) {
    lensSyncEnabled = changes[SYNC_LENSES_KEY].newValue === true;
    if (lensSyncEnabled) {
      reconcileLensSync().catch((error) => console.error("Lens sync reconcile failed:", error));
    } else {
      cancelLensSyncPush();
    }
  }
  if (hasLensSyncChange && !applyingInboundLensSync) {
    queueLensSyncPushFromLocalChange(changes);
    recordLocalLensSyncTimestamps(changes)
      .catch((error) => console.error("Lens sync timestamp failed:", error))
      .finally(() => scheduleLensSyncPush());
  }
});

// ── Tab group logic ────────────────────────────────────────

function normalizeLastError(value) {
  return isRecord(value) && typeof value.message === "string" ? value : null;
}

async function refreshBadge() {
  try {
    if (!browser.browserAction) {
      return;
    }
    if (lastError) {
      await browser.browserAction.setBadgeText({ text: "!" });
      await browser.browserAction.setBadgeBackgroundColor({ color: "#B71C1C" });
      await browser.browserAction.setTitle({ title: `Tabloupe — ${lastError.message}` });
      return;
    }
    const badge = focusBadge || {};
    const text = typeof badge.text === "string" ? badge.text : "";
    await browser.browserAction.setBadgeText({ text });
    if (badge.color) {
      await browser.browserAction.setBadgeBackgroundColor({ color: badge.color });
    }
    await browser.browserAction.setTitle({ title: badge.title || "Tabloupe" });
  } catch (error) {
    console.error("Badge error:", error);
  }
}

async function setFocusBadge(badge) {
  focusBadge = {
    text: typeof badge.text === "string" ? badge.text : "",
    color: badge.color || null,
    title: badge.title || "Tabloupe",
  };
  await refreshBadge();
}

async function setConnectionState(state) {
  await browser.storage.local.set({ connectionState: state });
  await refreshBadge();
}

async function setLastError(code, message) {
  lastError = {
    code: typeof code === "string" ? code : "ai_failed",
    message: typeof message === "string" ? message : "AI operation failed.",
    at: Date.now(),
    source: "ai",
  };
  await browser.storage.local.set({ lastError });
  await refreshBadge();
}

async function clearLastError() {
  lastError = null;
  await browser.storage.local.set({ lastError: null });
  await refreshBadge();
}

async function notify(options, notificationId) {
  try {
    if (notificationId) {
      await browser.notifications.create(notificationId, options);
    } else {
      await browser.notifications.create(options);
    }
  } catch (error) {
    console.error("Notification error:", error);
  }
}

const CLEAR_ACTION_DIAGNOSTICS = Object.freeze({
  unmappedFocusId: null,
  missingGroup: null,
  emptyGroup: null,
  expandedGroups: [],
  collapsedGroups: [],
  updateFailures: [],
});

function groupLabel(group) {
  const title = typeof group.title === "string" && group.title.length > 0 ? group.title : `#${group.id}`;
  return typeof group.windowId === "number" ? `${title} (window ${group.windowId})` : title;
}

function truncateList(items, separator = ", ") {
  if (items.length <= NOTIFICATION_LIST_MAX) {
    return items.join(separator);
  }
  const hidden = items.length - NOTIFICATION_LIST_MAX;
  return `${items.slice(0, NOTIFICATION_LIST_MAX).join(separator)}${separator}… (+${hidden} more)`;
}

async function setGroupCollapsed(group, collapsed) {
  if (group.collapsed === collapsed) {
    return null;
  }

  try {
    await browser.tabGroups.update(group.id, { collapsed });
    group.collapsed = collapsed;
    return null;
  } catch (error) {
    console.error("Tab group update error:", group.id, group.title, error);
    return groupLabel(group);
  }
}

async function setGroupsCollapsed(groups, collapsed) {
  const failures = await Promise.all(groups.map((group) => setGroupCollapsed(group, collapsed)));
  return failures.filter((failure) => failure !== null);
}

async function activateMatchingGroups(groups) {
  let activated = false;
  const failures = [];

  // One tabs.query instead of N+1: bucket every tab by group and remember each
  // window's active tab in memory, so a focus mapped to many groups doesn't fan
  // out a query per group plus a per-group active-tab lookup.
  const allTabs = await browser.tabs.query({});
  const tabsByGroup = new Map();
  const activeByWindow = new Map();
  let firstActiveTab = null;
  for (const tab of allTabs) {
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const bucket = tabsByGroup.get(tab.groupId);
      if (bucket) {
        bucket.push(tab);
      } else {
        tabsByGroup.set(tab.groupId, [tab]);
      }
    }
    if (tab.active) {
      if (firstActiveTab === null) {
        firstActiveTab = tab;
      }
      if (typeof tab.windowId === "number" && !activeByWindow.has(tab.windowId)) {
        activeByWindow.set(tab.windowId, tab);
      }
    }
  }

  for (const group of groups) {
    const tabs = tabsByGroup.get(group.id) || [];
    if (tabs.length === 0) {
      continue;
    }

    // Don't pull focus away from an ungrouped active tab — the options page, a
    // pinned tab, or an about: page. Ungrouped tabs never block collapsing other
    // groups, so activating a matching tab here is unnecessary and would yank the
    // user off whatever they were deliberately viewing.
    const activeTab = typeof group.windowId === "number"
      ? activeByWindow.get(group.windowId) || null
      : firstActiveTab;
    if (activeTab && isUngroupedTab(activeTab)) {
      activated = true;
      continue;
    }

    const target = tabs.find((tab) => tab.active) || tabs[0];
    try {
      await browser.tabs.update(target.id, { active: true });
      activated = true;
    } catch (error) {
      console.error("Tab activation error:", group.id, group.title, error);
      failures.push(groupLabel(group));
    }
  }

  return { activated, failures };
}

async function resolveActivation(view, windowId) {
  if (isRecord(view) && view.kind === "all") {
    return { ok: true, view: { kind: "all" }, name: "All groups", selectors: null, badgeText: "", badgeColor: null };
  }
  if (isRecord(view) && view.kind === "lens" && typeof view.lensId === "string") {
    const lens = (await getLenses()).find((candidate) => candidate.id === view.lensId);
    if (!lens) {
      return { ok: false, error: "missing_lens" };
    }
    return {
      ok: true,
      view: { kind: "lens", lensId: lens.id },
      name: lens.name,
      selectors: lens.groupSelectors,
      badgeText: lens.name.substring(0, 1).toUpperCase(),
      badgeColor: lens.color || "#00C853",
    };
  }
  if (isRecord(view) && view.kind === "transient") {
    return {
      ok: true,
      view: {
        kind: "transient",
        label: typeof view.label === "string" && view.label ? view.label : "Temporary view",
        selectors: normalizedSelectors(view.selectors),
        windowId,
      },
      name: typeof view.label === "string" && view.label ? view.label : "Temporary view",
      selectors: normalizedSelectors(view.selectors),
      badgeText: "",
      badgeColor: null,
    };
  }
  return { ok: false, error: "invalid_view" };
}

async function rememberActivatedView(resolvedView, activation) {
  if (resolvedView.kind === "transient") {
    if (typeof resolvedView.windowId === "number") {
      transientViewsByWindow.set(resolvedView.windowId, resolvedView);
      persistSessionWindowState();
    }
    return;
  }
  // A persisted view is applied across every window, so transient views are
  // genuinely overridden everywhere — drop them all.
  if (transientViewsByWindow.size > 0) {
    transientViewsByWindow.clear();
    persistSessionWindowState();
  }
  await setActiveView(resolvedView, activation);
  publishLensStateSoon();
}

async function discardCollapsedGroupTabs(groups) {
  if (!browser.tabs || typeof browser.tabs.discard !== "function" || groups.length === 0) {
    return;
  }
  if (!(await discardCollapsedTabsEnabled())) {
    return;
  }

  const groupIdsByWindow = new Map();
  for (const group of groups) {
    if (typeof group.id !== "number" || typeof group.windowId !== "number") {
      continue;
    }
    const groupIds = groupIdsByWindow.get(group.windowId);
    if (groupIds) {
      groupIds.add(group.id);
    } else {
      groupIdsByWindow.set(group.windowId, new Set([group.id]));
    }
  }

  await Promise.all(Array.from(groupIdsByWindow, async ([windowId, groupIds]) => {
    let tabs;
    try {
      tabs = await browser.tabs.query({ windowId });
    } catch (error) {
      return;
    }
    const ids = tabs
      .filter((tab) => (
        groupIds.has(tab.groupId) &&
        !tab.active &&
        !tab.pinned &&
        !tab.audible &&
        !tab.discarded &&
        GROUPABLE_URL.test(tab.url || "") &&
        typeof tab.id === "number"
      ))
      .map((tab) => tab.id);
    if (ids.length > 0) {
      browser.tabs.discard(ids).catch(() => {});
    }
  }));
}

async function applyResolvedToGroups(resolved, allGroups, activation, { persist = true } = {}) {
  if (resolved.view.kind === "all") {
    const updateFailures = await setGroupsCollapsed(allGroups, false);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: updateFailures.length === 0 ? "expanded_all" : "expanded_all_with_errors",
      updateFailures,
    });
    if (persist) {
      await setFocusBadge({ text: "", color: null, title: "Tabloupe" });
      await rememberActivatedView(resolved.view, activation);
    }
    return { ok: true, expandedGroups: allGroups.map((group) => group.title), collapsedGroups: [], updateFailures };
  }

  if (allGroups.length === 0) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "no_groups",
    });
    if (persist) await rememberActivatedView(resolved.view, activation);
    return { ok: true, expandedGroups: [], collapsedGroups: [], updateFailures: [] };
  }

  const matches = await selectorMatcherForGroups(resolved.selectors, allGroups);
  const matching = allGroups.filter((group) => matches(group));
  const others = allGroups.filter((group) => !matches(group));
  const selectorText = normalizedSelectors(resolved.selectors).map((selector) => selector.value).join(", ");

  if (matching.length === 0) {
    const updateFailures = await setGroupsCollapsed(allGroups, false);
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "no_matching_group",
      missingGroup: selectorText,
      updateFailures,
    });
    if (persist) {
      await setFocusBadge({ text: "!", color: "#FF9800", title: `Tabloupe: ${resolved.name}` });
      await rememberActivatedView(resolved.view, activation);
    }
    return { ok: true, expandedGroups: allGroups.map((group) => group.title), collapsedGroups: [], updateFailures };
  }

  const handoff = await activateMatchingGroups(matching);
  if (handoff.failures.length > 0) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "activation_failed",
      updateFailures: handoff.failures,
    });
    return { ok: false, expandedGroups: [], collapsedGroups: [], updateFailures: handoff.failures };
  }

  if (!handoff.activated) {
    await browser.storage.local.set({
      ...CLEAR_ACTION_DIAGNOSTICS,
      lastAction: "matching_group_empty",
      emptyGroup: selectorText,
    });
    if (persist) await rememberActivatedView(resolved.view, activation);
    return { ok: true, expandedGroups: [], collapsedGroups: [], updateFailures: [] };
  }

  const groupsToCollapse = others.filter((group) => group.collapsed !== true);
  const [expandFailures, collapseFailures] = await Promise.all([
    setGroupsCollapsed(matching, false),
    setGroupsCollapsed(others, true),
  ]);
  const updateFailures = expandFailures.concat(collapseFailures);
  await browser.storage.local.set({
    ...CLEAR_ACTION_DIAGNOSTICS,
    lastAction: updateFailures.length === 0 ? "applied" : "applied_with_errors",
    expandedGroups: matching.map((group) => group.title),
    collapsedGroups: others.map((group) => group.title),
    updateFailures,
  });
  if (persist) {
    await setFocusBadge({
      text: updateFailures.length === 0 ? resolved.badgeText : "!",
      color: updateFailures.length === 0 ? resolved.badgeColor : "#FF9800",
      title: `Tabloupe: ${resolved.name}`,
    });
    await rememberActivatedView(resolved.view, activation);
  }
  const result = {
    ok: true,
    expandedGroups: matching.map((group) => group.title),
    collapsedGroups: others.map((group) => group.title),
    updateFailures,
  };
  const collapsedNow = groupsToCollapse.filter((group) => group.collapsed === true);
  discardCollapsedGroupTabs(collapsedNow).catch(() => {});
  return result;
}

async function activateWithWindowProfiles(resolved, activation) {
  const allGroups = await browser.tabGroups.query({});
  const byWindow = new Map();
  for (const group of allGroups) {
    if (typeof group.windowId !== "number") continue;
    if (!byWindow.has(group.windowId)) byWindow.set(group.windowId, []);
    byWindow.get(group.windowId).push(group);
  }
  const aggregate = { expandedGroups: [], collapsedGroups: [], updateFailures: [] };
  for (const [windowId, groups] of byWindow.entries()) {
    const profile = getWindowProfile(windowId);
    if (profile.kind === "none") continue;
    const windowResolved = profile.kind === "lens"
      ? await resolveActivation({ kind: "lens", lensId: profile.lensId }, windowId)
      : resolved;
    if (!windowResolved.ok) continue;
    const result = await applyResolvedToGroups(windowResolved, groups, activation, { persist: false });
    if (result.ok === false) return false;
    aggregate.expandedGroups.push(...result.expandedGroups);
    aggregate.collapsedGroups.push(...result.collapsedGroups);
    aggregate.updateFailures.push(...result.updateFailures);
  }
  await browser.storage.local.set({
    groupTitles: allGroups.map((group) => group.title),
    expandedGroups: aggregate.expandedGroups,
    collapsedGroups: aggregate.collapsedGroups,
    updateFailures: aggregate.updateFailures,
  });
  await setFocusBadge({
    text: aggregate.updateFailures.length === 0 ? resolved.badgeText : "!",
    color: aggregate.updateFailures.length === 0 ? resolved.badgeColor : "#FF9800",
    title: `Tabloupe: ${resolved.name}`,
  });
  await rememberActivatedView(resolved.view, activation);
  return true;
}

async function activateView(view, activation = {}) {
  await sessionStateReady;
  const resolved = await resolveActivation(view, activation.windowId);
  if (!resolved.ok) {
    return false;
  }
  if (isPersistedView(resolved.view)) {
    await recordActivationSession(resolved.view, activation);
  }
  const automationWithProfiles = activation.trigger !== "manual" &&
    resolved.view.kind !== "transient" &&
    windowProfileOverrides.size > 0;
  if (automationWithProfiles) {
    return activateWithWindowProfiles(resolved, activation);
  }
  const query = resolved.view.kind === "transient" && typeof activation.windowId === "number"
    ? { windowId: activation.windowId }
    : {};
  const allGroups = await browser.tabGroups.query(query);
  await browser.storage.local.set({
    groupTitles: allGroups.map((group) => group.title),
  });
  const result = await applyResolvedToGroups(resolved, allGroups, activation, { persist: true });
  return result.ok !== false;
}

// ── AI tab grouping ────────────────────────────────────────
// Sends ungrouped-tab metadata to mac-command-centre, which clusters them with
// Apple's on-device model (FoundationModels) and returns named topic groups.

function nextGroupingRequestId() {
  groupingRequestSeq += 1;
  return `g${groupingRequestSeq}-${Date.now()}`;
}

function tryResolveGroupingResponse(eventOrMessage) {
  let msg;
  if (isRecord(eventOrMessage) && hasOwn(eventOrMessage, "data")) {
    try {
      msg = JSON.parse(eventOrMessage.data);
    } catch (error) {
      return false;
    }
  } else {
    msg = eventOrMessage;
  }
  if (!isRecord(msg) || msg.type !== "groupTabsResult") {
    return false;
  }
  resolveGroupingResponse(msg);
  return true;
}

function resolveGroupingResponse(msg) {
  if (typeof msg.id !== "string") {
    return;
  }
  const pending = pendingGroupingRequests.get(msg.id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingGroupingRequests.delete(msg.id);
  pending.resolve(msg);
}

function rejectPendingGrouping(error) {
  const entries = Array.from(pendingGroupingRequests.values());
  pendingGroupingRequests.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function groupingUnavailableCode() {
  if (socket && socket.readyState === WebSocket.OPEN && socketAuthState === BUS_AUTH_STATES.AWAITING_AUTH_OK) {
    return "pairing_pending";
  }
  if (pairingStatus === BUS_PAIRING_STATUSES.PAIRING_FAILED) {
    return "pairing_failed";
  }
  if (pairingStatus === BUS_PAIRING_STATUSES.PAIRING_REQUIRED) {
    return "pairing_required";
  }
  return "daemon_disconnected";
}

function promoteOpenSocketToLegacy() {
  if (socket && socket.readyState === WebSocket.OPEN && socketAuthState === BUS_AUTH_STATES.UNAUTHENTICATED) {
    socketAuthState = BUS_AUTH_STATES.LEGACY;
    setPairingStatus(BUS_PAIRING_STATUSES.LEGACY).catch((error) => {
      console.error("Pairing status error:", error);
    });
    publishLensStateSoon();
  }
}

function requestTabGrouping(tabsPayload, promptOverride) {
  promoteOpenSocketToLegacy();
  if (!canUseBusSocket()) {
    return Promise.reject(new Error(groupingUnavailableCode()));
  }
  const id = nextGroupingRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingGroupingRequests.delete(id);
      reject(new Error("grouping_timeout"));
    }, GROUPING_TIMEOUT_MS);
    pendingGroupingRequests.set(id, { resolve, reject, timer });
    try {
      const message = { type: "groupTabs", schemaVersion: 1, id, tabs: tabsPayload };
      const prompt = normalizeGroupingPrompt(promptOverride);
      if (prompt) {
        message.prompt = prompt;
      }
      socket.send(JSON.stringify(message));
    } catch (error) {
      clearTimeout(timer);
      pendingGroupingRequests.delete(id);
      reject(error);
    }
  });
}

function isUngroupedTab(tab) {
  // Firefox (139+) reports groupId === -1 for tabs not in any group. Fail closed:
  // an unknown group state is treated as grouped and left untouched.
  return tab.groupId === -1;
}

async function collectGroupableTabs(windowId) {
  const targetWindow = typeof windowId === "number" ? windowId : browser.windows.WINDOW_ID_CURRENT;
  const tabs = await browser.tabs.query({ windowId: targetWindow });
  // Only touch ungrouped, non-pinned web tabs so existing manual groups and
  // privileged pages (about:, moz-extension:, …) are never disturbed.
  return tabs.filter((tab) =>
    !tab.pinned &&
    isUngroupedTab(tab) &&
    typeof tab.url === "string" &&
    GROUPABLE_URL.test(tab.url)
  );
}

function mapProposalToGroups(proposalGroups, candidates) {
  if (!Array.isArray(proposalGroups)) {
    return [];
  }
  const groups = [];
  const seen = new Set();
  let colorIndex = 0;
  for (const proposal of proposalGroups) {
    if (!isRecord(proposal) || typeof proposal.topic !== "string") {
      continue;
    }
    const topic = proposal.topic.trim();
    if (topic === "") {
      continue;
    }
    const indices = Array.isArray(proposal.tabIndices) ? proposal.tabIndices : [];
    const tabs = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length || seen.has(index)) {
        continue;
      }
      const tab = candidates[index];
      if (tab && typeof tab.id === "number") {
        seen.add(index);
        tabs.push({ id: tab.id, title: typeof tab.title === "string" && tab.title !== "" ? tab.title : tab.url });
      }
    }
    if (tabs.length === 0) {
      continue;
    }
    groups.push({
      topic,
      color: TAB_GROUP_COLORS[colorIndex % TAB_GROUP_COLORS.length],
      tabs,
    });
    colorIndex += 1;
  }
  return groups;
}

function describeGroupingError(code) {
  switch (code) {
    case "daemon_disconnected":
      return "Not connected to mac-command-centre.";
    case "pairing_pending":
      return "Still pairing with mac-command-centre. Try again in a moment.";
    case "pairing_failed":
      return "Pairing with mac-command-centre failed. Check the pairing token.";
    case "pairing_required":
      return "Enter the mac-command-centre pairing token in Options.";
    case "grouping_timeout":
      return "The on-device model took too long to respond.";
    default:
      return "Could not reach the AI tab grouping service.";
  }
}

// Resolves the active provider. A valid custom provider is used directly via
// fetch; otherwise we fall back to Foundation (on-device, routed to the daemon).
async function getProvider() {
  const stored = await browser.storage.local.get(AI_PROVIDER_KEY);
  const provider = stored[AI_PROVIDER_KEY];
  if (
    isRecord(provider) &&
    provider.kind === "custom" &&
    typeof provider.baseURL === "string" && provider.baseURL !== "" &&
    typeof provider.model === "string" && provider.model !== ""
  ) {
    return {
      kind: "custom",
      baseURL: provider.baseURL,
      model: provider.model,
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
    };
  }
  return { kind: "foundation" };
}

// Tab titles are attacker-influenced (any page controls its own <title>):
// collapse whitespace so a title can't fake extra prompt lines and cap the
// length. Titleless tabs fall back to the host only — a raw URL can embed
// query-string secrets (sign-in links, OAuth callbacks) that must not reach
// a cloud provider's request logs.
function sanitizeTabTitle(title) {
  return title.replace(/\s+/g, " ").trim().slice(0, 200);
}

function buildGroupingPrompt(payload) {
  const lines = ["Tabs to organize (index: title [host]):"];
  for (const tab of payload) {
    let host = "";
    try {
      host = new URL(tab.url).host;
    } catch (error) {
      host = "";
    }
    const cleaned = typeof tab.title === "string" ? sanitizeTabTitle(tab.title) : "";
    const title = cleaned !== "" ? cleaned : host || "(untitled)";
    lines.push(`${tab.index}: ${title}${host ? ` [${host}]` : ""}`);
  }
  return lines.join("\n");
}

// Pulls the JSON object/array out of model content that may be fenced or prose-wrapped.
function extractGroupingJSON(content) {
  let text = content.trim();
  if (text.startsWith("```")) {
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      text = text.slice(newline + 1);
    }
    const fence = text.lastIndexOf("```");
    if (fence !== -1) {
      text = text.slice(0, fence);
    }
    text = text.trim();
  }
  const opens = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  const start = opens.length ? Math.min(...opens) : -1;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return start >= 0 && end >= start ? text.slice(start, end + 1) : text;
}

function parseGroupsFromContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(extractGroupingJSON(content));
  } catch (error) {
    return [];
  }
  let entries;
  if (isRecord(parsed) && Array.isArray(parsed.groups)) {
    entries = parsed.groups;
  } else if (Array.isArray(parsed)) {
    entries = parsed;
  } else {
    return [];
  }
  const groups = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.topic !== "string") {
      continue;
    }
    const indices = Array.isArray(entry.tabIndices)
      ? entry.tabIndices
          .map((value) => (typeof value === "number" ? value : parseInt(value, 10)))
          .filter((n) => Number.isInteger(n))
      : [];
    groups.push({ topic: entry.topic, tabIndices: indices });
  }
  return groups;
}



function normalizeGroupingPrompt(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.length > AI_GROUPING_PROMPT_MAX
    ? trimmed.slice(0, AI_GROUPING_PROMPT_MAX)
    : trimmed;
}

async function getGroupingPromptOverride() {
  const stored = await browser.storage.local.get(AI_GROUPING_PROMPT_KEY);
  return normalizeGroupingPrompt(stored[AI_GROUPING_PROMPT_KEY]);
}

// The user's stored prompt fully replaces the default when set; an empty
// override uses the built-in GROUPING_SYSTEM_PROMPT.
function buildGroupingSystemPrompt(promptOverride) {
  const override = normalizeGroupingPrompt(promptOverride);
  return override || GROUPING_SYSTEM_PROMPT;
}
// Calls an OpenAI-compatible endpoint directly from the extension. Returns raw
// [{topic, tabIndices}]; throws an Error with a `code` and a friendly message.
async function cloudCluster(payload, provider, systemPrompt) {
  const endpoint = provider.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROUPING_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt || GROUPING_SYSTEM_PROMPT },
          { role: "user", content: buildGroupingPrompt(payload) },
        ],
      }),
    });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    const wrapped = new Error(
      aborted
        ? "The provider took too long to respond."
        : "Could not reach the provider. Check the URL and grant host access in options."
    );
    wrapped.code = aborted ? "cloud_timeout" : "cloud_unreachable";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const wrapped = new Error(
      `Provider returned HTTP ${response.status}.${response.status === 401 ? " Check your API key." : ""}`
    );
    wrapped.code = `cloud_http_${response.status}`;
    throw wrapped;
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    const wrapped = new Error("Provider returned invalid JSON.");
    wrapped.code = "cloud_bad_json";
    throw wrapped;
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined;
  if (typeof content !== "string") {
    const wrapped = new Error("Provider response was not a chat completion.");
    wrapped.code = "cloud_malformed";
    throw wrapped;
  }
  return parseGroupsFromContent(content);
}

async function computeTabGrouping(windowId, explicitTabs) {
  const candidates = Array.isArray(explicitTabs) ? explicitTabs : await collectGroupableTabs(windowId);
  if (candidates.length < 2) {
    const message = Array.isArray(explicitTabs)
      ? "Select at least 2 ungrouped tabs to organize."
      : "Open at least 2 ungrouped tabs to organize.";
    return { ok: false, error: "not_enough_tabs", message };
  }

  const payload = candidates.map((tab, index) => ({
    index,
    title: typeof tab.title === "string" ? tab.title : "",
    url: tab.url,
  }));

  const provider = await getProvider();
  const promptOverride = await getGroupingPromptOverride();
  const systemPrompt = buildGroupingSystemPrompt(promptOverride);
  let raw;
  if (provider.kind === "custom") {
    try {
      raw = await cloudCluster(payload, provider, systemPrompt);
    } catch (error) {
      return { ok: false, error: error.code || "cloud_failed", message: error.message || "Cloud provider failed." };
    }
  } else {
    let response;
    try {
      response = await requestTabGrouping(payload, promptOverride);
    } catch (error) {
      return { ok: false, error: error.message || "grouping_failed", message: describeGroupingError(error.message) };
    }
    if (!isRecord(response) || response.ok !== true) {
      return {
        ok: false,
        error: (response && response.error) || "grouping_failed",
        message: (response && response.message) || "Could not organize tabs.",
      };
    }
    raw = response.groups;
  }

  const groups = mapProposalToGroups(raw, candidates);
  if (groups.length === 0) {
    return { ok: false, error: "empty_result", message: "No groups were returned for these tabs." };
  }
  return { ok: true, groups };
}

async function applyTabGrouping(groups, windowId) {
  const applied = [];
  const failures = [];
  // Merge into an existing same-named group (manual or a prior AI run) instead
  // of spawning a duplicate. Snapshot existing groups once, scoped to the window.
  const existingByTitle = new Map();
  if (browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const query = typeof windowId === "number" ? { windowId } : {};
    const existing = await browser.tabGroups.query(query).catch(() => []);
    for (const group of existing) {
      if (typeof group.title === "string" && group.title !== "" && !existingByTitle.has(group.title)) {
        existingByTitle.set(group.title, group);
      }
    }
  }
  for (const group of groups) {
    const tabIds = group.tabs.map((tab) => tab.id).filter((id) => typeof id === "number");
    if (tabIds.length === 0) {
      continue;
    }
    const color = TAB_GROUP_COLORS.includes(group.color) ? group.color : TAB_GROUP_COLORS[0];
    try {
      const existing = existingByTitle.get(group.topic);
      if (existing) {
        // Append to the existing group; leave its title and color intact.
        await browser.tabs.group({ groupId: existing.id, tabIds });
      } else {
        const groupId = await browser.tabs.group({ tabIds });
        await browser.tabGroups.update(groupId, { title: group.topic, color });
      }
      applied.push(group.topic);
    } catch (error) {
      console.error("AI tab group apply error:", group.topic, error);
      failures.push(group.topic);
    }
  }
  return { applied, failures };
}

async function aiGroupingEnabled() {
  const stored = await browser.storage.local.get(AI_GROUPING_ENABLED_KEY);
  return stored[AI_GROUPING_ENABLED_KEY] === true;
}

async function discardCollapsedTabsEnabled() {
  const stored = await browser.storage.local.get(DISCARD_COLLAPSED_TABS_KEY);
  return stored[DISCARD_COLLAPSED_TABS_KEY] === true;
}

async function aiPinToFocusEnabled() {
  const stored = await browser.storage.local.get(AI_PIN_TO_FOCUS_KEY);
  return stored[AI_PIN_TO_FOCUS_KEY] === true;
}

async function aiAutoGroupEnabled() {
  const stored = await browser.storage.local.get(AI_AUTO_GROUP_KEY);
  return stored[AI_AUTO_GROUP_KEY] === true;
}

async function activeFocusName() {
  const activeView = await getActiveView();
  if (activeView.kind !== "lens") {
    return null;
  }
  const lens = (await getLenses()).find((candidate) => candidate.id === activeView.lensId);
  return lens ? lens.name : null;
}

async function pinTopicsToActiveFocus(topics) {
  if (topics.length === 0 || !(await aiPinToFocusEnabled())) {
    return;
  }
  const activeView = await getActiveView();
  if (activeView.kind !== "lens") {
    return;
  }
  const lenses = await getLenses();
  const index = lenses.findIndex((lens) => lens.id === activeView.lensId);
  if (index === -1) {
    return;
  }
  const selectors = normalizedSelectors(lenses[index].groupSelectors);
  const seen = new Set(selectors.map((selector) => `${selector.type}\u0000${selector.value}`));
  let changed = false;
  for (const topic of topics) {
    if (typeof topic !== "string" || topic.trim() === "") {
      continue;
    }
    const value = topic.trim();
    const key = `title\u0000${value}`;
    if (!seen.has(key)) {
      selectors.push({ type: "title", value });
      seen.add(key);
      changed = true;
    }
  }
  if (changed) {
    lenses[index] = { ...lenses[index], groupSelectors: selectors, updatedAt: Date.now() };
    await saveLenses(lenses);
  }
}

function cachedProposal(windowId) {
  const entry = lastProposalByWindow.get(windowId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > PROPOSAL_TTL_MS) {
    lastProposalByWindow.delete(windowId);
    return null;
  }
  return entry.groups;
}

async function handleGroupState(windowId) {
  const [enabled, candidates, provider, pinToFocus, activeFocus, autoGroup] = await Promise.all([
    aiGroupingEnabled(),
    collectGroupableTabs(windowId),
    getProvider(),
    aiPinToFocusEnabled(),
    activeFocusName(),
    aiAutoGroupEnabled(),
  ]);
  return {
    enabled,
    groupableCount: candidates.length,
    proposal: cachedProposal(windowId),
    providerKind: provider.kind,
    pinToFocus,
    activeFocus,
    autoGroup,
  };
}

function handleGroupClear(windowId) {
  if (typeof windowId === "number") {
    lastProposalByWindow.delete(windowId);
  }
  return { ok: true };
}

async function handleGroupPreview(windowId) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  // Collapse concurrent previews for the same window onto one in-flight request
  // so re-opening the popup or clicking Regroup mid-compute can't fan out
  // duplicate daemon/LLM calls. The cache key tolerates an absent windowId.
  const key = typeof windowId === "number" ? windowId : "current";
  const existing = inflightPreviews.get(key);
  if (existing) {
    return existing;
  }
  const work = (async () => {
    const result = await computeTabGrouping(windowId);
    if (result.ok) {
      await clearLastError();
      if (typeof windowId === "number") {
        lastProposalByWindow.set(windowId, { groups: result.groups, ts: Date.now() });
      }
    } else {
      await setLastError(result.error, result.message);
    }
    return result;
  })();
  inflightPreviews.set(key, work);
  try {
    return await work;
  } finally {
    inflightPreviews.delete(key);
  }
}

async function commitTabGroups(windowId, groups, { notify: doNotify = true, surfaceEmptyError = true, surfaceStatus = true, pinToActiveLens = true } = {}) {
  // Re-validate against live tab state: between preview and apply a tab may have
  // been closed, pinned, manually grouped, or navigated off http(s). Only group
  // ids that are still groupable right now.
  const groupableIds = new Set((await collectGroupableTabs(windowId)).map((tab) => tab.id));
  const normalized = (Array.isArray(groups) ? groups : [])
    .filter((group) => isRecord(group) && typeof group.topic === "string" && Array.isArray(group.tabs))
    .map((group) => ({
      topic: group.topic,
      color: group.color,
      tabs: group.tabs.filter((tab) => isRecord(tab) && typeof tab.id === "number" && groupableIds.has(tab.id)),
    }))
    .filter((group) => group.tabs.length > 0);
  if (normalized.length === 0) {
    const result = { ok: false, error: "no_groups", message: "Those tabs are no longer available to group." };
    // In silent auto mode an empty re-validation usually means the tabs were
    // already grouped (the desired end state) — not a user-facing failure.
    if (surfaceEmptyError && surfaceStatus) {
      await setLastError(result.error, result.message);
    }
    return result;
  }

  const outcome = await applyTabGrouping(normalized, windowId);
  const ok = outcome.failures.length === 0;
  if (outcome.applied.length > 0) {
    // Even on a partial failure the applied groups exist: pin them to the
    // active lens and drop the cached proposal, which no longer matches the
    // window's live tabs.
    if (pinToActiveLens) await pinTopicsToActiveFocus(outcome.applied);
    if (typeof windowId === "number") {
      lastProposalByWindow.delete(windowId);
    }
  }
  const message = ok
    ? `Created ${outcome.applied.length} group(s): ${outcome.applied.join(", ")}`
    : `Created ${outcome.applied.length}; failed: ${outcome.failures.join(", ")}`;
  const result = ok
    ? { ok, applied: outcome.applied, failures: outcome.failures }
    : { ok, error: "apply_failed", message, applied: outcome.applied, failures: outcome.failures };
  if (surfaceStatus) {
    if (ok) {
      await clearLastError();
    } else {
      await setLastError(result.error, result.message);
    }
    await setFocusBadge({ text: ok ? "AI" : "!", color: ok ? "#00C853" : "#FF9800", title: "AI Tab Groups" });
  }
  if (doNotify) {
    await notify({ type: "basic", title: "AI Tab Groups", message });
  }
  return result;
}

async function handleGroupApply(windowId, groups) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  return commitTabGroups(windowId, groups, { notify: true });
}

function scheduleAutoGroup(windowId) {
  if (typeof windowId !== "number" || !autoGroupEnabled) {
    return;
  }
  const existing = autoGroupDebounceTimers.get(windowId);
  if (existing) {
    clearTimeout(existing);
  }
  const id = setTimeout(() => {
    autoGroupDebounceTimers.delete(windowId);
    runAutoGroup(windowId).catch((error) => console.error("Auto-group error:", error));
  }, AUTO_GROUP_DEBOUNCE_MS);
  autoGroupDebounceTimers.set(windowId, id);
}

function startAutoGroupCooldown(windowId) {
  autoGroupCooldown.add(windowId);
  setTimeout(() => autoGroupCooldown.delete(windowId), AUTO_GROUP_COOLDOWN_MS);
}

async function runAutoGroup(windowId) {
  if (typeof windowId !== "number" || !autoGroupEnabled) {
    return;
  }
  // Skip if a run is already in progress, cooling down, or a manual popup
  // preview is computing for this window — all three would otherwise let two
  // clustering passes race over the same tabs.
  if (autoGroupCooldown.has(windowId) || autoGroupInflight.has(windowId) || inflightPreviews.has(windowId)) {
    return;
  }
  autoGroupInflight.add(windowId);
  try {
    if (!(await aiGroupingEnabled())) {
      return;
    }
    const candidates = await collectGroupableTabs(windowId);
    if (candidates.length < 2) {
      return;
    }
    startAutoGroupCooldown(windowId);
    const result = await computeTabGrouping(windowId, candidates);
    if (!result.ok) {
      console.warn("Auto-group skipped:", result.error, result.message);
      return;
    }
    // surfaceEmptyError: false — if the tabs were grouped out from under us
    // mid-compute, that's the desired end state, not a red-badge failure.
    await commitTabGroups(windowId, result.groups, { notify: false, surfaceEmptyError: false, surfaceStatus: false, pinToActiveLens: false });
  } finally {
    autoGroupInflight.delete(windowId);
  }
}

// ── Tab search ─────────────────────────────────────────────
// Content scripts can't touch browser.tabs, so the search overlay (tabsearch.js)
// asks the background for the tab list and routes switch/close actions through here.

async function listTabsForSearch() {
  const currentWindow = browser.windows
    ? await browser.windows.getCurrent().catch(() => null)
    : null;
  const currentWindowId = currentWindow ? currentWindow.id : null;
  const [tabs, containers] = await Promise.all([
    browser.tabs.query({}),
    getContainers(),
  ]);
  const containersByStore = containersByCookieStore(containers);
  let groupsById = null;
  const hasGroupedTabs = tabs.some((tab) => typeof tab.groupId === "number" && tab.groupId !== -1);
  if (hasGroupedTabs && browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const groups = await browser.tabGroups.query({}).catch(() => []);
    groupsById = new Map(groups.map((group) => [group.id, group]));
  }
  const mapped = tabs.map((tab) => {
    const group = groupsById && typeof tab.groupId === "number" && tab.groupId !== -1
      ? groupsById.get(tab.groupId)
      : null;
    const cookieStoreId = typeof tab.cookieStoreId === "string" ? tab.cookieStoreId : DEFAULT_COOKIE_STORE_ID;
    const container = !isSpecialCookieStoreId(cookieStoreId) ? containersByStore.get(cookieStoreId) : null;
    const row = {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || tab.url || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      active: Boolean(tab.active),
      currentWindow: tab.windowId === currentWindowId,
      groupTitle: group && group.title ? group.title : "",
      groupColor: group && group.color ? group.color : "",
      pinned: Boolean(tab.pinned),
      grouped: typeof tab.groupId === "number" && tab.groupId !== -1,
      groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
      cookieStoreId,
    };
    if (container) {
      row.containerName = container.name;
      row.containerColor = container.color;
    }
    return row;
  });
  // Stable sort keeps native tab order within a window; current window floats first.
  mapped.sort((a, b) => {
    if (a.currentWindow !== b.currentWindow) return a.currentWindow ? -1 : 1;
    return 0;
  });
  return mapped;
}

async function activateTabFromSearch(tabId, windowId) {
  if (typeof tabId !== "number") return { ok: false };
  if (browser.windows && typeof windowId === "number") {
    await browser.windows.update(windowId, { focused: true }).catch(() => {});
  }
  await browser.tabs.update(tabId, { active: true });
  return { ok: true };
}

async function closeTabFromSearch(tabId) {
  if (typeof tabId === "number") {
    await browser.tabs.remove(tabId).catch(() => {});
  }
  return listTabsForSearch();
}

// Collapse near-duplicate history URLs (scheme, www., trailing slash, and
// tracking/session params) so "https://youtube.com/", "http://youtube.com/",
// and "...?themeRefresh=1" don't each take a row.
const HISTORY_NOISE_PARAMS = new Set([
  "sei", "themerefresh", "gs_lcrp", "ved", "ei", "sca_esv", "source", "sourceid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid",
]);

function normalizeHistoryUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (HISTORY_NOISE_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    const search = url.searchParams.toString();
    let path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}${search ? `?${search}` : ""}`.toLowerCase();
  } catch (error) {
    return rawUrl.toLowerCase();
  }
}

async function searchHistoryFromSearch(query) {
  if (typeof query !== "string" || query.trim() === "") return { ok: false, results: [] };
  if (!browser.history || typeof browser.history.search !== "function") return { ok: false, results: [] };
  try {
    const items = await browser.history.search({ text: query, maxResults: 20, startTime: 0 });
    const byKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const url = item && typeof item.url === "string" ? item.url : "";
      if (!url) continue;
      const title = item.title && item.title.trim() ? item.title.trim() : "";
      const key = normalizeHistoryUrl(url);
      const existing = byKey.get(key);
      // Prefer an entry with a real title, then the shorter (canonical) url.
      if (
        !existing ||
        (!existing.title && title) ||
        (Boolean(existing.title) === Boolean(title) && url.length < existing.url.length)
      ) {
        byKey.set(key, { title, url });
      }
    }
    // title left empty when history has no real title -> the client renders one line.
    return { ok: true, results: [...byKey.values()] };
  } catch (error) {
    return { ok: false, results: [] };
  }
}

async function webSearchFromSearch(query) {
  if (typeof query !== "string" || query.trim() === "") return { ok: false };
  if (!browser.search || typeof browser.search.query !== "function") return { ok: false };
  try {
    await browser.search.query({ text: query, disposition: "NEW_TAB" });
    return { ok: true };
  } catch (error) {
    return { ok: false };
  }
}

// A brand-new/empty tab worth replacing instead of stacking another tab on top.
function isBlankTab(tab) {
  return tab && (typeof tab.url !== "string" || tab.url === "" || /^(about:blank|about:newtab|about:home)(?:[?#]|$)/.test(tab.url));
}

async function openUrlFromSearch(url) {
  if (typeof url !== "string" || !url) return { ok: false };
  if (!browser.tabs || typeof browser.tabs.create !== "function") return { ok: false };
  try {
    // Reuse the current tab when it's blank (about:blank/newtab/home) so we don't
    // leave an empty tab behind; otherwise open alongside in a new tab.
    if (typeof browser.tabs.query === "function" && typeof browser.tabs.update === "function") {
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      if (isBlankTab(active)) {
        await browser.tabs.update(active.id, { url });
        return { ok: true };
      }
    }
    await browser.tabs.create({ url, active: true });
    return { ok: true };
  } catch (error) {
    return { ok: false };
  }
}

function validTabIds(tabIds) {
  return Array.isArray(tabIds) ? tabIds.filter((id) => typeof id === "number") : [];
}

async function closeManyTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0) {
    await browser.tabs.remove(validIds).catch(() => {});
  }
  return listTabsForSearch();
}

async function groupTabsFromSearch(tabIds, title, windowId, groupId) {
  const validIds = validTabIds(tabIds);
  if (validIds.length === 0) {
    return { ok: false, error: "no_tabs", message: "No tabs to group.", list: await listTabsForSearch() };
  }
  // Drag-onto-section: add tabs to an existing group by id — no title needed,
  // and the group's existing title/color are preserved.
  if (typeof groupId === "number") {
    try {
      await browser.tabs.group({ groupId, tabIds: validIds });
    } catch (error) {
      return { ok: false, error: "group_failed", message: "Could not add tabs to the group.", list: await listTabsForSearch() };
    }
    return { ok: true, list: await listTabsForSearch() };
  }
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") {
    return { ok: false, error: "no_title", message: "Enter a group name." };
  }
  let existingGroupCount = 0;
  if (browser.tabGroups && typeof browser.tabGroups.query === "function") {
    const query = typeof windowId === "number" ? { windowId } : {};
    const existing = await browser.tabGroups.query(query).catch(() => []);
    existingGroupCount = Array.isArray(existing) ? existing.length : 0;
  }
  const group = {
    topic: trimmed,
    color: TAB_GROUP_COLORS[existingGroupCount % TAB_GROUP_COLORS.length] || TAB_GROUP_COLORS[0],
    tabs: validIds.map((id) => ({ id })),
  };
  const outcome = await applyTabGrouping([group], windowId);
  const ok = outcome.failures.length === 0;
  const result = { ok, list: await listTabsForSearch() };
  if (!ok) {
    result.error = "group_failed";
    result.message = "Could not group some tabs.";
  }
  return result;
}

async function ungroupTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0 && browser.tabs && typeof browser.tabs.ungroup === "function") {
    await browser.tabs.ungroup(validIds).catch(() => {});
  }
  return listTabsForSearch();
}

async function moveTabsToNewWindow(tabIds) {
  const validIds = validTabIds(tabIds);
  if (validIds.length < 1) {
    return listTabsForSearch();
  }
  try {
    const win = await browser.windows.create({ tabId: validIds[0] });
    if (validIds.length > 1 && win && typeof win.id === "number") {
      await browser.tabs.move(validIds.slice(1), { windowId: win.id, index: -1 });
    }
  } catch (error) {
    // Keep the overlay responsive if one of the selected tabs no longer exists.
  }
  return listTabsForSearch();
}

async function moveTabsToContainerFromSearch(tabIds, cookieStoreId) {
  const validIds = validTabIds(tabIds);
  const targetCookieStoreId = typeof cookieStoreId === "string" ? cookieStoreId : "";
  if (validIds.length < 1 || !targetCookieStoreId) {
    return listTabsForSearch();
  }
  const containers = await getContainers();
  const validTarget = targetCookieStoreId === DEFAULT_COOKIE_STORE_ID ||
    containers.some((container) => container.cookieStoreId === targetCookieStoreId);
  if (!validTarget) {
    return listTabsForSearch();
  }

  const wanted = new Set(validIds);
  const tabs = (await browser.tabs.query({}))
    .filter((tab) =>
      wanted.has(tab.id) &&
      typeof tab.url === "string" &&
      GROUPABLE_URL.test(tab.url) &&
      typeof tab.windowId === "number"
    )
    .sort((a, b) => (a.windowId - b.windowId) || ((a.index || 0) - (b.index || 0)));
  for (const tab of tabs) {
    const createProperties = {
      url: tab.url,
      windowId: tab.windowId,
      pinned: Boolean(tab.pinned),
      active: false,
      cookieStoreId: targetCookieStoreId,
    };
    if (typeof tab.index === "number") {
      createProperties.index = tab.index + 1;
    }
    try {
      await browser.tabs.create(createProperties);
      await browser.tabs.remove(tab.id);
    } catch (error) {
      // Skip tabs that vanish or reject container moves; the refreshed list tells the truth.
    }
  }
  return listTabsForSearch();
}

async function moveTabsFromSearch(tabIds, windowId, anchorId, placeAfter, groupId) {
  const validIds = validTabIds(tabIds);
  if (validIds.length < 1 || typeof windowId !== "number") {
    return listTabsForSearch();
  }
  try {
    const winTabs = (await browser.tabs.query({ windowId }))
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0));
    const moveSet = new Set(validIds);
    let anchorIdx = winTabs.findIndex((tab) => tab.id === anchorId);
    if (anchorIdx === -1) anchorIdx = winTabs.length - 1;
    let target = placeAfter ? anchorIdx + 1 : anchorIdx;
    // Discount moved tabs already positioned before the target slot so the tab
    // lands exactly where it was dropped (the classic reorder off-by-one).
    const movedBefore = winTabs.slice(0, target).filter((tab) => moveSet.has(tab.id)).length;
    target = Math.max(0, target - movedBefore);
    await browser.tabs.move(validIds, { windowId, index: target });
    // Group membership follows the drop position: join the target group, or drop
    // out of any group when the position isn't inside one.
    if (typeof groupId === "number" && groupId !== -1) {
      await browser.tabs.group({ groupId, tabIds: validIds });
    } else if (typeof browser.tabs.ungroup === "function") {
      await browser.tabs.ungroup(validIds);
    }
  } catch (error) {
    // Keep the overlay responsive if a tab vanished mid-drag.
  }
  return listTabsForSearch();
}

async function setTabsPinnedFromSearch(tabIds, pinned) {
  const validIds = validTabIds(tabIds);
  await Promise.all(validIds.map((id) => browser.tabs.update(id, { pinned: Boolean(pinned) }).catch(() => {})));
  return listTabsForSearch();
}

async function discardTabsFromSearch(tabIds) {
  const validIds = validTabIds(tabIds);
  if (browser.tabs && typeof browser.tabs.discard === "function") {
    await Promise.all(validIds.map((id) => browser.tabs.discard(id).catch(() => {})));
  }
  return listTabsForSearch();
}

async function tabsearchAiPreview(windowId, tabIds) {
  if (!(await aiGroupingEnabled())) {
    return { ok: false, error: "disabled", message: "AI tab grouping is turned off." };
  }
  let candidates;
  const validIds = validTabIds(tabIds);
  if (validIds.length > 0) {
    const wanted = new Set(validIds);
    const tabs = await browser.tabs.query({});
    candidates = tabs.filter((tab) =>
      wanted.has(tab.id) &&
      (typeof windowId !== "number" || tab.windowId === windowId) &&
      !tab.pinned &&
      isUngroupedTab(tab) &&
      typeof tab.url === "string" &&
      GROUPABLE_URL.test(tab.url)
    );
  } else {
    candidates = await collectGroupableTabs(windowId);
  }
  const result = await computeTabGrouping(windowId, candidates);
  if (!result.ok) {
    await setLastError(result.error, result.message);
    return result;
  }
  await clearLastError();
  return {
    ok: true,
    groups: result.groups.map((group) => ({
      topic: group.topic,
      color: group.color,
      tabs: group.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
    })),
  };
}

const TAB_SEARCH_HOST_URL = browser.runtime.getURL("tabsearch.html?tabsearchOpen=1");

function isNewTabPage(tab) {
  return tab && typeof tab.url === "string" && /^(about:newtab|about:home)(?:[?#]|$)/.test(tab.url);
}

async function openTabSearchOverlay() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active || typeof active.id !== "number") return;
  try {
    await browser.tabs.sendMessage(active.id, { type: "tabsearch-open" });
  } catch (error) {
    if (isNewTabPage(active)) {
      // Navigating the new-tab page in place (tabs.update) leaves keyboard focus
      // stuck in the address bar (Firefox bug 1411465 / 1415860), so typed text
      // lands in the URL bar. Opening a *fresh* tab instead lands focus in the
      // content area like a link click; then discard the blank new-tab.
      await browser.tabs.create({ url: TAB_SEARCH_HOST_URL, active: true });
      try {
        await browser.tabs.remove(active.id);
      } catch (removeError) {
        // Leaving the blank tab is harmless if it can't be removed.
      }
      return;
    }
    // No content script on this page (e.g. about:, addons, PDF viewer).
    await notify({
      type: "basic",
      title: "Tab Search",
      message: "Tab search can't open on this page. Switch to a normal web page and try again.",
    });
  }
}

async function handleLensCommand(command) {
  const lensSlot = /^activate-lens-([1-9])$/.exec(command);
  if (lensSlot) {
    const lenses = await getLenses();
    const lens = lenses[Number(lensSlot[1]) - 1];
    if (lens) {
      await activateView({ kind: "lens", lensId: lens.id }, { trigger: "manual" });
    }
    return true;
  }

  if (command === "show-all-groups") {
    await activateView({ kind: "all" }, { trigger: "manual" });
    return true;
  }

  if (command === "cycle-lens-next" || command === "cycle-lens-prev") {
    const lenses = await getLenses();
    const ring = [{ kind: "all" }, ...lenses.map((lens) => ({ kind: "lens", lensId: lens.id }))];
    const active = await getActiveView();
    if (ring.length === 1 && viewKey(active) === "all") {
      return true;
    }
    const currentIndex = ring.findIndex((view) => viewKey(view) === viewKey(active));
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const step = command === "cycle-lens-next" ? 1 : -1;
    await activateView(ring[(startIndex + step + ring.length) % ring.length], { trigger: "manual" });
    return true;
  }

  return false;
}

async function handleCommand(command) {
  if (command === "search-tabs") {
    await openTabSearchOverlay();
    return;
  }
  await handleLensCommand(command);
}

if (browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener((command) => {
    handleCommand(command).catch(console.error);
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") {
    connect();
  } else if (alarm.name === SCHEDULE_ALARM_NAME) {
    enqueueFocusWork(() => handleScheduleTick()).catch((error) => console.error("Schedule activation error:", error));
  }
});

start();
