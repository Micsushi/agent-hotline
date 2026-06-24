const fs = require("fs");
const path = require("path");

const { getDefaultDataDir } = require("./settings-store");

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const CACHE_DIR_NAME = "audio-cache";
const INDEX_FILE = "index.json";

function sanitize(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
}

function keyFor(itemId, engine, voice) {
  return `${sanitize(itemId)}__${sanitize(engine)}__${sanitize(voice)}`;
}

function emptyIndex() {
  return { totalBytes: 0, entries: {} };
}

function safeReadJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries) return parsed;
  } catch {}
  return emptyIndex();
}

function createAudioCacheStore(options = {}) {
  const dataDir = options.dataDir || getDefaultDataDir();
  const cacheDir = options.cacheDir || path.join(dataDir, CACHE_DIR_NAME);
  const indexPath = path.join(cacheDir, INDEX_FILE);
  const staticMax = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const getMax = typeof options.getMaxBytes === "function" ? options.getMaxBytes : () => staticMax;
  function currentMax() {
    const value = Number(getMax());
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
  }
  const now = options.now || (() => new Date().toISOString());

  let index = loadAndReconcile();

  function wavPath(key) {
    return path.join(cacheDir, `${key}.wav`);
  }

  function loadAndReconcile() {
    const loaded = safeReadJson(indexPath);
    const entries = {};
    let totalBytes = 0;
    for (const [key, entry] of Object.entries(loaded.entries || {})) {
      if (!entry || typeof entry !== "object") continue;
      if (!fs.existsSync(path.join(cacheDir, `${key}.wav`))) continue;
      entries[key] = entry;
      totalBytes += Number(entry.bytes) || 0;
    }
    return { totalBytes, entries };
  }

  function persist() {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tempFile = `${indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    fs.renameSync(tempFile, indexPath);
  }

  function recomputeTotal() {
    index.totalBytes = Object.values(index.entries).reduce(
      (sum, entry) => sum + (Number(entry.bytes) || 0),
      0
    );
  }

  function evictToFit(keepKey) {
    const cap = currentMax();
    const ordered = Object.values(index.entries)
      .filter((entry) => entry.key !== keepKey)
      .sort((a, b) => String(a.lastAccessedAt).localeCompare(String(b.lastAccessedAt)));

    let i = 0;
    while (index.totalBytes > cap && i < ordered.length) {
      const victim = ordered[i];
      i += 1;
      removeKey(victim.key, { persist: false });
    }
  }

  function enforceLimit() {
    evictToFit(null);
    persist();
  }

  function removeKey(key, { persist: shouldPersist = true } = {}) {
    const entry = index.entries[key];
    if (!entry) return false;
    try {
      fs.rmSync(wavPath(key), { force: true });
    } catch {}
    delete index.entries[key];
    recomputeTotal();
    if (shouldPersist) persist();
    return true;
  }

  function touch(key) {
    const entry = index.entries[key];
    if (!entry) return;
    entry.lastAccessedAt = now();
    persist();
  }

  function has(itemId, engine, voice) {
    return Boolean(index.entries[keyFor(itemId, engine, voice)]);
  }

  function getManifest(itemId, engine, voice) {
    const key = keyFor(itemId, engine, voice);
    const entry = index.entries[key];
    if (!entry) return null;
    touch(key);
    return {
      sampleRate: entry.sampleRate,
      durationSec: entry.durationSec,
      segments: Array.isArray(entry.segments) ? entry.segments : [],
      wordAccurate: Boolean(entry.wordAccurate)
    };
  }

  function getAudioPath(itemId, engine, voice) {
    const key = keyFor(itemId, engine, voice);
    const entry = index.entries[key];
    if (!entry) return null;
    const filePath = wavPath(key);
    if (!fs.existsSync(filePath)) {
      removeKey(key);
      return null;
    }
    touch(key);
    return filePath;
  }

  function put(itemId, engine, voice, payload) {
    const wavBuffer = payload.wavBuffer;
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length === 0) {
      throw new Error("wavBuffer must be a non-empty Buffer");
    }
    if (wavBuffer.length > currentMax()) {
      return null;
    }

    const key = keyFor(itemId, engine, voice);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(wavPath(key), wavBuffer);

    const timestamp = now();
    const existing = index.entries[key];
    index.entries[key] = {
      key,
      itemId: String(itemId),
      engine: String(engine),
      voice: String(voice),
      bytes: wavBuffer.length,
      sampleRate: Number(payload.sampleRate) || 24000,
      durationSec: Number(payload.durationSec) || 0,
      wordAccurate: Boolean(payload.wordAccurate),
      segments: Array.isArray(payload.segments) ? payload.segments : [],
      createdAt: existing?.createdAt || timestamp,
      lastAccessedAt: timestamp
    };

    recomputeTotal();
    evictToFit(key);
    persist();
    return JSON.parse(JSON.stringify(index.entries[key]));
  }

  function removeOne(itemId, engine, voice) {
    if (engine && voice) {
      return removeKey(keyFor(itemId, engine, voice)) ? 1 : 0;
    }
    const id = String(itemId);
    return removeWhere((entry) => entry.itemId === id);
  }

  function removeWhere(predicate) {
    const keys = Object.values(index.entries)
      .filter(predicate)
      .map((entry) => entry.key);
    let removed = 0;
    for (const key of keys) {
      if (removeKey(key, { persist: false })) removed += 1;
    }
    if (removed > 0) persist();
    return removed;
  }

  function removeByItemIds(itemIds) {
    const wanted = new Set(Array.from(itemIds || []).map(String));
    return removeWhere((entry) => wanted.has(entry.itemId));
  }

  function clearAll() {
    const count = Object.keys(index.entries).length;
    for (const key of Object.keys(index.entries)) {
      removeKey(key, { persist: false });
    }
    index = emptyIndex();
    persist();
    return count;
  }

  function list() {
    return {
      entries: Object.values(index.entries).map((entry) => ({ ...entry })),
      totalBytes: index.totalBytes,
      maxBytes: currentMax()
    };
  }

  return {
    cacheDir,
    get maxBytes() {
      return currentMax();
    },
    keyFor,
    has,
    getManifest,
    getAudioPath,
    put,
    removeOne,
    removeByItemIds,
    removeWhere,
    clearAll,
    enforceLimit,
    list
  };
}

module.exports = {
  createAudioCacheStore,
  DEFAULT_MAX_BYTES,
  keyFor
};
