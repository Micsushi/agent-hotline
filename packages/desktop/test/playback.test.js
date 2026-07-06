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
      json: async () => result.body,
      arrayBuffer: async () => {
        if (result.arrayBuffer) return result.arrayBuffer;
        if (result.bodyBuffer) {
          return result.bodyBuffer.buffer.slice(
            result.bodyBuffer.byteOffset,
            result.bodyBuffer.byteOffset + result.bodyBuffer.byteLength
          );
        }
        return new ArrayBuffer(0);
      }
    };
  };
  return calls;
}

function testWav(samples = [0, 1000, -1000, 0], sampleRate = 24000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return buffer;
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
  const { synth, spoken } = installWindow();
  const sources = [];
  const contexts = [];
  const stretches = [];

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
      contexts.push(this);
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
  class FakeStretchNode {
    constructor() {
      this.playbackRate = { value: 1 };
      stretches.push(this);
    }

    setStretchParameters(params) {
      this.params = params;
    }

    connect() {}

    disconnect() {}
  }

  return { contexts, FakeStretchNode, stretches, synth, sources, spoken };
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

test("playback skips online voices when no manual voice is selected", async () => {
  const onlineVoice = {
    name: "Microsoft Aria Natural",
    voiceURI: "Microsoft Aria Natural Online",
    lang: "en-US"
  };
  const localVoice = {
    name: "Samantha Enhanced",
    voiceURI: "Samantha Enhanced",
    lang: "en-US"
  };
  const { spoken } = installWindow({ voices: [onlineVoice, localVoice] });
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

  assert.equal(spoken[0].voice, localVoice);
  assert.equal(spoken[0].rate, 0.9);
});

test("browser speech exposes estimated playback position for text highlighting", async () => {
  installWindow();
  installFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/highlight-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "highlight-1",
            sourceApp: "Codex",
            speakableText: "First sentence for highlighting. Second sentence keeps moving."
          }
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({ backendUrl: "http://127.0.0.1:4777" });

  await controller.readNextPending({
    settings: { mute: false, engine: "webview", voice: "", rate: 1, volume: 1 },
    queue: {
      pending: [
        {
          id: "highlight-1",
          sourceApp: "Codex",
          speakableText: "First sentence for highlighting. Second sentence keeps moving."
        }
      ]
    }
  });

  const pos = controller.getPlaybackPosition();
  assert.ok(pos);
  assert.equal(pos.segments.length, 2);
  assert.equal(pos.wordAccurate, false);
  assert.equal(pos.totalSec > 0, true);
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

test("macOS engine generates saved backend audio and plays it", async () => {
  const { sources, spoken } = installAudioWindow();
  const updates = [];
  const wav = testWav();
  const calls = installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/macos-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "macos-1",
            sourceApp: "Codex",
            speakableText: "Native speech should be saved first."
          }
        }
      };
    }
    if (path === "/api/queue/macos-1/audio" && !options.method) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("engine"), "macos");
      assert.equal(query.get("voice"), "default@base-0.90");
      return options.__hit
        ? {
            status: 200,
            body: {
              cached: true,
              sampleRate: 24000,
              segments: [{ text: "Native speech should be saved first.", startSec: 0, endSec: 1 }]
            }
          }
        : { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/macos-1/native-audio") {
      assert.equal(options.body.engine, "macos");
      assert.equal(options.body.text, "Native speech should be saved first.");
      assert.equal(options.body.cacheVoice, "default@base-0.90");
      assert.equal(options.body.rate, 0.9);
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/macos-1/audio.wav") {
      return { status: 200, body: {}, arrayBuffer: wav };
    }
    if (path === "/api/queue/macos-1/played") {
      return { status: 200, body: { item: { id: "macos-1", status: "played" } } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  let manifestRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/queue/macos-1/audio?")) {
      manifestRequests += 1;
      return originalFetch(url, { ...options, __hit: manifestRequests > 1 });
    }
    return originalFetch(url, options);
  };

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message)
  });

  await controller.playItem(
    {
      id: "macos-1",
      sourceApp: "Codex",
      speakableText: "Native speech should be saved first."
    },
    { mute: false, engine: "macos", voice: "", rate: 0.9, volume: 1 }
  );

  assert.equal(spoken.length, 0);
  assert.equal(sources.length, 1);
  assert.equal(controller.state, "speaking");
  assert.match(updates.at(-1), /macOS native voice/);
  await controller.changeSpeed(1.5, { engine: "macos", rate: 1.5, volume: 1 });
  assert.equal(sources[0].playbackRate.value, 1);
  assert.match(updates.at(-1), /pitch-preserving audio support/);

  await sources[0].onended();
  assert.equal(controller.state, "ended");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/queue/macos-1/playing",
      "/api/queue/macos-1/audio",
      "/api/queue/macos-1/native-audio",
      "/api/queue/macos-1/audio",
      "/api/queue/macos-1/audio.wav",
      "/api/queue/macos-1/played"
    ]
  );
});

test("native Kokoro engine generates backend audio, syncs segments, and changes speed live", async () => {
  const { contexts, sources, spoken } = installAudioWindow();
  const updates = [];
  const wav = testWav(new Int16Array(Math.round(24000 * 1.2)));
  const calls = installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/native-kokoro-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "native-kokoro-1",
            sourceApp: "Codex",
            speakableText:
              "Native Kokoro should be generated by the backend. It should keep highlighting after a speed change."
          }
        }
      };
    }
    if (path === "/api/queue/native-kokoro-1/audio" && !options.method) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("engine"), "kokoro-native");
      const voice = query.get("voice");
      assert.match(voice, /^af_heart@speed-(1\.00|1\.40)$/);
      return options.__hit
        ? {
            status: 200,
            body: {
              cached: true,
              sampleRate: 24000,
              segments: [
                {
                  text: "Native Kokoro should be generated by the backend.",
                  startSec: 0,
                  endSec: 0.6
                },
                {
                  text: "It should keep highlighting after a speed change.",
                  startSec: 0.68,
                  endSec: 1.2
                }
              ]
            }
          }
        : { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/native-kokoro-1/kokoro-native-audio") {
      assert.equal(
        options.body.text,
        "Native Kokoro should be generated by the backend. It should keep highlighting after a speed change."
      );
      assert.equal(options.body.voice, "af_heart");
      assert.match(options.body.cacheVoice, /^af_heart@speed-(1\.00|1\.40)$/);
      assert.ok(options.body.speed === 1 || options.body.speed === 1.4);
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/native-kokoro-1/audio.wav") {
      return { status: 200, body: {}, arrayBuffer: wav };
    }
    if (path === "/api/queue/native-kokoro-1/played") {
      return { status: 200, body: { item: { id: "native-kokoro-1", status: "played" } } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const manifestHits = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/queue/native-kokoro-1/audio?")) {
      const voice = new URL(url).searchParams.get("voice");
      const count = manifestHits.get(voice) || 0;
      manifestHits.set(voice, count + 1);
      return originalFetch(url, { ...options, __hit: count > 0 });
    }
    return originalFetch(url, options);
  };

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message)
  });

  await controller.playItem(
    {
      id: "native-kokoro-1",
      sourceApp: "Codex",
      speakableText:
        "Native Kokoro should be generated by the backend. It should keep highlighting after a speed change."
    },
    { mute: false, engine: "kokoro-native", kokoroVoice: "af_heart", rate: 1, volume: 1 }
  );

  assert.equal(spoken.length, 0);
  assert.equal(sources.length, 1);
  assert.equal(controller.state, "speaking");
  assert.match(updates.at(-1), /Kokoro Mac native/);
  let position = controller.getPlaybackPosition();
  assert.equal(position.segments.length, 2);
  assert.equal(position.segmentIndex, 0);
  assert.equal(position.wordAccurate, false);
  await controller.changeSpeed(1.4, { engine: "kokoro-native", rate: 1.4, volume: 1 });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].stopped, true);
  assert.equal(sources[1].playbackRate.value, 1);
  contexts[0].currentTime = 0.5;
  position = controller.getPlaybackPosition();
  assert.equal(Number(position.currentSec.toFixed(1)), 0.5);
  assert.equal(position.segmentIndex, 0);

  await sources[1].onended();
  assert.equal(controller.state, "ended");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/queue/native-kokoro-1/playing",
      "/api/queue/native-kokoro-1/audio",
      "/api/queue/native-kokoro-1/kokoro-native-audio",
      "/api/queue/native-kokoro-1/audio",
      "/api/queue/native-kokoro-1/audio.wav",
      "/api/queue/native-kokoro-1/audio",
      "/api/queue/native-kokoro-1/kokoro-native-audio",
      "/api/queue/native-kokoro-1/audio",
      "/api/queue/native-kokoro-1/audio.wav",
      "/api/queue/native-kokoro-1/played"
    ]
  );
});

test("native Kokoro applies the configured speed on initial start with pitch preservation", async () => {
  const { FakeStretchNode, sources, stretches } = installAudioWindow();
  const updates = [];
  const wav = testWav(new Int16Array(Math.round(24000 * 1.2)));
  const calls = installFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/native-kokoro-fast/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "native-kokoro-fast",
            sourceApp: "Codex",
            speakableText: "Fast startup should not wait for a slider change."
          }
        }
      };
    }
    if (path === "/api/queue/native-kokoro-fast/audio" && !options.method) {
      const query = new URL(url).searchParams;
      assert.equal(query.get("engine"), "kokoro-native");
      assert.equal(query.get("voice"), "af_heart@speed-1.00");
      return options.__hit
        ? {
            status: 200,
            body: {
              cached: true,
              sampleRate: 24000,
              segments: [
                {
                  text: "Fast startup should not wait for a slider change.",
                  startSec: 0,
                  endSec: 1.2
                }
              ]
            }
          }
        : { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/native-kokoro-fast/kokoro-native-audio") {
      assert.equal(options.body.cacheVoice, "af_heart@speed-1.00");
      assert.equal(options.body.speed, 1);
      return { status: 201, body: { stored: true } };
    }
    if (path === "/api/queue/native-kokoro-fast/audio.wav") {
      return { status: 200, body: {}, arrayBuffer: wav };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  let manifestRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/api/queue/native-kokoro-fast/audio?")) {
      manifestRequests += 1;
      return originalFetch(url, { ...options, __hit: manifestRequests > 1 });
    }
    return originalFetch(url, options);
  };

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message),
    stretchNodeClass: FakeStretchNode
  });

  await controller.playItem(
    {
      id: "native-kokoro-fast",
      sourceApp: "Codex",
      speakableText: "Fast startup should not wait for a slider change."
    },
    { mute: false, engine: "kokoro-native", kokoroVoice: "af_heart", rate: 1.9, volume: 1 }
  );

  assert.equal(sources.length, 1, updates.join("\n"));
  assert.equal(stretches.length, 1, updates.join("\n"));
  assert.equal(Number(sources[0].playbackRate.value.toFixed(3)), 1.9);
  assert.equal(Number(stretches[0].playbackRate.value.toFixed(3)), 1.9);
  assert.equal(sources[0].startOffset, 0);
  assert.ok(sources[0].buffer.duration > 1.2, "lead-in silence primes SoundTouch before speech");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/queue/native-kokoro-fast/playing",
      "/api/queue/native-kokoro-fast/audio",
      "/api/queue/native-kokoro-fast/kokoro-native-audio",
      "/api/queue/native-kokoro-fast/audio",
      "/api/queue/native-kokoro-fast/audio.wav"
    ]
  );
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

test("kokoro warmModel starts model load only for the Kokoro engine", async () => {
  installAudioWindow();
  let warmed = 0;
  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    kokoroWarm: async () => {
      warmed += 1;
    }
  });

  controller.warmModel({ engine: "webview" });
  controller.warmModel({ engine: "kokoro-ts" });
  controller.warmModel({ engine: "kokoro" });
  await Promise.resolve();

  assert.equal(warmed, 1);
});

test("kokoro warmModel swallows warmup failures so playback can retry later", async () => {
  installAudioWindow();
  const originalDebug = console.debug;
  let debugged = false;
  console.debug = () => {
    debugged = true;
  };
  try {
    const controller = createPlaybackController({
      backendUrl: "http://127.0.0.1:4777",
      kokoroWarm: async () => {
        throw new Error("warmup failed");
      }
    });

    controller.warmModel({ engine: "kokoro" });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(debugged, true);
  } finally {
    console.debug = originalDebug;
  }
});

test("kokoro generation failure falls back to browser speech", async () => {
  const { spoken } = installAudioWindow();
  const updates = [];
  const calls = installFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/fallback-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "fallback-1",
            sourceApp: "Codex",
            speakableText: "This should still be spoken."
          }
        }
      };
    }
    if (path === "/api/queue/fallback-1/audio") {
      return { status: 200, body: { cached: false } };
    }
    if (path === "/api/queue/fallback-1/skipped") {
      assert.fail("Kokoro failure should fall back instead of skipping");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message),
    kokoroGetChunks: () => ["This should still be spoken."],
    kokoroGenerateChunk: async () => {
      throw new Error("model load failed");
    }
  });

  await controller.playItem(
    {
      id: "fallback-1",
      sourceApp: "Codex",
      speakableText: "This should still be spoken."
    },
    { mute: false, engine: "kokoro", rate: 1, volume: 1 }
  );

  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "This should still be spoken.");
  assert.match(updates.join("\n"), /Falling back to system voice/);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/queue/fallback-1/playing",
      "/api/queue/fallback-1/audio",
      "/api/queue/fallback-1/playing"
    ]
  );
});

test("kokoro first chunk timeout falls back to browser speech", async () => {
  const { spoken } = installAudioWindow();
  const updates = [];
  const stuckChunk = deferred();
  installFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/queue/timeout-1/playing") {
      return {
        status: 200,
        body: {
          item: {
            id: "timeout-1",
            sourceApp: "Codex",
            speakableText: "This should fall back after a timeout."
          }
        }
      };
    }
    if (path === "/api/queue/timeout-1/audio") {
      return { status: 200, body: { cached: false } };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const controller = createPlaybackController({
    backendUrl: "http://127.0.0.1:4777",
    onUpdate: (message) => updates.push(message),
    kokoroFirstChunkTimeoutMs: 1,
    kokoroGetChunks: () => ["This should fall back after a timeout."],
    kokoroGenerateChunk: () => stuckChunk.promise
  });

  await controller.playItem(
    {
      id: "timeout-1",
      sourceApp: "Codex",
      speakableText: "This should fall back after a timeout."
    },
    { mute: false, engine: "kokoro", rate: 1, volume: 1 }
  );

  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "This should fall back after a timeout.");
  assert.match(updates.join("\n"), /did not produce the first audio chunk/);
  stuckChunk.resolve({ samples: new Float32Array([0.1]), sampleRate: 24000 });
  await Promise.resolve();
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
