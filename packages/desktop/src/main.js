import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as notification from "@tauri-apps/plugin-notification";
import { createPlaybackController } from "./playback.js";
import { shouldAutoReadPending, getNextPendingItem } from "./read-mode.js";
import { initSettingsUi } from "./settings-ui.js";
import {
  listCache,
  deleteCacheAll,
  deleteCacheSession,
  deleteCacheProject,
  deleteCacheItem
} from "./audio-cache.js";
import { groupByProjectSession, latestCreatedAt, projectKeyOf, sessionKeyOf } from "./grouping.js";
import { applyProjectColor, applyOwnerColor, ownerSolidColor } from "./project-colors.js";
import { openColorMenu } from "./color-menu.js";
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
const AUDIO_CACHE_LIMIT_MAX_MB = 100000;

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_SPINNER = '<span class="spinner" aria-hidden="true"></span>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M4.5 4.5 19.5 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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
const navStorage = el("nav-storage");
const navSettings = el("nav-settings");
const viewBlank = el("view-blank");
const viewChats = el("view-chats");
const viewStorage = el("view-storage");
const viewSettings = el("view-settings");
const projectsList = el("projects-list");
const sessionsList = el("sessions-list");
const sessionsPane = el("sessions-pane");
const messagesPane = el("messages-pane");
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
let voiceTrackInit = false;
let lastDataSig = null;
let historyView = { level: "messages", projectKey: null, sessionKey: null };
let storageView = { projectKey: null, sessionKey: null };
let autoReadAttemptedItemIds = loadAutoReadAttempted();
let highlightSurface = "preview";

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

function rememberAutoReadAttempt(itemId) {
  if (!itemId) return;
  autoReadAttemptedItemIds.add(itemId);
  const recent = Array.from(autoReadAttemptedItemIds).slice(-100);
  autoReadAttemptedItemIds = new Set(recent);
  try {
    window.sessionStorage.setItem(AUTO_READ_STORAGE_KEY, JSON.stringify(recent));
  } catch {}
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

let currentView = "blank";

// Nav rail drives a single workspace view. "chats" and "storage" cascade their
// own columns; "settings" fills the page; "blank" is the fresh/empty state.
function setView(view) {
  const active = ["chats", "storage", "settings"].includes(view) ? view : "blank";
  // Switching away from chats counts as leaving the open thread: flush it read.
  if (currentView === "chats" && active !== "chats") leaveOpenSession();
  currentView = active;
  if (navChats) navChats.classList.toggle("is-active", active === "chats");
  if (navStorage) navStorage.classList.toggle("is-active", active === "storage");
  if (navSettings) navSettings.classList.toggle("is-active", active === "settings");
  if (viewBlank) viewBlank.hidden = active !== "blank";
  if (viewChats) viewChats.hidden = active !== "chats";
  if (viewStorage) viewStorage.hidden = active !== "storage";
  if (viewSettings) viewSettings.hidden = active !== "settings";
  if (active === "storage") loadAudioCache().catch(showError);
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
  if (!isTauri || !settings?.notifyOnNewReply || document.hasFocus()) return;
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
  return items.filter((item) => item.speakableText && item.speakableText.trim());
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

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

// History groups newest-first; Storage groups largest-first. Both run through
// the shared grouper in grouping.js so the two trees stay in lockstep.
function buildProjects(items) {
  return groupByProjectSession(items, { sortBy: "recent", dropUnnamed: true });
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

// A user prompt bubble (right side). Display-only: never read aloud. Clicking it
// expands the clamped body. No id/owner chrome -- it is the human half of the turn.
function buildUserBubble(text, createdAt) {
  const row = document.createElement("div");
  row.className = "convo-row is-user";

  const bubble = document.createElement("div");
  bubble.className = "bubble bubble-user";

  const body = document.createElement("div");
  body.className = "bubble-body";
  body.textContent = text;

  bubble.append(buildBubbleTail(), body);
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
  body.textContent = item.speakableText;

  bubble.append(buildBubbleTail(), play, body, buildNowPlayingIcon());
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

function buildNowPlayingIcon() {
  const icon = document.createElement("span");
  icon.className = "now-playing-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICON_SPEAKER;
  return icon;
}

function nowPlayingItem() {
  if (!playback) return null;
  if (!playback.isSpeaking && !playback.isLoading) return null;
  const id = playback.activeItemId;
  if (!id) return null;
  return speakableItems(latestState?.queue || {}).find((item) => item.id === id) || null;
}

function updateNowPlayingIndicators() {
  const item = nowPlayingItem();
  const projectKey = item ? projectKeyOf(item) : null;
  const sessionKey = item ? sessionKeyOf(item) : null;
  const ownerColor = item ? ownerSolidColor(item.sourceApp) : null;
  const paintIcon = (el, on) => {
    const icon = el.querySelector(".now-playing-icon");
    if (icon) icon.style.color = on ? ownerColor : "";
  };
  for (const btn of projectsList.querySelectorAll(".tree-item")) {
    const on = Boolean(projectKey) && btn.dataset.project === projectKey;
    btn.classList.toggle("is-playing", on);
    paintIcon(btn, on);
  }
  for (const btn of sessionsList.querySelectorAll(".tree-item")) {
    const on = Boolean(sessionKey) && btn.dataset.session === sessionKey;
    btn.classList.toggle("is-playing", on);
    paintIcon(btn, on);
  }
  for (const bubble of historyList.querySelectorAll(".bubble-assistant")) {
    bubble.classList.toggle("is-playing", Boolean(item) && bubble.dataset.id === item.id);
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
  if (body) body.textContent = item.speakableText;
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

function renderProjectsList(projects) {
  projectsList.replaceChildren();
  for (const project of projects) {
    const btn = document.createElement("button");
    btn.className = `tree-item ${project.key === historyView.projectKey ? "is-selected" : ""}`;
    btn.dataset.project = project.key;
    applyProjectColor(btn, project);
    const titleRow = document.createElement("span");
    titleRow.className = "tree-item-head";
    const title = document.createElement("span");
    title.className = "tree-item-title";
    title.textContent = project.label;
    titleRow.append(title, buildNowPlayingIcon());
    let unread = unreadCount(project.items);
    const openSession = project.sessions.find((s) => isSessionOpen(s));
    if (openSession) unread = Math.max(0, unread - unreadCount(openSession.items));
    if (unread > 0) titleRow.append(unreadDot(unread));
    const count = project.sessions.length;
    const meta = document.createElement("span");
    meta.className = "tree-item-meta";
    meta.textContent = `${count} session${count === 1 ? "" : "s"} - ${formatTime(latestCreatedAt(project.items))}`;
    btn.append(titleRow, meta);
    btn.onclick = () => {
      leaveOpenSession();
      historyView.projectKey = project.key;
      historyView.sessionKey = null;
      renderState(latestState);
    };
    btn.oncontextmenu = (event) => openColorMenu(event, project, () => renderState(latestState));
    projectsList.append(btn);
  }
}

function renderSessionsList(project) {
  if (!project) {
    sessionsPane.hidden = true;
    sessionsList.replaceChildren();
    return;
  }
  sessionsPane.hidden = false;
  sessionsList.replaceChildren();
  for (const session of project.sessions) {
    const btn = document.createElement("button");
    btn.className = `tree-item ${session.key === historyView.sessionKey ? "is-selected" : ""}`;
    btn.dataset.session = session.key;
    applyOwnerColor(btn, session.owner);
    const titleRow = document.createElement("span");
    titleRow.className = "tree-item-head";
    const title = document.createElement("span");
    title.className = "tree-item-title session-title";
    appendSessionTitle(title, session);
    titleRow.append(ownerBadge(session.owner), title, buildNowPlayingIcon());
    const unread = isSessionOpen(session) ? 0 : unreadCount(session.items);
    if (unread > 0) titleRow.append(unreadDot(unread));
    const meta = document.createElement("span");
    meta.className = "tree-item-meta";
    meta.textContent = `${session.items.length} msgs - ${formatTime(latestCreatedAt(session.items))}`;
    btn.append(titleRow, meta);
    btn.onclick = () => {
      if (session.key !== historyView.sessionKey) leaveOpenSession();
      historyView.sessionKey = session.key;
      renderState(latestState);
    };
    sessionsList.append(btn);
  }
}

function renderMessagesDetail(session) {
  if (!session) {
    if (messagesPane) messagesPane.hidden = true;
    historyList.replaceChildren();
    return;
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
    for (const prompt of prompts) {
      fragment.append(buildUserBubble(prompt, item.timestamps?.createdAt));
    }
    fragment.append(buildAssistantBubble(item));
  }
  historyList.replaceChildren(fragment);
  markClampedBubbles();
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
  // The bottom preview always follows progress. Inline and modal highlights get
  // the colored treatment only when that surface is active.
  if (colored) {
    const bubbleBody = selectedInlineBubbleBody();
    if (highlightSurface === "inline" && bubbleBody) {
      renderHighlight(bubbleBody, currentSec, segments, wordAccurate, "center", true);
      renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", false);
      return;
    }
    if (highlightSurface === "modal" && isModalOpen()) {
      renderHighlight(modalBody, currentSec, segments, wordAccurate, "center", true);
      renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", false);
      return;
    }
  }
  renderHighlight(previewText, currentSec, segments, wordAccurate, "pair", colored);
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
  if (latest && latest.id !== lastLatestId) {
    const firstLoad = lastLatestId === null;
    selectedItemId = latest.id;
    lastLatestId = latest.id;
    if (!firstLoad) maybeNotify(latest, settings);
  }
  if (!findSelected(items)) selectedItemId = latest ? latest.id : null;

  const selected = findSelected(items);
  const statusKind = deriveStatus(settings, playback?.state, selected);
  setStatus(statusKind);
  renderNowCard(selected, statusKind);
  renderHistory(items);
  updateNowPlayingIndicators();
  updateControls(settings, items, selected);
  updateModal();
  settingsUi?.render(settings);
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

function moveSelection(delta) {
  if (!latestState) return false;
  const items = sessionScopedItems(speakableItems(latestState.queue), selectedItemId);
  const index = items.findIndex((item) => item.id === selectedItemId);
  if (index < 0) return false;
  const next = items[index + delta];
  if (!next) return false;
  selectedItemId = next.id;
  renderState(latestState);
  return true;
}

function jumpSelection(edge) {
  if (!latestState) return false;
  const items = sessionScopedItems(speakableItems(latestState.queue), selectedItemId);
  if (!items.length) return false;
  const target = edge === "first" ? items[0] : items[items.length - 1];
  if (!target || target.id === selectedItemId) return false;
  selectedItemId = target.id;
  renderState(latestState);
  return true;
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
    if (bubbleBody) bubbleBody.textContent = item.speakableText;
  }
  if (surface !== "modal" && modalBody?.dataset.itemId === item.id) {
    modalBody.textContent = item.speakableText;
  }
  if (surface !== "preview") {
    renderNowCard(item);
  }
}

let audioCacheData = null;
// Three independent selection sets, one per storage level. "Delete selected"
// acts on the union; a checked project/session subsumes its own descendants so
// we never fire redundant per-item deletes for things already covered above.
const audioSelected = new Set();
const projectSelected = new Set();
const sessionSelected = new Set();

function selectionTotal() {
  return audioSelected.size + projectSelected.size + sessionSelected.size;
}

function updateDeleteSelectedState() {
  const deleteSelected = el("audio-delete-selected");
  if (deleteSelected) deleteSelected.disabled = selectionTotal() === 0;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function cacheEntryKey(entry) {
  return `${entry.itemId}__${entry.engine}__${entry.voice}`;
}

function buildProjectTree(entries) {
  return groupByProjectSession(entries, { sortBy: "bytes", dropUnnamed: true });
}

async function loadAudioCache() {
  const summary = el("audio-summary");
  try {
    audioCacheData = await listCache(targetUrl);
    renderAudioCache();
  } catch (error) {
    if (summary) summary.textContent = `Could not load saved audio: ${error.message}`;
  }
}

// A storage row mirrors a Chats tree-item (owner badge + label + meta) with a
// leading selection checkbox. The checkbox marks the whole level for the bulk
// "Delete selected" action; there is no per-row delete button.
function storageRow(kind, key, label, owner, metaText, selectedKey, checked) {
  const wrap = document.createElement("div");
  wrap.className = "tree-row";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "tree-check";
  check.dataset[kind === "project" ? "pcheck" : "scheck"] = key;
  check.checked = Boolean(checked);
  check.title = kind === "project" ? "Select this project" : "Select this chat";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `tree-item ${key === selectedKey ? "is-selected" : ""}`;
  btn.dataset[kind === "project" ? "sproject" : "ssession"] = key;

  const head = document.createElement("span");
  head.className = "tree-item-head";
  if (kind === "project") {
    const pseudo = { key, label };
    applyProjectColor(btn, pseudo);
    btn.oncontextmenu = (event) => openColorMenu(event, pseudo, () => renderAudioCache());
  } else {
    applyOwnerColor(btn, owner);
    head.append(ownerBadge(owner));
  }
  const title = document.createElement("span");
  title.className = "tree-item-title";
  title.textContent = label;
  head.append(title);

  const meta = document.createElement("span");
  meta.className = "tree-item-meta";
  meta.textContent = metaText;
  btn.append(head, meta);

  wrap.append(check, btn);
  return wrap;
}

function renderStorageSessions(project) {
  const pane = el("storage-sessions-pane");
  const col = el("storage-sessions");
  const title = el("storage-project-title");
  if (!project) {
    if (pane) pane.hidden = true;
    if (col) col.replaceChildren();
    return;
  }
  if (pane) pane.hidden = false;
  if (title) title.textContent = "Sessions";
  col.replaceChildren();
  for (const session of project.sessions) {
    col.append(
      storageRow(
        "session",
        session.key,
        session.label,
        session.owner,
        `${session.items.length}  -  ${formatBytes(session.bytes)}`,
        storageView.sessionKey,
        sessionSelected.has(session.key)
      )
    );
  }
}

function renderStorageRecordings(session) {
  const pane = el("storage-recordings-pane");
  const listEl = el("audio-list");
  const title = el("storage-session-title");
  if (!session) {
    if (pane) pane.hidden = true;
    if (listEl) listEl.replaceChildren();
    return;
  }
  if (pane) pane.hidden = false;
  if (title) title.textContent = session.label;
  const fragment = document.createDocumentFragment();
  for (const entry of session.items) {
    const row = document.createElement("label");
    row.className = "manage-item";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.dataset.entry = cacheEntryKey(entry);
    check.checked = audioSelected.has(cacheEntryKey(entry));

    const text = document.createElement("span");
    text.className = "manage-item-text";
    text.textContent = entry.preview || entry.itemId;

    const size = document.createElement("span");
    size.className = "session-meta";
    size.textContent = `${entry.voice}  -  ${formatBytes(entry.bytes)}`;

    row.append(check, text, size);
    fragment.append(row);
  }
  listEl.replaceChildren(fragment);
}

// Storage is the same progressive Project > Session > Recordings cascade as
// Chats, so the column headers double as the breadcrumb of where you are.
function renderAudioCache() {
  const summary = el("audio-summary");
  const deleteSelected = el("audio-delete-selected");
  const limitInput = el("audio-limit");
  const projectsCol = el("storage-projects");
  if (!audioCacheData || !summary || !projectsCol) return;

  const { entries, totalBytes, maxBytes } = audioCacheData;
  summary.textContent = entries.length
    ? `${entries.length} saved  -  ${formatBytes(totalBytes)} of ${formatBytes(maxBytes)} used`
    : "No saved audio yet. New replies are saved automatically as they arrive.";

  if (limitInput && document.activeElement !== limitInput) {
    limitInput.value = String(Math.round(maxBytes / 1024 / 1024));
  }

  const liveKeys = new Set(entries.map(cacheEntryKey));
  for (const key of [...audioSelected]) if (!liveKeys.has(key)) audioSelected.delete(key);

  if (entries.length === 0) {
    projectSelected.clear();
    sessionSelected.clear();
    storageView = { projectKey: null, sessionKey: null };
    projectsCol.innerHTML = '<p class="history-empty">Nothing saved yet.</p>';
    renderStorageSessions(null);
    renderStorageRecordings(null);
    if (deleteSelected) deleteSelected.disabled = selectionTotal() === 0;
    return;
  }

  const projects = buildProjectTree(entries);
  // Drop checkbox selections whose project/session no longer exists.
  const liveProjects = new Set(projects.map((p) => p.key));
  const liveSessions = new Set(projects.flatMap((p) => p.sessions.map((s) => s.key)));
  for (const key of [...projectSelected]) if (!liveProjects.has(key)) projectSelected.delete(key);
  for (const key of [...sessionSelected]) if (!liveSessions.has(key)) sessionSelected.delete(key);
  if (deleteSelected) deleteSelected.disabled = selectionTotal() === 0;
  projectsCol.replaceChildren();
  for (const project of projects) {
    const count = project.sessions.length;
    projectsCol.append(
      storageRow(
        "project",
        project.key,
        project.label,
        project.owner,
        `${count} chat${count === 1 ? "" : "s"}  -  ${formatBytes(project.bytes)}`,
        storageView.projectKey,
        projectSelected.has(project.key)
      )
    );
  }

  const project = storageView.projectKey
    ? projects.find((entry) => entry.key === storageView.projectKey)
    : null;
  if (storageView.projectKey && !project) {
    storageView.projectKey = null;
    storageView.sessionKey = null;
  }
  renderStorageSessions(project);

  const session =
    project && storageView.sessionKey
      ? project.sessions.find((entry) => entry.key === storageView.sessionKey)
      : null;
  if (project && storageView.sessionKey && !session) storageView.sessionKey = null;
  renderStorageRecordings(session);
}

async function runCacheDelete(action) {
  try {
    await action();
    await loadAudioCache();
  } catch (error) {
    showError(error);
  }
}

function setupManageTab() {
  const refreshBtn = el("audio-refresh");
  const deleteAllBtn = el("audio-delete-all");
  const deleteSelectedBtn = el("audio-delete-selected");
  const limitInput = el("audio-limit");
  const listEl = el("audio-list");
  const cascade = el("storage-cascade");

  refreshBtn?.addEventListener("click", () => loadAudioCache().catch(showError));

  limitInput?.addEventListener("change", async () => {
    const mb = Math.round(Number(limitInput.value));
    if (!Number.isFinite(mb) || mb < 10 || mb > AUDIO_CACHE_LIMIT_MAX_MB) {
      loadAudioCache().catch(showError);
      return;
    }
    try {
      const response = await fetch(`${targetUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioCacheLimitMb: mb })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadAudioCache();
    } catch (error) {
      showError(error);
    }
  });

  deleteAllBtn?.addEventListener("click", () => {
    if (!window.confirm("Delete all saved audio?")) return;
    audioSelected.clear();
    projectSelected.clear();
    sessionSelected.clear();
    runCacheDelete(() => deleteCacheAll(targetUrl));
  });

  deleteSelectedBtn?.addEventListener("click", () => {
    if (selectionTotal() === 0) return;
    // Resolve each checked item back to its session/project so a checked
    // project or session subsumes everything inside it: we only fire the
    // narrowest delete that isn't already covered by a broader one.
    const tree = buildProjectTree(audioCacheData?.entries || []);
    const sessionToProject = new Map();
    const itemOwner = new Map();
    for (const project of tree) {
      for (const session of project.sessions) {
        sessionToProject.set(session.key, project.key);
        for (const entry of session.items) {
          itemOwner.set(cacheEntryKey(entry), {
            projectKey: project.key,
            sessionKey: session.key,
            entry
          });
        }
      }
    }

    const projectsToDelete = [...projectSelected];
    const projectSet = new Set(projectsToDelete);
    const sessionsToDelete = [...sessionSelected].filter(
      (key) => !projectSet.has(sessionToProject.get(key))
    );
    const sessionSet = new Set(sessionsToDelete);
    const itemsToDelete = [...audioSelected]
      .map((key) => itemOwner.get(key))
      .filter(
        (owner) => owner && !projectSet.has(owner.projectKey) && !sessionSet.has(owner.sessionKey)
      )
      .map((owner) => owner.entry);

    audioSelected.clear();
    projectSelected.clear();
    sessionSelected.clear();
    runCacheDelete(async () => {
      for (const key of projectsToDelete) await deleteCacheProject(targetUrl, key);
      for (const key of sessionsToDelete) await deleteCacheSession(targetUrl, key);
      for (const entry of itemsToDelete) {
        await deleteCacheItem(targetUrl, entry.itemId, entry.engine, entry.voice);
      }
    });
  });

  cascade?.addEventListener("click", (event) => {
    // Drill-down cascade (mirrors the Chats tab): clicking a project reveals its
    // sessions column; clicking a session reveals its recordings column.
    const projectRow = event.target.closest(".tree-item[data-sproject]");
    if (projectRow) {
      storageView = { projectKey: projectRow.dataset.sproject, sessionKey: null };
      renderAudioCache();
      return;
    }

    const sessionRow = event.target.closest(".tree-item[data-ssession]");
    if (sessionRow) {
      storageView = { projectKey: storageView.projectKey, sessionKey: sessionRow.dataset.ssession };
      renderAudioCache();
    }
  });

  // Project/session checkboxes toggle their selection set without re-rendering;
  // their checked state lives in the DOM until the next render reads the set.
  cascade?.addEventListener("change", (event) => {
    const pcheck = event.target.closest("input[data-pcheck]");
    if (pcheck) {
      if (pcheck.checked) projectSelected.add(pcheck.dataset.pcheck);
      else projectSelected.delete(pcheck.dataset.pcheck);
      updateDeleteSelectedState();
      return;
    }
    const scheck = event.target.closest("input[data-scheck]");
    if (scheck) {
      if (scheck.checked) sessionSelected.add(scheck.dataset.scheck);
      else sessionSelected.delete(scheck.dataset.scheck);
      updateDeleteSelectedState();
    }
  });

  listEl?.addEventListener("change", (event) => {
    const check = event.target.closest("input[type=checkbox][data-entry]");
    if (!check) return;
    if (check.checked) audioSelected.add(check.dataset.entry);
    else audioSelected.delete(check.dataset.entry);
    updateDeleteSelectedState();
  });
}

initColumnResize();

const config = await loadRuntimeConfig();
const targetUrl = config.backendUrl || DEFAULT_BACKEND_URL;
backendUrl.textContent = targetUrl;

settingsUi = initSettingsUi({
  backendUrl: targetUrl,
  onLivePreview: (partial) => playback?.applyLiveSettings(partial),
  onSettingsChanged: (settings) => {
    playback?.applyLiveSettings(settings);
    if (settings?.mute && (playback?.isSpeaking || playback?.isPaused)) {
      playback.stop("User muted playback.").catch(showError);
    } else {
      maybeRestartForVoiceChange(settings);
    }
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
wireNav(navStorage, "storage");
wireNav(navSettings, "settings");
setupManageTab();
function navAndFollow(moved) {
  if (moved && playbackActive()) playSelectedOn("preview");
}
firstButton.addEventListener("click", () => navAndFollow(jumpSelection("first")));
prevButton.addEventListener("click", () => navAndFollow(moveSelection(-1)));
nextButton.addEventListener("click", () => navAndFollow(moveSelection(1)));
lastButton.addEventListener("click", () => navAndFollow(jumpSelection("last")));
playPauseButton.addEventListener("click", () => {
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  highlightSurface = "preview";
  resetInactiveHighlightSurfaces("preview", findSelected(speakableItems(latestState?.queue || {})));
  if (playback.isEnded && playback.replayCurrent()) return;
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
  // Bubble body (user or assistant): toggle the 2-line clamp to show full text.
  const bubble = event.target.closest(".bubble");
  if (bubble) bubble.classList.toggle("is-expanded");
});

el("expand-all")?.addEventListener("click", () => setAllBubblesExpanded(true));
el("collapse-all")?.addEventListener("click", () => setAllBubblesExpanded(false));

// ---- Modal wiring ----------------------------------------------------------
function modalMove(delta) {
  if (!moveSelection(delta)) return;
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
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isModalOpen()) closeModal();
});
modalPlay?.addEventListener("click", () => {
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  highlightSurface = "modal";
  resetInactiveHighlightSurfaces("modal", findSelected(speakableItems(latestState?.queue || {})));
  if (playback.isEnded && playback.replayCurrent()) return;
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
refreshPanel(targetUrl).catch(showError);
window.setInterval(
  () => refreshPanel(targetUrl, { quiet: true }).catch(showError),
  QUEUE_POLL_INTERVAL_MS
);
window.setInterval(updatePlaybackUi, 150);
