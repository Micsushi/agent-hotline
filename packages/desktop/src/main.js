import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as notification from "@tauri-apps/plugin-notification";
import { createPlaybackController } from "./playback.js";
import {
  describeQueueArrivalNotice,
  getStartupAutoReadAttemptIds,
  shouldAutoReadPending,
  getNextPendingItem,
  selectItemIdForQueueUpdate
} from "./read-mode.js";
import { initSettingsUi } from "./settings-ui.js";
import { listCache, deleteCacheSession, deleteCacheProject } from "./audio-cache.js";
import {
  groupByProjectSession,
  latestCreatedAt,
  projectKeyOf,
  projectLabelOf,
  sessionKeyOf,
  sessionLabelOf
} from "./grouping.js";
import { buildNotificationEntries, latestUnreadItemId } from "./notifications.js";
import { applyProjectColor, applyOwnerColor, ownerSolidColor } from "./project-colors.js";
import { closeColorMenu, openColorMenu } from "./color-menu.js";
import { initColumnResize } from "./column-resize.js";

const isTauri = Boolean(window.__TAURI_INTERNALS__);

const DEFAULT_BACKEND_URL = "http://127.0.0.1:4777";
const STATUS_LABELS = {
  idle: "Idle",
  pending: "Pending",
  loading: "Loading",
  speaking: "Speaking",
  paused: "Paused",
  muted: "Muted",
  skipped: "Skipped",
  error: "Error"
};
const QUEUE_POLL_INTERVAL_MS = 1000;
const AUTO_READ_STORAGE_KEY = "agent-hotline.auto-read-attempted";
const PREGEN_STORAGE_KEY = "agent-hotline.pregen-seen";
const ORDERING_STORAGE_KEY = "agent-hotline.ordering";
const STARTUP_SETTINGS_STORAGE_KEY = "agent-hotline.startup-settings";
const COPY_TOAST_DURATION_MS = 500;
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_SPINNER = '<span class="spinner" aria-hidden="true"></span>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M4.5 4.5 19.5 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_PIN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-4 4v5l-2 2-5-5-5 5 5-5-5-5 2-2h5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';

const el = (id) => document.getElementById(id);
const windowMinimize = el("window-minimize");
const windowMaximize = el("window-maximize");
const windowClose = el("window-close");
const statusBadge = el("status-badge");
const sourceApp = el("source-app");
const itemTime = el("item-time");
const itemStatus = el("item-status");
const previewText = el("preview-text");
const previewMeta = el("preview-meta");
const nowBar = previewText.closest(".now-bar");
const seekBar = el("seek-bar");
const seekCurrent = el("seek-current");
const seekTotal = el("seek-total");
const firstButton = el("first-button");
const prevButton = el("prev-button");
const playPauseButton = el("playpause-button");
const nextButton = el("next-button");
const lastButton = el("last-button");
const muteButton = el("mute-button");
const historyList = el("history");
const actionHint = el("action-hint");
const backendUrl = el("backend-url");
const navChats = el("nav-chats");
const navSearch = el("nav-search");
const navNotifications = el("nav-notifications");
const navTrash = el("nav-trash");
const navSettings = el("nav-settings");
const viewBlank = el("view-blank");
const viewChats = el("view-chats");
const viewSearch = el("view-search");
const viewNotifications = el("view-notifications");
const viewTrash = el("view-trash");
const viewSettings = el("view-settings");
const searchInput = el("search-input");
const searchClear = el("search-clear");
const searchCount = el("search-count");
const searchResults = el("search-results");
const searchType = el("search-type");
const searchOwner = el("search-owner");
const searchTime = el("search-time");
const searchSort = el("search-sort");
const notificationsCount = el("notifications-count");
const notificationsList = el("notifications-list");
const projectsTitle = el("projects-title");
const sessionFind = el("session-find");
const sessionFindInput = el("session-find-input");
const sessionFindCount = el("session-find-count");
const sessionFindPrev = el("session-find-prev");
const sessionFindNext = el("session-find-next");
const trashCount = el("trash-count");
const trashEmpty = el("trash-empty");
const trashCascade = el("trash-cascade");
const trashProjectsList = el("trash-projects");
const trashSessionsPane = el("trash-sessions-pane");
const trashSessionsList = el("trash-sessions");
const trashMessagesPane = el("trash-messages-pane");
const trashMessagesList = el("trash-messages");
const trashProjectsTitle = el("trash-projects-title");
const trashSessionsTitle = el("trash-sessions-title");
const trashMessagesTitle = el("trash-messages-title");
const projectsList = el("projects-list");
const sessionsList = el("sessions-list");
const sessionsPane = el("sessions-pane");
const messagesPane = el("messages-pane");
const trashSessionButton = el("trash-session");
const msgModal = el("msg-modal");
const modalOwner = el("modal-owner");
const modalTime = el("modal-time");
const modalMeta = el("modal-meta");
const modalBody = el("modal-body");
const modalClose = el("modal-close");
const modalPrev = el("modal-prev");
const modalPlay = el("modal-play");
const modalNext = el("modal-next");
const modalSpeed = el("modal-speed");
const sessionDetailsModal = el("session-details-modal");
const sessionDetailsOwner = el("session-details-owner");
const sessionDetailsTitle = el("session-details-title");
const sessionDetailsBody = el("session-details-body");
const sessionDetailsClose = el("session-details-close");
const confirmModal = el("confirm-modal");
const confirmTitle = el("confirm-title");
const confirmMessage = el("confirm-message");
const confirmCancel = el("confirm-cancel");
const confirmOk = el("confirm-ok");

function initWindowChrome() {
  if (!isTauri) return;
  const appWindow = getCurrentWindow();
  windowMinimize?.addEventListener("click", () => appWindow.minimize());
  windowMaximize?.addEventListener("click", () => appWindow.toggleMaximize());
  windowClose?.addEventListener("click", () => appWindow.close());
}

let playback = null;
let settingsUi = null;
let latestState = null;
let refreshInFlight = false;
let selectedItemId = null;
let lastLatestId = null;
let seekDragging = false;
let lastKokoroVoice;
let lastEngine;
let lastRate;
let voiceTrackInit = false;
let lastDataSig = null;
let historyView = { level: "messages", projectKey: null, sessionKey: null };
let searchQuery = "";
let searchResultType = "all";
let searchOwnerFilter = "all";
let searchTimeFilter = "any";
let searchSortMode = "newest";
let searchHighlightItemId = null;
let searchHighlightPrompt = null;
let projectSelectMode = false;
let selectedProjectKeys = new Set();
let sessionSelectMode = false;
let sessionSelectionProjectKey = null;
let selectedSessionKeys = new Set();
let trashView = { projectKey: null, sessionKey: null };
let trashSelectMode = null;
let selectedTrashProjectKeys = new Set();
let selectedTrashSessionKeys = new Set();
let sessionFindQuery = "";
let sessionFindActiveIndex = 0;
let sessionFindPreferredTarget = null;
let sessionFindMatches = [];
let autoReadAttemptedItemIds = loadAutoReadAttempted();
let autoReadSeeded = false;
let highlightSurface = "preview";
const noticedQueueItemIds = new Set();
const NOTICED_QUEUE_ITEM_LIMIT = 200;
let queueNotice = null;
let queueNoticeEl = null;
let returnNoticeEl = null;
let pendingConfirm = null;
let toastEl = null;
let toastTimer = 0;
let orderingPrefs = loadOrderingPrefs();
let backgroundArrivalIds = new Set();

// ---- Unread tracking -------------------------------------------------------
// An item is "unread" until the user opens it or playback of it finishes. The
// read set is persisted so unread state survives restarts. On a brand-new
// install (no stored set) we seed every current item as read, so only genuinely
// new arrivals get dots instead of the whole backlog.
const READ_STORAGE_KEY = "agent-hotline.read-items";
let readItemIds;
let readSeeded;
(function initReadItems() {
  const raw = window.localStorage.getItem(READ_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      readItemIds = new Set(
        Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []
      );
      readSeeded = true;
      return;
    } catch {}
  }
  readItemIds = new Set();
  readSeeded = false;
})();

function persistReadItems() {
  const recent = Array.from(readItemIds).slice(-2000);
  readItemIds = new Set(recent);
  try {
    window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(recent));
  } catch {}
}

function isUnread(item) {
  return Boolean(item && item.id && !readItemIds.has(item.id));
}

function unreadCount(items) {
  let count = 0;
  for (const item of items) if (isUnread(item)) count += 1;
  return count;
}

function markItemRead(itemId, { render = true } = {}) {
  if (!itemId || readItemIds.has(itemId)) return;
  readItemIds.add(itemId);
  persistReadItems();
  if (render && latestState) renderState(latestState);
}

// A session counts as "open" while it is the selected thread in the chats view.
// While open its aggregate dot (session + project) is suppressed, but the
// individual message dots linger so you can still see what was new. Leaving the
// session (picking another, drilling out, or switching views) flushes those
// items to the read set, so coming back later shows no dots at all.
function isSessionOpen(session) {
  return Boolean(session && currentView === "chats" && session.key === historyView.sessionKey);
}

function markSessionItemsRead(projectKey, sessionKey) {
  if (!projectKey || !sessionKey || !latestState) return;
  const project = buildProjects(speakableItems(latestState.queue)).find(
    (p) => p.key === projectKey
  );
  const session = project?.sessions.find((s) => s.key === sessionKey);
  if (!session) return;
  let changed = false;
  for (const item of session.items) {
    if (item.id && !readItemIds.has(item.id)) {
      readItemIds.add(item.id);
      changed = true;
    }
  }
  if (changed) persistReadItems();
}

// Flush the currently-open session to the read set before navigating away.
function leaveOpenSession() {
  if (historyView.sessionKey) markSessionItemsRead(historyView.projectKey, historyView.sessionKey);
}

// ---- Harness owner badge ---------------------------------------------------
const OWNER_CLASS = {
  Codex: "owner-codex",
  Claude: "owner-claude",
  Antigravity: "owner-antigravity",
  Mixed: "owner-mixed",
  Unknown: "owner-unknown"
};

const OWNER_CHIP_TEXT = {
  Codex: "#5a93cc",
  Claude: "#f0a98a",
  Antigravity: "#c9a2f7",
  Mixed: "#95a0b5",
  Unknown: "#95a0b5"
};

function ownerChipTextColor(owner) {
  return OWNER_CHIP_TEXT[owner] || OWNER_CHIP_TEXT.Unknown;
}

function ownerBadge(owner, { compact = false } = {}) {
  const span = document.createElement("span");
  span.className = `owner-badge ${OWNER_CLASS[owner] || "owner-unknown"}`;
  span.textContent = compact ? (owner || "?").slice(0, 1) : owner || "Unknown";
  span.title = owner || "Unknown harness";
  return span;
}

function unreadDot(count) {
  const dot = document.createElement("span");
  if (count > 1) {
    dot.className = "unread-badge";
    dot.textContent = String(count > 99 ? "99+" : count);
  } else {
    dot.className = "unread-dot";
  }
  dot.title = `${count} unread`;
  return dot;
}

function loadAutoReadAttempted() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(AUTO_READ_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistAutoReadAttempts() {
  const recent = Array.from(autoReadAttemptedItemIds).slice(-100);
  autoReadAttemptedItemIds = new Set(recent);
  try {
    window.sessionStorage.setItem(AUTO_READ_STORAGE_KEY, JSON.stringify(recent));
  } catch {}
}

function seedAutoReadAttempts(queue) {
  if (autoReadSeeded) return;
  for (const itemId of getStartupAutoReadAttemptIds(queue)) {
    autoReadAttemptedItemIds.add(itemId);
  }
  autoReadSeeded = true;
  persistAutoReadAttempts();
}

function rememberAutoReadAttempt(itemId) {
  if (!itemId) return;
  autoReadAttemptedItemIds.add(itemId);
  persistAutoReadAttempts();
}

let pregenSeenIds = loadPregenSeen();
let pregenSeeded = false;
const pregenQueue = [];
let pregenRunning = false;

function loadPregenSeen() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PREGEN_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistPregenSeen() {
  const recent = Array.from(pregenSeenIds).slice(-300);
  pregenSeenIds = new Set(recent);
  try {
    window.sessionStorage.setItem(PREGEN_STORAGE_KEY, JSON.stringify(recent));
  } catch {}
}

function defaultOrderingPrefs() {
  return {
    projectSort: "recent",
    sessionSortByProject: {},
    pinnedProjects: [],
    projectOrder: [],
    pinnedSessionsByProject: {},
    sessionOrderByProject: {}
  };
}

function cleanStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function cleanSort(value) {
  return ["recent", "name", "manual"].includes(value) ? value : "recent";
}

function cleanStringArrayMap(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entries] of Object.entries(value)) out[key] = cleanStringArray(entries);
  return out;
}

function cleanSortMap(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, sort] of Object.entries(value)) out[key] = cleanSort(sort);
  return out;
}

function loadOrderingPrefs() {
  const base = defaultOrderingPrefs();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ORDERING_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return base;
    return {
      projectSort: cleanSort(parsed.projectSort),
      sessionSortByProject: cleanSortMap(parsed.sessionSortByProject),
      pinnedProjects: cleanStringArray(parsed.pinnedProjects),
      projectOrder: cleanStringArray(parsed.projectOrder),
      pinnedSessionsByProject: cleanStringArrayMap(parsed.pinnedSessionsByProject),
      sessionOrderByProject: cleanStringArrayMap(parsed.sessionOrderByProject)
    };
  } catch {
    return base;
  }
}

function persistOrderingPrefs() {
  try {
    window.localStorage.setItem(ORDERING_STORAGE_KEY, JSON.stringify(orderingPrefs));
  } catch {}
}

function uniqueOrdered(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function moveKeyToFront(keys, key) {
  return uniqueOrdered([key, ...keys.filter((entry) => entry !== key)]);
}

function sortByName(a, b) {
  return String(a.label || "").localeCompare(String(b.label || ""), undefined, {
    sensitivity: "base"
  });
}

function sortByRecent(a, b) {
  return latestCreatedAt(b.items).localeCompare(latestCreatedAt(a.items));
}

function manualIndex(order, key) {
  const index = order.indexOf(key);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function compareOrderedGroups(a, b, { order, sort }) {
  const aIndex = manualIndex(order, a.key);
  const bIndex = manualIndex(order, b.key);
  if (sort === "manual" && aIndex !== bIndex) return aIndex - bIndex;
  if (sort === "name") return sortByName(a, b);
  return sortByRecent(a, b);
}

function orderGroupsWithPinnedSlots(groups, { pinnedKeys, order, sort }) {
  const sortedUnpinned = groups
    .filter((group) => !pinnedKeys.has(group.key))
    .sort((a, b) => compareOrderedGroups(a, b, { order, sort }));
  const result = new Array(groups.length).fill(null);
  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  const placedPinned = new Set();

  const placePinned = (key, preferredIndex) => {
    const group = groupByKey.get(key);
    if (!group || !pinnedKeys.has(key) || placedPinned.has(key)) return;
    let index = Math.min(Math.max(preferredIndex, 0), result.length - 1);
    while (index < result.length && result[index]) index += 1;
    if (index >= result.length) {
      index = result.length - 1;
      while (index >= 0 && result[index]) index -= 1;
    }
    if (index < 0) return;
    result[index] = group;
    placedPinned.add(key);
  };

  order.forEach((key, index) => placePinned(key, index));
  groups.forEach((group, index) => placePinned(group.key, index));

  let unpinnedIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) {
      result[index] = sortedUnpinned[unpinnedIndex];
      unpinnedIndex += 1;
    }
  }
  return result.filter(Boolean);
}

function sessionSortForProject(projectKey) {
  return cleanSort(orderingPrefs.sessionSortByProject[projectKey]);
}

function orderedSessions(project) {
  const pinnedKeys = new Set(orderingPrefs.pinnedSessionsByProject[project.key] || []);
  const order = orderingPrefs.sessionOrderByProject[project.key] || [];
  const sort = sessionSortForProject(project.key);
  return orderGroupsWithPinnedSlots(project.sessions, { pinnedKeys, order, sort });
}

function applyOrdering(projects) {
  const pinnedKeys = new Set(orderingPrefs.pinnedProjects);
  const orderedProjects = projects.map((project) => ({
    ...project,
    sessions: orderedSessions(project)
  }));
  return orderGroupsWithPinnedSlots(orderedProjects, {
    pinnedKeys,
    order: orderingPrefs.projectOrder,
    sort: orderingPrefs.projectSort
  });
}

function schedulePregen(settings, items) {
  if (!playback) return;
  if (settings.engine !== "kokoro" && settings.engine !== "kokoro-ts") return;

  if (!pregenSeeded) {
    for (const item of items) pregenSeenIds.add(item.id);
    persistPregenSeen();
    pregenSeeded = true;
    return;
  }

  let added = false;
  for (const item of items) {
    if (pregenSeenIds.has(item.id)) continue;
    pregenSeenIds.add(item.id);
    pregenQueue.push({ item, settings });
    added = true;
  }
  if (added) {
    persistPregenSeen();
    drainPregen();
  }
}

async function drainPregen() {
  if (pregenRunning) return;
  pregenRunning = true;
  try {
    while (pregenQueue.length > 0) {
      const { item, settings } = pregenQueue.shift();
      await playback.prewarm(item, settings);
    }
  } finally {
    pregenRunning = false;
  }
}

function queuePregenForItemIds(itemIds, settings) {
  if (!playback || !settings || !Array.isArray(itemIds) || itemIds.length === 0) return;
  if (settings.engine !== "kokoro" && settings.engine !== "kokoro-ts") return;
  const wanted = new Set(itemIds);
  const items = speakableItems(latestState?.queue || {}).filter((item) => wanted.has(item.id));
  for (const item of items) {
    pregenSeenIds.add(item.id);
    pregenQueue.push({ item, settings });
  }
  persistPregenSeen();
  drainPregen();
}

let currentView = "blank";

// Nav rail drives a single workspace view. "chats" cascades its own columns;
// settings/search/trash fill the page; "blank" is the fresh/empty state.
function setView(view) {
  const active = ["chats", "search", "notifications", "trash", "settings"].includes(view)
    ? view
    : "blank";
  // Switching away from chats counts as leaving the open thread: flush it read.
  if (currentView === "chats" && active !== "chats") leaveOpenSession();
  currentView = active;
  const navPairs = [
    [navChats, "chats"],
    [navSearch, "search"],
    [navNotifications, "notifications"],
    [navTrash, "trash"],
    [navSettings, "settings"]
  ];
  for (const [button, name] of navPairs) {
    if (!button) continue;
    const selected = active === name;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected || active === "blank" ? 0 : -1;
  }
  if (viewBlank) viewBlank.hidden = active !== "blank";
  if (viewChats) viewChats.hidden = active !== "chats";
  if (viewSearch) viewSearch.hidden = active !== "search";
  if (viewNotifications) viewNotifications.hidden = active !== "notifications";
  if (viewTrash) viewTrash.hidden = active !== "trash";
  if (viewSettings) viewSettings.hidden = active !== "settings";
  if (latestState) {
    // Re-render so per-layer unread dots (nav badge, project rows) reflect the
    // view we just entered/left instead of the previous view's state.
    renderState(latestState);
    if (active === "search") renderSearch();
    if (active === "notifications") renderNotifications();
    if (active === "trash") renderTrash();
  }
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    return response.ok ? response.json() : {};
  } catch {
    return {};
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function setStatus(kind) {
  if (!statusBadge) return;
  const k = STATUS_LABELS[kind] ? kind : "error";
  statusBadge.className = `status-badge is-${k}`;
  statusBadge.textContent = STATUS_LABELS[k];
}

function notify(message) {
  actionHint.textContent = message;
}

function showToast(message, options = {}) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "app-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.querySelector(".app-shell")?.append(toastEl);
  }
  toastEl.classList.toggle("is-copy", Boolean(options.copy));
  toastEl.classList.remove("is-anchored");
  toastEl.style.removeProperty("--toast-left");
  toastEl.style.removeProperty("--toast-top");
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (options.anchor?.getBoundingClientRect) {
    const rect = options.anchor.getBoundingClientRect();
    const left = rect.left + rect.width / 2;
    const top = Math.max(8, rect.top - toastEl.offsetHeight - 8);
    toastEl.style.setProperty("--toast-left", `${left}px`);
    toastEl.style.setProperty("--toast-top", `${top}px`);
    toastEl.classList.add("is-anchored");
  }
  toastEl.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl?.classList.remove("is-visible");
  }, options.durationMs || 1800);
}

function queueNoticeContainer() {
  if (queueNoticeEl) return queueNoticeEl;
  queueNoticeEl = document.createElement("div");
  queueNoticeEl.className = "queue-notice";
  queueNoticeEl.hidden = true;
  queueNoticeEl.setAttribute("role", "status");
  queueNoticeEl.setAttribute("aria-live", "polite");
  document.querySelector(".app-shell")?.append(queueNoticeEl);
  return queueNoticeEl;
}

function returnNoticeContainer() {
  if (returnNoticeEl) return returnNoticeEl;
  returnNoticeEl = document.createElement("div");
  returnNoticeEl.className = "queue-notice return-notice";
  returnNoticeEl.hidden = true;
  returnNoticeEl.setAttribute("role", "status");
  returnNoticeEl.setAttribute("aria-live", "polite");
  document.querySelector(".app-shell")?.append(returnNoticeEl);
  return returnNoticeEl;
}

function isAppActiveSurface() {
  return document.visibilityState !== "hidden" && document.hasFocus();
}

async function ensureNotifyPermission() {
  try {
    let granted = await notification.isPermissionGranted();
    if (!granted) granted = (await notification.requestPermission()) === "granted";
    return granted;
  } catch {
    return false;
  }
}

async function maybeNotify(item, settings) {
  if (!isTauri || !settings?.notifyOnNewReply || isAppActiveSurface()) return;
  try {
    if (!(await ensureNotifyPermission())) return;
    notification.sendNotification({
      title: `Agent Hotline: ${item.sessionName || item.sourceApp}`,
      body: String(item.speakableText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
    });
  } catch {}
}

function speakableItems(queue) {
  const items = Array.isArray(queue.items) ? queue.items : [];
  return items.filter((item) => item.speakableText && item.speakableText.trim() && !item.trashedAt);
}

function trashedSpeakableItems(queue) {
  const items = Array.isArray(queue.items) ? queue.items : [];
  return items.filter((item) => item.speakableText && item.speakableText.trim() && item.trashedAt);
}

function findSelected(items) {
  return items.find((item) => item.id === selectedItemId) || null;
}

function sessionScopedItems(items, anchorId) {
  const anchor = items.find((item) => item.id === anchorId);
  if (!anchor) return items;
  const projectKey = projectKeyOf(anchor);
  const sessionKey = sessionKeyOf(anchor);
  return items.filter(
    (item) => projectKeyOf(item) === projectKey && sessionKeyOf(item) === sessionKey
  );
}

function playbackActive() {
  return Boolean(playback && (playback.isSpeaking || playback.isPaused || playback.isLoading));
}

const STARTUP_MIN_MS = 2100;
const STARTUP_SPLASH_MAX_MS = 9000;
const STARTUP_AUDIO_SURFACE_WAIT_MS = 1500;
let startupJingleAudio = null;
let startupJinglePlayStarted = false;
let startupJingleFallbackArmed = false;

function startupSettingsHint(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    startupJingle: typeof source.startupJingle === "boolean" ? source.startupJingle : true,
    mute: source.mute === true,
    volume: Number.isFinite(source.volume) ? Math.min(1, Math.max(0, source.volume)) : 1,
    audioOutputDeviceId:
      typeof source.audioOutputDeviceId === "string" ? source.audioOutputDeviceId : ""
  };
}

function loadStartupSettingsHint() {
  try {
    return startupSettingsHint(
      JSON.parse(window.localStorage.getItem(STARTUP_SETTINGS_STORAGE_KEY) || "{}")
    );
  } catch {
    return startupSettingsHint();
  }
}

function cacheStartupSettingsHint(settings) {
  try {
    window.localStorage.setItem(
      STARTUP_SETTINGS_STORAGE_KEY,
      JSON.stringify(startupSettingsHint(settings))
    );
  } catch {}
}

function revealAppShell() {
  document.querySelector(".app-shell")?.removeAttribute("hidden");
}

function hideStartupSplash(splash) {
  if (!splash || splash.dataset.hiding) return;
  revealAppShell();
  splash.dataset.hiding = "1";
  splash.classList.add("is-hiding");
  splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  window.setTimeout(() => splash.remove(), 600);
}

function startupAudioSurfaceReady() {
  if (!isTauri) return true;
  return document.visibilityState !== "hidden" && document.hasFocus();
}

async function waitForStartupAudioSurface() {
  if (startupAudioSurfaceReady()) return;

  await new Promise((resolve) => {
    let timeoutId = 0;
    const finish = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("focus", onReady);
      window.removeEventListener("pageshow", onReady);
      document.removeEventListener("visibilitychange", onReady);
      resolve();
    };
    const onReady = () => {
      if (startupAudioSurfaceReady()) finish();
    };

    window.addEventListener("focus", onReady);
    window.addEventListener("pageshow", onReady);
    document.addEventListener("visibilitychange", onReady);
    timeoutId = window.setTimeout(finish, STARTUP_AUDIO_SURFACE_WAIT_MS);
  });
}

async function applyStartupAudioSettings(audio, settings) {
  audio.volume = Number.isFinite(settings.volume) ? Math.min(1, Math.max(0, settings.volume)) : 1;

  const sinkId = String(settings.audioOutputDeviceId || "");
  if (sinkId && typeof audio.setSinkId === "function") {
    await audio.setSinkId(sinkId).catch(() => {});
  }
}

function ensureStartupJingleAudio() {
  if (!startupJingleAudio) {
    startupJingleAudio = new Audio("/hotline-bling.mp3");
    startupJingleAudio.preload = "auto";
  }
  return startupJingleAudio;
}

function stopStartupJingle() {
  if (!startupJingleAudio) return;
  startupJingleAudio.pause();
  startupJingleAudio.currentTime = 0;
}

function armStartupJingleFallback() {
  if (startupJingleFallbackArmed) return;
  startupJingleFallbackArmed = true;
  const playOnce = () => {
    window.removeEventListener("pointerdown", playOnce);
    window.removeEventListener("keydown", playOnce);
    startupJingleAudio?.play().catch(() => {});
  };
  window.addEventListener("pointerdown", playOnce, { once: true });
  window.addEventListener("keydown", playOnce, { once: true });
}

function startStartupJingle(settings = loadStartupSettingsHint()) {
  const hint = startupSettingsHint(settings);
  if (hint.startupJingle === false || hint.mute) return;
  if (startupJinglePlayStarted) return;
  startupJinglePlayStarted = true;
  const audio = ensureStartupJingleAudio();
  audio.volume = hint.volume;
  try {
    const result = audio.play();
    if (result?.catch) result.catch(() => armStartupJingleFallback());
  } catch {
    armStartupJingleFallback();
  }
}

async function finalizeStartupJingle(settings) {
  cacheStartupSettingsHint(settings);
  if (settings.startupJingle === false || settings.mute) {
    stopStartupJingle();
    return;
  }

  await waitForStartupAudioSurface();
  const audio = ensureStartupJingleAudio();
  await applyStartupAudioSettings(audio, settings);
  startStartupJingle();
}

async function runStartupExperience() {
  startStartupJingle();
  const splash = document.getElementById("startup-splash");
  if (splash) splash.hidden = false;
  const startedAt = Date.now();

  let settings = {};
  try {
    const data = await fetchJson(`${targetUrl}/api/settings`);
    settings = data?.settings || {};
    cacheStartupSettingsHint(settings);
  } catch {}

  const keepSplash = Boolean(splash) && settings.startupSplash !== false;
  if (splash && !keepSplash) {
    revealAppShell();
    splash.remove();
  }

  await finalizeStartupJingle(settings);

  await refreshPanel(targetUrl).catch(() => {});
  if (!keepSplash) {
    revealAppShell();
    return;
  }
  const remaining = Math.max(0, STARTUP_MIN_MS - (Date.now() - startedAt));
  window.setTimeout(() => hideStartupSplash(splash), remaining);
  window.setTimeout(() => hideStartupSplash(splash), STARTUP_SPLASH_MAX_MS);
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  if (isSameDay(date, now)) return time;
  // Older than today: prefix the date so "11pm yesterday" never reads as now.
  // Drop the year while it matches the current year to keep the stamp short.
  const dateOpts =
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return `${date.toLocaleDateString([], dateOpts)}, ${time}`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Clock for the seek bar: speech-time seconds (base 1x timeline), so it never
// rescales with playback speed. M:SS, e.g. 0:03 / 1:12.
function formatClock(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function threadLabel(item) {
  if (item.sessionName) return item.sessionName;
  if (item.threadLabel) return item.threadLabel;
  if (item.threadId) return `${item.sourceApp}  -  ${item.threadId.slice(0, 8)}`;
  return `${item.sourceApp}  -  direct`;
}

function sessionTitleParts(session) {
  const title = session?.parts?.title || session?.label || "Messages";
  const id = session?.parts?.id || "";
  return { title, id };
}

function itemSessionTitleParts(item) {
  const title = item?.sessionName || item?.sourceApp || "Direct";
  const id = item?.threadId ? item.threadId.slice(0, 8) : "direct";
  return { title, id };
}

function appendSessionTitleParts(parent, { title, id }, { header = false } = {}) {
  const titleEl = document.createElement("span");
  titleEl.className = "session-title-text";
  titleEl.textContent = title;
  parent.append(titleEl);
  if (id) {
    const idEl = document.createElement("span");
    idEl.className = header ? "session-title-id is-header" : "session-title-id";
    idEl.textContent = id;
    parent.append(idEl);
  }
}

function appendSessionTitle(parent, session, options = {}) {
  appendSessionTitleParts(parent, sessionTitleParts(session), options);
}

function deriveStatus(settings, playerState, selected) {
  if (settings.mute) return "muted";
  if (playerState === "loading") return "loading";
  if (playerState === "paused") return "paused";
  if (playerState === "speaking") return "speaking";
  if (Array.isArray(latestState?.queue?.pending) && latestState.queue.pending.length > 0) {
    return "pending";
  }
  if (selected?.status === "skipped") return "skipped";
  return "idle";
}

function renderNowCard(selected, statusKind = selected?.status || "idle") {
  if (!selected) {
    sourceApp.className = `owner-badge ${OWNER_CLASS.Unknown}`;
    sourceApp.textContent = "None";
    itemTime.textContent = "";
    itemTime.className = "now-time";
    itemStatus.textContent = "none";
    itemStatus.className = "now-status is-idle";
    previewText.textContent = "No speakable text yet.";
    previewMeta.className = "now-meta";
    previewMeta.textContent = "Waiting for Codex or Claude output.";
    previewText.style.removeProperty("--owner-color");
    nowBar?.style.removeProperty("--owner-color");
    nowBar?.style.removeProperty("--owner-chip-text");
    delete previewText.dataset.itemId;
    return;
  }
  sourceApp.className = `owner-badge ${OWNER_CLASS[selected.sourceApp] || OWNER_CLASS.Unknown}`;
  sourceApp.textContent = selected.sourceApp;
  itemTime.textContent = formatTime(selected.timestamps?.createdAt);
  itemTime.className = "now-time has-value";
  itemStatus.textContent = STATUS_LABELS[statusKind] || selected.status || "Idle";
  itemStatus.className = `now-status is-${statusKind}`;
  const ownerColor = ownerSolidColor(selected.sourceApp);
  previewText.style.setProperty("--owner-color", ownerColor);
  nowBar?.style.setProperty("--owner-color", ownerColor);
  nowBar?.style.setProperty("--owner-chip-text", ownerChipTextColor(selected.sourceApp));
  // Keep the active text nodes stable while progress highlighting is mounted.
  const liveHighlight =
    previewText.dataset.itemId === selected.id && previewText.querySelector(".spoken-cursor");
  if (!liveHighlight) {
    previewText.dataset.itemId = selected.id;
    previewText.textContent = selected.speakableText;
  }
  previewMeta.className = "now-meta session-title now-session-title";
  previewMeta.replaceChildren();
  appendSessionTitleParts(previewMeta, itemSessionTitleParts(selected));
  if (selected.replayOf) {
    const replay = document.createElement("span");
    replay.className = "h-badge";
    replay.textContent = "Replay";
    previewMeta.append(replay);
  }
}

// History groups newest-first through the shared grouper in grouping.js.
function buildProjects(items) {
  return applyOrdering(groupByProjectSession(items, { sortBy: "recent", dropUnnamed: true }));
}

// A small muted timestamp that sits outside the bubble, aligned to its side
// (WhatsApp/Instagram style). `extras` are inline nodes shown before the time.
function buildTimeOut(createdAt, extras = []) {
  const time = document.createElement("span");
  time.className = "bubble-time-out";
  time.append(...extras);
  const stamp = document.createElement("span");
  stamp.textContent = formatTime(createdAt);
  time.append(stamp);
  return time;
}

// The WhatsApp-style tail that flows out of a bubble's top corner. Purely
// decorative (CSS draws and carves it), so it is aria-hidden.
function buildBubbleTail() {
  const tail = document.createElement("span");
  tail.className = "bubble-tail";
  tail.setAttribute("aria-hidden", "true");
  return tail;
}

function showCopyToast(anchor) {
  showToast("Copied", {
    anchor,
    copy: true,
    durationMs: COPY_TOAST_DURATION_MS
  });
}

async function copyMessageText(text, anchor) {
  const value = String(text || "");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showCopyToast(anchor);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showCopyToast(anchor);
  }
}

function copyButton(text, side) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `bubble-copy is-${side}`;
  button.title = "Copy message";
  button.setAttribute("aria-label", "Copy message");
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2zm2 0h4a2 2 0 0 1 2 2v6h2V5h-8v2zM6 9v10h8V9H6z"/></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    copyMessageText(text, event.currentTarget);
  });
  return button;
}

function closeMessageMenu() {
  document.querySelector(".message-menu")?.remove();
}

function closeSessionMenu() {
  document.querySelector(".session-menu")?.remove();
  closeColorMenu();
}

function resolveConfirm(value) {
  if (!pendingConfirm) return;
  const { resolve } = pendingConfirm;
  pendingConfirm = null;
  if (confirmModal) confirmModal.hidden = true;
  resolve(value);
}

function askConfirm({
  title = "Confirm action",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel"
}) {
  if (!confirmModal || !confirmTitle || !confirmMessage || !confirmOk || !confirmCancel) {
    return Promise.resolve(window.confirm(message));
  }
  if (pendingConfirm) resolveConfirm(false);
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmOk.textContent = confirmText;
  confirmCancel.textContent = cancelText;
  confirmModal.hidden = false;
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
  });
}

function openMessageMenu(event, text) {
  closeMessageMenu();
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "message-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy message";
  copy.addEventListener("click", async (clickEvent) => {
    await copyMessageText(
      text,
      clickEvent.currentTarget.closest(".message-menu") || clickEvent.currentTarget
    );
    closeMessageMenu();
  });
  menu.append(copy);
  document.body.append(menu);
}

function openSession(project, session) {
  if (historyView.sessionKey !== session.key) leaveOpenSession();
  historyView.projectKey = project.key;
  historyView.sessionKey = session.key;
  setView("chats");
  renderState(latestState);
}

function openMessageById(itemId, { markRead = true, dismissReturnNotice = true } = {}) {
  const item = speakableItems(latestState?.queue || {}).find((entry) => entry.id === itemId);
  if (!item) return false;
  selectedItemId = item.id;
  historyView = {
    level: "messages",
    projectKey: projectKeyOf(item),
    sessionKey: sessionKeyOf(item)
  };
  searchHighlightItemId = item.id;
  setView("chats");
  if (markRead) markItemRead(item.id, { render: false });
  if (dismissReturnNotice) dismissReturnNoticeToast();
  renderState(latestState);
  return true;
}

function sessionDateRange(session) {
  const times = session.items
    .map((item) => item.timestamps?.createdAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  if (times.length === 0) return { first: "", last: "" };
  return {
    first: new Date(Math.min(...times)).toISOString(),
    last: new Date(Math.max(...times)).toISOString()
  };
}

function statusCounts(session) {
  const counts = new Map();
  for (const item of session.items) {
    const status = item.status || "unknown";
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}: ${count}`).join(", ");
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function detailsRow(label, value) {
  const row = document.createElement("div");
  row.className = "details-row";
  const term = document.createElement("dt");
  term.textContent = label;
  const desc = document.createElement("dd");
  desc.textContent = value || "-";
  row.append(term, desc);
  return row;
}

function detailsStat(label, value, hint = "") {
  const stat = document.createElement("div");
  stat.className = "details-stat";
  const number = document.createElement("strong");
  number.textContent = value || "-";
  const caption = document.createElement("span");
  caption.textContent = label;
  stat.append(number, caption);
  if (hint) {
    const note = document.createElement("small");
    note.textContent = hint;
    stat.append(note);
  }
  return stat;
}

function detailsSection(title, ...rows) {
  const section = document.createElement("section");
  section.className = "details-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("dl");
  list.className = "details-list";
  list.append(...rows);
  section.append(heading, list);
  return section;
}

function detailsIdGroup(label, values) {
  const clean = uniqueValues(values);
  const group = document.createElement("details");
  group.className = "details-id-group";

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = label;
  const count = document.createElement("span");
  count.className = "details-id-count";
  count.textContent = `${clean.length} ${clean.length === 1 ? "value" : "values"}`;
  summary.append(title, count);
  group.append(summary);

  const list = document.createElement("ol");
  list.className = "details-id-list";
  if (clean.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "-";
    list.append(empty);
  } else {
    for (const value of clean) {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = value;
      item.append(code);
      list.append(item);
    }
  }
  group.append(list);
  return group;
}

function audioDetailsText(audio) {
  if (!audio) return "Unavailable";
  return `${formatBytes(audio.bytes)} across ${audio.count} recording${audio.count === 1 ? "" : "s"}`;
}

async function cacheSummaryFor({ projectKey, sessionKey } = {}) {
  try {
    const data = await listCache(targetUrl);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const matching = entries.filter((entry) => {
      if (sessionKey) return entry.sessionKey === sessionKey;
      if (projectKey) return entry.projectKey === projectKey;
      return false;
    });
    return {
      count: matching.length,
      bytes: matching.reduce((total, entry) => total + (Number(entry.bytes) || 0), 0)
    };
  } catch {
    return null;
  }
}

async function openSessionDetails(project, session) {
  closeSessionMenu();
  if (!sessionDetailsModal || !sessionDetailsBody) return;
  const { first, last } = sessionDateRange(session);
  const title = session.parts?.title || session.label || "Session";
  const threadIds = uniqueValues(session.items.map((item) => item.threadId));
  const sessionNames = uniqueValues(
    session.items.map((item) => item.sessionName || item.threadLabel)
  );
  const sourceApps = uniqueValues(session.items.map((item) => item.sourceApp));

  if (sessionDetailsOwner) {
    sessionDetailsOwner.hidden = false;
    sessionDetailsOwner.className = `owner-badge ${OWNER_CLASS[session.owner] || "owner-unknown"}`;
    sessionDetailsOwner.textContent = session.owner || "Unknown";
    sessionDetailsOwner.title = session.owner || "Unknown harness";
  }
  if (sessionDetailsTitle) sessionDetailsTitle.textContent = title;
  const audio = await cacheSummaryFor({ sessionKey: session.key });

  const shell = document.createElement("div");
  shell.className = "details-shell";
  const overview = document.createElement("div");
  overview.className = "details-overview";
  overview.append(
    detailsStat("Messages", String(session.items.length)),
    detailsStat(
      "Saved audio",
      audio ? formatBytes(audio.bytes) : "-",
      audio ? `${audio.count} files` : ""
    ),
    detailsStat("Started", formatTime(first)),
    detailsStat("Last", formatTime(last))
  );

  const ids = document.createElement("section");
  ids.className = "details-section details-id-section";
  const idsTitle = document.createElement("h3");
  idsTitle.textContent = "Identifiers";
  ids.append(
    idsTitle,
    detailsIdGroup("Session keys", [session.key]),
    detailsIdGroup("Session IDs", threadIds.length ? threadIds : [session.parts?.id || "direct"]),
    detailsIdGroup("Project keys", [project.key])
  );

  shell.append(
    overview,
    detailsSection(
      "Identity",
      detailsRow("Display name", session.label),
      detailsRow("Full session name", sessionNames.join(", ") || title),
      detailsRow("Project", project.label),
      detailsRow("Harness", sourceApps.join(", ") || session.owner)
    ),
    detailsSection(
      "Activity",
      detailsRow("First message", formatDateTime(first)),
      detailsRow("Last message", formatDateTime(last)),
      detailsRow("Statuses", statusCounts(session)),
      detailsRow("Saved audio", audioDetailsText(audio))
    ),
    ids
  );
  sessionDetailsBody.replaceChildren(shell);
  sessionDetailsModal.hidden = false;
}

async function openProjectDetails(project) {
  closeSessionMenu();
  if (!sessionDetailsModal || !sessionDetailsBody || !project) return;
  const times = project.items
    .map((item) => item.timestamps?.createdAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  const first = times.length ? new Date(Math.min(...times)).toISOString() : "";
  const last = times.length ? new Date(Math.max(...times)).toISOString() : "";
  const owners = uniqueValues(project.items.map((item) => item.sourceApp));
  const threadIds = uniqueValues(project.items.map((item) => item.threadId));

  if (sessionDetailsOwner) {
    sessionDetailsOwner.hidden = true;
  }
  if (sessionDetailsTitle) sessionDetailsTitle.textContent = project.label || "Project";
  const audio = await cacheSummaryFor({ projectKey: project.key });

  const shell = document.createElement("div");
  shell.className = "details-shell";
  const overview = document.createElement("div");
  overview.className = "details-overview";
  overview.append(
    detailsStat("Sessions", String(project.sessions.length)),
    detailsStat("Messages", String(project.items.length)),
    detailsStat(
      "Saved audio",
      audio ? formatBytes(audio.bytes) : "-",
      audio ? `${audio.count} files` : ""
    ),
    detailsStat("Last", formatTime(last))
  );

  const ids = document.createElement("section");
  ids.className = "details-section details-id-section";
  const idsTitle = document.createElement("h3");
  idsTitle.textContent = "Identifiers";
  ids.append(
    idsTitle,
    detailsIdGroup("Project keys", [project.key]),
    detailsIdGroup("Session IDs", threadIds)
  );

  shell.append(
    overview,
    detailsSection(
      "Identity",
      detailsRow("Project", project.label),
      detailsRow("Harnesses", owners.join(", "))
    ),
    detailsSection(
      "Activity",
      detailsRow("First message", formatDateTime(first)),
      detailsRow("Last message", formatDateTime(last)),
      detailsRow("Saved audio", audioDetailsText(audio))
    ),
    ids
  );
  sessionDetailsBody.replaceChildren(shell);
  sessionDetailsModal.hidden = false;
}

function closeSessionDetails() {
  if (sessionDetailsModal) sessionDetailsModal.hidden = true;
}

function openSessionMenu(event, project, session, visibleSessionKeys = []) {
  event.preventDefault();
  closeMessageMenu();
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "message-menu session-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open session";
  open.addEventListener("click", () => {
    openSession(project, session);
    closeSessionMenu();
  });

  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Details";
  details.addEventListener("click", () => openSessionDetails(project, session));

  const sessionPinned = (orderingPrefs.pinnedSessionsByProject[project.key] || []).includes(
    session.key
  );
  const pin = document.createElement("button");
  pin.type = "button";
  pin.textContent = sessionPinned ? "Unpin session" : "Pin session";
  pin.addEventListener("click", () => {
    closeSessionMenu();
    const pinned = orderingPrefs.pinnedSessionsByProject[project.key] || [];
    orderingPrefs.pinnedSessionsByProject[project.key] = sessionPinned
      ? pinned.filter((key) => key !== session.key)
      : moveKeyToFront(pinned, session.key);
    if (!sessionPinned) {
      orderingPrefs.sessionOrderByProject[project.key] = uniqueOrdered(
        visibleSessionKeys.length
          ? visibleSessionKeys
          : [
              ...(orderingPrefs.sessionOrderByProject[project.key] || []),
              ...project.sessions.map((entry) => entry.key)
            ]
      );
    }
    persistOrderingPrefs();
    renderState(latestState);
  });

  const audio = document.createElement("button");
  audio.type = "button";
  audio.textContent = "Remove audio";
  audio.addEventListener("click", () => {
    closeSessionMenu();
    removeSessionAudio(session);
  });

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "is-danger";
  trash.textContent = "Move to trash";
  trash.addEventListener("click", () => {
    closeSessionMenu();
    trashQueueTarget({ sessionKey: session.key, itemIds: session.items.map((item) => item.id) });
  });

  menu.append(open, details, pin, audio, trash);
  document.body.append(menu);
}

function openProjectMenu(event, project, visibleProjectKeys = []) {
  event.preventDefault();
  closeMessageMenu();
  closeSessionMenu();
  closeColorMenu();
  const menu = document.createElement("div");
  menu.className = "message-menu session-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Details";
  details.addEventListener("click", () => openProjectDetails(project));

  const color = document.createElement("button");
  color.type = "button";
  color.textContent = "Change colour";
  color.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    closeSessionMenu();
    openColorMenu(clickEvent, project, () => renderState(latestState));
  });

  const projectPinned = orderingPrefs.pinnedProjects.includes(project.key);
  const pin = document.createElement("button");
  pin.type = "button";
  pin.textContent = projectPinned ? "Unpin project" : "Pin project";
  pin.addEventListener("click", () => {
    closeSessionMenu();
    orderingPrefs.pinnedProjects = projectPinned
      ? orderingPrefs.pinnedProjects.filter((key) => key !== project.key)
      : moveKeyToFront(orderingPrefs.pinnedProjects, project.key);
    if (!projectPinned)
      orderingPrefs.projectOrder = uniqueOrdered(
        visibleProjectKeys.length
          ? visibleProjectKeys
          : [...orderingPrefs.projectOrder, project.key]
      );
    persistOrderingPrefs();
    renderState(latestState);
  });

  const audio = document.createElement("button");
  audio.type = "button";
  audio.textContent = "Remove audio";
  audio.addEventListener("click", () => {
    closeSessionMenu();
    removeProjectAudio(project);
  });

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "is-danger";
  trash.textContent = "Move to trash";
  trash.addEventListener("click", () => {
    closeSessionMenu();
    trashQueueTarget({ projectKey: project.key, itemIds: project.items.map((item) => item.id) });
  });

  menu.append(details, color, pin, audio, trash);
  document.body.append(menu);
}

function openTrashRestoreMenu(event, actions) {
  event.preventDefault();
  event.stopPropagation();
  closeMessageMenu();
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "message-menu session-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  for (const action of actions) {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = action.text;
    restore.addEventListener("click", () => {
      closeSessionMenu();
      restoreQueueTarget(action.body, action.label);
    });
    menu.append(restore);
  }
  document.body.append(menu);
}

// A user prompt bubble (right side). Display-only: never read aloud. Clicking it
// expands the clamped body. No id/owner chrome -- it is the human half of the turn.
function searchMatchBadge() {
  const badge = document.createElement("span");
  badge.className = "search-match-badge";
  badge.textContent = "Search match";
  return badge;
}

function sessionFindTerms() {
  return String(sessionFindQuery || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function findTextRanges(text, terms) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      ranges.push({ start: index, end: index + term.length });
      index = lower.indexOf(term, index + Math.max(1, term.length));
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function sameFindTarget(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.itemId !== b.itemId) return false;
  return a.kind !== "prompt" || a.targetId === b.targetId;
}

function appendFindMarkedText(body, text, target, { record = true } = {}) {
  const terms = sessionFindTerms();
  const ranges = terms.length ? findTextRanges(text, terms) : [];
  if (ranges.length === 0) {
    body.textContent = text;
    return;
  }

  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) body.append(document.createTextNode(text.slice(cursor, range.start)));
    const index = sessionFindMatches.length;
    if (record) sessionFindMatches.push({ index, target });
    const mark = document.createElement("mark");
    mark.className = "session-find-mark";
    if (record) mark.dataset.findIndex = String(index);
    mark.textContent = text.slice(range.start, range.end);
    body.append(mark);
    cursor = range.end;
  }
  if (cursor < text.length) body.append(document.createTextNode(text.slice(cursor)));
}

function setBubbleBodyText(body, text, target, options = {}) {
  body.replaceChildren();
  appendFindMarkedText(body, String(text || ""), target, options);
}

function updateSessionFindControls() {
  if (sessionFindInput && sessionFindInput.value !== sessionFindQuery) {
    sessionFindInput.value = sessionFindQuery;
  }
  const total = sessionFindMatches.length;
  if (sessionFindCount) {
    sessionFindCount.textContent = total ? `${sessionFindActiveIndex + 1}/${total}` : "0/0";
  }
  if (sessionFindPrev) sessionFindPrev.disabled = total === 0;
  if (sessionFindNext) sessionFindNext.disabled = total === 0;
}

function updateSessionFindActiveDom({ scroll = false } = {}) {
  const total = sessionFindMatches.length;
  if (sessionFindPreferredTarget && total > 0) {
    const preferredIndex = sessionFindMatches.findIndex((match) =>
      sameFindTarget(match.target, sessionFindPreferredTarget)
    );
    if (preferredIndex >= 0) sessionFindActiveIndex = preferredIndex;
    sessionFindPreferredTarget = null;
  }
  if (total === 0) {
    sessionFindActiveIndex = 0;
    updateSessionFindControls();
    return null;
  }
  sessionFindActiveIndex = Math.min(Math.max(0, sessionFindActiveIndex), total - 1);
  for (const mark of historyList.querySelectorAll(".session-find-mark.is-active")) {
    mark.classList.remove("is-active");
  }
  const active = historyList.querySelector(
    `.session-find-mark[data-find-index="${CSS.escape(String(sessionFindActiveIndex))}"]`
  );
  active?.classList.add("is-active");
  updateSessionFindControls();
  if (scroll && active) {
    const bubble = active.closest(".bubble");
    bubble?.classList.add("is-expanded");
    const historyRect = historyList.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    historyList.scrollTop = Math.max(
      0,
      historyList.scrollTop +
        activeRect.top -
        historyRect.top -
        historyList.clientHeight / 2 +
        activeRect.height / 2
    );
  }
  return active;
}

function moveSessionFind(delta) {
  if (sessionFindMatches.length === 0) return;
  sessionFindActiveIndex =
    (sessionFindActiveIndex + delta + sessionFindMatches.length) % sessionFindMatches.length;
  updateSessionFindActiveDom({ scroll: true });
}

function buildUserBubble(text, createdAt, options = {}) {
  const row = document.createElement("div");
  row.className = "convo-row is-user";

  const bubble = document.createElement("div");
  const classes = ["bubble", "bubble-user"];
  if (options.searchHighlight) classes.push("is-search-highlight", "is-expanded");
  bubble.className = classes.join(" ");
  if (options.searchTargetId) bubble.dataset.searchTargetId = options.searchTargetId;

  const body = document.createElement("div");
  body.className = "bubble-body";
  setBubbleBodyText(body, text, {
    kind: "prompt",
    itemId: options.itemId,
    targetId: options.searchTargetId
  });

  bubble.dataset.copyText = text;
  bubble.append(buildBubbleTail(), copyButton(text, "left"));
  if (options.searchHighlight) bubble.append(searchMatchBadge());
  bubble.append(body);
  row.append(bubble);
  if (createdAt) row.append(buildTimeOut(createdAt));
  return row;
}

// An assistant (spoken) bubble (left side). The harness identity lives once in
// the column header, so the bubble itself just carries an inline play button +
// the text; the timestamp sits outside, below the bubble.
function buildAssistantBubble(item) {
  const row = document.createElement("div");
  row.className = "convo-row is-assistant";
  row.style.setProperty("--owner-color", ownerSolidColor(item.sourceApp));

  const bubble = document.createElement("div");
  const classes = ["bubble", "bubble-assistant"];
  if (item.id === selectedItemId) classes.push("is-selected");
  if (item.id === selectedItemId && highlightSurface === "inline") classes.push("is-expanded");
  if (item.id === searchHighlightItemId) classes.push("is-search-highlight", "is-expanded");
  if (isUnread(item)) classes.push("is-unread");
  bubble.className = classes.join(" ");
  bubble.dataset.id = item.id;
  const play = document.createElement("button");
  play.type = "button";
  play.className = "bubble-play";
  play.addEventListener("click", (event) => {
    event.stopPropagation();
    handleBubblePlay(item.id, bubble);
  });
  updateBubblePlayButton(play, item);

  const body = document.createElement("div");
  body.className = "bubble-body";
  setBubbleBodyText(body, item.speakableText, { kind: "reply", itemId: item.id });

  bubble.dataset.copyText = item.speakableText;
  bubble.append(buildBubbleTail(), play);
  if (item.id === searchHighlightItemId) bubble.append(searchMatchBadge());
  bubble.append(body, copyButton(item.speakableText, "right"), buildNowPlayingIcon());
  row.append(bubble);

  const extras = [];
  if (item.replayOf) {
    const badge = document.createElement("span");
    badge.className = "h-badge";
    badge.textContent = "Replay";
    extras.push(badge);
  }
  if (isUnread(item)) extras.push(unreadDot(1));
  row.append(buildTimeOut(item.timestamps?.createdAt, extras));
  return row;
}

function buildTrashAssistantBubble(item, session) {
  const row = document.createElement("div");
  row.className = "convo-row is-assistant is-trash";
  row.style.setProperty("--owner-color", ownerSolidColor(item.sourceApp));

  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-assistant bubble-trash-audio";
  bubble.dataset.id = item.id;

  const deleted = document.createElement("span");
  deleted.className = "trash-audio-deleted";
  deleted.title = "Restore this session to regenerate and play audio.";
  deleted.textContent = "Audio deleted";

  const body = document.createElement("div");
  body.className = "bubble-body";
  setBubbleBodyText(
    body,
    item.speakableText,
    { kind: "reply", itemId: item.id },
    { record: false }
  );

  bubble.dataset.copyText = item.speakableText;
  bubble.append(buildBubbleTail(), deleted, body, copyButton(item.speakableText, "right"));
  row.oncontextmenu = (event) =>
    openTrashRestoreMenu(event, [
      { text: "Restore message", label: "this message", body: { itemIds: [item.id] } },
      {
        text: "Restore session",
        label: session.label,
        body: { itemIds: session.items.map((entry) => entry.id) }
      }
    ]);
  bubble.oncontextmenu = row.oncontextmenu;
  row.append(bubble);
  row.append(buildTimeOut(item.timestamps?.createdAt));
  return row;
}

function buildNowPlayingIcon() {
  const icon = document.createElement("span");
  icon.className = "now-playing-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICON_SPEAKER;
  return icon;
}

function buildPinnedIcon(label) {
  const icon = document.createElement("span");
  icon.className = "pinned-icon";
  icon.title = label;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICON_PIN;
  return icon;
}

function nowPlayingItem(items = speakableItems(latestState?.queue || {})) {
  if (!playback) return null;
  if (!playback.isSpeaking && !playback.isLoading && !playback.isPaused) return null;
  const id = playback.activeItemId;
  if (!id) return null;
  return items.find((item) => item.id === id) || null;
}

function updateNowPlayingIndicators() {
  const item = nowPlayingItem();
  const projectKey = item ? projectKeyOf(item) : null;
  const sessionKey = item ? sessionKeyOf(item) : null;
  const ownerColor = item ? ownerSolidColor(item.sourceApp) : null;
  const paused = Boolean(item && playback?.isPaused);
  const paintIcon = (el, on) => {
    const icon = el.querySelector(".now-playing-icon");
    if (icon) icon.style.color = on ? ownerColor : "";
  };
  for (const btn of projectsList.querySelectorAll(".tree-item")) {
    const on = Boolean(projectKey) && btn.dataset.project === projectKey;
    btn.classList.toggle("is-playing", on);
    btn.classList.toggle("is-paused", on && paused);
    paintIcon(btn, on);
  }
  for (const btn of sessionsList.querySelectorAll(".tree-item")) {
    const on = Boolean(sessionKey) && btn.dataset.session === sessionKey;
    btn.classList.toggle("is-playing", on);
    btn.classList.toggle("is-paused", on && paused);
    paintIcon(btn, on);
  }
  for (const bubble of historyList.querySelectorAll(".bubble-assistant")) {
    const on = Boolean(item) && bubble.dataset.id === item.id;
    bubble.classList.toggle("is-playing", on);
    bubble.classList.toggle("is-paused", on && paused);
  }
}

function activateInlineSurfaceForOpenPlayback(session) {
  const item = nowPlayingItem();
  if (!session || !item) return false;
  if (!session.items.some((entry) => entry.id === item.id)) return false;
  selectedItemId = item.id;
  if (!isModalOpen()) highlightSurface = "inline";
  return highlightSurface === "inline";
}

function isActivePlaybackItem(item) {
  return Boolean(item?.id && playback?.activeItemId === item.id);
}

function isInlinePlaybackItem(item) {
  return Boolean(
    item?.id &&
    item.id === selectedItemId &&
    highlightSurface === "inline" &&
    (playback?.isLoading || playback?.isSpeaking || playback?.isPaused)
  );
}

function setPlaybackButtonIcon(button, { loading = false, speaking = false } = {}) {
  const iconState = loading ? "loading" : speaking ? "pause" : "play";
  if (button.dataset.iconState === iconState) return;
  button.dataset.iconState = iconState;
  button.innerHTML = loading ? ICON_SPINNER : speaking ? ICON_PAUSE : ICON_PLAY;
}

function updateBubblePlayButton(button, item) {
  const active = isActivePlaybackItem(item) || isInlinePlaybackItem(item);
  const loading = active && playback?.isLoading;
  const speaking = active && playback?.isSpeaking;
  const paused = active && playback?.isPaused;
  const label = loading
    ? "Generating speech..."
    : speaking
      ? "Pause"
      : paused
        ? "Resume"
        : "Read aloud";
  button.classList.toggle("is-loading", Boolean(loading));
  button.title = label;
  button.setAttribute("aria-label", label);
  setPlaybackButtonIcon(button, { loading, speaking });
}

function updateInlinePlaybackButtons() {
  const items = speakableItems(latestState?.queue || {});
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const button of historyList.querySelectorAll(".bubble-play")) {
    const bubble = button.closest(".bubble-assistant");
    const item = bubble ? byId.get(bubble.dataset.id) : null;
    if (item) updateBubblePlayButton(button, item);
  }
}

function handleBubblePlay(itemId, bubble) {
  const items = speakableItems(latestState?.queue || {});
  const item = items.find((entry) => entry.id === itemId);
  if (!item || !bubble) return;
  const activeInlineButton = isActivePlaybackItem(item) || isInlinePlaybackItem(item);
  if (activeInlineButton && playback.isLoading) return;
  if (activeInlineButton && playback.isSpeaking) return playback.pause();
  if (activeInlineButton && playback.isPaused) return playback.resume();

  selectedItemId = item.id;
  markItemRead(item.id, { render: false });
  for (const selectedBubble of historyList.querySelectorAll(".bubble-assistant.is-selected")) {
    selectedBubble.classList.remove("is-selected");
  }
  bubble.classList.add("is-selected", "is-expanded");
  bubble.classList.remove("is-unread");
  const body = bubble.querySelector(".bubble-body");
  if (body) {
    setBubbleBodyText(
      body,
      item.speakableText,
      { kind: "reply", itemId: item.id },
      { record: false }
    );
  }
  renderNowCard(item);
  updateControls(latestState.settings, items, item);
  playSelectedOn("inline");
}

// Mark bubbles whose body overflows the 2-line clamp so only those advertise the
// click-to-expand affordance. Run after the nodes are in the DOM (measurable).
function markClampedBubbles() {
  for (const bubble of historyList.querySelectorAll(".bubble")) {
    if (bubble.classList.contains("is-expanded")) continue;
    const body = bubble.querySelector(".bubble-body");
    if (!body) continue;
    bubble.classList.toggle("is-clamped", body.scrollHeight - body.clientHeight > 1);
  }
}

function menuButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button head-action menu-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  button.addEventListener("click", onClick);
  return button;
}

function openHeaderMenu(event, actions) {
  event.preventDefault();
  event.stopPropagation();
  closeMessageMenu();
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "message-menu session-menu header-menu";
  const rect = event.currentTarget.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 236)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = action.label;
    item.disabled = Boolean(action.disabled);
    if (action.danger) item.className = "is-danger";
    item.addEventListener("click", () => {
      closeSessionMenu();
      action.run();
    });
    menu.append(item);
  }
  document.body.append(menu);
}

function selectionCheckbox({ checked, label, onChange }) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "tree-select-check";
  checkbox.checked = checked;
  checkbox.setAttribute("aria-label", label);
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  return checkbox;
}

function setSelectionRowClick(row, onToggle) {
  row.classList.add("is-selecting");
  row.tabIndex = 0;
  row.addEventListener("click", (event) => {
    if (event.target.closest("button, input, a, select, textarea")) return;
    onToggle();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    onToggle();
  });
}

function reorderedKeys(keys, sourceKey, targetKey, placeAfter = false) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return keys;
  const next = keys.filter((key) => key !== sourceKey);
  const targetIndex = next.indexOf(targetKey);
  if (targetIndex === -1) return keys;
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceKey);
  return next;
}

function reorderTargetFromPointer(container, sourceKey, clientY, sourcePinned) {
  const rows = [...container.querySelectorAll(".tree-select-row.is-drag-enabled")].filter(
    (row) =>
      row.dataset.reorderKey &&
      row.dataset.reorderKey !== sourceKey &&
      row.dataset.reorderPinned === sourcePinned
  );
  if (rows.length === 0) return null;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { key: row.dataset.reorderKey, placeAfter: false };
    }
  }
  return { key: rows[rows.length - 1].dataset.reorderKey, placeAfter: true };
}

function clearReorderIndicators(container) {
  for (const row of container?.querySelectorAll(
    ".is-drop-before, .is-drop-after, .is-drop-target"
  ) || []) {
    row.classList.remove("is-drop-before", "is-drop-after", "is-drop-target");
  }
}

function pointerInElement(element, event) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function updateReorderIndicator(container, sourceKey, sourcePinned, event) {
  clearReorderIndicators(container);
  if (!pointerInElement(container, event)) return null;
  const target = reorderTargetFromPointer(container, sourceKey, event.clientY, sourcePinned);
  if (!target) return null;
  const row = [...container.querySelectorAll(".tree-select-row.is-drag-enabled")].find(
    (entry) => entry.dataset.reorderKey === target.key
  );
  row?.classList.add("is-drop-target", target.placeAfter ? "is-drop-after" : "is-drop-before");
  return target;
}

function setDragRow(row, key, visibleKeys, onOrder, options = {}) {
  row.classList.add("is-drag-enabled");
  row.dataset.reorderKey = key;
  row.dataset.reorderPinned = options.pinned ? "true" : "false";
  let dragTimer = null;
  let dragArmed = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let target = null;
  let suppressNextClick = false;

  const clearDragTimer = () => {
    if (!dragTimer) return;
    window.clearTimeout(dragTimer);
    dragTimer = null;
  };

  const resetDragState = () => {
    clearDragTimer();
    dragArmed = false;
    pointerId = null;
    row.classList.remove("is-dragging");
    clearReorderIndicators(row.parentElement);
  };

  row.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    target = null;
    dragTimer = window.setTimeout(() => {
      if (pointerId !== event.pointerId) return;
      dragArmed = true;
      row.setPointerCapture?.(event.pointerId);
      row.classList.add("is-dragging");
    }, 1000);
  });
  row.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    if (!dragArmed) return;
    const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
    if (distance > 3) moved = true;
    if (!moved) return;
    event.preventDefault();
    target = updateReorderIndicator(row.parentElement, key, row.dataset.reorderPinned, event);
  });
  row.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId) return;
    const wasDragArmed = dragArmed;
    if (wasDragArmed) row.releasePointerCapture?.(event.pointerId);
    resetDragState();
    if (!wasDragArmed) return;
    suppressNextClick = true;
    event.preventDefault();
    if (!moved) return;
    if (!target || !pointerInElement(row.parentElement, event)) return;
    const next = reorderedKeys(visibleKeys, key, target.key, target.placeAfter);
    onOrder(next);
  });
  row.addEventListener("pointercancel", (event) => {
    if (pointerId !== event.pointerId) return;
    if (dragArmed) row.releasePointerCapture?.(event.pointerId);
    resetDragState();
  });
  row.addEventListener(
    "click",
    (event) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  row.addEventListener("lostpointercapture", () => {
    resetDragState();
  });
}

function buildSelectionToolbar({ selectedCount, totalCount, selectAll, deselectAll, actions }) {
  const toolbar = document.createElement("div");
  toolbar.className = "session-selection-toolbar";

  const count = document.createElement("span");
  count.className = "selection-count";
  count.textContent = `${selectedCount} selected`;

  const selectAllButton = document.createElement("button");
  selectAllButton.type = "button";
  selectAllButton.className = "text-button head-action";
  selectAllButton.textContent = "Select all";
  selectAllButton.disabled = totalCount === 0 || selectedCount === totalCount;
  selectAllButton.onclick = selectAll;

  const deselectAllButton = document.createElement("button");
  deselectAllButton.type = "button";
  deselectAllButton.className = "text-button head-action";
  deselectAllButton.textContent = "Deselect all";
  deselectAllButton.disabled = selectedCount === 0;
  deselectAllButton.onclick = deselectAll;

  toolbar.append(count, selectAllButton, deselectAllButton, ...actions);
  return toolbar;
}

function resetProjectSelection() {
  projectSelectMode = false;
  selectedProjectKeys = new Set();
}

function finishProjectManageMode() {
  resetProjectSelection();
  renderState(latestState);
}

function selectedProjects(projects) {
  return projects.filter((project) => selectedProjectKeys.has(project.key));
}

function renderProjectsHeader() {
  if (!projectsTitle) return;
  const title = document.createElement("span");
  title.textContent = "Projects";
  if (projectSelectMode) {
    const done = document.createElement("button");
    done.type = "button";
    done.className = "text-button head-action";
    done.textContent = "Done";
    done.onclick = finishProjectManageMode;
    projectsTitle.replaceChildren(title, done);
    return;
  }
  projectsTitle.replaceChildren(
    title,
    menuButton("Project options", (event) =>
      openHeaderMenu(event, [
        {
          label: "Select items",
          run: () => {
            projectSelectMode = true;
            selectedProjectKeys = new Set();
            renderState(latestState);
          }
        },
        {
          label: "Sort by recent",
          run: () => {
            orderingPrefs.projectSort = "recent";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Sort A-Z",
          run: () => {
            orderingPrefs.projectSort = "name";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Manual order",
          run: () => {
            orderingPrefs.projectSort = "manual";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Reset pins",
          run: () => {
            orderingPrefs.pinnedProjects = [];
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Reset manual order",
          run: () => {
            orderingPrefs.projectOrder = [];
            if (orderingPrefs.projectSort === "manual") orderingPrefs.projectSort = "recent";
            persistOrderingPrefs();
            renderState(latestState);
          }
        }
      ])
    )
  );
}

function buildProjectSelectionToolbar(projects) {
  const selected = selectedProjects(projects);
  const removeAudio = document.createElement("button");
  removeAudio.type = "button";
  removeAudio.className = "text-button head-action";
  removeAudio.textContent = "Remove audio";
  removeAudio.disabled = selected.length === 0;
  removeAudio.onclick = async () => {
    const removed = await removeAudioForTarget(
      async () => {
        for (const project of selected) await deleteCacheProject(targetUrl, project.key);
      },
      `${selected.length} project${selected.length === 1 ? "" : "s"}`
    );
    if (!removed) return;
    resetProjectSelection();
    if (latestState) renderState(latestState);
  };

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "text-button danger head-action";
  trash.textContent = "Move to trash";
  trash.disabled = selected.length === 0;
  trash.onclick = async () => {
    const itemIds = selected.flatMap((project) => project.items.map((item) => item.id));
    await trashQueueTarget({ itemIds });
    resetProjectSelection();
    if (latestState) renderState(latestState);
  };

  return buildSelectionToolbar({
    selectedCount: selected.length,
    totalCount: projects.length,
    selectAll: () => {
      selectedProjectKeys = new Set(projects.map((project) => project.key));
      renderState(latestState);
    },
    deselectAll: () => {
      selectedProjectKeys = new Set();
      renderState(latestState);
    },
    actions: [removeAudio, trash]
  });
}

function renderProjectsList(projects) {
  renderProjectsHeader();
  const liveProjectKeys = new Set(projects.map((project) => project.key));
  for (const key of [...selectedProjectKeys]) {
    if (!liveProjectKeys.has(key)) selectedProjectKeys.delete(key);
  }
  projectsList.replaceChildren();
  if (projectSelectMode) {
    projectsList.append(buildProjectSelectionToolbar(projects));
  }
  const projectKeys = projects.map((project) => project.key);
  for (const project of projects) {
    const row = document.createElement("div");
    row.className = "tree-select-row";
    const toggleProject = () => {
      checkbox.checked = !checkbox.checked;
      if (checkbox.checked) selectedProjectKeys.add(project.key);
      else selectedProjectKeys.delete(project.key);
      renderState(latestState);
    };
    const checkbox = selectionCheckbox({
      checked: selectedProjectKeys.has(project.key),
      label: `Select ${project.label}`,
      onChange: (checked) => {
        if (checked) selectedProjectKeys.add(project.key);
        else selectedProjectKeys.delete(project.key);
        renderState(latestState);
      }
    });

    const btn = document.createElement("button");
    btn.className = `tree-item ${project.key === historyView.projectKey ? "is-selected" : ""}`;
    btn.dataset.project = project.key;
    applyProjectColor(btn, project);
    const titleRow = document.createElement("span");
    titleRow.className = "tree-item-head";
    const title = document.createElement("span");
    title.className = "tree-item-title";
    title.textContent = project.label;
    titleRow.append(title);
    const projectPinned = orderingPrefs.pinnedProjects.includes(project.key);
    if (projectPinned) {
      titleRow.append(buildPinnedIcon("Pinned project"));
    }
    titleRow.append(buildNowPlayingIcon());
    // Drilling into a project suppresses its own aggregate dot; the unread
    // signal moves down to the session rows now on screen.
    const projectOpen = currentView === "chats" && project.key === historyView.projectKey;
    const unread = projectOpen ? 0 : unreadCount(project.items);
    if (unread > 0) titleRow.append(unreadDot(unread));
    const count = project.sessions.length;
    const meta = document.createElement("span");
    meta.className = "tree-item-meta";
    meta.textContent = `${count} session${count === 1 ? "" : "s"} - ${formatTime(latestCreatedAt(project.items))}`;
    btn.append(titleRow, meta);
    btn.onclick = () => {
      if (projectSelectMode) {
        toggleProject();
        return;
      }
      leaveOpenSession();
      historyView.projectKey = project.key;
      historyView.sessionKey = null;
      renderState(latestState);
    };
    btn.oncontextmenu = (event) => openProjectMenu(event, project, projectKeys);
    if (projectSelectMode) {
      setSelectionRowClick(row, toggleProject);
      row.append(checkbox);
    }
    row.append(btn);
    if (!projectSelectMode) {
      setDragRow(
        row,
        project.key,
        projectKeys,
        (nextOrder) => {
          orderingPrefs.projectOrder = uniqueOrdered([
            ...nextOrder,
            ...orderingPrefs.projectOrder.filter((key) => !nextOrder.includes(key))
          ]);
          persistOrderingPrefs();
          renderState(latestState);
        },
        { pinned: projectPinned }
      );
    }
    projectsList.append(row);
  }
}

function resetSessionSelection() {
  sessionSelectMode = false;
  sessionSelectionProjectKey = null;
  selectedSessionKeys = new Set();
}

function finishSessionManageMode() {
  resetSessionSelection();
  renderState(latestState);
}

function selectedSessionsForProject(project) {
  if (!project) return [];
  return project.sessions.filter((session) => selectedSessionKeys.has(session.key));
}

function toggleSessionSelection(sessionKey, checked) {
  if (checked) selectedSessionKeys.add(sessionKey);
  else selectedSessionKeys.delete(sessionKey);
  renderState(latestState);
}

function renderSessionsHeader(project, projectTitle) {
  if (!projectTitle) return;
  const title = document.createElement("span");
  title.textContent = "Sessions";
  const managing = sessionSelectMode && sessionSelectionProjectKey === project.key;

  if (managing) {
    const done = document.createElement("button");
    done.type = "button";
    done.className = "text-button head-action";
    done.textContent = "Done";
    done.onclick = finishSessionManageMode;
    projectTitle.replaceChildren(title, done);
    return;
  }

  projectTitle.replaceChildren(
    title,
    menuButton("Session options", (event) =>
      openHeaderMenu(event, [
        {
          label: "Select items",
          run: () => {
            sessionSelectMode = true;
            sessionSelectionProjectKey = project.key;
            selectedSessionKeys = new Set();
            renderState(latestState);
          }
        },
        {
          label: "Sort by recent",
          run: () => {
            orderingPrefs.sessionSortByProject[project.key] = "recent";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Sort A-Z",
          run: () => {
            orderingPrefs.sessionSortByProject[project.key] = "name";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Manual order",
          run: () => {
            orderingPrefs.sessionSortByProject[project.key] = "manual";
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Reset pins",
          run: () => {
            orderingPrefs.pinnedSessionsByProject[project.key] = [];
            persistOrderingPrefs();
            renderState(latestState);
          }
        },
        {
          label: "Reset manual order",
          run: () => {
            orderingPrefs.sessionOrderByProject[project.key] = [];
            if (orderingPrefs.sessionSortByProject[project.key] === "manual") {
              orderingPrefs.sessionSortByProject[project.key] = "recent";
            }
            persistOrderingPrefs();
            renderState(latestState);
          }
        }
      ])
    )
  );
}

function buildSessionSelectionToolbar(project) {
  const selected = selectedSessionsForProject(project);
  const toolbar = document.createElement("div");
  toolbar.className = "session-selection-toolbar";

  const count = document.createElement("span");
  count.className = "selection-count";
  count.textContent = `${selected.length} selected`;

  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "text-button head-action";
  selectAll.textContent = "Select all";
  selectAll.onclick = () => {
    selectedSessionKeys = new Set(project.sessions.map((session) => session.key));
    renderState(latestState);
  };

  const deselectAll = document.createElement("button");
  deselectAll.type = "button";
  deselectAll.className = "text-button head-action";
  deselectAll.textContent = "Deselect all";
  deselectAll.disabled = selected.length === 0;
  deselectAll.onclick = () => {
    selectedSessionKeys = new Set();
    renderState(latestState);
  };

  const removeAudio = document.createElement("button");
  removeAudio.type = "button";
  removeAudio.className = "text-button head-action";
  removeAudio.textContent = "Remove audio";
  removeAudio.disabled = selected.length === 0;
  removeAudio.onclick = async () => {
    const removed = await removeAudioForTarget(
      async () => {
        for (const session of selected) await deleteCacheSession(targetUrl, session.key);
      },
      `${selected.length} session${selected.length === 1 ? "" : "s"}`
    );
    if (!removed) return;
    resetSessionSelection();
    if (latestState) renderState(latestState);
  };

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "text-button danger head-action";
  trash.textContent = "Move to trash";
  trash.disabled = selected.length === 0;
  trash.onclick = async () => {
    const itemIds = selected.flatMap((session) => session.items.map((item) => item.id));
    await trashQueueTarget({ itemIds });
    resetSessionSelection();
    if (latestState) renderState(latestState);
  };

  toolbar.append(count, selectAll, deselectAll, removeAudio, trash);
  return toolbar;
}

function renderSessionsList(project) {
  const projectTitle = el("current-project-title");
  if (!project) {
    sessionsPane.hidden = true;
    sessionsList.replaceChildren();
    resetSessionSelection();
    if (projectTitle) projectTitle.textContent = "Sessions";
    return;
  }
  if (sessionSelectionProjectKey && sessionSelectionProjectKey !== project.key) {
    resetSessionSelection();
  }
  sessionsPane.hidden = false;
  renderSessionsHeader(project, projectTitle);
  sessionsList.replaceChildren();
  if (sessionSelectMode && sessionSelectionProjectKey === project.key) {
    sessionsList.append(buildSessionSelectionToolbar(project));
  }
  const sessionKeys = project.sessions.map((session) => session.key);
  for (const session of project.sessions) {
    const row = document.createElement("div");
    row.className = "tree-select-row";
    const toggleSession = () => {
      checkbox.checked = !checkbox.checked;
      toggleSessionSelection(session.key, checkbox.checked);
    };
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tree-select-check";
    checkbox.checked = selectedSessionKeys.has(session.key);
    checkbox.hidden = !sessionSelectMode || sessionSelectionProjectKey !== project.key;
    checkbox.setAttribute("aria-label", `Select ${session.label}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () =>
      toggleSessionSelection(session.key, checkbox.checked)
    );

    const btn = document.createElement("button");
    btn.className = `tree-item ${session.key === historyView.sessionKey ? "is-selected" : ""}`;
    btn.dataset.session = session.key;
    applyOwnerColor(btn, session.owner);
    const titleRow = document.createElement("span");
    titleRow.className = "tree-item-head";
    const title = document.createElement("span");
    title.className = "tree-item-title session-title";
    appendSessionTitle(title, session);
    titleRow.append(ownerBadge(session.owner), title);
    const sessionPinned = (orderingPrefs.pinnedSessionsByProject[project.key] || []).includes(
      session.key
    );
    if (sessionPinned) {
      titleRow.append(buildPinnedIcon("Pinned session"));
    }
    titleRow.append(buildNowPlayingIcon());
    const unread = isSessionOpen(session) ? 0 : unreadCount(session.items);
    if (unread > 0) titleRow.append(unreadDot(unread));
    const meta = document.createElement("span");
    meta.className = "tree-item-meta";
    meta.textContent = `${session.items.length} msgs - ${formatTime(latestCreatedAt(session.items))}`;
    btn.append(titleRow, meta);
    btn.onclick = () => {
      if (sessionSelectMode && sessionSelectionProjectKey === project.key) {
        toggleSession();
        return;
      }
      openSession(project, session);
    };
    btn.oncontextmenu = (event) => openSessionMenu(event, project, session, sessionKeys);
    if (sessionSelectMode && sessionSelectionProjectKey === project.key) {
      setSelectionRowClick(row, toggleSession);
    }
    row.append(checkbox, btn);
    if (!sessionSelectMode || sessionSelectionProjectKey !== project.key) {
      setDragRow(
        row,
        session.key,
        sessionKeys,
        (nextOrder) => {
          const current = orderingPrefs.sessionOrderByProject[project.key] || [];
          orderingPrefs.sessionOrderByProject[project.key] = uniqueOrdered([
            ...nextOrder,
            ...current.filter((key) => !nextOrder.includes(key))
          ]);
          persistOrderingPrefs();
          renderState(latestState);
        },
        { pinned: sessionPinned }
      );
    }
    sessionsList.append(row);
  }
}

function renderMessagesDetail(session) {
  if (!session) {
    if (messagesPane) messagesPane.hidden = true;
    historyList.replaceChildren();
    sessionFindMatches = [];
    if (sessionFind) sessionFind.hidden = true;
    updateSessionFindControls();
    if (trashSessionButton) trashSessionButton.hidden = true;
    return;
  }
  sessionFindMatches = [];
  if (sessionFind) sessionFind.hidden = false;
  if (trashSessionButton) {
    trashSessionButton.hidden = false;
    trashSessionButton.onclick = () =>
      trashQueueTarget({ sessionKey: session.key, itemIds: session.items.map((item) => item.id) });
  }
  const inlinePlaybackVisible = activateInlineSurfaceForOpenPlayback(session);
  if (messagesPane) messagesPane.hidden = false;
  const st = el("current-session-title");
  if (st) {
    const chipText = ownerChipTextColor(session.owner);
    st.closest(".column-head")?.style.setProperty("--owner-chip-text", chipText);
    st.style.setProperty("--owner-chip-text", chipText);
    st.replaceChildren();
    appendSessionTitle(st, session, { header: true });
  }

  // Harness identity shows once at the top of the thread (chat-app style) rather
  // than on every bubble.
  const ownerChip = el("convo-owner");
  if (ownerChip) {
    ownerChip.hidden = false;
    ownerChip.className = `owner-badge ${OWNER_CLASS[session.owner] || "owner-unknown"}`;
    ownerChip.textContent = session.owner || "Unknown";
    ownerChip.title = session.owner || "Unknown harness";
  }

  // Chronological conversation: for each turn, the user's prompts (right) then the
  // assistant's spoken reply (left). Ascending so it reads top-to-bottom like chat.
  const fragment = document.createDocumentFragment();
  for (const item of session.items) {
    const prompts = Array.isArray(item.userMessages) ? item.userMessages : [];
    for (let index = 0; index < prompts.length; index += 1) {
      const prompt = prompts[index];
      const searchTargetId = `${item.id}:prompt:${index}`;
      fragment.append(
        buildUserBubble(prompt, item.timestamps?.createdAt, {
          itemId: item.id,
          searchTargetId,
          searchHighlight:
            searchHighlightPrompt?.itemId === item.id && searchHighlightPrompt?.prompt === prompt
        })
      );
    }
    fragment.append(buildAssistantBubble(item));
  }
  historyList.replaceChildren(fragment);
  markClampedBubbles();
  updateSessionFindActiveDom();
  if (searchHighlightPrompt) {
    const promptBubble = historyList.querySelector(
      `.bubble-user[data-search-target-id="${CSS.escape(searchHighlightPrompt.targetId)}"]`
    );
    if (promptBubble) {
      historyList.scrollTop = Math.max(
        0,
        promptBubble.offsetTop - historyList.clientHeight / 2 + promptBubble.clientHeight / 2
      );
      window.setTimeout(() => {
        if (searchHighlightPrompt?.targetId === promptBubble.dataset.searchTargetId) {
          promptBubble.classList.remove("is-search-highlight");
          promptBubble.querySelector(".search-match-badge")?.remove();
          searchHighlightPrompt = null;
        }
      }, 4200);
      updateSessionFindActiveDom({ scroll: true });
      return;
    }
  }
  if (searchHighlightItemId) {
    const bubble = historyList.querySelector(
      `.bubble-assistant[data-id="${CSS.escape(searchHighlightItemId)}"]`
    );
    if (bubble) {
      historyList.scrollTop = Math.max(
        0,
        bubble.offsetTop - historyList.clientHeight / 2 + bubble.clientHeight / 2
      );
      window.setTimeout(() => {
        if (searchHighlightItemId === bubble.dataset.id) {
          bubble.classList.remove("is-search-highlight");
          bubble.querySelector(".search-match-badge")?.remove();
          searchHighlightItemId = null;
        }
      }, 4200);
      updateSessionFindActiveDom({ scroll: true });
      return;
    }
  }
  if (inlinePlaybackVisible && selectedItemId) {
    const bubble = historyList.querySelector(
      `.bubble-assistant[data-id="${CSS.escape(selectedItemId)}"]`
    );
    if (bubble) {
      historyList.scrollTop = Math.max(
        0,
        bubble.offsetTop - historyList.clientHeight / 2 + bubble.clientHeight / 2
      );
      return;
    }
  }
  historyList.scrollTop = historyList.scrollHeight;
}

function setAllBubblesExpanded(expanded) {
  for (const bubble of historyList.querySelectorAll(".bubble")) {
    bubble.classList.toggle("is-expanded", expanded);
  }
  if (!expanded) markClampedBubbles();
}

// ---- Full-message modal ----------------------------------------------------
function isModalOpen() {
  return Boolean(msgModal && !msgModal.hidden);
}

function modalItem() {
  if (!latestState) return null;
  return findSelected(speakableItems(latestState.queue));
}

// Reset body text only when the displayed item changes, so progress highlighting
// can keep its DOM nodes between polling refreshes.
function updateModal() {
  if (!isModalOpen()) return;
  const item = modalItem();
  if (!item) {
    closeModal();
    return;
  }
  if (modalOwner) {
    modalOwner.className = `owner-badge ${OWNER_CLASS[item.sourceApp] || "owner-unknown"}`;
    modalOwner.textContent = item.sourceApp || "Unknown";
  }
  if (modalBody) modalBody.style.setProperty("--owner-color", ownerSolidColor(item.sourceApp));
  if (modalTime) modalTime.textContent = formatTime(item.timestamps?.createdAt);
  if (modalMeta) {
    modalMeta.textContent = item.replayOf ? "Replay of an earlier item." : threadLabel(item);
  }
  if (modalBody && modalBody.dataset.itemId !== item.id) {
    modalBody.dataset.itemId = item.id;
    modalBody.textContent = item.speakableText;
    modalBody.scrollTop = 0;
  }
  if (modalSpeed) {
    modalSpeed.textContent = `${parseFloat(Number(latestState?.settings?.rate || 1).toFixed(2))}x`;
  }
  if (modalPlay) {
    const speaking = playback?.isSpeaking;
    modalPlay.innerHTML = speaking ? ICON_PAUSE : ICON_PLAY;
    modalPlay.title = speaking ? "Pause" : "Read aloud";
  }
}

function closeModal() {
  if (msgModal) msgModal.hidden = true;
}

// Progressive cascade: projects always show; sessions appear only after a
// project is picked; messages appear only after a session is picked. Nothing
// is auto-selected, so the columns grow rightward as the user drills in.
function renderHistory(items) {
  const projects = buildProjects(items);
  renderProjectsList(projects);

  const project = historyView.projectKey
    ? projects.find((entry) => entry.key === historyView.projectKey)
    : null;
  if (historyView.projectKey && !project) {
    historyView.projectKey = null;
    historyView.sessionKey = null;
  }
  renderSessionsList(project);

  const session =
    project && historyView.sessionKey
      ? project.sessions.find((entry) => entry.key === historyView.sessionKey)
      : null;
  if (project && historyView.sessionKey && !session) {
    historyView.sessionKey = null;
  }
  renderMessagesDetail(session);
}

function dismissQueueNotice() {
  queueNotice = null;
  renderQueueNotice();
}

function jumpToQueueNotice(itemId) {
  openMessageById(itemId, { dismissReturnNotice: false });
  dismissQueueNotice();
}

function renderQueueNotice() {
  const container = queueNoticeContainer();
  if (!queueNotice) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  container.hidden = false;
  container.className = `queue-notice is-${queueNotice.prominence}`;

  const copy = document.createElement("div");
  copy.className = "queue-notice-copy";
  const title = document.createElement("strong");
  title.textContent =
    queueNotice.kind === "other-session" ? "Queued from another chat" : "Queued in this chat";
  const detail = document.createElement("span");
  detail.textContent = `${queueNotice.source} - ${queueNotice.project} - ${queueNotice.session}`;
  copy.append(title, detail);

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "queue-notice-action";
  jump.textContent = "Jump";
  jump.addEventListener("click", () => jumpToQueueNotice(queueNotice.itemId));

  const close = document.createElement("button");
  close.type = "button";
  close.className = "queue-notice-close";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  close.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  close.addEventListener("click", dismissQueueNotice);

  container.replaceChildren(copy, jump, close);
}

function dismissReturnNoticeToast() {
  backgroundArrivalIds = new Set();
  const container = returnNoticeContainer();
  container.hidden = true;
  container.replaceChildren();
}

function pruneBackgroundArrivals(items) {
  const liveUnreadIds = new Set(items.filter(isUnread).map((item) => item.id));
  backgroundArrivalIds = new Set([...backgroundArrivalIds].filter((id) => liveUnreadIds.has(id)));
}

function recordBackgroundArrivals(items) {
  if (isAppActiveSurface()) return;
  for (const item of items) {
    if (item?.id && isUnread(item)) backgroundArrivalIds.add(item.id);
  }
}

function latestBackgroundArrivalId(items) {
  return latestUnreadItemId(items, { unreadIds: backgroundArrivalIds });
}

function showReturnNoticeIfNeeded() {
  const items = speakableItems(latestState?.queue || {});
  pruneBackgroundArrivals(items);
  const targetId = latestBackgroundArrivalId(items);
  if (!targetId) return;

  const container = returnNoticeContainer();
  const count = backgroundArrivalIds.size;
  const target = items.find((item) => item.id === targetId);
  container.hidden = false;
  container.className = "queue-notice return-notice is-high";

  const copy = document.createElement("div");
  copy.className = "queue-notice-copy";
  const title = document.createElement("strong");
  title.textContent = count === 1 ? "You have a new message" : `You have ${count} new messages`;
  const detail = document.createElement("span");
  detail.textContent = target
    ? `${target.sourceApp || "Unknown"} - ${projectLabelOf(target)} - ${sessionLabelOf(target)}`
    : "Open the latest unread message.";
  copy.append(title, detail);

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "queue-notice-action";
  jump.textContent = "Open latest";
  jump.addEventListener("click", () => openMessageById(targetId));

  const close = document.createElement("button");
  close.type = "button";
  close.className = "queue-notice-close";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  close.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  close.addEventListener("click", dismissReturnNoticeToast);

  container.replaceChildren(copy, jump, close);
}

function notificationMeta(entry) {
  const time = formatTime(entry.createdAt);
  return `${entry.source} - ${entry.project} - ${entry.session}${time ? ` - ${time}` : ""}`;
}

function buildNotificationRow(entry) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `notification-item ${entry.unread ? "is-unread" : ""}`;
  btn.dataset.itemId = entry.id;
  btn.addEventListener("click", () => openMessageById(entry.id));

  const head = document.createElement("span");
  head.className = "notification-head";
  head.append(ownerBadge(entry.source, { compact: true }));
  const title = document.createElement("strong");
  title.textContent = entry.session;
  head.append(title);
  if (entry.unread) head.append(unreadDot(1));

  const meta = document.createElement("span");
  meta.className = "notification-meta";
  meta.textContent = notificationMeta(entry);

  const preview = document.createElement("span");
  preview.className = "notification-preview";
  preview.textContent = entry.preview || "No speakable text.";

  const action = document.createElement("span");
  action.className = "notification-open";
  action.textContent = "Open";

  btn.append(head, meta, preview, action);
  return btn;
}

function renderNotifications() {
  if (!notificationsList) return;
  const items = speakableItems(latestState?.queue || {});
  const entries = buildNotificationEntries(items, { isUnread });
  const unread = entries.filter((entry) => entry.unread).length;
  if (notificationsCount) {
    notificationsCount.textContent =
      entries.length === 0
        ? "No messages"
        : `${entries.length} message${entries.length === 1 ? "" : "s"}${
            unread ? ` - ${unread} unread` : ""
          }`;
  }
  if (entries.length === 0) {
    notificationsList.innerHTML = '<p class="history-empty">No messages have arrived yet.</p>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.append(buildNotificationRow(entry));
  notificationsList.replaceChildren(fragment);
}

function newItemsSinceLast(items, previousLatestId) {
  if (!previousLatestId) return [];
  const index = items.findIndex((item) => item.id === previousLatestId);
  return index >= 0 ? items.slice(index + 1) : items.slice(-1);
}

function updateChatsUnreadBadge(items) {
  if (!navChats) return;
  navChats.querySelector(".nav-unread")?.remove();
  // Once the chats view is open the projects list carries the dots; drop the
  // aggregate dot on the nav entry so each layer only shows the layer below.
  const count = currentView === "chats" ? 0 : unreadCount(items);
  navChats.classList.toggle("has-unread", count > 0);
  navChats.setAttribute("aria-label", count > 0 ? `Chats, ${count} unread` : "Chats");
  if (count === 0) return;
  const badge = unreadDot(count);
  badge.classList.add("nav-unread");
  navChats.append(badge);
}

function normalizeSearchText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function localDayKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function parseSearchQuery(query) {
  const raw = String(query || "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const now = new Date();
  const textTerms = [];
  const timeTests = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "today") {
      const key = localDayKey(now);
      timeTests.push((date) => localDayKey(date) === key);
    } else if (lower === "yesterday") {
      const date = new Date(now);
      date.setDate(date.getDate() - 1);
      const key = localDayKey(date);
      timeTests.push((candidate) => localDayKey(candidate) === key);
    } else if (lower.startsWith("last:")) {
      const match = lower.match(/^last:(\d+)(h|d)$/);
      if (!match) {
        textTerms.push(lower);
        continue;
      }
      const amount = Number(match[1]);
      const unitMs = match[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const cutoff = now.getTime() - amount * unitMs;
      timeTests.push((date) => date.getTime() >= cutoff);
    } else if (lower.startsWith("after:")) {
      const cutoff = new Date(`${lower.slice(6)}T00:00:00`);
      if (Number.isNaN(cutoff.getTime())) textTerms.push(lower);
      else timeTests.push((date) => date >= cutoff);
    } else if (lower.startsWith("before:")) {
      const cutoff = new Date(`${lower.slice(7)}T23:59:59.999`);
      if (Number.isNaN(cutoff.getTime())) textTerms.push(lower);
      else timeTests.push((date) => date <= cutoff);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
      timeTests.push((date) => localDayKey(date) === lower);
    } else {
      textTerms.push(lower);
    }
  }
  return { raw, textTerms, timeTests };
}

function timeTestsForSearchFilter(filter) {
  const now = new Date();
  if (filter === "today") {
    const key = localDayKey(now);
    return [(date) => localDayKey(date) === key];
  }
  if (filter === "yesterday") {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    const key = localDayKey(date);
    return [(candidate) => localDayKey(candidate) === key];
  }
  if (filter === "7d" || filter === "30d") {
    const days = filter === "7d" ? 7 : 30;
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return [(date) => date.getTime() >= cutoff];
  }
  return [];
}

function activeSearchFilters() {
  return (
    searchResultType !== "all" ||
    searchOwnerFilter !== "all" ||
    searchTimeFilter !== "any" ||
    searchSortMode !== "newest"
  );
}

function resultTimeMs(result) {
  const iso =
    result.type === "message"
      ? result.item?.timestamps?.createdAt
      : latestCreatedAt(result.session?.items || []);
  const date = new Date(iso || "");
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function compareSearchResults(a, b) {
  if (searchSortMode === "oldest") return resultTimeMs(a) - resultTimeMs(b);
  if (searchSortMode === "project") {
    return (
      a.project.label.localeCompare(b.project.label) ||
      a.session.label.localeCompare(b.session.label) ||
      resultTimeMs(b) - resultTimeMs(a)
    );
  }
  if (searchSortMode === "session") {
    return (
      a.session.label.localeCompare(b.session.label) ||
      a.project.label.localeCompare(b.project.label) ||
      resultTimeMs(b) - resultTimeMs(a)
    );
  }
  return resultTimeMs(b) - resultTimeMs(a);
}

function sessionMatchesOwner(session) {
  if (searchOwnerFilter === "all") return true;
  return session.items.some((item) => item.sourceApp === searchOwnerFilter);
}

function itemMatchesOwner(item) {
  return searchOwnerFilter === "all" || item.sourceApp === searchOwnerFilter;
}

function renderSearchOwnerOptions(items) {
  if (!searchOwner) return;
  const owners = Array.from(new Set(items.map((item) => item.sourceApp).filter(Boolean))).sort(
    (a, b) => a.localeCompare(b)
  );
  const previous = searchOwnerFilter;
  const options = [new Option("Any harness", "all")];
  for (const owner of owners) options.push(new Option(owner, owner));
  searchOwner.replaceChildren(...options);
  searchOwnerFilter = previous === "all" || owners.includes(previous) ? previous : "all";
  searchOwner.value = searchOwnerFilter;
}

function sessionSearchText(project, session) {
  return normalizeSearchText(
    [
      project.label,
      session.label,
      session.parts?.title,
      session.parts?.id,
      session.key,
      ...session.items.flatMap((item) => [item.threadId, item.threadLabel, item.sessionName])
    ].join(" ")
  );
}

function itemSearchText(item, project, session) {
  return normalizeSearchText(
    [
      project.label,
      session.label,
      session.parts?.title,
      session.parts?.id,
      item.id,
      item.threadId,
      item.threadLabel,
      item.sessionName,
      item.projectName,
      item.speakableText,
      ...(Array.isArray(item.userMessages) ? item.userMessages : [])
    ].join(" ")
  );
}

function itemMatchesParsedSearch(item, text, parsed) {
  const created = new Date(item.timestamps?.createdAt || "");
  const textOk = parsed.textTerms.every((term) => text.includes(term));
  const timeOk =
    parsed.timeTests.length === 0 ||
    (!Number.isNaN(created.getTime()) && parsed.timeTests.every((test) => test(created)));
  return textOk && timeOk;
}

function searchPreviewFrom(value, terms) {
  const raw = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).find((pos) => pos >= 0);
  if (!Number.isFinite(index) || index < 0) return raw.slice(0, 170);
  const start = Math.max(0, index - 52);
  const end = Math.min(raw.length, index + 118);
  return `${start > 0 ? "..." : ""}${raw.slice(start, end)}${end < raw.length ? "..." : ""}`;
}

function itemSearchMatchDetail(item, parsed) {
  const terms = parsed.textTerms;
  const prompts = Array.isArray(item.userMessages) ? item.userMessages : [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const text = normalizeSearchText(prompt);
    if (terms.length > 0 && terms.every((term) => text.includes(term))) {
      return {
        kind: "prompt",
        prompt,
        targetId: `${item.id}:prompt:${index}`,
        preview: `Prompt: ${searchPreviewFrom(prompt, terms)}`
      };
    }
  }
  const replyText = normalizeSearchText(item.speakableText);
  if (terms.length > 0 && terms.every((term) => replyText.includes(term))) {
    return {
      kind: "reply",
      preview: `Reply: ${searchPreviewFrom(item.speakableText, terms)}`
    };
  }
  return {
    kind: "message",
    preview: item.speakableText.slice(0, 170)
  };
}

function buildSearchResults() {
  if (!latestState) return [];
  const parsed = parseSearchQuery(searchQuery);
  parsed.timeTests.push(...timeTestsForSearchFilter(searchTimeFilter));
  if (!parsed.raw && !activeSearchFilters()) return [];
  const items = speakableItems(latestState.queue);
  const projects = buildProjects(items);
  const results = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      const sessionText = sessionSearchText(project, session);
      const sessionTextOk =
        parsed.textTerms.length === 0 ||
        parsed.textTerms.every((term) => sessionText.includes(term));
      const sessionTimeOk =
        parsed.timeTests.length === 0 ||
        session.items.some((item) => itemMatchesParsedSearch(item, sessionText, parsed));
      if (
        searchResultType !== "messages" &&
        sessionMatchesOwner(session) &&
        sessionTextOk &&
        sessionTimeOk
      ) {
        results.push({ type: "session", project, session });
      }
      if (searchResultType !== "sessions") {
        for (const item of session.items) {
          const text = itemSearchText(item, project, session);
          if (itemMatchesOwner(item) && itemMatchesParsedSearch(item, text, parsed)) {
            results.push({
              type: "message",
              project,
              session,
              item,
              match: itemSearchMatchDetail(item, parsed)
            });
          }
        }
      }
    }
  }
  return results.sort(compareSearchResults).slice(0, 100);
}

function resultMeta(project, session, item) {
  const time = formatTime(item?.timestamps?.createdAt || latestCreatedAt(session.items));
  return `${project.label} - ${session.label}${time ? ` - ${time}` : ""}`;
}

function resultButton(result) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "result-item";
  const badge = document.createElement("span");
  badge.className = "h-badge";
  badge.textContent = result.type === "session" ? "Session" : "Message";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent =
    result.type === "session"
      ? result.session.label
      : result.match?.preview || result.item.speakableText.slice(0, 160);
  const meta = document.createElement("span");
  meta.className = "result-meta";
  meta.textContent = resultMeta(result.project, result.session, result.item);
  const action = document.createElement("span");
  action.className = "result-open";
  action.textContent = "Open";
  btn.append(badge, title, action, meta);
  btn.addEventListener("click", () => jumpToSearchResult(result));
  return btn;
}

function renderSearch() {
  if (!searchResults || !searchCount) return;
  if (searchInput && searchInput.value !== searchQuery) searchInput.value = searchQuery;
  if (searchType && searchType.value !== searchResultType) searchType.value = searchResultType;
  if (searchTime && searchTime.value !== searchTimeFilter) searchTime.value = searchTimeFilter;
  if (searchSort && searchSort.value !== searchSortMode) searchSort.value = searchSortMode;
  document.querySelectorAll("[data-search-chip]").forEach((button) => {
    const value = button.dataset.searchChip || "";
    const filterValue = value.startsWith("last:") ? value.slice(5) : value;
    button.classList.toggle("is-active", searchTimeFilter === filterValue);
  });
  const items = latestState ? speakableItems(latestState.queue) : [];
  renderSearchOwnerOptions(items);
  const results = buildSearchResults();
  if (!searchQuery.trim() && !activeSearchFilters()) {
    searchCount.textContent = "No query";
    searchResults.innerHTML =
      '<p class="history-empty">Search chats by keyword, date, name, ID, or add filters above.</p>';
    return;
  }
  searchCount.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
  if (results.length === 0) {
    searchResults.innerHTML = '<p class="history-empty">No matching chats.</p>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const result of results) fragment.append(resultButton(result));
  searchResults.replaceChildren(fragment);
}

function setSessionFindQuery(query, { preferredTarget = null, activeIndex = 0 } = {}) {
  sessionFindQuery = String(query || "");
  sessionFindPreferredTarget = preferredTarget;
  sessionFindActiveIndex = activeIndex;
  if (sessionFindInput && sessionFindInput.value !== sessionFindQuery) {
    sessionFindInput.value = sessionFindQuery;
  }
  if (latestState && currentView === "chats") renderState(latestState);
}

function jumpToSearchResult(result) {
  leaveOpenSession();
  const parsed = parseSearchQuery(searchQuery);
  const findQuery = parsed.textTerms.join(" ");
  let preferredTarget = null;
  historyView = {
    level: "messages",
    projectKey: result.project.key,
    sessionKey: result.session.key
  };
  if (result.type === "message") {
    selectedItemId = result.item.id;
    if (result.match?.kind === "prompt") {
      preferredTarget = {
        kind: "prompt",
        itemId: result.item.id,
        targetId: result.match.targetId
      };
      searchHighlightPrompt = {
        itemId: result.item.id,
        prompt: result.match.prompt,
        targetId: result.match.targetId
      };
      searchHighlightItemId = null;
    } else {
      preferredTarget = { kind: "reply", itemId: result.item.id };
      searchHighlightItemId = result.item.id;
      searchHighlightPrompt = null;
    }
    markItemRead(result.item.id, { render: false });
  } else {
    searchHighlightItemId = null;
    searchHighlightPrompt = null;
  }
  if (findQuery) {
    sessionFindQuery = findQuery;
    sessionFindPreferredTarget = preferredTarget;
    sessionFindActiveIndex = 0;
  }
  setView("chats");
  renderState(latestState);
}

async function postQueueAction(path, body) {
  const response = await fetch(`${targetUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshAfterQueueMutation(message) {
  notify(message);
  await refreshPanel(targetUrl, { quiet: true, force: true });
}

async function removeAudioForTarget(action, label) {
  const ok = await askConfirm({
    title: "Remove Saved Audio",
    message: `Remove saved audio for ${label}? Chats will stay visible and audio will regenerate when played.`,
    confirmText: "Remove Audio"
  });
  if (!ok) return false;
  try {
    await action();
    showToast("Saved audio removed.");
    await refreshPanel(targetUrl, { quiet: true, force: true });
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

function removeProjectAudio(project) {
  removeAudioForTarget(() => deleteCacheProject(targetUrl, project.key), project.label);
}

function removeSessionAudio(session) {
  removeAudioForTarget(() => deleteCacheSession(targetUrl, session.key), session.label);
}

async function trashQueueTarget(body) {
  const targetLabel = body?.projectKey
    ? "this project"
    : body?.sessionKey
      ? "the current chat"
      : "the selected chats";
  const ok = await askConfirm({
    title: "Move to Trash",
    message: `Move ${targetLabel} to Trash? Saved audio will be deleted.`,
    confirmText: "Move to Trash"
  });
  if (!ok) return;
  try {
    const result = await postQueueAction("/api/queue/trash", body);
    if (!result.trashed?.length) {
      notify("Nothing moved to Trash. The session may have already changed.");
      await refreshPanel(targetUrl, { quiet: true, force: true });
      return;
    }
    if (Array.isArray(result.trashed) && result.trashed.includes(selectedItemId)) {
      selectedItemId = null;
    }
    await refreshAfterQueueMutation(`Moved ${result.trashed?.length || 0} chat item(s) to Trash.`);
  } catch (error) {
    showError(error);
  }
}

async function restoreQueueTarget(body, label) {
  try {
    const result = await postQueueAction("/api/queue/restore", body);
    for (const id of result.restored || []) pregenSeenIds.delete(id);
    persistPregenSeen();
    await refreshAfterQueueMutation(`Restored ${label}. Audio will regenerate in the background.`);
    queuePregenForItemIds(result.restored || [], latestState?.settings);
  } catch (error) {
    showError(error);
  }
}

function trashSelectionCount() {
  return selectedTrashProjectKeys.size + selectedTrashSessionKeys.size;
}

function selectedTrashProjects(projects) {
  return projects.filter((project) => selectedTrashProjectKeys.has(project.key));
}

function selectedTrashSessions(project) {
  if (!project) return [];
  return project.sessions.filter((session) => selectedTrashSessionKeys.has(session.key));
}

async function restoreSelectedTrashItems() {
  if (!latestState || trashSelectionCount() === 0) return;
  const projects = buildProjects(trashedSpeakableItems(latestState.queue));
  const selectedProjectSet = new Set(selectedTrashProjectKeys);
  const selectedSessionSet = new Set(selectedTrashSessionKeys);
  const itemIds = new Set();
  for (const project of projects) {
    if (selectedProjectSet.has(project.key)) {
      for (const item of project.items) itemIds.add(item.id);
      continue;
    }
    for (const session of project.sessions) {
      if (selectedSessionSet.has(session.key)) {
        for (const item of session.items) itemIds.add(item.id);
      }
    }
  }
  const ids = [...itemIds];
  if (ids.length === 0) return;
  await restoreQueueTarget({ itemIds: ids }, `${ids.length} item${ids.length === 1 ? "" : "s"}`);
  clearTrashSelection();
}

function restoreTrashSession(session) {
  if (!session) return;
  restoreQueueTarget({ itemIds: session.items.map((item) => item.id) }, session.label || "session");
}

function clearTrashSelection() {
  selectedTrashProjectKeys = new Set();
  selectedTrashSessionKeys = new Set();
  renderTrash();
}

function setTrashSelectMode(mode) {
  trashSelectMode = mode;
  selectedTrashProjectKeys = new Set();
  selectedTrashSessionKeys = new Set();
  renderTrash();
}

function renderTrashColumnHeader(titleEl, label, mode, metaNode = null) {
  if (!titleEl) return;
  const title = document.createElement("span");
  title.textContent = label;
  const actions = document.createElement("span");
  actions.className = "head-actions";
  if (metaNode) actions.append(metaNode);

  if (trashSelectMode === mode) {
    const done = document.createElement("button");
    done.type = "button";
    done.className = "text-button head-action";
    done.textContent = "Done";
    done.onclick = () => setTrashSelectMode(null);
    actions.append(done);
  } else {
    actions.append(
      menuButton(`${label} options`, (event) =>
        openHeaderMenu(event, [
          {
            label: "Select items",
            run: () => setTrashSelectMode(mode)
          }
        ])
      )
    );
  }

  titleEl.replaceChildren(title, actions);
}

function buildTrashSelectionToolbar({ selectedCount, totalCount, selectAll, deselectAll }) {
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "text-button head-action";
  restore.textContent = "Restore";
  restore.disabled = selectedCount === 0;
  restore.onclick = restoreSelectedTrashItems;

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "text-button head-action";
  clear.textContent = "Clear";
  clear.disabled = selectedCount === 0;
  clear.onclick = clearTrashSelection;

  return buildSelectionToolbar({
    selectedCount,
    totalCount,
    selectAll,
    deselectAll,
    actions: [restore, clear]
  });
}

function buildTrashProjectRow(project) {
  const row = document.createElement("div");
  row.className = "tree-select-row";
  const toggleProject = () => {
    check.checked = !check.checked;
    if (check.checked) selectedTrashProjectKeys.add(project.key);
    else selectedTrashProjectKeys.delete(project.key);
    renderTrash();
  };
  const check = selectionCheckbox({
    checked: selectedTrashProjectKeys.has(project.key),
    label: `Select ${project.label}`,
    onChange: (checked) => {
      if (checked) selectedTrashProjectKeys.add(project.key);
      else selectedTrashProjectKeys.delete(project.key);
      renderTrash();
    }
  });

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `tree-item ${project.key === trashView.projectKey ? "is-selected" : ""}`;
  btn.dataset.project = project.key;
  applyProjectColor(btn, project);
  const titleRow = document.createElement("span");
  titleRow.className = "tree-item-head";
  const title = document.createElement("span");
  title.className = "tree-item-title";
  title.textContent = project.label;
  const meta = document.createElement("span");
  meta.className = "tree-item-meta";
  meta.textContent = `${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"} - ${project.items.length} trashed`;
  titleRow.append(title);
  btn.append(titleRow, meta);
  btn.onclick = () => {
    if (trashSelectMode === "projects") {
      toggleProject();
      return;
    }
    trashView.projectKey = project.key;
    trashView.sessionKey = null;
    renderTrash();
  };
  btn.oncontextmenu = (event) =>
    openTrashRestoreMenu(event, [
      {
        text: "Restore project",
        label: project.label,
        body: { itemIds: project.items.map((item) => item.id) }
      }
    ]);
  if (trashSelectMode === "projects") {
    setSelectionRowClick(row, toggleProject);
    row.append(check);
  }
  row.append(btn);
  return row;
}

function renderTrashSessions(project) {
  if (!trashSessionsPane || !trashSessionsList) return;
  if (!project) {
    trashSessionsPane.hidden = true;
    trashSessionsList.replaceChildren();
    if (trashSelectMode === "sessions") setTrashSelectMode(null);
    renderTrashMessages(null);
    return;
  }
  trashSessionsPane.hidden = false;
  renderTrashColumnHeader(trashSessionsTitle, "Sessions", "sessions");
  trashSessionsList.replaceChildren();
  if (trashSelectMode === "sessions") {
    const selected = selectedTrashSessions(project);
    trashSessionsList.append(
      buildTrashSelectionToolbar({
        selectedCount: selected.length,
        totalCount: project.sessions.length,
        selectAll: () => {
          selectedTrashSessionKeys = new Set(project.sessions.map((session) => session.key));
          renderTrash();
        },
        deselectAll: () => {
          selectedTrashSessionKeys = new Set();
          renderTrash();
        }
      })
    );
  }
  for (const session of project.sessions) {
    const row = document.createElement("div");
    row.className = "tree-select-row";
    const toggleSession = () => {
      check.checked = !check.checked;
      if (check.checked) selectedTrashSessionKeys.add(session.key);
      else selectedTrashSessionKeys.delete(session.key);
      renderTrash();
    };
    const check = selectionCheckbox({
      checked: selectedTrashSessionKeys.has(session.key),
      label: `Select ${session.label}`,
      onChange: (checked) => {
        if (checked) selectedTrashSessionKeys.add(session.key);
        else selectedTrashSessionKeys.delete(session.key);
        renderTrash();
      }
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `tree-item ${session.key === trashView.sessionKey ? "is-selected" : ""}`;
    btn.dataset.session = session.key;
    applyOwnerColor(btn, session.owner);
    const titleRow = document.createElement("span");
    titleRow.className = "tree-item-head";
    const title = document.createElement("span");
    title.className = "tree-item-title session-title";
    appendSessionTitle(title, session);
    titleRow.append(ownerBadge(session.owner), title);
    const meta = document.createElement("span");
    meta.className = "tree-item-meta";
    meta.textContent = `${session.items.length} msg${session.items.length === 1 ? "" : "s"} - audio deleted`;
    btn.append(titleRow, meta);
    btn.onclick = () => {
      if (trashSelectMode === "sessions") {
        toggleSession();
        return;
      }
      trashView.sessionKey = session.key;
      renderTrash();
    };
    btn.oncontextmenu = (event) =>
      openTrashRestoreMenu(event, [
        {
          text: "Restore session",
          label: session.label,
          body: { itemIds: session.items.map((item) => item.id) }
        }
      ]);
    if (trashSelectMode === "sessions") {
      setSelectionRowClick(row, toggleSession);
      row.append(check);
    }
    row.append(btn);
    trashSessionsList.append(row);
  }
}

function renderTrashMessages(session) {
  if (!trashMessagesPane || !trashMessagesList) return;
  if (!session) {
    trashMessagesPane.hidden = true;
    trashMessagesList.replaceChildren();
    return;
  }
  trashMessagesPane.hidden = false;
  if (trashMessagesTitle) {
    const title = document.createElement("span");
    title.textContent = "Messages";
    const actions = document.createElement("span");
    actions.className = "head-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "text-button head-action";
    restore.textContent = "Restore session";
    restore.addEventListener("click", () => restoreTrashSession(session));
    actions.append(restore);
    trashMessagesTitle.replaceChildren(title, actions);
  }
  const fragment = document.createDocumentFragment();
  for (const item of session.items) {
    const prompts = Array.isArray(item.userMessages) ? item.userMessages : [];
    for (let index = 0; index < prompts.length; index += 1) {
      const promptRow = buildUserBubble(prompts[index], item.timestamps?.createdAt, {
        itemId: item.id,
        searchTargetId: `${item.id}:trash-prompt:${index}`
      });
      promptRow.oncontextmenu = (event) =>
        openTrashRestoreMenu(event, [
          { text: "Restore message", label: "this message", body: { itemIds: [item.id] } },
          {
            text: "Restore session",
            label: session.label,
            body: { itemIds: session.items.map((entry) => entry.id) }
          }
        ]);
      fragment.append(promptRow);
    }
    fragment.append(buildTrashAssistantBubble(item, session));
  }
  trashMessagesList.replaceChildren(fragment);
}

function renderTrash() {
  if (!trashProjectsList || !trashCount) return;
  const trashed = trashedSpeakableItems(latestState?.queue || {});
  trashCount.textContent = `${trashed.length} trashed item${trashed.length === 1 ? "" : "s"}`;
  if (trashed.length === 0) {
    selectedTrashProjectKeys = new Set();
    selectedTrashSessionKeys = new Set();
    trashSelectMode = null;
    trashView = { projectKey: null, sessionKey: null };
    trashEmpty.hidden = false;
    trashCascade.hidden = true;
    trashProjectsList.replaceChildren();
    trashSessionsList?.replaceChildren();
    trashMessagesList?.replaceChildren();
    if (trashSessionsPane) trashSessionsPane.hidden = true;
    if (trashMessagesPane) trashMessagesPane.hidden = true;
    return;
  }
  trashEmpty.hidden = true;
  trashCascade.hidden = false;
  const projects = buildProjects(trashed);
  const trashCountMeta = document.createElement("span");
  trashCountMeta.id = "trash-count";
  trashCountMeta.className = "head-meta";
  trashCountMeta.textContent = `${trashed.length} trashed item${trashed.length === 1 ? "" : "s"}`;
  renderTrashColumnHeader(trashProjectsTitle, "Projects", "projects", trashCountMeta);

  const liveProjectKeys = new Set(projects.map((project) => project.key));
  const liveSessionKeys = new Set(
    projects.flatMap((project) => project.sessions.map((s) => s.key))
  );
  for (const key of [...selectedTrashProjectKeys])
    if (!liveProjectKeys.has(key)) selectedTrashProjectKeys.delete(key);
  for (const key of [...selectedTrashSessionKeys])
    if (!liveSessionKeys.has(key)) selectedTrashSessionKeys.delete(key);
  if (trashView.projectKey && !liveProjectKeys.has(trashView.projectKey)) {
    trashView = { projectKey: null, sessionKey: null };
  }
  if (!trashView.projectKey && projects[0]) {
    trashView.projectKey = projects[0].key;
  }

  trashProjectsList.replaceChildren();
  if (trashSelectMode === "projects") {
    const selected = selectedTrashProjects(projects);
    trashProjectsList.append(
      buildTrashSelectionToolbar({
        selectedCount: selected.length,
        totalCount: projects.length,
        selectAll: () => {
          selectedTrashProjectKeys = new Set(projects.map((project) => project.key));
          renderTrash();
        },
        deselectAll: () => {
          selectedTrashProjectKeys = new Set();
          renderTrash();
        }
      })
    );
  }
  for (const project of projects) {
    trashProjectsList.append(buildTrashProjectRow(project));
  }

  const project = trashView.projectKey
    ? projects.find((entry) => entry.key === trashView.projectKey)
    : null;
  renderTrashSessions(project);
  const session =
    project && trashView.sessionKey
      ? project.sessions.find((entry) => entry.key === trashView.sessionKey)
      : null;
  if (project && trashView.sessionKey && !session) trashView.sessionKey = null;
  renderTrashMessages(session);
}

function snapToWordEnd(full, count) {
  if (count <= 0) return 0;
  if (count >= full.length) return full.length;
  const inWord = !/\s/.test(full[count - 1]) && !/\s/.test(full[count]);
  if (!inWord) return count;
  let i = count;
  while (i < full.length && !/\s/.test(full[i])) i += 1;
  return i;
}

function renderHighlight(target, currentSec, segments, wordAccurate, scrollMode, colored = true) {
  if (!target || !Array.isArray(segments) || segments.length === 0) return;
  let activeIdx = segments.findIndex((seg) => currentSec < seg.endSec);
  if (activeIdx === -1) activeIdx = segments.length - 1;

  let highlightChars = 0;
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const text = segments[i].text;
    parts.push(text);
    if (i < activeIdx) {
      highlightChars += text.length + 1;
    } else if (i === activeIdx) {
      const seg = segments[i];
      const span = Math.max(0.001, seg.endSec - seg.startSec);
      const within = Math.min(1, Math.max(0, (currentSec - seg.startSec) / span));
      highlightChars += Math.round(within * text.length);
    }
  }

  const full = parts.join(" ");
  highlightChars = Math.min(full.length, Math.max(0, highlightChars));
  if (!wordAccurate) highlightChars = snapToWordEnd(full, highlightChars);
  const done = document.createElement("span");
  if (colored) done.className = "spoken-done";
  done.textContent = full.slice(0, highlightChars);
  const cursor = document.createElement("span");
  cursor.className = "spoken-cursor";
  const rest = document.createElement("span");
  if (colored) rest.className = "spoken-rest";
  rest.textContent = full.slice(highlightChars);
  target.replaceChildren(done, cursor, rest);

  if (scrollMode === "pair") {
    const lineHeight = Number.parseFloat(getComputedStyle(target).lineHeight) || 1;
    const currentLine = Math.floor(cursor.offsetTop / lineHeight);
    const pairStartLine = Math.floor(currentLine / 2) * 2;
    target.scrollTop = Math.max(0, pairStartLine * lineHeight);
  } else if (scrollMode === "center") {
    target.scrollTop = Math.max(0, cursor.offsetTop - target.clientHeight / 2);
  }
}

function renderHighlightAt(currentSec, segments, wordAccurate, colored = true) {
  const selectedIsActiveItem = selectedItemId && selectedItemId === playback?.activeItemId;
  const previewIsActiveItem =
    previewText?.dataset?.itemId && previewText.dataset.itemId === playback?.activeItemId;
  const renderPreviewHighlight = () => {
    if (previewIsActiveItem) {
      renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", colored);
    }
  };

  // Only the item currently being spoken gets progress highlighting. The bottom
  // preview can advance to a newly arrived message while older audio continues.
  if (colored) {
    const bubbleBody = selectedInlineBubbleBody();
    if (selectedIsActiveItem && highlightSurface === "inline" && bubbleBody) {
      renderHighlight(bubbleBody, currentSec, segments, wordAccurate, "center", true);
      if (previewIsActiveItem) {
        renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", false);
      }
      return;
    }
    if (selectedIsActiveItem && highlightSurface === "modal" && isModalOpen()) {
      renderHighlight(modalBody, currentSec, segments, wordAccurate, "center", true);
      if (previewIsActiveItem) {
        renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", false);
      }
      return;
    }
  }
  renderPreviewHighlight();
}

function selectedInlineBubbleBody() {
  if (!selectedItemId || !historyList) return null;
  const bubble = historyList.querySelector(
    `.bubble-assistant[data-id="${CSS.escape(selectedItemId)}"]`
  );
  if (!bubble?.classList.contains("is-expanded")) return null;
  return bubble.querySelector(".bubble-body");
}

function updatePlaybackUi() {
  updateInlinePlaybackButtons();
  updateNowPlayingIndicators();
  const pos = playback?.getPlaybackPosition?.();
  if (!pos) {
    seekBar.disabled = true;
    if (!seekDragging) seekBar.value = "0";
    if (seekCurrent) seekCurrent.textContent = "0:00";
    if (seekTotal) seekTotal.textContent = "0:00";
    // Flatten any leftover highlight back to plain text once playback stops.
    if (previewText.querySelector(".spoken-cursor")) {
      previewText.replaceChildren(document.createTextNode(previewText.textContent));
    }
    return;
  }
  seekBar.disabled = false;
  if (seekTotal) seekTotal.textContent = formatClock(pos.totalSec);
  if (seekCurrent) {
    const shownSec = seekDragging ? (Number(seekBar.value) / 1000) * pos.totalSec : pos.currentSec;
    seekCurrent.textContent = formatClock(shownSec);
  }
  if (!seekDragging) {
    seekBar.value = String(Math.round(pos.fraction * 1000));
    const colored = Boolean(latestState?.settings?.highlightSpokenText);
    renderHighlightAt(pos.currentSec, pos.segments, pos.wordAccurate, colored);
  }
}

function updateControls(settings, items, selected) {
  const scoped = sessionScopedItems(items, selectedItemId);
  const index = scoped.findIndex((item) => item.id === selectedItemId);
  prevButton.disabled = index <= 0;
  nextButton.disabled = index < 0 || index >= scoped.length - 1;
  firstButton.disabled = index <= 0;
  lastButton.disabled = index < 0 || index >= scoped.length - 1;

  const loading = playback?.isLoading;
  const speaking = playback?.isSpeaking;
  const paused = playback?.isPaused;
  playPauseButton.classList.toggle("is-loading", Boolean(loading));
  setPlaybackButtonIcon(playPauseButton, { loading, speaking });
  if (loading) {
    playPauseButton.title = "Generating speech...";
    playPauseButton.setAttribute("aria-label", "Generating speech");
    playPauseButton.disabled = true;
    return;
  }
  const ppLabel = speaking ? "Pause" : paused ? "Resume" : "Read aloud";
  playPauseButton.title = ppLabel;
  playPauseButton.setAttribute("aria-label", ppLabel);
  playPauseButton.disabled = settings.mute || (!selected && !speaking && !paused);

  const muteLabel = settings.mute ? "Unmute" : "Mute";
  muteButton.innerHTML = settings.mute ? ICON_SPEAKER_MUTED : ICON_SPEAKER;
  muteButton.title = muteLabel;
  muteButton.setAttribute("aria-label", muteLabel);
}

function maybeRestartForVoiceChange(settings) {
  if (!settings) return;
  const changed = settings.kokoroVoice !== lastKokoroVoice || settings.engine !== lastEngine;
  lastKokoroVoice = settings.kokoroVoice;
  lastEngine = settings.engine;
  if (!changed) return;

  const usingKokoro = settings.engine === "kokoro" || settings.engine === "kokoro-ts";
  if (!usingKokoro) return;
  if (!playback?.isSpeaking && !playback?.isPaused) return;

  const selected = findSelected(speakableItems(latestState?.queue || {}));
  if (!selected) return;
  notify("Voice changed. Restarting playback...");
  playback.playItem(selected, settings).catch(showError);
}

function renderState({ settings, queue }) {
  latestState = { settings, queue };
  if (!voiceTrackInit) {
    lastKokoroVoice = settings.kokoroVoice;
    lastEngine = settings.engine;
    lastRate = settings.rate;
    voiceTrackInit = true;
  }
  const items = speakableItems(queue);

  // First ever run: treat the existing backlog as already read so only new
  // arrivals surface unread dots.
  if (!readSeeded) {
    for (const item of items) readItemIds.add(item.id);
    persistReadItems();
    readSeeded = true;
  }

  const latest = items[items.length - 1] || null;
  const activeItem = nowPlayingItem(items);
  if (latest && latest.id !== lastLatestId) {
    const firstLoad = lastLatestId === null;
    const newItems = firstLoad ? [] : newItemsSinceLast(items, lastLatestId);
    if (!firstLoad) recordBackgroundArrivals(newItems);
    if (!firstLoad) maybeNotify(latest, settings);
    // Suppress the "new message" toast when the arriving item's session is
    // already open on screen - the message is right there, no nudge needed.
    const latestSessionOpen =
      currentView === "chats" &&
      projectKeyOf(latest) === historyView.projectKey &&
      sessionKeyOf(latest) === historyView.sessionKey;
    if (!firstLoad && !latestSessionOpen) {
      const notice = describeQueueArrivalNotice({
        item: latest,
        activeItem,
        playbackActive: playbackActive(),
        noticedItemIds: noticedQueueItemIds
      });
      if (notice) {
        noticedQueueItemIds.add(notice.itemId);
        if (noticedQueueItemIds.size > NOTICED_QUEUE_ITEM_LIMIT) {
          noticedQueueItemIds.delete(noticedQueueItemIds.values().next().value);
        }
        queueNotice = notice;
      }
    }
    selectedItemId = selectItemIdForQueueUpdate({
      currentSelectedId: selectedItemId,
      latestItem: latest,
      activeItem,
      playbackActive: playbackActive()
    });
    lastLatestId = latest.id;
  }
  if (!findSelected(items)) selectedItemId = latest ? latest.id : null;

  const selected = findSelected(items);
  const statusKind = deriveStatus(settings, playback?.state, selected);
  setStatus(statusKind);
  renderNowCard(selected, statusKind);
  renderHistory(items);
  renderQueueNotice();
  updateChatsUnreadBadge(items);
  renderNotifications();
  if (isAppActiveSurface()) showReturnNoticeIfNeeded();
  renderSearch();
  renderTrash();
  updateNowPlayingIndicators();
  updateControls(settings, items, selected);
  updateModal();
  settingsUi?.render(settings);
  seedAutoReadAttempts(queue);
  runAutoRead(settings, queue);
  schedulePregen(settings, items);
}

function runAutoRead(settings, queue) {
  if (!playback) return;
  if (
    !shouldAutoReadPending({
      settings,
      queue,
      playbackActive: playback.isSpeaking || playback.isPaused || playback.isLoading,
      attemptedItemIds: autoReadAttemptedItemIds
    })
  ) {
    return;
  }
  const item = getNextPendingItem(queue);
  rememberAutoReadAttempt(item.id);
  notify("Auto-play found a new item. Starting playback...");
  highlightSurface = "preview";
  playback.readNextPending({ settings, queue }).catch(showError);
}

async function refreshPanel(url, { quiet = false, force = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (!quiet) notify("Refreshing...");
  try {
    const [{ settings }, { queue }] = await Promise.all([
      fetchJson(`${url}/api/settings`),
      fetchJson(`${url}/api/queue`)
    ]);
    const sig = JSON.stringify({ settings, queue });
    if (quiet && !force && sig === lastDataSig) return;
    lastDataSig = sig;
    renderState({ settings, queue });
  } catch (error) {
    showError(error);
  } finally {
    refreshInFlight = false;
  }
}

function showError(error) {
  setStatus("error");
  notify(`Backend unavailable: ${String(error?.message || error)}. Start it and refresh.`);
  playPauseButton.disabled = true;
  prevButton.disabled = true;
  nextButton.disabled = true;
  firstButton.disabled = true;
  lastButton.disabled = true;
}

// Returns the id moved to (truthy) or false.
function moveSelection(delta) {
  if (!latestState) return false;
  const items = sessionScopedItems(speakableItems(latestState.queue), selectedItemId);
  const index = items.findIndex((item) => item.id === selectedItemId);
  if (index < 0) return false;
  const next = items[index + delta];
  if (!next) return false;
  selectedItemId = next.id;
  renderState(latestState);
  return next.id;
}

function jumpSelection(edge) {
  if (!latestState) return false;
  const items = sessionScopedItems(speakableItems(latestState.queue), selectedItemId);
  if (!items.length) return false;
  const target = edge === "first" ? items[0] : items[items.length - 1];
  if (!target || target.id === selectedItemId) return false;
  selectedItemId = target.id;
  renderState(latestState);
  return target.id;
}

function playSelected() {
  if (!latestState) return;
  const items = speakableItems(latestState.queue);
  const selected = findSelected(items);
  if (!selected) {
    notify("No item is selected.");
    return;
  }
  playback.playItem(selected, latestState.settings).catch(showError);
}

function playSelectedOn(surface) {
  highlightSurface = surface;
  const selected = findSelected(speakableItems(latestState?.queue || {}));
  resetInactiveHighlightSurfaces(surface, selected);
  playSelected();
}

function resetInactiveHighlightSurfaces(surface, item) {
  if (!item) return;
  if (surface !== "inline") {
    const bubbleBody = selectedInlineBubbleBody();
    if (bubbleBody) {
      setBubbleBodyText(
        bubbleBody,
        item.speakableText,
        { kind: "reply", itemId: item.id },
        { record: false }
      );
    }
  }
  if (surface !== "modal" && modalBody?.dataset.itemId === item.id) {
    modalBody.textContent = item.speakableText;
  }
  if (surface !== "preview") {
    renderNowCard(item);
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

initColumnResize();

startStartupJingle();

const config = await loadRuntimeConfig();
const targetUrl = config.backendUrl || DEFAULT_BACKEND_URL;
backendUrl.textContent = targetUrl;

settingsUi = initSettingsUi({
  backendUrl: targetUrl,
  onLivePreview: (partial) => playback?.applyLiveSettings(partial),
  onSettingsChanged: (settings) => {
    cacheStartupSettingsHint(settings);
    if (settings?.mute && (playback?.isSpeaking || playback?.isPaused)) {
      playback.stop("User muted playback.").catch(showError);
    } else {
      const voiceChanged =
        settings.kokoroVoice !== lastKokoroVoice || settings.engine !== lastEngine;
      maybeRestartForVoiceChange(settings);
      // A rate change may cross a native-gen band (needs regen) or stay within
      // one (live WSOLA adjust); changeSpeed decides. Voice/engine changes already
      // restart playback above, so skip rate handling then to avoid a double regen.
      if (!voiceChanged && settings.rate !== lastRate) {
        const result = playback?.changeSpeed?.(settings.rate, settings);
        if (result?.catch) result.catch(showError);
      } else if (!voiceChanged) {
        playback?.applyLiveSettings(settings);
      }
    }
    lastRate = settings?.rate;
    refreshPanel(targetUrl, { quiet: true }).catch(showError);
  }
});

playback = createPlaybackController({
  backendUrl: targetUrl,
  onUpdate: notify,
  onStateChanged: () => refreshPanel(targetUrl, { quiet: true, force: true }).catch(showError),
  onItemFinished: (itemId) => markItemRead(itemId)
});

function wireNav(button, view) {
  if (!button) return;
  // Clicking the active item again returns to the blank full-screen state.
  button.addEventListener("click", () => setView(currentView === view ? "blank" : view));
}
wireNav(navChats, "chats");
wireNav(navSearch, "search");
wireNav(navNotifications, "notifications");
wireNav(navTrash, "trash");
wireNav(navSettings, "settings");

function setSettingsTab(targetId) {
  const tabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));
  if (!tabs.length || !panels.length) return;
  const fallback = tabs[0]?.dataset.settingsTab;
  const activeId = panels.some((panel) => panel.id === targetId) ? targetId : fallback;
  for (const tab of tabs) {
    const active = tab.dataset.settingsTab === activeId;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.id !== activeId;
    panel.setAttribute("aria-hidden", panel.hidden ? "true" : "false");
  }
}

document.querySelector(".settings-rail")?.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-settings-tab]");
  if (!tab) return;
  setSettingsTab(tab.dataset.settingsTab);
});
setSettingsTab("settings-behavior");

searchInput?.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderSearch();
});
searchClear?.addEventListener("click", () => {
  searchQuery = "";
  if (searchInput) searchInput.value = "";
  renderSearch();
  searchInput?.focus();
});
searchType?.addEventListener("change", () => {
  searchResultType = searchType.value || "all";
  renderSearch();
});
searchOwner?.addEventListener("change", () => {
  searchOwnerFilter = searchOwner.value || "all";
  renderSearch();
});
searchTime?.addEventListener("change", () => {
  searchTimeFilter = searchTime.value || "any";
  renderSearch();
});
searchSort?.addEventListener("change", () => {
  searchSortMode = searchSort.value || "newest";
  renderSearch();
});
document.querySelectorAll("[data-search-chip]").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.searchChip || "any";
    searchTimeFilter = value.startsWith("last:") ? value.slice(5) : value;
    renderSearch();
  });
});
sessionFindInput?.addEventListener("input", () => {
  sessionFindQuery = sessionFindInput.value;
  sessionFindPreferredTarget = null;
  sessionFindActiveIndex = 0;
  if (latestState) renderState(latestState);
});
sessionFindInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    moveSessionFind(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    sessionFindInput.blur();
    if (sessionFindQuery) setSessionFindQuery("");
  }
});
sessionFindPrev?.addEventListener("click", () => moveSessionFind(-1));
sessionFindNext?.addEventListener("click", () => moveSessionFind(1));
function navAndFollow(targetId) {
  if (!targetId || !playbackActive()) return;
  selectedItemId = targetId;
  playSelectedOn("preview");
}
firstButton.addEventListener("click", () => navAndFollow(jumpSelection("first")));
prevButton.addEventListener("click", () => navAndFollow(moveSelection(-1)));
nextButton.addEventListener("click", () => navAndFollow(moveSelection(1)));
lastButton.addEventListener("click", () => navAndFollow(jumpSelection("last")));
playPauseButton.addEventListener("click", () => {
  // Reaching the end takes precedence over pause/resume: restart from the start
  // instead of resuming silence at the tail.
  if (playback.isEnded || playback.isAtEnd) {
    highlightSurface = "preview";
    resetInactiveHighlightSurfaces(
      "preview",
      findSelected(speakableItems(latestState?.queue || {}))
    );
    if (playback.replayCurrent()) return;
  }
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  highlightSurface = "preview";
  resetInactiveHighlightSurfaces("preview", findSelected(speakableItems(latestState?.queue || {})));
  playSelectedOn("preview");
});
muteButton.addEventListener("click", () => {
  const muted = latestState?.settings?.mute !== true;
  playback.setMute(muted).catch(showError);
});

seekBar.addEventListener("pointerdown", () => (seekDragging = true));
seekBar.addEventListener("input", () => {
  seekDragging = true;
  const dragPos = playback?.getPlaybackPosition?.();
  if (dragPos && seekCurrent) {
    seekCurrent.textContent = formatClock((Number(seekBar.value) / 1000) * dragPos.totalSec);
  }
  const pos = playback?.getPlaybackPosition?.();
  if (pos) {
    const colored = Boolean(latestState?.settings?.highlightSpokenText);
    renderHighlightAt(
      (Number(seekBar.value) / 1000) * pos.totalSec,
      pos.segments,
      pos.wordAccurate,
      colored
    );
  }
});
seekBar.addEventListener("change", () => {
  seekDragging = false;
  playback?.seek?.(Number(seekBar.value) / 1000);
});
seekBar.addEventListener("blur", () => (seekDragging = false));

historyList.addEventListener("click", (event) => {
  closeMessageMenu();
  // Bubble body (user or assistant): toggle the 2-line clamp to show full text.
  const bubble = event.target.closest(".bubble");
  if (bubble) bubble.classList.toggle("is-expanded");
});

historyList.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest(".bubble");
  if (!bubble?.dataset.copyText) return;
  event.preventDefault();
  openMessageMenu(event, bubble.dataset.copyText);
});

window.addEventListener("click", (event) => {
  if (!event.target.closest(".message-menu")) closeMessageMenu();
  if (!event.target.closest(".session-menu")) closeSessionMenu();
});

window.addEventListener("focus", showReturnNoticeIfNeeded);
document.addEventListener("visibilitychange", () => {
  if (isAppActiveSurface()) showReturnNoticeIfNeeded();
});

el("expand-all")?.addEventListener("click", () => setAllBubblesExpanded(true));
el("collapse-all")?.addEventListener("click", () => setAllBubblesExpanded(false));

// ---- Modal wiring ----------------------------------------------------------
function modalMove(delta) {
  const targetId = moveSelection(delta);
  if (!targetId) return;
  selectedItemId = targetId;
  const item = modalItem();
  if (!item) return;
  markItemRead(item.id);
  updateModal();
  playSelectedOn("modal");
}

modalClose?.addEventListener("click", closeModal);
msgModal?.addEventListener("click", (event) => {
  // Click on the dimmed backdrop (not the card) closes the modal.
  if (event.target === msgModal) closeModal();
});
sessionDetailsClose?.addEventListener("click", closeSessionDetails);
sessionDetailsModal?.addEventListener("click", (event) => {
  if (event.target === sessionDetailsModal) closeSessionDetails();
});
confirmCancel?.addEventListener("click", () => resolveConfirm(false));
confirmOk?.addEventListener("click", () => resolveConfirm(true));
confirmModal?.addEventListener("click", (event) => {
  if (event.target === confirmModal) resolveConfirm(false);
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    if (currentView === "chats") {
      event.preventDefault();
      sessionFindInput?.focus();
      sessionFindInput?.select();
      return;
    }
    if (currentView === "search") {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
      return;
    }
  }
  if (event.key === "Escape" && isModalOpen()) closeModal();
  if (event.key === "Escape" && sessionDetailsModal && !sessionDetailsModal.hidden) {
    closeSessionDetails();
  }
  if (event.key === "Escape" && confirmModal && !confirmModal.hidden) {
    resolveConfirm(false);
  }
});
modalPlay?.addEventListener("click", () => {
  if (playback.isEnded || playback.isAtEnd) {
    highlightSurface = "modal";
    resetInactiveHighlightSurfaces("modal", findSelected(speakableItems(latestState?.queue || {})));
    if (playback.replayCurrent()) return;
  }
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  highlightSurface = "modal";
  resetInactiveHighlightSurfaces("modal", findSelected(speakableItems(latestState?.queue || {})));
  playSelectedOn("modal");
});
modalPrev?.addEventListener("click", () => modalMove(-1));
modalNext?.addEventListener("click", () => modalMove(1));

function subscribeTrayEvents() {
  if (!window.__TAURI_INTERNALS__) return;

  listen("agent-hotline://show", () => refreshPanel(targetUrl).catch(showError)).catch(() => {});

  if (typeof notification.onAction === "function") {
    notification
      .onAction(() => {
        const opens = latestState?.settings?.notificationOpens || "full";
        invoke(opens === "mini" ? "show_mini_panel" : "show_main_panel").catch(() => {});
      })
      .catch(() => {});
  }

  listen("agent-hotline://tray-action", (event) => {
    const action = event.payload?.action || "unknown";
    if (action === "read-latest") return playSelectedOn("preview");
    if (action === "stop") return void playback.stop().catch(showError);
    if (action === "pause-resume") return playback.isPaused ? playback.resume() : playback.pause();
    if (action === "mute-unmute") {
      const muted = latestState?.settings?.mute !== true;
      return void playback.setMute(muted).catch(showError);
    }
    refreshPanel(targetUrl, { quiet: true }).catch(showError);
  }).catch(() => {});
}

setView("blank");
initWindowChrome();
subscribeTrayEvents();
runStartupExperience().catch((error) => {
  revealAppShell();
  hideStartupSplash(document.getElementById("startup-splash"));
  showError(error);
});
window.setInterval(
  () => refreshPanel(targetUrl, { quiet: true }).catch(showError),
  QUEUE_POLL_INTERVAL_MS
);
window.setInterval(updatePlaybackUi, 150);
