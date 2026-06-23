import "./mini.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { createPlaybackController } from "./playback.js";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:4777";
const QUEUE_POLL_INTERVAL_MS = 1000;

const STATUS_LABELS = {
  idle: "Idle",
  pending: "Pending",
  speaking: "Speaking",
  paused: "Paused",
  muted: "Muted",
  error: "Error"
};

const el = (id) => document.getElementById(id);
const sourceEl = el("mini-source");
const statusEl = el("mini-status");
const previewEl = el("mini-preview");
const readButton = el("mini-read");
const pauseButton = el("mini-pause");
const stopButton = el("mini-stop");
const muteButton = el("mini-mute");
const openButton = el("mini-open");
const hintEl = el("mini-hint");

let playback = null;
let latestState = null;
let refreshInFlight = false;

function notify(message) {
  hintEl.textContent = message;
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

// Newest item that carries speakable text (queue order is oldest -> newest).
function latestSpeakable(queue) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].speakableText && items[i].speakableText.trim()) return items[i];
  }
  return null;
}

function setStatus(kind) {
  const k = STATUS_LABELS[kind] ? kind : "error";
  statusEl.className = `mini-badge is-${k}`;
  statusEl.textContent = STATUS_LABELS[k];
}

function deriveStatus(settings, queue) {
  if (settings?.mute) return "muted";
  if (playback?.isPaused) return "paused";
  if (playback?.isSpeaking) return "speaking";
  if (Array.isArray(queue?.pending) && queue.pending.length > 0) return "pending";
  return "idle";
}

function render(state) {
  latestState = state;
  const { settings, queue } = state;
  const latest = latestSpeakable(queue);

  if (latest) {
    sourceEl.textContent = latest.sourceApp || "Latest";
    previewEl.textContent = latest.speakableText;
  } else {
    sourceEl.textContent = "None";
    previewEl.textContent = "No speakable text yet.";
  }

  setStatus(deriveStatus(settings, queue));
  readButton.disabled = !latest || settings?.mute;
  pauseButton.disabled = !(playback?.isSpeaking || playback?.isPaused) || settings?.mute;
  pauseButton.textContent = playback?.isPaused ? "Resume" : "Pause";
  stopButton.disabled = !(playback?.isSpeaking || playback?.isPaused);
  muteButton.textContent = settings?.mute ? "Unmute" : "Mute";
}

async function refresh({ quiet = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (!quiet) notify("Refreshing…");
  try {
    const [{ settings }, { queue }] = await Promise.all([
      fetchJson(`${targetUrl}/api/settings`),
      fetchJson(`${targetUrl}/api/queue`)
    ]);
    render({ settings, queue });
    if (!quiet) notify(latestSpeakable(queue) ? "Latest reply ready." : "Waiting for output…");
  } catch (error) {
    setStatus("error");
    notify(`Backend unavailable. Start it and reopen.`);
    readButton.disabled = true;
  } finally {
    refreshInFlight = false;
  }
}

function readLatest() {
  if (!latestState) return;
  const latest = latestSpeakable(latestState.queue);
  if (!latest) {
    notify("Nothing to read yet.");
    return;
  }
  playback.playItem(latest, latestState.settings).catch((error) => notify(String(error?.message || error)));
}

const config = await loadRuntimeConfig();
const targetUrl = config.backendUrl || DEFAULT_BACKEND_URL;

playback = createPlaybackController({
  backendUrl: targetUrl,
  onUpdate: notify,
  onStateChanged: () => refresh({ quiet: true }).catch(() => {})
});

readButton.addEventListener("click", readLatest);
pauseButton.addEventListener("click", () => (playback.isPaused ? playback.resume() : playback.pause()));
stopButton.addEventListener("click", () => playback.stop().catch(() => {}));
muteButton.addEventListener("click", () => {
  const muted = latestState?.settings?.mute !== true;
  playback.setMute(muted).catch(() => {});
});
openButton.addEventListener("click", () => {
  invoke("show_main_panel").catch(() => {});
});

// Force an immediate refresh each time the tray reopens the popup, so the
// freshest reply is shown without waiting for the next poll tick.
if (window.__TAURI_INTERNALS__) {
  listen("agent-hotline://show", () => refresh().catch(() => {})).catch(() => {});
}

refresh().catch(() => {});
window.setInterval(() => refresh({ quiet: true }).catch(() => {}), QUEUE_POLL_INTERVAL_MS);
