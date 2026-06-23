import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import * as notification from "@tauri-apps/plugin-notification";
import { createPlaybackController } from "./playback.js";
import { shouldAutoReadPending, getNextPendingItem } from "./read-mode.js";
import { initSettingsUi } from "./settings-ui.js";

const isTauri = Boolean(window.__TAURI_INTERNALS__);

const DEFAULT_BACKEND_URL = "http://127.0.0.1:4777";
const STATUS_LABELS = {
  idle: "Idle",
  pending: "Pending",
  speaking: "Speaking",
  paused: "Paused",
  muted: "Muted",
  skipped: "Skipped",
  error: "Error"
};
const QUEUE_POLL_INTERVAL_MS = 1000;
const AUTO_READ_STORAGE_KEY = "agent-hotline.auto-read-attempted";

// Inline icons so the transport stays icon-only while reflecting state.
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
// Speaker with a diagonal slash = the mute control.
const ICON_SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M4.5 4.5 19.5 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const el = (id) => document.getElementById(id);
const statusBadge = el("status-badge");
const queueCount = el("queue-count");
const readMode = el("read-mode");
const sourceApp = el("source-app");
const itemTime = el("item-time");
const itemStatus = el("item-status");
const previewText = el("preview-text");
const previewMeta = el("preview-meta");
const seekBar = el("seek-bar");
const prevButton = el("prev-button");
const playPauseButton = el("playpause-button");
const nextButton = el("next-button");
const muteButton = el("mute-button");
const refreshButton = el("refresh");
const historyList = el("history");
const actionHint = el("action-hint");
const backendUrl = el("backend-url");
const tabHome = el("tab-home");
const tabSettings = el("tab-settings");
const panelHome = el("panel-home");
const panelSettings = el("panel-settings");

let playback = null;
let settingsUi = null;
let latestState = null;
let refreshInFlight = false;
let selectedItemId = null;
let lastLatestId = null;
let seekDragging = false;
// Signature of the last rendered backend payload; lets quiet polls skip a
// no-op DOM rebuild (see refreshPanel) so selections survive.
let lastDataSig = null;
// History view: either the session list, or one session's detail. Default lands
// on the most recent session so a fresh reply is visible without scrolling.
let historyView = { mode: "detail", sessionKey: null };
let autoReadAttemptedItemIds = loadAutoReadAttempted();

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
  } catch {
    // best-effort cache only
  }
}

function setTab(tab) {
  const home = tab === "home";
  tabHome.classList.toggle("is-active", home);
  tabSettings.classList.toggle("is-active", !home);
  panelHome.hidden = !home;
  panelSettings.hidden = home;
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

function readableMode(value) {
  if (value === "ask_every_time") return "Ask";
  if (value === "auto") return "Auto";
  return "Manual";
}

function setStatus(kind) {
  const k = STATUS_LABELS[kind] ? kind : "error";
  statusBadge.className = `status-badge is-${k}`;
  statusBadge.textContent = STATUS_LABELS[k];
}

function notify(message) {
  actionHint.textContent = message;
}

// OS notification on a new reply (opt-in, and only when the app isn't focused so
// it never toasts while you're looking at the panel).
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
  } catch {
    // notifications unavailable; the in-app state still updates
  }
}

// All items that carry speakable text, oldest -> newest (queue order).
function speakableItems(queue) {
  const items = Array.isArray(queue.items) ? queue.items : [];
  return items.filter((item) => item.speakableText && item.speakableText.trim());
}

function findSelected(items) {
  return items.find((item) => item.id === selectedItemId) || null;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function threadKey(item) {
  return item.threadId || `app:${item.sourceApp}`;
}

function threadLabel(item) {
  if (item.sessionName) return item.sessionName;
  if (item.threadLabel) return item.threadLabel;
  if (item.threadId) return `${item.sourceApp} · ${item.threadId.slice(0, 8)}`;
  return `${item.sourceApp} · direct`;
}

function deriveStatus(settings, playerState, selected) {
  if (settings.mute) return "muted";
  if (playerState === "paused") return "paused";
  if (playerState === "speaking") return "speaking";
  if (Array.isArray(latestState?.queue?.pending) && latestState.queue.pending.length > 0) {
    return "pending";
  }
  if (selected?.status === "skipped") return "skipped";
  return "idle";
}

function renderNowCard(selected) {
  if (!selected) {
    sourceApp.textContent = "None";
    itemTime.textContent = "";
    itemStatus.textContent = "none";
    previewText.textContent = "No speakable text yet.";
    previewMeta.textContent = "Waiting for Codex or Claude output.";
    return;
  }
  sourceApp.textContent = selected.sourceApp;
  itemTime.textContent = formatTime(selected.timestamps?.createdAt);
  itemStatus.textContent = selected.status;
  previewText.textContent = selected.speakableText;
  previewMeta.textContent = selected.replayOf
    ? "Replay of an earlier item."
    : threadLabel(selected);
}

// Group speakable items into sessions (threads), ordered newest session first.
function buildSessions(items) {
  const groups = new Map();
  for (const item of items) {
    const key = threadKey(item);
    if (!groups.has(key)) groups.set(key, { key, label: threadLabel(item), items: [] });
    const group = groups.get(key);
    group.items.push(item);
    group.label = threadLabel(item); // newest item wins the label
  }
  return [...groups.values()].sort((a, b) => {
    const ta = a.items[a.items.length - 1]?.timestamps?.createdAt || "";
    const tb = b.items[b.items.length - 1]?.timestamps?.createdAt || "";
    return tb.localeCompare(ta);
  });
}

function buildHistoryItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `history-item${item.id === selectedItemId ? " is-selected" : ""}`;
  button.dataset.id = item.id;

  const time = document.createElement("span");
  time.className = "h-time";
  time.textContent = formatTime(item.timestamps?.createdAt);

  const text = document.createElement("span");
  text.className = "h-text";
  text.textContent = item.speakableText;

  button.append(time, text);
  if (item.replayOf) {
    const badge = document.createElement("span");
    badge.className = "h-badge";
    badge.textContent = "↻";
    button.append(badge);
  }
  return button;
}

function renderSessionList(sessions) {
  // Same capped, scrollable container as the detail view so the two match.
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const session of sessions) {
    const last = session.items[session.items.length - 1];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "session-row";
    row.dataset.session = session.key;

    const label = document.createElement("span");
    label.className = "session-label";
    label.textContent = session.label;

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.items.length} · ${formatTime(last?.timestamps?.createdAt)}`;

    row.append(label, meta);
    scroll.append(row);
  }
  historyList.replaceChildren(scroll);
}

function renderSessionDetail(session) {
  const fragment = document.createDocumentFragment();

  const head = document.createElement("div");
  head.className = "detail-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "back-button";
  back.dataset.action = "back";
  back.textContent = "‹ Sessions";
  const label = document.createElement("span");
  label.className = "detail-label";
  label.textContent = session.label;
  head.append(back, label);
  fragment.append(head);

  // Newest first, capped height + scroll (see .detail-scroll), so older items
  // are reachable by scrolling down without growing the page.
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const item of [...session.items].reverse()) {
    scroll.append(buildHistoryItem(item));
  }
  fragment.append(scroll);
  historyList.replaceChildren(fragment);
}

function renderHistory(items) {
  if (items.length === 0) {
    historyView = { mode: "detail", sessionKey: null };
    historyList.innerHTML = '<p class="history-empty">Nothing has been spoken yet.</p>';
    return;
  }

  const sessions = buildSessions(items);
  if (historyView.mode === "list") {
    renderSessionList(sessions);
    return;
  }

  let session = sessions.find((entry) => entry.key === historyView.sessionKey);
  if (!session) {
    session = sessions[0];
    historyView = { mode: "detail", sessionKey: session.key };
  }
  renderSessionDetail(session);
}

// Highlight the spoken-so-far portion of the text, accurate to the sentence
// (chunk) boundaries with linear interpolation inside the current sentence.
function renderHighlightAt(currentSec, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return;
  let activeIdx = segments.findIndex((seg) => currentSec < seg.endSec);
  if (activeIdx === -1) activeIdx = segments.length - 1;

  let highlightChars = 0;
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const text = segments[i].text;
    parts.push(text);
    if (i < activeIdx) {
      highlightChars += text.length + 1; // include the joining space
    } else if (i === activeIdx) {
      const seg = segments[i];
      const span = Math.max(0.001, seg.endSec - seg.startSec);
      const within = Math.min(1, Math.max(0, (currentSec - seg.startSec) / span));
      highlightChars += Math.round(within * text.length);
    }
  }

  const full = parts.join(" ");
  highlightChars = Math.min(full.length, Math.max(0, highlightChars));
  const done = document.createElement("span");
  done.className = "spoken-done";
  done.textContent = full.slice(0, highlightChars);
  const rest = document.createElement("span");
  rest.textContent = full.slice(highlightChars);
  previewText.replaceChildren(done, rest);
}

// Poll playback position to drive the seek bar + highlight while audio plays.
function updatePlaybackUi() {
  const pos = playback?.getPlaybackPosition?.();
  if (!pos) {
    seekBar.disabled = true;
    if (!seekDragging) seekBar.value = "0";
    return;
  }
  seekBar.disabled = false;
  if (!seekDragging) {
    seekBar.value = String(Math.round(pos.fraction * 1000));
    if (latestState?.settings?.highlightSpokenText) {
      renderHighlightAt(pos.currentSec, pos.segments);
    }
  }
}

function updateControls(settings, items, selected) {
  const index = items.findIndex((item) => item.id === selectedItemId);
  prevButton.disabled = index <= 0;
  nextButton.disabled = index < 0 || index >= items.length - 1;

  // One button cycles read -> pause -> resume.
  const speaking = playback?.isSpeaking;
  const paused = playback?.isPaused;
  playPauseButton.innerHTML = speaking ? ICON_PAUSE : ICON_PLAY;
  const ppLabel = speaking ? "Pause" : paused ? "Resume" : "Read aloud";
  playPauseButton.title = ppLabel;
  playPauseButton.setAttribute("aria-label", ppLabel);
  playPauseButton.disabled = settings.mute || (!selected && !speaking && !paused);

  const muteLabel = settings.mute ? "Unmute" : "Mute";
  muteButton.innerHTML = settings.mute ? ICON_SPEAKER_MUTED : ICON_SPEAKER;
  muteButton.title = muteLabel;
  muteButton.setAttribute("aria-label", muteLabel);
}

function renderState({ settings, queue }) {
  latestState = { settings, queue };
  const items = speakableItems(queue);

  // Surface the newest item automatically (so manual mode shows new arrivals).
  const latest = items[items.length - 1] || null;
  if (latest && latest.id !== lastLatestId) {
    const firstLoad = lastLatestId === null;
    selectedItemId = latest.id;
    lastLatestId = latest.id;
    if (!firstLoad) maybeNotify(latest, settings);
  }
  if (!findSelected(items)) selectedItemId = latest ? latest.id : null;

  const selected = findSelected(items);
  const pendingCount = Array.isArray(queue.pending) ? queue.pending.length : 0;

  queueCount.textContent = String(pendingCount);
  readMode.textContent = readableMode(settings.readBehavior);
  setStatus(deriveStatus(settings, playback?.state, selected));
  renderNowCard(selected);
  renderHistory(items);
  updateControls(settings, items, selected);
  settingsUi?.render(settings);
  runAutoRead(settings, queue);
}

function runAutoRead(settings, queue) {
  if (!playback) return;
  if (
    !shouldAutoReadPending({
      settings,
      queue,
      playbackActive: playback.isSpeaking || playback.isPaused,
      attemptedItemIds: autoReadAttemptedItemIds
    })
  ) {
    return;
  }
  const item = getNextPendingItem(queue);
  rememberAutoReadAttempt(item.id);
  notify("Auto mode found a new item. Starting playback...");
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
    // Skip the DOM rebuild when a background poll sees no change, so an active
    // text selection / copy is never interrupted by replaceChildren. Forced
    // renders (playback state, manual refresh) always go through.
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
}

function moveSelection(delta) {
  if (!latestState) return;
  const items = speakableItems(latestState.queue);
  const index = items.findIndex((item) => item.id === selectedItemId);
  if (index < 0) return;
  const next = items[index + delta];
  if (!next) return;
  selectedItemId = next.id;
  renderState(latestState);
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
    }
    refreshPanel(targetUrl, { quiet: true }).catch(showError);
  }
});

playback = createPlaybackController({
  backendUrl: targetUrl,
  onUpdate: notify,
  onStateChanged: () => refreshPanel(targetUrl, { quiet: true, force: true }).catch(showError)
});

tabHome.addEventListener("click", () => setTab("home"));
tabSettings.addEventListener("click", () => setTab("settings"));
refreshButton.addEventListener("click", () => refreshWithSpin());

// Spin the refresh icon on click (min 500ms so the feedback is always visible,
// even when the refresh returns instantly).
async function refreshWithSpin() {
  refreshButton.classList.add("is-spinning");
  const started = Date.now();
  try {
    await refreshPanel(targetUrl, { force: true });
  } catch (error) {
    showError(error);
  } finally {
    const wait = Math.max(0, 500 - (Date.now() - started));
    window.setTimeout(() => refreshButton.classList.remove("is-spinning"), wait);
  }
}
prevButton.addEventListener("click", () => moveSelection(-1));
nextButton.addEventListener("click", () => moveSelection(1));
playPauseButton.addEventListener("click", () => {
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  playSelected();
});
muteButton.addEventListener("click", () => {
  const muted = latestState?.settings?.mute !== true;
  playback.setMute(muted).catch(showError);
});

seekBar.addEventListener("pointerdown", () => (seekDragging = true));
seekBar.addEventListener("input", () => {
  seekDragging = true;
  if (!latestState?.settings?.highlightSpokenText) return;
  const pos = playback?.getPlaybackPosition?.();
  if (pos) renderHighlightAt((Number(seekBar.value) / 1000) * pos.totalSec, pos.segments);
});
seekBar.addEventListener("change", () => {
  seekDragging = false;
  playback?.seek?.(Number(seekBar.value) / 1000);
});
seekBar.addEventListener("blur", () => (seekDragging = false));

historyList.addEventListener("click", (event) => {
  if (event.target.closest(".back-button")) {
    historyView = { mode: "list", sessionKey: null };
    if (latestState) renderState(latestState);
    return;
  }

  const row = event.target.closest(".session-row");
  if (row) {
    historyView = { mode: "detail", sessionKey: row.dataset.session };
    if (latestState) renderState(latestState);
    return;
  }

  const item = event.target.closest(".history-item");
  if (!item) return;
  selectedItemId = item.dataset.id;
  if (latestState) renderState(latestState);
  playSelected();
});

// Subscribe to tray events without ever blocking startup: if the IPC layer is
// unavailable the listeners are simply skipped, but the refresh loop below
// must still start so the panel keeps itself current on its own.
function subscribeTrayEvents() {
  if (!window.__TAURI_INTERNALS__) return;

  listen("agent-hotline://show", () => refreshPanel(targetUrl).catch(showError)).catch(() => {});

  // Clicking a notification opens the full window or the mini popup per setting.
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
    if (action === "read-latest") return playSelected();
    if (action === "stop") return void playback.stop().catch(showError);
    if (action === "pause-resume") return playback.isPaused ? playback.resume() : playback.pause();
    if (action === "mute-unmute") {
      const muted = latestState?.settings?.mute !== true;
      return void playback.setMute(muted).catch(showError);
    }
    refreshPanel(targetUrl, { quiet: true }).catch(showError);
  }).catch(() => {});
}

setTab("home");
subscribeTrayEvents();
refreshPanel(targetUrl).catch(showError);
window.setInterval(
  () => refreshPanel(targetUrl, { quiet: true }).catch(showError),
  QUEUE_POLL_INTERVAL_MS
);
window.setInterval(updatePlaybackUi, 150);
