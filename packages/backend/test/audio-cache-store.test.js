const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createAudioCacheStore, keyFor } = require("../src/audio-cache-store");

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

test("malformed persisted keys cannot escape the cache directory", () => {
  const dir = tempDir();
  const cacheDir = path.join(dir, "audio-cache");
  const outsidePath = path.join(dir, "outside.wav");
  const safeKey = keyFor("item-1", "kokoro", "voice");
  const safePath = path.join(cacheDir, `${safeKey}.wav`);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(outsidePath, Buffer.from("keep this file"));
  fs.writeFileSync(safePath, Buffer.from("valid"));
  fs.writeFileSync(
    path.join(cacheDir, "index.json"),
    JSON.stringify({
      totalBytes: Number.MAX_SAFE_INTEGER,
      entries: {
        "../outside": {
          key: "../outside",
          itemId: "outside-item",
          engine: "kokoro",
          voice: "voice",
          bytes: Number.MAX_SAFE_INTEGER,
          lastAccessedAt: "2026-01-01T00:00:00.000Z"
        },
        [safeKey]: {
          key: "../outside",
          itemId: "item-1",
          engine: "kokoro",
          voice: "voice",
          bytes: -999,
          lastAccessedAt: "2026-01-01T00:00:01.000Z"
        }
      }
    })
  );

  const store = createAudioCacheStore({ dataDir: dir });
  const listing = store.list();
  assert.equal(listing.totalBytes, 5, "cache usage comes from the file, not index metadata");
  assert.deepEqual(
    listing.entries.map((entry) => ({ key: entry.key, bytes: entry.bytes })),
    [{ key: safeKey, bytes: 5 }]
  );

  assert.equal(store.removeOne("item-1"), 1, "removal uses the persisted map key");
  assert.equal(fs.existsSync(safePath), false);
  assert.equal(fs.existsSync(outsidePath), true, "removeOne stays inside the cache directory");

  assert.equal(store.clearAll(), 0);
  assert.equal(fs.existsSync(outsidePath), true, "clearAll stays inside the cache directory");
});

test("unindexed WAV files are swept on reload while indexed and unrelated files remain", () => {
  const dir = tempDir();
  const store = createAudioCacheStore({ dataDir: dir });
  store.put("kept", "kokoro", "v", { wavBuffer: wav(100) });

  const cacheDir = path.join(dir, "audio-cache");
  const orphanPath = path.join(cacheDir, "orphan.wav");
  const notePath = path.join(cacheDir, "notes.txt");
  const directoryPath = path.join(cacheDir, "folder.wav");
  fs.writeFileSync(orphanPath, wav(50, 2));
  fs.writeFileSync(notePath, "leave this file");
  fs.mkdirSync(directoryPath);

  const reopened = createAudioCacheStore({ dataDir: dir });

  assert.equal(fs.existsSync(orphanPath), false, "unindexed WAV is removed");
  assert.equal(reopened.has("kept", "kokoro", "v"), true, "indexed WAV remains");
  assert.equal(fs.existsSync(notePath), true, "non-WAV file remains");
  assert.equal(fs.existsSync(directoryPath), true, "WAV-named directory remains");
});

test("indexed WAV survives a case-only physical rename when the filesystem aliases it", () => {
  const dir = tempDir();
  const store = createAudioCacheStore({ dataDir: dir });
  store.put("kept", "kokoro", "v", { wavBuffer: wav(100) });

  const cacheDir = path.join(dir, "audio-cache");
  const canonicalPath = path.join(cacheDir, "kept__kokoro__v.wav");
  const renamedPath = path.join(cacheDir, "KEPT__KOKORO__V.WAV");
  fs.renameSync(canonicalPath, renamedPath);
  const aliasResolves = fs.existsSync(canonicalPath);

  const reopened = createAudioCacheStore({ dataDir: dir });

  if (aliasResolves) {
    assert.equal(reopened.has("kept", "kokoro", "v"), true, "indexed alias remains cached");
    assert.equal(fs.existsSync(renamedPath), true, "physical aliased file remains");
  } else {
    assert.equal(reopened.has("kept", "kokoro", "v"), false, "distinct case is an orphan");
    assert.equal(fs.existsSync(renamedPath), false, "distinct orphan is swept");
  }
});

test("an unindexed hard link is swept even when it shares an indexed file identity", () => {
  const dir = tempDir();
  const store = createAudioCacheStore({ dataDir: dir });
  store.put("kept", "kokoro", "v", { wavBuffer: wav(100) });

  const cacheDir = path.join(dir, "audio-cache");
  const indexedPath = path.join(cacheDir, "kept__kokoro__v.wav");
  const hardLinkPath = path.join(cacheDir, "other__kokoro__v.wav");
  fs.linkSync(indexedPath, hardLinkPath);

  const reopened = createAudioCacheStore({ dataDir: dir });

  assert.equal(reopened.has("kept", "kokoro", "v"), true, "indexed file remains cached");
  assert.equal(fs.existsSync(indexedPath), true, "indexed file remains on disk");
  assert.equal(fs.existsSync(hardLinkPath), false, "unindexed hard link is swept");
});

test("a malformed index document preserves WAV files for later recovery", () => {
  const dir = tempDir();
  const store = createAudioCacheStore({ dataDir: dir });
  store.put("kept", "kokoro", "v", { wavBuffer: wav(100) });

  const cacheDir = path.join(dir, "audio-cache");
  const keptPath = path.join(cacheDir, "kept__kokoro__v.wav");
  const orphanPath = path.join(cacheDir, "orphan.wav");
  fs.writeFileSync(orphanPath, wav(50, 2));
  fs.writeFileSync(path.join(cacheDir, "index.json"), '{"entries":');

  const reopened = createAudioCacheStore({ dataDir: dir });

  assert.equal(fs.statSync(keptPath).size, 100, "indexed audio is preserved");
  assert.equal(
    fs.statSync(orphanPath).size,
    50,
    "orphan audio is preserved when ownership is unknown"
  );
  assert.equal(reopened.list().entries.length, 0, "malformed metadata is not exposed");
  assert.equal(reopened.list().totalBytes, 0, "unreadable metadata is not trusted for accounting");

  reopened.enforceLimit();
  const persisted = createAudioCacheStore({ dataDir: dir });
  assert.equal(
    fs.existsSync(keptPath),
    true,
    "later persistence does not make unknown audio sweepable"
  );
  assert.equal(
    fs.existsSync(orphanPath),
    true,
    "later persistence keeps unknown audio recoverable"
  );

  persisted.put("new", "kokoro", "v", { wavBuffer: wav(25, 3) });
  const afterPut = createAudioCacheStore({ dataDir: dir });
  assert.equal(
    afterPut.has("new", "kokoro", "v"),
    true,
    "new valid entries survive recovery persistence"
  );
  assert.equal(
    afterPut.list().totalBytes,
    25,
    "new valid bytes are loaded while sweep stays disabled"
  );
  assert.equal(fs.existsSync(keptPath), true, "old audio remains recoverable after a new put");
  assert.equal(fs.existsSync(orphanPath), true, "old orphan remains recoverable after a new put");
});

test("malformed entries shapes preserve WAV files without enabling a destructive sweep", () => {
  for (const malformedEntries of [[], null, "bad"]) {
    const dir = tempDir();
    const store = createAudioCacheStore({ dataDir: dir });
    store.put("kept", "kokoro", "v", { wavBuffer: wav(100) });

    const cacheDir = path.join(dir, "audio-cache");
    const keptPath = path.join(cacheDir, "kept__kokoro__v.wav");
    const orphanPath = path.join(cacheDir, "orphan.wav");
    fs.writeFileSync(orphanPath, wav(50, 2));
    fs.writeFileSync(
      path.join(cacheDir, "index.json"),
      JSON.stringify({ totalBytes: Number.MAX_SAFE_INTEGER, entries: malformedEntries })
    );

    const reopened = createAudioCacheStore({ dataDir: dir });

    assert.equal(
      fs.existsSync(keptPath),
      true,
      `kept audio survives entries=${String(malformedEntries)}`
    );
    assert.equal(
      fs.existsSync(orphanPath),
      true,
      `orphan audio survives entries=${String(malformedEntries)}`
    );
    assert.equal(reopened.list().entries.length, 0);
  }
});

test("persisted metadata is whitelisted and invalid ownership stays recoverable", () => {
  const dir = tempDir();
  const cacheDir = path.join(dir, "audio-cache");
  const validKey = keyFor("valid", "kokoro", "voice");
  const mismatchedKey = keyFor("other", "kokoro", "voice");
  const validPath = path.join(cacheDir, `${validKey}.wav`);
  const mismatchedPath = path.join(cacheDir, `${mismatchedKey}.wav`);
  const orphanPath = path.join(cacheDir, "orphan.wav");

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(validPath, wav(12));
  fs.writeFileSync(mismatchedPath, wav(13));
  fs.writeFileSync(orphanPath, wav(14));
  fs.writeFileSync(
    path.join(cacheDir, "index.json"),
    JSON.stringify({
      totalBytes: Number.MAX_SAFE_INTEGER,
      entries: {
        [validKey]: {
          key: "forged-key",
          itemId: "valid",
          engine: "kokoro",
          voice: "voice",
          bytes: -999,
          sampleRate: "bad",
          durationSec: -1,
          wordAccurate: "true",
          segments: [
            null,
            { text: 7, startSec: "bad", endSec: -2 },
            { text: "kept", startSec: 1, endSec: 2 },
            { text: "backwards", startSec: 3, endSec: 2 }
          ],
          createdAt: "bad timestamp",
          lastAccessedAt: "not finite",
          untrustedExtra: "drop this"
        },
        [mismatchedKey]: {
          key: mismatchedKey,
          itemId: "different-owner",
          engine: "kokoro",
          voice: "voice",
          sampleRate: 24000,
          durationSec: 1,
          segments: []
        }
      }
    })
  );

  const reopened = createAudioCacheStore({ dataDir: dir });
  const listing = reopened.list();

  assert.deepEqual(listing.entries, [
    {
      key: validKey,
      itemId: "valid",
      engine: "kokoro",
      voice: "voice",
      bytes: 12,
      sampleRate: null,
      durationSec: null,
      wordAccurate: false,
      segments: [{ text: "kept", startSec: 1, endSec: 2 }],
      createdAt: null,
      lastAccessedAt: null
    }
  ]);
  assert.equal(listing.totalBytes, 12, "actual file bytes remain authoritative");
  assert.deepEqual(reopened.getManifest("valid", "kokoro", "voice"), {
    sampleRate: null,
    durationSec: null,
    segments: [{ text: "kept", startSec: 1, endSec: 2 }],
    wordAccurate: false
  });
  assert.equal(fs.existsSync(mismatchedPath), true, "mismatched ownership remains recoverable");
  reopened.enforceLimit();
  const persisted = createAudioCacheStore({ dataDir: dir });
  assert.equal(
    persisted.has("valid", "kokoro", "voice"),
    true,
    "valid entries remain visible after protection persistence"
  );
  assert.equal(
    fs.existsSync(mismatchedPath),
    true,
    "mismatched ownership survives a second restart"
  );
  assert.equal(persisted.removeOne("different-owner", "kokoro", "voice"), 0);
  assert.equal(
    fs.existsSync(mismatchedPath),
    true,
    "untrusted ownership is not deletable by another id"
  );
  assert.equal(fs.existsSync(orphanPath), false, "known orphan is still swept");
});
