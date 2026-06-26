const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSpeechQueueStore, defaultQueueFile } = require("../src/speech-queue-store");

function createTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-queue-"));
  return path.join(dir, "speech-queue.json");
}

function createClock() {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-06-20T00:00:${String(tick).padStart(2, "0")}.000Z`;
  };
}

function createIds(ids) {
  let index = 0;
  return () => ids[index++] || `generated-${index}`;
}

function sampleItem(overrides = {}) {
  return {
    rawSource: "Full agent response with display-only detail.",
    speakableText: "Here is the short spoken summary.",
    sourceApp: "Codex",
    ...overrides
  };
}

function testDefaultRuntimeFile() {
  const expected = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Agent Hotline",
    "speech-queue.json"
  );
  assert.equal(defaultQueueFile(), expected);
}

function testQueueLifecycle() {
  const store = createSpeechQueueStore({
    filePath: createTempFile(),
    now: createClock(),
    idGenerator: createIds(["item-1"])
  });

  const enqueued = store.enqueue(sampleItem());
  assert.equal(enqueued.id, "item-1");
  assert.equal(enqueued.status, "pending");
  assert.equal(enqueued.sourceApp, "Codex");
  assert.equal(enqueued.timestamps.createdAt, "2026-06-20T00:00:01.000Z");
  assert.deepEqual(
    store.getPending().map((item) => item.id),
    ["item-1"]
  );

  const playing = store.markPlaying("item-1");
  assert.equal(playing.status, "playing");
  assert.equal(playing.timestamps.playingAt, "2026-06-20T00:00:02.000Z");
  assert.equal(store.getCurrent().id, "item-1");

  const played = store.markPlayed("item-1");
  assert.equal(played.status, "played");
  assert.equal(played.timestamps.playedAt, "2026-06-20T00:00:03.000Z");
  assert.equal(store.getCurrent(), null);
  assert.equal(store.getLatest().id, "item-1");
}

function testPersistenceAndReplayAfterRestart() {
  const filePath = createTempFile();
  const firstStore = createSpeechQueueStore({
    filePath,
    now: createClock(),
    idGenerator: createIds(["original"])
  });

  firstStore.enqueue(sampleItem({ sourceApp: "Claude" }));
  firstStore.markPlaying("original");
  firstStore.markPlayed("original");

  const restartedStore = createSpeechQueueStore({
    filePath,
    now: createClock(),
    idGenerator: createIds(["replay-1"])
  });

  assert.equal(restartedStore.getLatest().id, "original");
  assert.equal(restartedStore.getLatest().status, "played");

  const replayed = restartedStore.replayLatest();
  assert.equal(replayed.id, "replay-1");
  assert.equal(replayed.replayOf, "original");
  assert.equal(replayed.status, "pending");
  assert.equal(replayed.sourceApp, "Claude");
  assert.equal(replayed.speakableText, "Here is the short spoken summary.");
  assert.deepEqual(
    restartedStore.getPending().map((item) => item.id),
    ["replay-1"]
  );
}

function testPlayingItemsResetAfterRestart() {
  const filePath = createTempFile();
  const firstStore = createSpeechQueueStore({
    filePath,
    now: createClock(),
    idGenerator: createIds(["interrupted"])
  });

  firstStore.enqueue(sampleItem({ sourceApp: "Claude" }));
  firstStore.markPlaying("interrupted");
  assert.equal(firstStore.getCurrent().id, "interrupted");

  const restartedStore = createSpeechQueueStore({
    filePath,
    now: createClock()
  });

  assert.equal(restartedStore.getCurrent(), null);
  assert.deepEqual(
    restartedStore.getPending().map((item) => item.id),
    ["interrupted"]
  );
  assert.equal(restartedStore.getPending()[0].timestamps.interruptedAt, "2026-06-20T00:00:01.000Z");
}

function testSkippedItemsRecordReason() {
  const store = createSpeechQueueStore({
    filePath: createTempFile(),
    now: createClock(),
    idGenerator: createIds(["skip-me"])
  });

  store.enqueue(sampleItem());
  const skipped = store.markSkipped("skip-me", "User chose not to read this response.");

  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.skipReason, "User chose not to read this response.");
  assert.equal(skipped.timestamps.skippedAt, "2026-06-20T00:00:02.000Z");
}

function testReplayIgnoresSkippedLatest() {
  const store = createSpeechQueueStore({
    filePath: createTempFile(),
    now: createClock(),
    idGenerator: createIds(["played", "skipped", "replay"])
  });

  store.enqueue(sampleItem({ speakableText: "Replay this." }));
  store.markPlayed("played");
  store.enqueue(sampleItem({ speakableText: "Do not replay this." }));
  store.markSkipped("skipped", "Filtered as code-heavy.");

  const replayed = store.replayLatest();
  assert.equal(replayed.replayOf, "played");
  assert.equal(replayed.speakableText, "Replay this.");
}

function testClearQueue() {
  const store = createSpeechQueueStore({
    filePath: createTempFile(),
    now: createClock(),
    idGenerator: createIds(["item-1"])
  });

  store.enqueue(sampleItem());
  const state = store.clearQueue();

  assert.deepEqual(state.items, []);
  assert.equal(store.getLatest(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.filePath, "utf8")), { items: [] });
}

function testThreadFieldsStoredAndReplayedById() {
  const store = createSpeechQueueStore({
    filePath: createTempFile(),
    now: createClock(),
    idGenerator: createIds(["orig", "replay"])
  });

  const item = store.enqueue(
    sampleItem({ threadId: "sess-123", threadLabel: "agent-hotline  -  sess-123" })
  );
  assert.equal(item.threadId, "sess-123");
  assert.equal(item.threadLabel, "agent-hotline  -  sess-123");

  const replayed = store.replayItem("orig");
  assert.equal(replayed.replayOf, "orig");
  assert.equal(replayed.threadId, "sess-123");
  assert.equal(replayed.speakableText, item.speakableText);

  assert.equal(store.replayItem("does-not-exist"), null);
}

function testProjectRootMigrationOnLoad() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-repo-"));
  fs.mkdirSync(path.join(repoRoot, ".git"));
  const subdir = path.join(repoRoot, "packages", "desktop");
  fs.mkdirSync(subdir, { recursive: true });
  const filePath = path.join(repoRoot, "speech-queue.json");

  const first = createSpeechQueueStore({
    filePath,
    now: createClock(),
    idGenerator: createIds(["drifted"])
  });
  first.enqueue(sampleItem({ projectPath: subdir, projectName: "desktop" }));

  // Restart: load-time migration should collapse the subdir path onto the repo root.
  const restarted = createSpeechQueueStore({
    filePath,
    now: createClock(),
    idGenerator: createIds(["after"])
  });
  const latest = restarted.getLatest();
  assert.equal(latest.projectPath, repoRoot);
  assert.equal(latest.projectName, path.basename(repoRoot));

  // Persisted, so a second restart is a no-op (idempotent).
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.items[0].projectPath, repoRoot);
}

const tests = [
  testProjectRootMigrationOnLoad,
  testDefaultRuntimeFile,
  testQueueLifecycle,
  testPersistenceAndReplayAfterRestart,
  testPlayingItemsResetAfterRestart,
  testSkippedItemsRecordReason,
  testReplayIgnoresSkippedLatest,
  testThreadFieldsStoredAndReplayedById,
  testClearQueue
];

for (const test of tests) {
  test();
}

console.log(`speech-queue-store: ${tests.length} tests passed`);
