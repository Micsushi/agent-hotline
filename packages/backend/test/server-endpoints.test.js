const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createServer, HOST } = require("../src/server");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-api-"));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withServer(callback) {
  const dataDir = tempDir();
  const server = createServer({ dataDir });
  const port = await listen(server);
  const baseUrl = `http://${HOST}:${port}`;

  try {
    await callback({ baseUrl, dataDir, server });
  } finally {
    await close(server);
  }
}

async function jsonFetch(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

async function rawFetch(baseUrl, pathName, options = {}) {
  return fetch(`${baseUrl}${pathName}`, options);
}

test("health works on the localhost API", async () => {
  await withServer(async ({ baseUrl }) => {
    const { response, body } = await jsonFetch(baseUrl, "/health");

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      service: "agent-hotline",
      host: "127.0.0.1"
    });
  });
});

test("local desktop origins can read API endpoints through CORS", async () => {
  await withServer(async ({ baseUrl }) => {
    const origin = "http://127.0.0.1:4778";

    for (const pathName of ["/api/health", "/api/settings", "/api/queue"]) {
      const response = await rawFetch(baseUrl, pathName, {
        headers: { Origin: origin }
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.match(response.headers.get("access-control-allow-methods"), /GET/);
    }
  });
});

test("local desktop origins can preflight queue and settings API requests", async () => {
  await withServer(async ({ baseUrl }) => {
    const origin = "http://127.0.0.1:4778";

    for (const pathName of ["/api/settings", "/api/queue"]) {
      const response = await rawFetch(baseUrl, pathName, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type"
        }
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.match(response.headers.get("access-control-allow-methods"), /POST/);
      assert.match(response.headers.get("access-control-allow-headers"), /Content-Type/);
    }
  });
});

test("non-local CORS origins are not allowed", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await rawFetch(baseUrl, "/api/queue", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET"
      }
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(body.error.code, "forbidden_origin");
  });
});

test("settings can be read, updated, muted, and unmuted without provider credentials", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const initial = await jsonFetch(baseUrl, "/api/settings");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.settings.readBehavior, "manual");
    assert.equal(initial.body.settings.mute, false);

    const updated = await jsonFetch(baseUrl, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        readBehavior: "auto",
        voice: "Local Browser Voice",
        audioOutputDeviceId: "speaker-1",
        rate: 1.2,
        volume: 0.7,
        skipRules: { tables: false },
        codexEnabled: false
      })
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.settings.readBehavior, "auto");
    assert.equal(updated.body.settings.voice, "Local Browser Voice");
    assert.equal(updated.body.settings.audioOutputDeviceId, "speaker-1");
    assert.equal(updated.body.settings.skipRules.tables, false);
    assert.equal(updated.body.settings.skipRules.codeBlocks, true);
    assert.equal(updated.body.settings.codexEnabled, false);

    const muted = await jsonFetch(baseUrl, "/api/mute", { method: "POST" });
    assert.equal(muted.response.status, 200);
    assert.equal(muted.body.settings.mute, true);

    const unmuted = await jsonFetch(baseUrl, "/api/unmute", { method: "POST" });
    assert.equal(unmuted.response.status, 200);
    assert.equal(unmuted.body.settings.mute, false);

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    assert.equal(persisted.readBehavior, "auto");
    assert.equal(persisted.mute, false);
  });
});

test("queue endpoints enqueue, expose state, mark played/skipped, and replay latest", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const enqueued = await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({
        id: "item-1",
        rawSource: "Full agent response with code kept in chat.",
        speakableText: "The backend endpoints are ready for local playback.",
        sourceApp: "Codex"
      })
    });
    assert.equal(enqueued.response.status, 201);
    assert.equal(enqueued.body.item.id, "item-1");
    assert.equal(enqueued.body.item.status, "pending");
    assert.deepEqual(
      enqueued.body.queue.pending.map((item) => item.id),
      ["item-1"]
    );

    const state = await jsonFetch(baseUrl, "/api/queue");
    assert.equal(state.response.status, 200);
    assert.equal(state.body.queue.latest.id, "item-1");
    assert.equal(state.body.queue.current, null);

    const playing = await jsonFetch(baseUrl, "/api/queue/item-1/playing", { method: "POST" });
    assert.equal(playing.response.status, 200);
    assert.equal(playing.body.item.status, "playing");
    assert.equal(playing.body.queue.current.id, "item-1");
    assert.deepEqual(playing.body.queue.pending, []);

    const played = await jsonFetch(baseUrl, "/api/queue/item-1/played", { method: "POST" });
    assert.equal(played.response.status, 200);
    assert.equal(played.body.item.status, "played");
    assert.deepEqual(played.body.queue.pending, []);

    const replayed = await jsonFetch(baseUrl, "/api/queue/replay-latest", { method: "POST" });
    assert.equal(replayed.response.status, 201);
    assert.equal(replayed.body.item.replayOf, "item-1");
    assert.equal(replayed.body.item.status, "pending");

    const skipped = await jsonFetch(baseUrl, `/api/queue/${replayed.body.item.id}/skipped`, {
      method: "POST",
      body: JSON.stringify({ reason: "User skipped playback." })
    });
    assert.equal(skipped.response.status, 200);
    assert.equal(skipped.body.item.status, "skipped");
    assert.equal(skipped.body.item.skipReason, "User skipped playback.");

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "speech-queue.json"), "utf8"));
    assert.equal(persisted.items.length, 2);
  });
});

test("queue trash and restore preserve chat records while hiding normal queue state", async () => {
  await withServer(async ({ baseUrl }) => {
    await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({
        id: "item-1",
        rawSource: "Full agent response.",
        speakableText: "Searchable reply one.",
        sourceApp: "Codex",
        threadId: "thread-a"
      })
    });
    await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({
        id: "item-2",
        rawSource: "Full agent response.",
        speakableText: "Searchable reply two.",
        sourceApp: "Codex",
        threadId: "thread-a"
      })
    });

    const trashed = await jsonFetch(baseUrl, "/api/queue/trash", {
      method: "POST",
      body: JSON.stringify({ itemIds: ["item-2"] })
    });
    assert.equal(trashed.response.status, 200);
    assert.deepEqual(trashed.body.trashed, ["item-2"]);
    assert.deepEqual(
      trashed.body.queue.pending.map((item) => item.id),
      ["item-1"]
    );
    assert.equal(
      trashed.body.queue.items.find((item) => item.id === "item-2").trashedAt,
      trashed.body.queue.items.find((item) => item.id === "item-2").timestamps.updatedAt
    );

    const restored = await jsonFetch(baseUrl, "/api/queue/restore", {
      method: "POST",
      body: JSON.stringify({ sessionKey: "thread-a" })
    });
    assert.equal(restored.response.status, 200);
    assert.deepEqual(restored.body.restored, ["item-2"]);
    assert.deepEqual(
      restored.body.queue.pending.map((item) => item.id),
      ["item-1", "item-2"]
    );
  });
});

test("queue trash can target explicit session keys", async () => {
  await withServer(async ({ baseUrl }) => {
    await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({
        id: "keyed-1",
        rawSource: "Full agent response.",
        speakableText: "Session keyed reply one.",
        sourceApp: "Codex",
        sessionKey: "session-a",
        threadId: "thread-a"
      })
    });
    await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({
        id: "keyed-2",
        rawSource: "Full agent response.",
        speakableText: "Session keyed reply two.",
        sourceApp: "Codex",
        sessionKey: "session-b",
        threadId: "thread-a"
      })
    });

    const trashed = await jsonFetch(baseUrl, "/api/queue/trash", {
      method: "POST",
      body: JSON.stringify({ sessionKey: "session-a" })
    });
    assert.equal(trashed.response.status, 200);
    assert.deepEqual(trashed.body.trashed, ["keyed-1"]);
    assert.deepEqual(
      trashed.body.queue.pending.map((item) => item.id),
      ["keyed-2"]
    );
  });
});

test("bad input returns structured errors", async () => {
  await withServer(async ({ baseUrl }) => {
    const malformed = await jsonFetch(baseUrl, "/api/settings", {
      method: "PATCH",
      body: "{ not json"
    });
    assert.equal(malformed.response.status, 400);
    assert.deepEqual(malformed.body.error, {
      code: "invalid_json",
      message: "Request body must be valid JSON"
    });

    const invalidSettings = await jsonFetch(baseUrl, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ rate: 99, skipRules: { tables: "no" } })
    });
    assert.equal(invalidSettings.response.status, 400);
    assert.equal(invalidSettings.body.error.code, "invalid_settings");
    assert.ok(invalidSettings.body.error.details.includes("rate must be a number from 0.1 to 10"));
    assert.ok(invalidSettings.body.error.details.includes("skipRules.tables must be boolean"));

    const invalidQueue = await jsonFetch(baseUrl, "/api/queue", {
      method: "POST",
      body: JSON.stringify({ speakableText: "Missing source app and raw source." })
    });
    assert.equal(invalidQueue.response.status, 400);
    assert.deepEqual(invalidQueue.body.error, {
      code: "invalid_request",
      message: "rawSource must be a non-empty string"
    });

    const missingItem = await jsonFetch(baseUrl, "/api/queue/missing/played", { method: "POST" });
    assert.equal(missingItem.response.status, 404);
    assert.equal(missingItem.body.error.code, "not_found");
  });
});
