import "./mini.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { createPlaybackController } from "./playback.js";
import { projectKeyOf, sessionKeyOf } from "./grouping.js";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:4777";
const QUEUE_POLL_INTERVAL_MS = 1000;

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
const prevButton = el("mini-prev");
const playPauseButton = el("mini-playpause");
const nextButton = el("mini-next");
const muteButton = el("mini-mute");
const openButton = el("mini-open");
const rate = el("mini-rate");
const rateValue = el("mini-rate-value");
const hintEl = el("mini-hint");

let playback = null;
let latestState = null;
let refreshInFlight = false;
let selectedId = null;
let lastLatestId = null;
let draggingRate = false;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function formatRate(value) {
  return `${parseFloat(Number(value).toFixed(2))}x`;
}

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

function speakableItems(queue) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  return items.filter((item) => item.speakableText && item.speakableText.trim());
}

function latestSpeakable(queue) {
  const items = speakableItems(queue);
  return items.length ? items[items.length - 1] : null;
}

function selectedItem() {
  const items = speakableItems(latestState?.queue);
  return items.find((item) => item.id === selectedId) || items[items.length - 1] || null;
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

function moveSelection(delta) {
  const items = sessionScopedItems(speakableItems(latestState?.queue), selectedId);
  const index = items.findIndex((item) => item.id === selectedId);
  const next = items[index + delta];
  if (!next) return;
  selectedId = next.id;
  if (latestState) render(latestState);
  if (playbackActive()) playSelected();
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
  const items = speakableItems(queue);

  const latest = items[items.length - 1] || null;
  if (latest && latest.id !== lastLatestId) {
    selectedId = latest.id;
    lastLatestId = latest.id;
  }
  const selected = selectedItem();

  if (selected) {
    sourceEl.textContent = selected.sessionName || selected.sourceApp || "Latest";
    previewEl.textContent = selected.speakableText;
  } else {
    sourceEl.textContent = "None";
    previewEl.textContent = "No speakable text yet.";
  }

  setStatus(deriveStatus(settings, queue));

  const scoped = sessionScopedItems(items, selected && selected.id);
  const index = scoped.findIndex((item) => item.id === (selected && selected.id));
  prevButton.disabled = index <= 0;
  nextButton.disabled = index < 0 || index >= scoped.length - 1;

  const speaking = playback?.isSpeaking;
  const paused = playback?.isPaused;
  playPauseButton.innerHTML = speaking ? ICON_PAUSE : ICON_PLAY;
  const ppLabel = speaking ? "Pause" : paused ? "Resume" : "Read aloud";
  playPauseButton.title = ppLabel;
  playPauseButton.setAttribute("aria-label", ppLabel);
  playPauseButton.disabled = settings?.mute || (!selected && !speaking && !paused);

  const muted = settings?.mute;
  muteButton.innerHTML = muted ? ICON_SPEAKER_MUTED : ICON_SPEAKER;
  muteButton.title = muted ? "Unmute" : "Mute";
  muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");

  if (!draggingRate && Number.isFinite(Number(settings?.rate))) {
    rate.value = String(settings.rate);
    rateValue.value = formatRate(settings.rate);
  }
}

async function refresh({ quiet = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (!quiet) notify("Refreshing...");
  try {
    const [{ settings }, { queue }] = await Promise.all([
      fetchJson(`${targetUrl}/api/settings`),
      fetchJson(`${targetUrl}/api/queue`)
    ]);
    render({ settings, queue });
    if (!quiet) notify(latestSpeakable(queue) ? "Latest reply ready." : "Waiting for output...");
  } catch {
    setStatus("error");
    notify(`Backend unavailable. Start it and reopen.`);
    playPauseButton.disabled = true;
  } finally {
    refreshInFlight = false;
  }
}

function playSelected() {
  if (!latestState) return;
  const selected = selectedItem();
  if (!selected) {
    notify("Nothing to read yet.");
    return;
  }
  playback
    .playItem(selected, latestState.settings)
    .catch((error) => notify(String(error?.message || error)));
}

async function saveRate(value) {
  try {
    await fetch(`${targetUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rate: value })
    });
  } catch {}
}

const config = await loadRuntimeConfig();
const targetUrl = config.backendUrl || DEFAULT_BACKEND_URL;

playback = createPlaybackController({
  backendUrl: targetUrl,
  onUpdate: notify,
  onStateChanged: () => refresh({ quiet: true }).catch(() => {})
});

prevButton.addEventListener("click", () => moveSelection(-1));
nextButton.addEventListener("click", () => moveSelection(1));
playPauseButton.addEventListener("click", () => {
  if (playback.isSpeaking) return playback.pause();
  if (playback.isPaused) return playback.resume();
  playSelected();
});
muteButton.addEventListener("click", () => {
  const muted = latestState?.settings?.mute !== true;
  playback.setMute(muted).catch(() => {});
});

rate.addEventListener("pointerdown", () => (draggingRate = true));
rate.addEventListener("input", () => {
  draggingRate = true;
  rateValue.value = formatRate(rate.value);
  playback.applyLiveSettings({ rate: clampNumber(rate.value, 1, 0.2, 4) });
});
rate.addEventListener("change", () => {
  draggingRate = false;
  saveRate(clampNumber(rate.value, 1, 0.2, 4));
});
rate.addEventListener("blur", () => (draggingRate = false));
openButton.addEventListener("click", () => {
  invoke("show_main_panel").catch(() => {});
});

if (window.__TAURI_INTERNALS__) {
  listen("agent-hotline://show", () => refresh().catch(() => {})).catch(() => {});
}

refresh().catch(() => {});
window.setInterval(() => refresh({ quiet: true }).catch(() => {}), QUEUE_POLL_INTERVAL_MS);
