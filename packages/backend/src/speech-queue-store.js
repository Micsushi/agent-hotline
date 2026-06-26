const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { resolveProjectRoot } = require("./hook-input-parser");

function pathBasename(value) {
  return (
    String(value)
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || undefined
  );
}

const SOURCE_APPS = new Set(["Codex", "Claude", "Antigravity"]);
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
    throw new Error("sourceApp must be Codex, Claude, or Antigravity");
  }
  return sourceApp;
}

function createSpeechQueueStore(options = {}) {
  const filePath =
    options.filePath || path.join(options.dataDir || defaultDataDir(), "speech-queue.json");
  const now = options.now || (() => new Date().toISOString());
  const idGenerator = options.idGenerator || createDefaultId;

  let state = loadState();
  resetPersistedPlayingItems();
  migrateProjectRoots();

  function loadState() {
    const data = safeReadJson(filePath);
    const items = Array.isArray(data.items) ? data.items.filter(isValidPersistedItem) : [];
    return { items };
  }

  // Self-heal items whose projectPath points into a subdirectory of a repo (a
  // result of shell cwd drift before the parser resolved to repo root). Collapse
  // them onto the enclosing repo root so subdir work regroups under the real
  // project. Only rewrites when a repo marker is actually found on disk, so
  // missing/foreign paths are left untouched. Persists once if anything changed.
  function migrateProjectRoots() {
    let changed = false;
    for (const item of state.items) {
      if (!item.projectPath) continue;
      const root = resolveProjectRoot(item.projectPath);
      if (root && root !== item.projectPath) {
        item.projectPath = root;
        item.projectName = pathBasename(root);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function resetPersistedPlayingItems() {
    let changed = false;
    let timestamp;
    for (const item of state.items) {
      if (item.status !== "playing") continue;
      timestamp ||= now();
      item.status = "pending";
      item.timestamps.interruptedAt = timestamp;
      touch(item, timestamp);
      changed = true;
    }
    if (changed) persist();
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

  function normalizeUserMessages(value) {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
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
    const projectPath = optionalString(input.projectPath);
    if (projectPath) item.projectPath = projectPath;
    const projectName = optionalString(input.projectName);
    if (projectName) item.projectName = projectName;
    const userMessages = normalizeUserMessages(input.userMessages);
    if (userMessages.length) item.userMessages = userMessages;

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
    if (source.projectPath) item.projectPath = source.projectPath;
    if (source.projectName) item.projectName = source.projectName;
    if (Array.isArray(source.userMessages) && source.userMessages.length) {
      item.userMessages = source.userMessages.slice();
    }

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
