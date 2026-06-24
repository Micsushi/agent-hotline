import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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
import { groupByProjectSession, latestCreatedAt } from "./grouping.js";

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
const ICON_SPINNER =
  '<svg viewBox="0 0 24 24" aria-hidden="true" class="spinner"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
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
const tabManage = el("tab-manage");
const panelHome = el("panel-home");
const panelSettings = el("panel-settings");
const panelManage = el("panel-manage");

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
let storageView = { level: "projects", projectKey: null, sessionKey: null };
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

function setTab(tab) {
  const active = ["home", "settings", "manage"].includes(tab) ? tab : "home";
  tabHome.classList.toggle("is-active", active === "home");
  tabSettings.classList.toggle("is-active", active === "settings");
  tabManage.classList.toggle("is-active", active === "manage");
  panelHome.hidden = active !== "home";
  panelSettings.hidden = active !== "settings";
  panelManage.hidden = active !== "manage";
  if (active === "manage") loadAudioCache().catch(showError);
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

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function threadLabel(item) {
  if (item.sessionName) return item.sessionName;
  if (item.threadLabel) return item.threadLabel;
  if (item.threadId) return `${item.sourceApp}  -  ${item.threadId.slice(0, 8)}`;
  return `${item.sourceApp}  -  direct`;
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

// History groups newest-first; Storage groups largest-first. Both run through
// the shared grouper in grouping.js so the two trees stay in lockstep.
function buildProjects(items) {
  return groupByProjectSession(items, { sortBy: "recent" });
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
    badge.textContent = "Replay";
    button.append(badge);
  }
  return button;
}

function detailHead(backTarget, backText, labelText) {
  const head = document.createElement("div");
  head.className = "detail-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "back-button";
  back.dataset.back = backTarget;
  back.textContent = backText;
  const label = document.createElement("span");
  label.className = "detail-label";
  label.textContent = labelText;
  head.append(back, label);
  return head;
}

// Inline glyphs so each row reads as a tappable card, not a table cell:
// a folder for projects, a chat bubble for sessions, plus a trailing chevron.
const ROW_ICONS = {
  project:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7v9.3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  session:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4 3.2V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'
};

function listRow(datasetKey, datasetValue, labelText, metaText, kind) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `session-row${kind ? ` is-${kind}` : ""}`;
  row.dataset[datasetKey] = datasetValue;

  if (kind && ROW_ICONS[kind]) {
    const icon = document.createElement("span");
    icon.className = "row-icon";
    icon.innerHTML = ROW_ICONS[kind];
    row.append(icon);
  }

  const body = document.createElement("span");
  body.className = "row-body";

  const label = document.createElement("span");
  label.className = "session-label";
  label.textContent = labelText;

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = metaText;

  body.append(label, meta);
  row.append(body);
  return row;
}

function renderProjectsList(projects) {
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const project of projects) {
    const count = project.sessions.length;
    scroll.append(
      listRow(
        "project",
        project.key,
        project.label,
        `${count} chat${count === 1 ? "" : "s"}  -  ${formatTime(latestCreatedAt(project.items))}`,
        "project"
      )
    );
  }
  historyList.replaceChildren(scroll);
}

function renderSessionsList(project) {
  const fragment = document.createDocumentFragment();
  fragment.append(detailHead("projects", "< Projects", project.label));
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const session of project.sessions) {
    scroll.append(
      listRow(
        "session",
        session.key,
        session.label,
        `${session.items.length}  -  ${formatTime(latestCreatedAt(session.items))}`,
        "session"
      )
    );
  }
  fragment.append(scroll);
  historyList.replaceChildren(fragment);
}

function renderMessagesDetail(session) {
  const fragment = document.createDocumentFragment();
  fragment.append(detailHead("sessions", "< Chats", session.label));
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
    historyView = { level: "messages", projectKey: null, sessionKey: null };
    historyList.innerHTML = '<p class="history-empty">Nothing has been spoken yet.</p>';
    return;
  }

  const projects = buildProjects(items);

  if (historyView.level === "projects") {
    renderProjectsList(projects);
    return;
  }

  const project = projects.find((entry) => entry.key === historyView.projectKey) || projects[0];
  historyView.projectKey = project.key;

  if (historyView.level === "sessions") {
    renderSessionsList(project);
    return;
  }

  const session =
    project.sessions.find((entry) => entry.key === historyView.sessionKey) || project.sessions[0];
  historyView.sessionKey = session.key;
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

function renderHighlightAt(currentSec, segments, wordAccurate) {
  if (!Array.isArray(segments) || segments.length === 0) return;
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
  done.className = "spoken-done";
  done.textContent = full.slice(0, highlightChars);
  const rest = document.createElement("span");
  rest.textContent = full.slice(highlightChars);
  previewText.replaceChildren(done, rest);
}

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
      renderHighlightAt(pos.currentSec, pos.segments, pos.wordAccurate);
    }
  }
}

function updateControls(settings, items, selected) {
  const index = items.findIndex((item) => item.id === selectedItemId);
  prevButton.disabled = index <= 0;
  nextButton.disabled = index < 0 || index >= items.length - 1;

  const loading = playback?.isLoading;
  const speaking = playback?.isSpeaking;
  const paused = playback?.isPaused;
  playPauseButton.classList.toggle("is-loading", Boolean(loading));
  if (loading) {
    playPauseButton.innerHTML = ICON_SPINNER;
    playPauseButton.title = "Generating speech...";
    playPauseButton.setAttribute("aria-label", "Generating speech");
    playPauseButton.disabled = true;
    return;
  }
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

let audioCacheData = null;
const audioSelected = new Set();

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
  return groupByProjectSession(entries, { sortBy: "bytes" });
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

function makeDeleteButton(className, datasetKey, datasetValue, text, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset[datasetKey] = datasetValue;
  button.textContent = text;
  if (title) button.title = title;
  return button;
}

// A storage row is the same card as a History row (icon + label + meta + chevron)
// plus a Delete button sitting beside it for that whole level.
function storageNavRow(kind, key, label, metaText, delClass, delValue, delTitle) {
  const wrap = document.createElement("div");
  wrap.className = "tree-row";
  const datasetKey = kind === "project" ? "sproject" : "ssession";
  const nav = listRow(datasetKey, key, label, metaText, kind);
  const del = makeDeleteButton(delClass, kind, delValue, "Delete", delTitle);
  wrap.append(nav, del);
  return wrap;
}

function renderStorageProjects(projects) {
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const project of projects) {
    const count = project.sessions.length;
    scroll.append(
      storageNavRow(
        "project",
        project.key,
        project.label,
        `${count} chat${count === 1 ? "" : "s"}  -  ${formatBytes(project.bytes)}`,
        "manage-del-project",
        project.key,
        "Delete all audio in this project"
      )
    );
  }
  el("audio-list").replaceChildren(scroll);
}

function renderStorageSessions(project) {
  const fragment = document.createDocumentFragment();
  fragment.append(detailHead("sprojects", "< Projects", project.label));
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
  for (const session of project.sessions) {
    scroll.append(
      storageNavRow(
        "session",
        session.key,
        session.label,
        `${session.items.length}  -  ${formatBytes(session.bytes)}`,
        "manage-del-session",
        session.key,
        "Delete all audio in this chat"
      )
    );
  }
  fragment.append(scroll);
  el("audio-list").replaceChildren(fragment);
}

function renderStorageRecordings(session) {
  const fragment = document.createDocumentFragment();
  fragment.append(detailHead("ssessions", "< Chats", session.label));
  const scroll = document.createElement("div");
  scroll.className = "detail-scroll";
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

    const del = makeDeleteButton(
      "manage-del-item",
      "item",
      entry.itemId,
      "x",
      "Delete this recording"
    );
    del.dataset.engine = entry.engine;
    del.dataset.voice = entry.voice;

    row.append(check, text, size, del);
    scroll.append(row);
  }
  fragment.append(scroll);
  el("audio-list").replaceChildren(fragment);
}

function renderAudioCache() {
  const summary = el("audio-summary");
  const listEl = el("audio-list");
  const deleteSelected = el("audio-delete-selected");
  const limitInput = el("audio-limit");
  if (!audioCacheData || !listEl || !summary) return;

  const { entries, totalBytes, maxBytes } = audioCacheData;
  summary.textContent = entries.length
    ? `${entries.length} saved  -  ${formatBytes(totalBytes)} of ${formatBytes(maxBytes)} used`
    : "No saved audio yet. New replies are saved automatically as they arrive.";

  if (limitInput && document.activeElement !== limitInput) {
    limitInput.value = String(Math.round(maxBytes / 1024 / 1024));
  }

  const liveKeys = new Set(entries.map(cacheEntryKey));
  for (const key of [...audioSelected]) if (!liveKeys.has(key)) audioSelected.delete(key);
  if (deleteSelected) deleteSelected.disabled = audioSelected.size === 0;

  if (entries.length === 0) {
    storageView = { level: "projects", projectKey: null, sessionKey: null };
    listEl.innerHTML = '<p class="history-empty">Nothing saved yet.</p>';
    return;
  }

  const projects = buildProjectTree(entries);

  if (storageView.level === "projects") {
    renderStorageProjects(projects);
    return;
  }

  const project = projects.find((entry) => entry.key === storageView.projectKey) || projects[0];
  storageView.projectKey = project.key;

  if (storageView.level === "sessions") {
    renderStorageSessions(project);
    return;
  }

  const session =
    project.sessions.find((entry) => entry.key === storageView.sessionKey) || project.sessions[0];
  storageView.sessionKey = session.key;
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
    runCacheDelete(() => deleteCacheAll(targetUrl));
  });

  deleteSelectedBtn?.addEventListener("click", () => {
    const entries = (audioCacheData?.entries || []).filter((entry) =>
      audioSelected.has(cacheEntryKey(entry))
    );
    audioSelected.clear();
    runCacheDelete(async () => {
      for (const entry of entries) {
        await deleteCacheItem(targetUrl, entry.itemId, entry.engine, entry.voice);
      }
    });
  });

  listEl?.addEventListener("click", (event) => {
    // Delete buttons first so a delete never doubles as a drill-in.
    const projectBtn = event.target.closest(".manage-del-project");
    if (projectBtn) {
      runCacheDelete(() => deleteCacheProject(targetUrl, projectBtn.dataset.project));
      return;
    }
    const sessionBtn = event.target.closest(".manage-del-session");
    if (sessionBtn) {
      runCacheDelete(() => deleteCacheSession(targetUrl, sessionBtn.dataset.session));
      return;
    }
    const itemBtn = event.target.closest(".manage-del-item");
    if (itemBtn) {
      runCacheDelete(() =>
        deleteCacheItem(
          targetUrl,
          itemBtn.dataset.item,
          itemBtn.dataset.engine,
          itemBtn.dataset.voice
        )
      );
      return;
    }

    // Drill-down navigation (mirrors the History tab).
    const back = event.target.closest(".back-button");
    if (back) {
      storageView =
        back.dataset.back === "sprojects"
          ? { level: "projects", projectKey: null, sessionKey: null }
          : { level: "sessions", projectKey: storageView.projectKey, sessionKey: null };
      renderAudioCache();
      return;
    }

    const projectRow = event.target.closest(".session-row[data-sproject]");
    if (projectRow) {
      storageView = {
        level: "sessions",
        projectKey: projectRow.dataset.sproject,
        sessionKey: null
      };
      renderAudioCache();
      return;
    }

    const sessionRow = event.target.closest(".session-row[data-ssession]");
    if (sessionRow) {
      storageView = {
        level: "recordings",
        projectKey: storageView.projectKey,
        sessionKey: sessionRow.dataset.ssession
      };
      renderAudioCache();
    }
  });

  listEl?.addEventListener("change", (event) => {
    const check = event.target.closest("input[type=checkbox][data-entry]");
    if (!check) return;
    if (check.checked) audioSelected.add(check.dataset.entry);
    else audioSelected.delete(check.dataset.entry);
    const deleteSelected = el("audio-delete-selected");
    if (deleteSelected) deleteSelected.disabled = audioSelected.size === 0;
  });
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
    } else {
      maybeRestartForVoiceChange(settings);
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
tabManage.addEventListener("click", () => setTab("manage"));
setupManageTab();
refreshButton.addEventListener("click", () => refreshWithSpin());

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
  if (playback.isEnded && playback.replayCurrent()) return;
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
  if (pos)
    renderHighlightAt(
      (Number(seekBar.value) / 1000) * pos.totalSec,
      pos.segments,
      pos.wordAccurate
    );
});
seekBar.addEventListener("change", () => {
  seekDragging = false;
  playback?.seek?.(Number(seekBar.value) / 1000);
});
seekBar.addEventListener("blur", () => (seekDragging = false));

historyList.addEventListener("click", (event) => {
  const back = event.target.closest(".back-button");
  if (back) {
    historyView =
      back.dataset.back === "projects"
        ? { level: "projects", projectKey: null, sessionKey: null }
        : { level: "sessions", projectKey: historyView.projectKey, sessionKey: null };
    if (latestState) renderState(latestState);
    return;
  }

  const projectRow = event.target.closest(".session-row[data-project]");
  if (projectRow) {
    historyView = { level: "sessions", projectKey: projectRow.dataset.project, sessionKey: null };
    if (latestState) renderState(latestState);
    return;
  }

  const sessionRow = event.target.closest(".session-row[data-session]");
  if (sessionRow) {
    historyView = {
      level: "messages",
      projectKey: historyView.projectKey,
      sessionKey: sessionRow.dataset.session
    };
    if (latestState) renderState(latestState);
    return;
  }

  const item = event.target.closest(".history-item");
  if (!item) return;
  selectedItemId = item.dataset.id;
  if (latestState) renderState(latestState);
  playSelected();
});

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
