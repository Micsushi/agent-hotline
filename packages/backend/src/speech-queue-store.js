const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SOURCE_APPS = new Set(["Codex", "Claude"]);
const STATUSES = new Set(["pending", "playing", "played", "skipped"]);

function defaultDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Agent Hotline");
}

function defaultQueueFile() {
  return path.join(defaultDataDir(), "speech-queue.json");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { items: [] };
    return { items: [] };
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function normalizeString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function normalizeSourceApp(value) {
  const sourceApp = normalizeString(value, "sourceApp");
  if (!SOURCE_APPS.has(sourceApp)) {
    throw new Error("sourceApp must be Codex or Claude");
  }
  return sourceApp;
}

function createSpeechQueueStore(options = {}) {
  const filePath =
    options.filePath || path.join(options.dataDir || defaultDataDir(), "speech-queue.json");
  const now = options.now || (() => new Date().toISOString());
  const idGenerator = options.idGenerator || createDefaultId;

  let state = loadState();

  function loadState() {
    const data = safeReadJson(filePath);
    const items = Array.isArray(data.items) ? data.items.filter(isValidPersistedItem) : [];
    return { items };
  }

  function persist() {
    writeJson(filePath, state);
  }

  function findItem(id) {
    return state.items.find((item) => item.id === id);
  }

  function requireItem(id) {
    const item = findItem(id);
    if (!item) {
      throw new Error(`Queue item not found: ${id}`);
    }
    return item;
  }

  function touch(item, timestamp) {
    item.timestamps.updatedAt = timestamp;
  }

  function optionalString(value) {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  }

  function enqueue(input) {
    const timestamp = now();
    const item = {
      id: input.id || idGenerator(),
      rawSource: normalizeString(input.rawSource, "rawSource"),
      speakableText: normalizeString(input.speakableText, "speakableText"),
      sourceApp: normalizeSourceApp(input.sourceApp),
      status: "pending",
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };

    const threadId = optionalString(input.threadId);
    if (threadId) item.threadId = threadId;
    const threadLabel = optionalString(input.threadLabel);
    if (threadLabel) item.threadLabel = threadLabel;
    const sessionName = optionalString(input.sessionName);
    if (sessionName) item.sessionName = sessionName;

    if (findItem(item.id)) {
      throw new Error(`Queue item already exists: ${item.id}`);
    }

    state.items.push(item);
    persist();
    return clone(item);
  }

  function getPending() {
    return clone(state.items.filter((item) => item.status === "pending"));
  }

  function getCurrent() {
    const current = state.items.find((item) => item.status === "playing") || null;
    return current ? clone(current) : null;
  }

  function getLatest() {
    const latest = state.items[state.items.length - 1] || null;
    return latest ? clone(latest) : null;
  }

  function markPlaying(id) {
    const timestamp = now();
    const item = requireItem(id);

    for (const candidate of state.items) {
      if (candidate.status === "playing" && candidate.id !== id) {
        candidate.status = "pending";
        touch(candidate, timestamp);
      }
    }

    item.status = "playing";
    item.timestamps.playingAt = timestamp;
    touch(item, timestamp);
    persist();
    return clone(item);
  }

  function markPlayed(id) {
    const timestamp = now();
    const item = requireItem(id);
    item.status = "played";
    item.timestamps.playedAt = timestamp;
    touch(item, timestamp);
    persist();
    return clone(item);
  }

  function markSkipped(id, reason) {
    const timestamp = now();
    const item = requireItem(id);
    item.status = "skipped";
    item.skipReason = normalizeString(reason, "reason");
    item.timestamps.skippedAt = timestamp;
    touch(item, timestamp);
    persist();
    return clone(item);
  }

  function pushReplay(source) {
    const timestamp = now();
    const item = {
      id: idGenerator(),
      rawSource: source.rawSource,
      speakableText: source.speakableText,
      sourceApp: source.sourceApp,
      status: "pending",
      replayOf: source.id,
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp,
        replayedAt: timestamp
      }
    };
    if (source.threadId) item.threadId = source.threadId;
    if (source.threadLabel) item.threadLabel = source.threadLabel;
    if (source.sessionName) item.sessionName = source.sessionName;

    state.items.push(item);
    persist();
    return clone(item);
  }

  function replayLatest() {
    const latest = [...state.items]
      .reverse()
      .find((item) => item.speakableText && item.status !== "skipped");
    return latest ? pushReplay(latest) : null;
  }

  // Replay a specific historical item by id (used by the history list).
  function replayItem(id) {
    const source = findItem(id);
    if (!source || !source.speakableText) {
      return null;
    }
    return pushReplay(source);
  }

  function clearQueue() {
    state = { items: [] };
    persist();
    return getState();
  }

  function getState() {
    return clone(state);
  }

  return {
    filePath,
    enqueue,
    getPending,
    getCurrent,
    getLatest,
    markPlaying,
    markPlayed,
    markSkipped,
    replayLatest,
    replayItem,
    clearQueue,
    getState
  };
}

function isValidPersistedItem(item) {
  return Boolean(
    item &&
    typeof item.id === "string" &&
    typeof item.rawSource === "string" &&
    typeof item.speakableText === "string" &&
    SOURCE_APPS.has(item.sourceApp) &&
    STATUSES.has(item.status) &&
    item.timestamps &&
    typeof item.timestamps.createdAt === "string" &&
    typeof item.timestamps.updatedAt === "string"
  );
}

module.exports = {
  createSpeechQueueStore,
  defaultDataDir,
  defaultQueueFile
};
