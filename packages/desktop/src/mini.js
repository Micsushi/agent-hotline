import "./mini.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { createPlaybackController } from "./playback.js";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:4777";
const QUEUE_POLL_INTERVAL_MS = 1000;

// Inline icons so the toggle buttons stay icon-only while reflecting state.
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_SPEAKER_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M4.5 4.5 19.5 19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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
const playPauseButton = el("mini-playpause");
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

  // One button cycles read -> pause -> resume.
  const speaking = playback?.isSpeaking;
  const paused = playback?.isPaused;
  playPauseButton.innerHTML = speaking ? ICON_PAUSE : ICON_PLAY;
  const ppLabel = speaking ? "Pause" : paused ? "Resume" : "Read aloud";
  playPauseButton.title = ppLabel;
  playPauseButton.setAttribute("aria-label", ppLabel);
  playPauseButton.disabled = settings?.mute || (!latest && !speaking && !paused);

  const muted = settings?.mute;
  muteButton.innerHTML = muted ? ICON_SPEAKER_MUTED : ICON_SPEAKER;
  muteButton.title = muted ? "Unmute" : "Mute";
  muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
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
    playPauseButton.disabled = true;
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

playPauseButton.addEventListener("click", () => {
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  readLatest();
});
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
