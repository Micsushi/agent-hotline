const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createAudioCacheStore } = require("../src/audio-cache-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-audio-"));
}

// A clock that hands out strictly increasing ISO timestamps so last-accessed
// ordering (used by LRU) is deterministic in tests.
function stepClock(start = 0) {
  let n = start;
  return () => {
    n += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  };
}

function wav(bytes, fill = 1) {
  return Buffer.alloc(bytes, fill);
}

test("put then get round-trips manifest and audio path", () => {
  const store = createAudioCacheStore({ dataDir: tempDir() });

  store.put("item-1", "kokoro-ts", "af_heart", {
    sampleRate: 24000,
    durationSec: 2.5,
    segments: [{ text: "hello", startSec: 0, endSec: 2.5 }],
    wordAccurate: true,
    wavBuffer: wav(2048)
  });

  assert.equal(store.has("item-1", "kokoro-ts", "af_heart"), true);
  assert.equal(store.has("item-1", "kokoro", "af_heart"), false, "engine is part of the key");

  const manifest = store.getManifest("item-1", "kokoro-ts", "af_heart");
  assert.equal(manifest.sampleRate, 24000);
  assert.equal(manifest.durationSec, 2.5);
  assert.equal(manifest.wordAccurate, true);
  assert.deepEqual(manifest.segments, [{ text: "hello", startSec: 0, endSec: 2.5 }]);

  const filePath = store.getAudioPath("item-1", "kokoro-ts", "af_heart");
  assert.ok(filePath && fs.existsSync(filePath));
  assert.equal(fs.readFileSync(filePath).length, 2048);

  assert.equal(store.getManifest("missing", "kokoro-ts", "af_heart"), null);
});

test("voice and engine produce distinct cache entries", () => {
  const store = createAudioCacheStore({ dataDir: tempDir() });
  store.put("item-1", "kokoro", "af_heart", { sampleRate: 24000, wavBuffer: wav(100) });
  store.put("item-1", "kokoro", "am_adam", { sampleRate: 24000, wavBuffer: wav(100) });
  store.put("item-1", "kokoro-ts", "af_heart", { sampleRate: 24000, wavBuffer: wav(100) });

  assert.equal(store.list().entries.length, 3);
});

test("LRU eviction drops the least-recently-accessed entry over the cap", () => {
  const store = createAudioCacheStore({ dataDir: tempDir(), maxBytes: 250, now: stepClock() });

  store.put("a", "kokoro", "v", { wavBuffer: wav(100) }); // t1
  store.put("b", "kokoro", "v", { wavBuffer: wav(100) }); // t2
  // Touch "a" so "b" becomes the oldest by last-access.
  store.getManifest("a", "kokoro", "v"); // t3
  store.put("c", "kokoro", "v", { wavBuffer: wav(100) }); // t4 -> over 250, evict "b"

  assert.equal(store.has("a", "kokoro", "v"), true);
  assert.equal(store.has("b", "kokoro", "v"), false, "oldest-accessed evicted");
  assert.equal(store.has("c", "kokoro", "v"), true);
  assert.ok(store.list().totalBytes <= 250);
});

test("a clip larger than the whole cap is not stored", () => {
  const store = createAudioCacheStore({ dataDir: tempDir(), maxBytes: 100 });
  const entry = store.put("big", "kokoro", "v", { wavBuffer: wav(500) });
  assert.equal(entry, null);
  assert.equal(store.has("big", "kokoro", "v"), false);
});

test("removeOne deletes a single recording or all voices for an item", () => {
  const store = createAudioCacheStore({ dataDir: tempDir() });
  store.put("item-1", "kokoro", "af_heart", { wavBuffer: wav(100) });
  store.put("item-1", "kokoro", "am_adam", { wavBuffer: wav(100) });

  assert.equal(store.removeOne("item-1", "kokoro", "af_heart"), 1);
  assert.equal(store.has("item-1", "kokoro", "af_heart"), false);
  assert.equal(store.has("item-1", "kokoro", "am_adam"), true);

  // No engine/voice -> remove everything for the item.
  store.put("item-1", "kokoro", "af_heart", { wavBuffer: wav(100) });
  assert.equal(store.removeOne("item-1"), 2);
  assert.equal(store.list().entries.length, 0);
});

test("removeByItemIds and clearAll clear cache and free bytes", () => {
  const store = createAudioCacheStore({ dataDir: tempDir() });
  store.put("a", "kokoro", "v", { wavBuffer: wav(100) });
  store.put("b", "kokoro", "v", { wavBuffer: wav(100) });
  store.put("c", "kokoro", "v", { wavBuffer: wav(100) });

  assert.equal(store.removeByItemIds(["a", "b"]), 2);
  assert.equal(store.list().entries.length, 1);

  assert.equal(store.clearAll(), 1);
  assert.equal(store.list().entries.length, 0);
  assert.equal(store.list().totalBytes, 0);
});

test("a dynamic cap (getMaxBytes) is honored and enforceLimit evicts down to it", () => {
  let capBytes = 1000;
  const store = createAudioCacheStore({
    dataDir: tempDir(),
    getMaxBytes: () => capBytes,
    now: stepClock()
  });

  store.put("a", "kokoro", "v", { wavBuffer: wav(300) });
  store.put("b", "kokoro", "v", { wavBuffer: wav(300) });
  store.put("c", "kokoro", "v", { wavBuffer: wav(300) }); // 900 <= 1000, all kept
  assert.equal(store.list().entries.length, 3);
  assert.equal(store.maxBytes, 1000);

  // Lower the cap and enforce: oldest entries evicted until under 500.
  capBytes = 500;
  store.enforceLimit();
  assert.ok(store.list().totalBytes <= 500);
  assert.equal(store.has("c", "kokoro", "v"), true, "newest survives");
  assert.equal(store.has("a", "kokoro", "v"), false, "oldest evicted first");
});

test("entries with a missing audio file are dropped on reload", () => {
  const dir = tempDir();
  const store = createAudioCacheStore({ dataDir: dir });
  store.put("a", "kokoro", "v", { wavBuffer: wav(100) });
  const filePath = store.getAudioPath("a", "kokoro", "v");
  fs.rmSync(filePath);

  const reopened = createAudioCacheStore({ dataDir: dir });
  assert.equal(reopened.has("a", "kokoro", "v"), false);
  assert.equal(reopened.list().totalBytes, 0);
});
