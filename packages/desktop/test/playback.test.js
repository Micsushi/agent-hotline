import assert from "node:assert/strict";
import test from "node:test";

import { createPlaybackController } from "../src/playback.js";

function installWindow({ voices = [{ name: "System Voice", voiceURI: "system-voice" }] } = {}) {
  const spoken = [];
  const synth = {
    paused: false,
    cancelled: 0,
    getVoices: () => voices,
    speak: (utterance) => {
      spoken.push(utterance);
    },
    pause: () => {
      synth.paused = true;
    },
    resume: () => {
      synth.paused = false;
    },
    cancel: () => {
      synth.cancelled += 1;
    },
    addEventListener: () => {}
  };

  class Utterance {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.volume = 1;
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }
  }

  globalThis.window = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: Utterance,
    setTimeout,
    clearTimeout
  };

  return { synth, spoken };
}

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    const result = await handler(String(url), { ...options, body });
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.body
    };
  };
  return calls;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, ms, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function installAudioWindow() {
  const { synth } = installWindow();
  const sources = [];

  class FakeAudioBuffer {
    constructor(length, sampleRate) {
      this.length = length;
      this.sampleRate = sampleRate;
      this.duration = length / sampleRate;
      this.data = new Float32Array(length);
    }

    copyToChannel(samples, _channel, offset = 0) {
      this.data.set(samples, offset);
    }
  }

  class FakeSource {
    constructor() {
      this.buffer = null;
      this.playbackRate = { value: 1 };
      this.onended = null;
      this.stopped = false;
      this.startOffset = 0;
    }

    connect() {}

    disconnect() {}

    start(_when = 0, offset = 0) {
      this.startOffset = offset;
      sources.push(this);
    }

    stop() {
      this.stopped = true;
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }

    createBuffer(_channels, length, sampleRate) {
      return new FakeAudioBuffer(length, sampleRate);
    }

    createBufferSource() {
      return new FakeSource();
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {}
      };
    }

    async resume() {
      this.state = "running";
    }

    suspend() {
      this.state = "suspended";
    }
  }

  globalThis.window.AudioContext = FakeAudioContext;
  return { synth, sources };
}

test("playback skips code-heavy speakable text before browser speech starts", async () => {
  const { spoken } = installWindow();
  const calls = installFetch(async (url, options) => {
    assert.match(url, /\/api\/queue\/item-1\/skipped$/);
    assert.equal(
      options.body.reason,
      "Speakable text still looks code-heavy, so playback was skipped."
    );
    return { status: 200, body: { item: { id: "item-1", status: "skipped" } } };
  });
  const updates = [];

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message)
  });

  await controller.readNextPending({
    settings: { mute: false },
    queue: {
      pending: [{ id: "item-1", sourceApp: "Codex", speakableText: "```js\nconst x = 1;\n```" }]
    }
  });

  assert.equal(spoken.length, 0);
  assert.equal(calls.length, 1);
  assert.match(updates.at(-1), /code-heavy/);
});

test("playback marks an item playing, applies voice settings, then marks it played on end", async () => {
  const voice = { name: "Local Voice", voiceURI: "local-voice" };
  const { spoken } = installWindow({ voices: [voice] });
  const calls = installFetch(async (url) => {
    if (url.endsWith("/api/queue/item-2/playing")) {
      return {
        status: 200,
        body: {
          item: {
            id: "item-2",
            sourceApp: "Claude",
            speakableText: "  The playback controller reads this aloud.  "
          }
        }
      };
    }

    if (url.endsWith("/api/queue/item-2/played")) {
      return { status: 200, body: { item: { id: "item-2", status: "played" } } };
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
  const states = [];
  const updates = [];
  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message),
    onStateChanged: () => states.push(controller.state)
  });

  await controller.readNextPending({
    settings: { mute: false, voice: "Local Voice", rate: 1.4, volume: 0.6 },
    queue: {
      pending: [
        {
          id: "item-2",
          sourceApp: "Claude",
          speakableText: "The playback controller reads this aloud."
        }
      ]
    }
  });

  assert.equal(controller.state, "speaking");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "The playback controller reads this aloud.");
  assert.equal(spoken[0].voice, voice);
  assert.equal(spoken[0].rate, 1.4);
  assert.equal(spoken[0].volume, 0.6);
  assert.match(updates.at(-1), /Claude/);

  await spoken[0].onend();

  assert.equal(controller.state, "idle");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/api/queue/item-2/playing", "/api/queue/item-2/played"]
  );
  assert.deepEqual(states.slice(-3), ["speaking", "idle", "idle"]);
  assert.equal(updates.at(-1), "Read aloud finished.");
});

test("playback chooses a natural installed voice when no manual voice is selected", async () => {
  const naturalVoice = {
    name: "Microsoft Aria Natural",
    voiceURI: "Microsoft Aria Natural Online",
    lang: "en-US"
  };
  const desktopVoice = {
    name: "Microsoft David Desktop",
    voiceURI: "Microsoft David Desktop",
    lang: "en-US"
  };
  const { spoken } = installWindow({ voices: [desktopVoice, naturalVoice] });
  installFetch(async (url) => {
    if (url.endsWith("/api/queue/item-natural/playing")) {
      return {
        status: 200,
        body: {
          item: {
            id: "item-natural",
            sourceApp: "Codex",
            speakableText: "This should use the more natural voice."
          }
        }
      };
    }
    return { status: 200, body: { item: { id: "item-natural", status: "played" } } };
  });
  const controller = createPlaybackController({ backendUrl: "http://127.0.0.1:4777" });

  await controller.readNextPending({
    settings: { mute: false, voice: "", rate: undefined, volume: 1 },
    queue: {
      pending: [
        {
          id: "item-natural",
          sourceApp: "Codex",
          speakableText: "This should use the more natural voice."
        }
      ]
    }
  });

  assert.equal(spoken[0].voice, naturalVoice);
  assert.equal(spoken[0].rate, 0.92);
});

test("pause resume stop and mute control active browser speech", async () => {
  const { synth, spoken } = installWindow();
  const calls = installFetch(async (url, options) => {
    if (url.endsWith("/api/queue/item-3/playing")) {
      return {
        status: 200,
        body: { item: { id: "item-3", sourceApp: "Codex", speakableText: "A stoppable response." } }
      };
    }
    if (url.endsWith("/api/queue/item-3/skipped")) {
      return {
        status: 200,
        body: { item: { id: "item-3", status: "skipped", skipReason: options.body.reason } }
      };
    }
    if (url.endsWith("/api/mute")) {
      return { status: 200, body: { settings: { mute: true } } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const controller = createPlaybackController({ backendUrl: "http://127.0.0.1:4777" });

  await controller.readNextPending({
    settings: { mute: false },
    queue: {
      pending: [{ id: "item-3", sourceApp: "Codex", speakableText: "A stoppable response." }]
    }
  });
  assert.equal(spoken.length, 1);

  controller.pause();
  assert.equal(controller.state, "paused");
  assert.equal(synth.paused, true);

  controller.resume();
  assert.equal(controller.state, "speaking");
  assert.equal(synth.paused, false);

  await controller.setMute(true);
  assert.equal(controller.state, "idle");
  assert.equal(calls.at(-2).body.reason, "User muted playback.");
  assert.equal(new URL(calls.at(-1).url).pathname, "/api/mute");
});

test("kokoro cache miss starts playback after the first generated chunk", async () => {
  const { sources } = installAudioWindow();
  const chunkA = deferred();
  const chunkB = deferred();
  const generatedChunks = [];
  const calls = installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/stream-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "stream-1",
            sourceApp: "Codex",
            speakableText: "First sentence. Second sentence."
          }
        }
      };
    }
    if (path === "/api/queue/stream-1/audio" && options.method === "POST") {
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/stream-1/audio") {
      return { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/stream-1/played") {
      return { status: 200, body: { item: { id: "stream-1", status: "played" } } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    kokoroGetChunks: () => ["First sentence.", "Second sentence."],
    kokoroGenerateChunk: async (chunk) => {
      generatedChunks.push(chunk);
      return chunk === "First sentence." ? chunkA.promise : chunkB.promise;
    }
  });

  const playPromise = controller.readNextPending({
    settings: { mute: false, engine: "kokoro", rate: 1, volume: 1 },
    queue: {
      pending: [
        {
          id: "stream-1",
          sourceApp: "Codex",
          speakableText: "First sentence. Second sentence."
        }
      ]
    }
  });

  await Promise.resolve();
  assert.equal(sources.length, 0);
  chunkA.resolve({ samples: new Float32Array([0.1, 0.2, 0.3]), sampleRate: 24000 });
  await playPromise;

  assert.equal(controller.state, "speaking");
  assert.equal(sources.length, 1, "first chunk starts playback before chunk two is ready");
  assert.deepEqual(generatedChunks.slice(0, 1), ["First sentence."]);

  await Promise.resolve();
  assert.equal(generatedChunks[1], "Second sentence.", "later chunk generation continues");
  chunkB.resolve({ samples: new Float32Array([0.4, 0.5]), sampleRate: 24000 });
  await Promise.resolve();

  await sources[0].onended();
  assert.equal(sources.length, 2, "second chunk starts after first chunk ends");
  await sources[1].onended();

  assert.equal(controller.state, "ended");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname).filter((path) => path.endsWith("/played")),
    ["/api/queue/stream-1/played"]
  );
});

test("kokoro high-speed stream buffers at chunk boundaries until the next chunk is ready", async () => {
  const { sources } = installAudioWindow();
  const chunkA = deferred();
  const chunkB = deferred();
  let generatedFullMessage = 0;
  let generatedChunk = 0;
  installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/stream-fast/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "stream-fast",
            sourceApp: "Codex",
            speakableText: "First sentence. Second sentence."
          }
        }
      };
    }
    if (path === "/api/queue/stream-fast/audio") {
      assert.notEqual(options.method, "POST", "high-speed generated variants stay memory-only");
      return { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/stream-fast/played") {
      return { status: 200, body: { item: { id: "stream-fast", status: "played" } } };
    }
    if (path === "/api/queue/stream-fast/skipped") {
      assert.fail(options.body.reason);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    kokoroGetChunks: () => ["First sentence.", "Second sentence."],
    kokoroGenerateChunk: async () => {
      generatedChunk += 1;
      return generatedChunk === 1 ? chunkA.promise : chunkB.promise;
    },
    kokoroGenerateAudio: async () => {
      generatedFullMessage += 1;
      return {
        samples: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        sampleRate: 24000,
        segments: [],
        wordAccurate: false
      };
    }
  });

  const playPromise = controller.playItem(
    {
      id: "stream-fast",
      sourceApp: "Codex",
      speakableText: "First sentence. Second sentence."
    },
    { mute: false, engine: "kokoro", rate: 4, volume: 1 }
  );

  await Promise.resolve();
  chunkA.resolve({ samples: new Float32Array([0.1]), sampleRate: 24000 });
  await withTimeout(playPromise, 1000, "first high-speed chunk did not start");

  assert.equal(controller.state, "speaking");
  assert.equal(sources.length, 1);
  assert.equal(generatedFullMessage, 0);
  assert.equal(generatedChunk, 2, "chunk two generation starts in the background");

  const boundaryPromise = sources[0].onended();
  await Promise.resolve();
  assert.equal(controller.state, "loading");
  assert.equal(sources.length, 1, "no second source starts before chunk two is ready");

  chunkB.resolve({ samples: new Float32Array([0.2]), sampleRate: 24000 });
  await withTimeout(boundaryPromise, 1000, "second high-speed chunk did not resume");
  assert.equal(controller.state, "speaking");
  assert.equal(sources.length, 2, "playback resumes when chunk two finishes generating");

  await sources[1].onended();
  assert.equal(controller.state, "ended");
  assert.equal(generatedChunk, 2);
});

test("kokoro streaming stop cancels later chunks without storing stale cache", async () => {
  const { sources } = installAudioWindow();
  const chunkA = deferred();
  const chunkB = deferred();
  const calls = installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/stream-stop/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "stream-stop",
            sourceApp: "Codex",
            speakableText: "First sentence. Second sentence."
          }
        }
      };
    }
    if (path === "/api/queue/stream-stop/audio" && options.method === "POST") {
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/stream-stop/audio") {
      return { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/stream-stop/skipped") {
      return {
        status: 200,
        body: { item: { id: "stream-stop", status: "skipped", skipReason: options.body.reason } }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    kokoroGetChunks: () => ["First sentence.", "Second sentence."],
    kokoroGenerateChunk: async (chunk) =>
      chunk === "First sentence." ? chunkA.promise : chunkB.promise
  });

  const playPromise = controller.playItem(
    {
      id: "stream-stop",
      sourceApp: "Codex",
      speakableText: "First sentence. Second sentence."
    },
    { mute: false, engine: "kokoro", rate: 1, volume: 1 }
  );

  await Promise.resolve();
  chunkA.resolve({ samples: new Float32Array([0.1, 0.2]), sampleRate: 24000 });
  await playPromise;
  assert.equal(sources.length, 1);

  await controller.stop("User stopped playback.");
  chunkB.resolve({ samples: new Float32Array([0.3, 0.4]), sampleRate: 24000 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.state, "idle");
  assert.equal(sources.length, 1, "cancelled chunk never starts a second source");
  assert.equal(
    calls.some(
      (call) => new URL(call.url).pathname.endsWith("/audio") && call.options.method === "POST"
    ),
    false,
    "cancelled streaming generation does not write a completed cache entry"
  );
});

test("kokoro streaming seek and replay use generated chunks before final buffer is ready", async () => {
  const { sources } = installAudioWindow();
  const chunkA = deferred();
  const chunkB = deferred();
  const updates = [];
  installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/stream-seek/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "stream-seek",
            sourceApp: "Codex",
            speakableText: "First sentence. Second sentence."
          }
        }
      };
    }
    if (path === "/api/queue/stream-seek/audio" && options.method === "POST") {
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/stream-seek/audio") {
      return { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/stream-seek/played") {
      return { status: 200, body: { item: { id: "stream-seek", status: "played" } } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message),
    kokoroGetChunks: () => ["First sentence.", "Second sentence."],
    kokoroGenerateChunk: async (chunk) =>
      chunk === "First sentence." ? chunkA.promise : chunkB.promise
  });

  const playPromise = controller.playItem(
    {
      id: "stream-seek",
      sourceApp: "Codex",
      speakableText: "First sentence. Second sentence."
    },
    { mute: false, engine: "kokoro", rate: 1, volume: 1 }
  );

  await Promise.resolve();
  chunkA.resolve({ samples: new Float32Array(24_000), sampleRate: 24_000 });
  await playPromise;
  assert.equal(sources.length, 1);

  controller.seek(0.5);
  assert.equal(sources.length, 2, "seek starts a replacement source for the generated chunk");
  assert.ok(sources[1].startOffset > 0, "seek starts within the generated chunk");

  assert.equal(controller.replayCurrent(), true);
  assert.equal(sources.length, 3, "replay starts a replacement source for chunk zero");
  assert.equal(sources[2].startOffset, 0);

  controller.seek(2);
  assert.match(updates.at(-1), /still generating/);

  chunkB.resolve({ samples: new Float32Array(24_000), sampleRate: 24_000 });
});
