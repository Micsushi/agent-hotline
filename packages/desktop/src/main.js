import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { createPlaybackController } from "./playback.js";
import { shouldAutoReadPending, getNextPendingItem } from "./read-mode.js";
import { initSettingsUi } from "./settings-ui.js";

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

const el = (id) => document.getElementById(id);
const statusBadge = el("status-badge");
const queueCount = el("queue-count");
const readMode = el("read-mode");
const sourceApp = el("source-app");
const itemTime = el("item-time");
const itemStatus = el("item-status");
const previewText = el("preview-text");
const previewMeta = el("preview-meta");
const prevButton = el("prev-button");
const readButton = el("read-button");
const nextButton = el("next-button");
const pauseButton = el("pause-button");
const resumeButton = el("resume-button");
const stopButton = el("stop-button");
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
// Per-thread expand state. Unset = use default (only the newest group open).
const threadExpand = new Map();
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

function renderHistory(items) {
  if (items.length === 0) {
    historyList.innerHTML = '<p class="history-empty">Nothing has been spoken yet.</p>';
    return;
  }

  const groups = new Map();
  for (const item of [...items].reverse()) {
    const key = threadKey(item);
    if (!groups.has(key)) groups.set(key, { key, label: threadLabel(item), items: [] });
    groups.get(key).items.push(item);
  }

  const topKey = groups.keys().next().value;
  const fragment = document.createDocumentFragment();
  for (const group of groups.values()) {
    const expanded = threadExpand.has(group.key)
      ? threadExpand.get(group.key)
      : group.key === topKey;

    const wrap = document.createElement("div");
    wrap.className = "thread-group";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "thread-head";
    head.dataset.thread = group.key;
    const label = document.createElement("span");
    label.className = "thread-label";
    label.textContent = `${expanded ? "▾" : "▸"} ${group.label}`;
    const count = document.createElement("span");
    count.className = "thread-count";
    count.textContent = `${group.items.length}`;
    head.append(label, count);
    wrap.append(head);

    if (expanded) {
      for (const item of group.items) {
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
        wrap.append(button);
      }
    }
    fragment.append(wrap);
  }

  historyList.replaceChildren(fragment);
}

function updateControls(settings, items, selected) {
  const index = items.findIndex((item) => item.id === selectedItemId);
  prevButton.disabled = index <= 0;
  nextButton.disabled = index < 0 || index >= items.length - 1;
  readButton.disabled = !selected || settings.mute;
  pauseButton.disabled = !playback?.isSpeaking || settings.mute;
  resumeButton.disabled = !playback?.isPaused || settings.mute;
  stopButton.disabled = !(playback?.isSpeaking || playback?.isPaused);
  muteButton.textContent = settings.mute ? "Unmute" : "Mute";
}

function renderState({ settings, queue }) {
  latestState = { settings, queue };
  const items = speakableItems(queue);

  // Surface the newest item automatically (so manual mode shows new arrivals).
  const latest = items[items.length - 1] || null;
  if (latest && latest.id !== lastLatestId) {
    selectedItemId = latest.id;
    lastLatestId = latest.id;
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

async function refreshPanel(url, { quiet = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (!quiet) notify("Refreshing...");
  try {
    const [{ settings }, { queue }] = await Promise.all([
      fetchJson(`${url}/api/settings`),
      fetchJson(`${url}/api/queue`)
    ]);
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
  readButton.disabled = true;
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
  onStateChanged: () => refreshPanel(targetUrl, { quiet: true }).catch(showError)
});

tabHome.addEventListener("click", () => setTab("home"));
tabSettings.addEventListener("click", () => setTab("settings"));
refreshButton.addEventListener("click", () => refreshPanel(targetUrl).catch(showError));
prevButton.addEventListener("click", () => moveSelection(-1));
nextButton.addEventListener("click", () => moveSelection(1));
readButton.addEventListener("click", playSelected);
pauseButton.addEventListener("click", () => playback.pause());
resumeButton.addEventListener("click", () => playback.resume());
stopButton.addEventListener("click", () => playback.stop().catch(showError));
muteButton.addEventListener("click", () => {
  const muted = latestState?.settings?.mute !== true;
  playback.setMute(muted).catch(showError);
});

historyList.addEventListener("click", (event) => {
  const head = event.target.closest(".thread-head");
  if (head) {
    const key = head.dataset.thread;
    const topKey = historyList.querySelector(".thread-head")?.dataset.thread;
    const current = threadExpand.has(key) ? threadExpand.get(key) : key === topKey;
    threadExpand.set(key, !current);
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
