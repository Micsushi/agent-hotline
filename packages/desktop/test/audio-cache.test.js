import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWav,
  decodeWav,
  getAudio,
  evictMem,
  withGenLock,
  deleteCacheProject,
  deleteCacheSession
} from "../src/audio-cache.js";

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    return handler(String(url), options);
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test("encodeWav/decodeWav round-trips samples and sample rate", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 0.999, -0.999, 0.25]);
  const decoded = decodeWav(encodeWav(samples, 24000));

  assert.equal(decoded.sampleRate, 24000);
  assert.equal(decoded.samples.length, samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    // 16-bit quantization, so allow a small epsilon.
    assert.ok(Math.abs(decoded.samples[i] - samples[i]) < 0.0001);
  }
});

test("getAudio generates once on a backend miss, then serves from memory", async () => {
  evictMem();
  let generated = 0;
  const calls = installFetch(async (url, options) => {
    if (options.method === "POST") return jsonResponse({ stored: true }, 201);
    return jsonResponse({ cached: false }); // manifest miss
  });

  const generate = async () => {
    generated += 1;
    return {
      samples: new Float32Array([0.1, 0.2]),
      sampleRate: 24000,
      segments: [],
      wordAccurate: false
    };
  };

  const target = { itemId: "miss-1", engine: "kokoro-ts", voice: "af_heart" };
  const first = await getAudio("http://b", target, generate);
  const second = await getAudio("http://b", target, generate);

  assert.equal(generated, 1, "second call comes from the in-memory cache");
  assert.equal(first.samples.length, 2);
  assert.equal(second.samples.length, 2);
  // One POST upload happened (after the first generate).
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("getAudio serves a backend hit without generating", async () => {
  evictMem();
  let generated = 0;
  const wavBuffer = encodeWav(new Float32Array([0.3, -0.3, 0.6]), 24000);

  installFetch(async (url) => {
    if (url.includes("/audio.wav")) {
      return { ok: true, status: 200, arrayBuffer: async () => wavBuffer };
    }
    return jsonResponse({
      cached: true,
      sampleRate: 24000,
      durationSec: 0.5,
      wordAccurate: true,
      segments: [{ text: "hi", startSec: 0, endSec: 0.5 }]
    });
  });

  const generate = async () => {
    generated += 1;
    return { samples: new Float32Array([0]), sampleRate: 24000, segments: [] };
  };

  const result = await getAudio(
    "http://b",
    { itemId: "hit-1", engine: "kokoro-ts", voice: "af_heart" },
    generate
  );

  assert.equal(generated, 0, "backend hit means no generation");
  assert.equal(result.samples.length, 3);
  assert.equal(result.wordAccurate, true);
  assert.deepEqual(result.segments, [{ text: "hi", startSec: 0, endSec: 0.5 }]);
});

test("concurrent getAudio for the same key generates only once (in-flight dedupe)", async () => {
  evictMem();
  let generated = 0;
  installFetch(async (url, options) => {
    if (options.method === "POST") return jsonResponse({ stored: true }, 201);
    return jsonResponse({ cached: false });
  });

  // Slow generate so the second call lands while the first is still in flight.
  const generate = async () => {
    generated += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      samples: new Float32Array([0.1]),
      sampleRate: 24000,
      segments: [],
      wordAccurate: false
    };
  };

  const target = { itemId: "dedupe-1", engine: "kokoro-ts", voice: "af_heart" };
  const [a, b] = await Promise.all([
    getAudio("http://b", target, generate),
    getAudio("http://b", target, generate)
  ]);

  assert.equal(generated, 1, "the Play click reuses the in-flight pre-gen");
  assert.equal(a.samples.length, 1);
  assert.equal(b.samples.length, 1);
});

test("withGenLock runs tasks one at a time, in order", async () => {
  const order = [];
  const make = (label) => () =>
    new Promise((resolve) =>
      setTimeout(() => {
        order.push(label);
        resolve(label);
      }, 5)
    );

  const a = withGenLock(make("a"));
  const b = withGenLock(make("b"));
  await Promise.all([a, b]);

  assert.deepEqual(order, ["a", "b"]);
});

test("a rejected locked task does not block the next one", async () => {
  await withGenLock(() => Promise.reject(new Error("boom"))).catch(() => {});
  const result = await withGenLock(() => Promise.resolve("ok"));
  assert.equal(result, "ok");
});

test("session and project deletes evict matching in-memory recordings", async () => {
  evictMem();
  let generated = 0;
  let deletedSession = false;
  let deletedProject = false;

  installFetch(async (url, options) => {
    if (url.endsWith("/api/audio-cache")) {
      return jsonResponse({
        entries: [
          { itemId: "session-item", engine: "kokoro-ts", voice: "af_heart", sessionKey: "s1" },
          { itemId: "project-item", engine: "kokoro-ts", voice: "af_heart", projectKey: "p1" }
        ]
      });
    }
    if (url.endsWith("/api/audio-cache?session=s1") && options.method === "DELETE") {
      deletedSession = true;
      return jsonResponse({ removed: 1 });
    }
    if (url.endsWith("/api/audio-cache?project=p1") && options.method === "DELETE") {
      deletedProject = true;
      return jsonResponse({ removed: 1 });
    }
    if (options.method === "POST") return jsonResponse({ stored: true }, 201);
    return jsonResponse({ cached: false });
  });

  const generate = async () => {
    generated += 1;
    return {
      samples: new Float32Array([generated]),
      sampleRate: 24000,
      segments: [],
      wordAccurate: false
    };
  };

  await getAudio(
    "http://b",
    { itemId: "session-item", engine: "kokoro-ts", voice: "af_heart" },
    generate
  );
  await getAudio(
    "http://b",
    { itemId: "project-item", engine: "kokoro-ts", voice: "af_heart" },
    generate
  );
  assert.equal(generated, 2);

  await deleteCacheSession("http://b", "s1");
  assert.equal(deletedSession, true);
  await getAudio(
    "http://b",
    { itemId: "session-item", engine: "kokoro-ts", voice: "af_heart" },
    generate
  );
  assert.equal(generated, 3, "session delete removed stale memory cache");

  await deleteCacheProject("http://b", "p1");
  assert.equal(deletedProject, true);
  await getAudio(
    "http://b",
    { itemId: "project-item", engine: "kokoro-ts", voice: "af_heart" },
    generate
  );
  assert.equal(generated, 4, "project delete removed stale memory cache");
});
