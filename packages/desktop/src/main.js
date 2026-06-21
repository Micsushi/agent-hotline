import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createPlaybackController } from "./playback.js";
import {
  canUserChoose,
  describeActionHint,
  getNextPendingItem,
  shouldAutoReadPending
} from "./read-mode.js";
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
const PREVIEW_LIMIT = 420;
const AUTO_READ_STORAGE_KEY = "agent-hotline.auto-read-attempted";

const statusBadge = document.querySelector("#status-badge");
const statusLabel = document.querySelector("#status-label");
const statusDetail = document.querySelector("#status-detail");
const queueCount = document.querySelector("#queue-count");
const readMode = document.querySelector("#read-mode");
const sourceApp = document.querySelector("#source-app");
const itemStatus = document.querySelector("#item-status");
const previewText = document.querySelector("#preview-text");
const previewMeta = document.querySelector("#preview-meta");
const backendUrl = document.querySelector("#backend-url");
const refresh = document.querySelector("#refresh");
const readButton = document.querySelector("#read-button");
const skipButton = document.querySelector("#skip-button");
const pauseButton = document.querySelector("#pause-button");
const resumeButton = document.querySelector("#resume-button");
const stopButton = document.querySelector("#stop-button");
const replayButton = document.querySelector("#replay-button");
const muteButton = document.querySelector("#mute-button");
const actionHint = document.querySelector("#action-hint");

let latestPanelState = null;
let playback = null;
let settingsUi = null;
let autoReadAttemptedItemIds = loadAutoReadAttemptedItemIds();

function loadAutoReadAttemptedItemIds() {
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
  const recentIds = Array.from(autoReadAttemptedItemIds).slice(-100);
  autoReadAttemptedItemIds = new Set(recentIds);
  try {
    window.sessionStorage.setItem(AUTO_READ_STORAGE_KEY, JSON.stringify(recentIds));
  } catch {
    // Losing this cache only means auto mode may retry after a full WebView reset.
  }
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) return {};
    return response.json();
  } catch {
    return {};
  }
}

function setStatus(kind, detail) {
  const statusKind = STATUS_LABELS[kind] ? kind : "error";
  statusBadge.className = `status-badge is-${statusKind}`;
  statusBadge.textContent = STATUS_LABELS[statusKind];
  statusLabel.textContent = STATUS_LABELS[statusKind];
  statusDetail.textContent = detail;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function checkBackendPort(url) {
  if (window.__TAURI_INTERNALS__) {
    return invoke("backend_status", { url });
  }

  try {
    await fetchJson(`${url}/api/health`);
    return { reachable: true, detail: `Connected to ${url}.` };
  } catch {
    return {
      reachable: false,
      detail: "Start the backend with npm run dev:backend, then refresh this panel."
    };
  }
}

function readableMode(value) {
  if (value === "ask_every_time") return "Ask every time";
  if (value === "auto") return "Auto";
  return "Manual";
}

function getLatestSpeakable(queue) {
  if (queue.current) return queue.current;
  if (Array.isArray(queue.pending) && queue.pending.length > 0) return queue.pending[0];
  return queue.latest || null;
}

function truncatePreview(text) {
  const cleanText = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanText) return "No speakable text is queued yet.";
  if (cleanText.length <= PREVIEW_LIMIT) return cleanText;
  return `${cleanText.slice(0, PREVIEW_LIMIT - 1).trim()}...`;
}

function deriveStatus(settings, queue, playerState) {
  const latest = queue.latest || null;

  if (settings.mute) return "muted";
  if (playerState === "paused") return "paused";
  if (playerState === "speaking") return "speaking";
  if (queue.current) return queue.current.status === "paused" ? "paused" : "speaking";
  if (Array.isArray(queue.pending) && queue.pending.length > 0) return "pending";
  if (latest?.status === "skipped") return "skipped";
  return "idle";
}

function describeStatus(kind, settings, queue, item) {
  if (kind === "muted")
    return "Muted is on. The speakable preview remains available as the visual fallback.";
  if (kind === "speaking")
    return "Reading the current speakable queue item through WebView speech synthesis.";
  if (kind === "paused") return "Playback is paused in this WebView.";
  if (kind === "pending")
    return `${queue.pending.length} speakable item${queue.pending.length === 1 ? "" : "s"} waiting.`;
  if (kind === "skipped")
    return item?.skipReason
      ? `Latest item was skipped: ${item.skipReason}`
      : "Latest item was skipped.";
  return `No pending speech. Read mode is ${readableMode(settings.readBehavior)}.`;
}

function updateActions(settings, queue) {
  const enabled = canUserChoose(settings, queue);
  const hasCurrentOrPlayback = Boolean(queue.current) || playback?.isSpeaking || playback?.isPaused;
  const hasReplayable =
    Boolean(queue.latest?.speakableText) || Boolean(queue.current?.speakableText);

  readButton.disabled = !enabled;
  skipButton.disabled = !enabled;
  pauseButton.disabled = !playback?.isSpeaking || settings.mute;
  resumeButton.disabled = !playback?.isPaused || settings.mute;
  stopButton.disabled = !hasCurrentOrPlayback;
  replayButton.disabled = !hasReplayable || settings.mute;
  muteButton.disabled = false;
  muteButton.textContent = settings.mute ? "Unmute" : "Mute";
  actionHint.textContent = describeActionHint(settings, queue);
}

function runReadModeOrchestration(settings, queue) {
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
  actionHint.textContent = "Auto mode found a new speakable item. Starting playback...";
  playback.readNextPending({ settings, queue }).catch(showError);
}

function renderState({ settings, queue }) {
  latestPanelState = { settings, queue };
  const item = getLatestSpeakable(queue);
  const statusKind = deriveStatus(settings, queue, playback?.state);
  const pendingCount = Array.isArray(queue.pending) ? queue.pending.length : 0;

  setStatus(statusKind, describeStatus(statusKind, settings, queue, item));
  queueCount.textContent = String(pendingCount);
  readMode.textContent = readableMode(settings.readBehavior);
  sourceApp.textContent = item?.sourceApp || "None";
  itemStatus.textContent = item?.status || "none";
  previewText.textContent = truncatePreview(item?.speakableText);
  previewMeta.textContent = item
    ? `Latest speakable item ${item.id}. Full raw agent output stays in the source chat.`
    : "Waiting for Codex or Claude hook output.";
  updateActions(settings, queue);
  settingsUi?.render(settings);
  runReadModeOrchestration(settings, queue);
}

async function refreshPanel(url) {
  setStatus("idle", "Checking queue state...");
  actionHint.textContent = "Refreshing...";

  const portStatus = await checkBackendPort(url);
  if (!portStatus.reachable) {
    throw new Error(portStatus.detail);
  }

  const [{ settings }, { queue }] = await Promise.all([
    fetchJson(`${url}/api/settings`),
    fetchJson(`${url}/api/queue`)
  ]);
  renderState({ settings, queue });
}

function showError(error) {
  const message = String(error?.message || error);
  setStatus("error", String(error?.message || error));
  queueCount.textContent = "0";
  readMode.textContent = "Unknown";
  sourceApp.textContent = "None";
  itemStatus.textContent = "error";
  previewText.textContent =
    "Queue preview is unavailable because Agent Hotline could not read the local backend.";
  previewMeta.textContent = "Start or refresh the backend, then try again.";
  readButton.disabled = true;
  skipButton.disabled = true;
  pauseButton.disabled = true;
  resumeButton.disabled = true;
  stopButton.disabled = true;
  replayButton.disabled = true;
  muteButton.disabled = true;
  actionHint.textContent = "Backend queue/settings endpoints are required for the compact panel.";
  settingsUi?.showUnavailable(message);
}

async function skipNextPending(url, state) {
  const item = Array.isArray(state?.queue?.pending) ? state.queue.pending[0] : null;
  if (!item) {
    actionHint.textContent = "No pending speakable item is waiting.";
    return;
  }

  const response = await fetch(`${url}/api/queue/${encodeURIComponent(item.id)}/skipped`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "User skipped playback from the desktop panel." })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  actionHint.textContent = "Skipped the pending speakable item.";
  await refreshPanel(url);
}

const config = await loadRuntimeConfig();
const targetUrl = config.backendUrl || DEFAULT_BACKEND_URL;
settingsUi = initSettingsUi({
  backendUrl: targetUrl,
  onSettingsChanged: (settings) => {
    const refreshAfterSettingsChange = () => refreshPanel(targetUrl).catch(showError);
    if (settings?.mute && (playback?.isSpeaking || playback?.isPaused)) {
      playback.stop("User muted playback.").then(refreshAfterSettingsChange).catch(showError);
      return;
    }
    refreshAfterSettingsChange();
  }
});
playback = createPlaybackController({
  backendUrl: targetUrl,
  onUpdate(message) {
    actionHint.textContent = message;
  },
  onStateChanged() {
    refreshPanel(targetUrl).catch(showError);
  }
});

backendUrl.textContent = targetUrl;
refresh.addEventListener("click", () => refreshPanel(targetUrl).catch(showError));

readButton.addEventListener("click", () => {
  playback.readNextPending(latestPanelState || { settings: {}, queue: {} }).catch(showError);
});

skipButton.addEventListener("click", () => {
  skipNextPending(targetUrl, latestPanelState).catch(showError);
});

pauseButton.addEventListener("click", () => {
  playback.pause();
});

resumeButton.addEventListener("click", () => {
  playback.resume();
});

stopButton.addEventListener("click", () => {
  playback.stop().catch(showError);
});

replayButton.addEventListener("click", () => {
  playback.replayLatest(latestPanelState?.settings || {}).catch(showError);
});

muteButton.addEventListener("click", () => {
  const muted = latestPanelState?.settings?.mute !== true;
  playback.setMute(muted).catch(showError);
});

if (window.__TAURI_INTERNALS__) {
  await listen("agent-hotline://tray-action", (event) => {
    const action = event.payload?.action || "unknown";
    if (action === "read-latest") {
      playback.readNextPending(latestPanelState || { settings: {}, queue: {} }).catch(showError);
      return;
    }
    if (action === "stop") {
      playback.stop().catch(showError);
      return;
    }
    if (action === "pause-resume") {
      if (playback.isPaused) {
        playback.resume();
      } else {
        playback.pause();
      }
      return;
    }
    if (action === "replay") {
      playback.replayLatest(latestPanelState?.settings || {}).catch(showError);
      return;
    }
    if (action === "mute-unmute") {
      const muted = latestPanelState?.settings?.mute !== true;
      playback.setMute(muted).catch(showError);
      return;
    }
    actionHint.textContent = `Tray action received: ${action}.`;
    refreshPanel(targetUrl).catch(showError);
  });
}

refreshPanel(targetUrl).catch(showError);
