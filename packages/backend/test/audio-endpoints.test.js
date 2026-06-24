const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createServer, HOST } = require("../src/server");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-audio-api-"));
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
    await callback({ baseUrl, dataDir });
  } finally {
    await close(server);
  }
}

async function enqueue(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return (await response.json()).item;
}

const FAKE_WAV = Buffer.from("RIFF....fake-wav-bytes....", "utf8").toString("base64");

test("audio can be uploaded, fetched as manifest + wav, and reported as cached", async () => {
  await withServer(async ({ baseUrl }) => {
    await enqueue(baseUrl, {
      id: "item-1",
      rawSource: "raw",
      speakableText: "Hello there from the cache test.",
      sourceApp: "Codex",
      threadId: "thread-a",
      sessionName: "Session A"
    });

    // Miss before upload.
    const missResp = await fetch(
      `${baseUrl}/api/queue/item-1/audio?engine=kokoro-ts&voice=af_heart`
    );
    assert.equal((await missResp.json()).cached, false);

    // Upload.
    const put = await fetch(`${baseUrl}/api/queue/item-1/audio?engine=kokoro-ts&voice=af_heart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sampleRate: 24000,
        durationSec: 1.5,
        wordAccurate: true,
        segments: [{ text: "Hello", startSec: 0, endSec: 1.5 }],
        wav: FAKE_WAV
      })
    });
    assert.equal(put.status, 201);
    assert.equal((await put.json()).stored, true);

    // Manifest hit.
    const manifestResp = await fetch(
      `${baseUrl}/api/queue/item-1/audio?engine=kokoro-ts&voice=af_heart`
    );
    const manifest = await manifestResp.json();
    assert.equal(manifest.cached, true);
    assert.equal(manifest.sampleRate, 24000);
    assert.equal(manifest.wordAccurate, true);
    assert.deepEqual(manifest.segments, [{ text: "Hello", startSec: 0, endSec: 1.5 }]);

    // Wav bytes.
    const wavResp = await fetch(
      `${baseUrl}/api/queue/item-1/audio.wav?engine=kokoro-ts&voice=af_heart`
    );
    assert.equal(wavResp.status, 200);
    assert.equal(wavResp.headers.get("content-type"), "audio/wav");
    const wavBytes = Buffer.from(await wavResp.arrayBuffer());
    assert.equal(wavBytes.toString("base64"), FAKE_WAV);

    // A different voice is a separate (uncached) key.
    const otherVoice = await fetch(
      `${baseUrl}/api/queue/item-1/audio?engine=kokoro-ts&voice=am_adam`
    );
    assert.equal((await otherVoice.json()).cached, false);
  });
});

test("audio.wav returns 404 when nothing is cached", async () => {
  await withServer(async ({ baseUrl }) => {
    const resp = await fetch(`${baseUrl}/api/queue/none/audio.wav?engine=kokoro&voice=af_heart`);
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).error.code, "not_found");
  });
});

test("audio upload requires engine and voice", async () => {
  await withServer(async ({ baseUrl }) => {
    const resp = await fetch(`${baseUrl}/api/queue/item-1/audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wav: FAKE_WAV })
    });
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error.code, "invalid_request");
  });
});

test("audio-cache list joins queue session info", async () => {
  await withServer(async ({ baseUrl }) => {
    await enqueue(baseUrl, {
      id: "item-1",
      rawSource: "raw",
      speakableText: "First reply.",
      sourceApp: "Codex",
      threadId: "thread-a",
      sessionName: "Session A"
    });
    await fetch(`${baseUrl}/api/queue/item-1/audio?engine=kokoro&voice=af_heart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleRate: 24000, durationSec: 1, wav: FAKE_WAV })
    });

    const listResp = await fetch(`${baseUrl}/api/audio-cache`);
    const list = await listResp.json();
    assert.equal(list.entries.length, 1);
    assert.ok(list.maxBytes > 0);
    assert.ok(list.totalBytes > 0);
    const entry = list.entries[0];
    assert.equal(entry.itemId, "item-1");
    assert.equal(entry.sessionName, "Session A");
    assert.equal(entry.sessionKey, "thread-a");
    assert.equal(entry.engine, "kokoro");
    assert.match(entry.preview, /First reply/);
  });
});

test("audio-cache deletes a single recording, a session, and everything", async () => {
  await withServer(async ({ baseUrl }) => {
    await enqueue(baseUrl, {
      id: "a1",
      rawSource: "raw",
      speakableText: "a one",
      sourceApp: "Codex",
      threadId: "thread-a"
    });
    await enqueue(baseUrl, {
      id: "a2",
      rawSource: "raw",
      speakableText: "a two",
      sourceApp: "Codex",
      threadId: "thread-a"
    });
    await enqueue(baseUrl, {
      id: "b1",
      rawSource: "raw",
      speakableText: "b one",
      sourceApp: "Claude",
      threadId: "thread-b"
    });

    for (const id of ["a1", "a2", "b1"]) {
      await fetch(`${baseUrl}/api/queue/${id}/audio?engine=kokoro&voice=af_heart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleRate: 24000, durationSec: 1, wav: FAKE_WAV })
      });
    }

    // Delete one recording.
    const one = await fetch(`${baseUrl}/api/audio-cache/a1?engine=kokoro&voice=af_heart`, {
      method: "DELETE"
    });
    assert.equal((await one.json()).removed, 1);

    // Delete the rest of session thread-a.
    const session = await fetch(`${baseUrl}/api/audio-cache?session=thread-a`, {
      method: "DELETE"
    });
    assert.equal((await session.json()).removed, 1);

    let list = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].itemId, "b1");

    // Delete everything.
    const all = await fetch(`${baseUrl}/api/audio-cache?all=true`, { method: "DELETE" });
    assert.equal((await all.json()).removed, 1);
    list = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    assert.equal(list.entries.length, 0);
  });
});

test("audio-cache list reports project info and deletes by project", async () => {
  await withServer(async ({ baseUrl }) => {
    // Two items in one project, one direct (no project).
    await enqueue(baseUrl, {
      id: "p1",
      rawSource: "raw",
      speakableText: "proj one",
      sourceApp: "Codex",
      threadId: "t1",
      projectPath: "C:/repos/alpha",
      projectName: "alpha"
    });
    await enqueue(baseUrl, {
      id: "p2",
      rawSource: "raw",
      speakableText: "proj two",
      sourceApp: "Codex",
      threadId: "t2",
      projectPath: "C:/repos/alpha",
      projectName: "alpha"
    });
    await enqueue(baseUrl, {
      id: "d1",
      rawSource: "raw",
      speakableText: "direct one",
      sourceApp: "Claude"
    });

    for (const id of ["p1", "p2", "d1"]) {
      await fetch(`${baseUrl}/api/queue/${id}/audio?engine=kokoro&voice=af_heart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleRate: 24000, durationSec: 1, wav: FAKE_WAV })
      });
    }

    const list = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    const alpha = list.entries.find((e) => e.itemId === "p1");
    assert.equal(alpha.projectName, "alpha");
    assert.equal(alpha.projectKey, "C:/repos/alpha");
    const direct = list.entries.find((e) => e.itemId === "d1");
    assert.equal(direct.projectKey, "direct:Claude");

    // Delete the whole alpha project -> removes p1 + p2, leaves the direct one.
    const removed = await (
      await fetch(`${baseUrl}/api/audio-cache?project=${encodeURIComponent("C:/repos/alpha")}`, {
        method: "DELETE"
      })
    ).json();
    assert.equal(removed.removed, 2);

    const after = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    assert.deepEqual(
      after.entries.map((e) => e.itemId),
      ["d1"]
    );
  });
});

test("storage limit setting is validated and enforced live", async () => {
  await withServer(async ({ baseUrl }) => {
    // Default limit is 1 GB.
    const initial = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    assert.equal(initial.maxBytes, 1024 * 1024 * 1024);

    // Out-of-range is rejected.
    const bad = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioCacheLimitMb: 0 })
    });
    assert.equal(bad.status, 400);

    const tooLarge = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioCacheLimitMb: 100001 })
    });
    assert.equal(tooLarge.status, 400);

    // Lowering the cap is accepted and reflected by the cache list.
    const ok = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioCacheLimitMb: 50 })
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).settings.audioCacheLimitMb, 50);

    const after = await (await fetch(`${baseUrl}/api/audio-cache`)).json();
    assert.equal(after.maxBytes, 50 * 1024 * 1024);
  });
});

test("audio DELETE is allowed through CORS for local origins", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/audio-cache?all=true`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:4778",
        "Access-Control-Request-Method": "DELETE"
      }
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("access-control-allow-methods"), /DELETE/);
  });
});
