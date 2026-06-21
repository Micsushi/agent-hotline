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
