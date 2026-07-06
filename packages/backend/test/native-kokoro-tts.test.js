const assert = require("assert");
const test = require("node:test");

const {
  KOKORO_CHUNK_GAP_SEC,
  createNativeKokoroTts,
  getKokoroChunks
} = require("../src/native-kokoro-tts");

test("native Kokoro splits long speech into sentence-sized chunks", () => {
  const chunks = getKokoroChunks("First sentence. Second sentence. Third sentence.", 24);

  assert.deepEqual(chunks, ["First sentence.", "Second sentence.", "Third sentence."]);
});

test("native Kokoro segment timings follow generated sample lengths", async () => {
  const sampleRate = 24000;
  const generated = [];
  const tts = createNativeKokoroTts({
    maxCharsPerChunk: 20,
    loadModel: async () => ({
      voices: { af_heart: true },
      generate: async (text, options) => {
        generated.push({ text, options });
        const seconds = text.startsWith("First") ? 0.5 : 0.25;
        return {
          audio: new Float32Array(Math.round(sampleRate * seconds)),
          sampling_rate: sampleRate
        };
      }
    })
  });

  const result = await tts.generate({
    text: "First sentence. Second sentence.",
    voice: "af_heart",
    speed: 1.2
  });

  assert.equal(generated.length, 2);
  assert.deepEqual(
    generated.map((entry) => entry.text),
    ["First sentence.", "Second sentence."]
  );
  assert.deepEqual(
    generated.map((entry) => entry.options),
    [
      { voice: "af_heart", speed: 1.2 },
      { voice: "af_heart", speed: 1.2 }
    ]
  );
  assert.equal(result.sampleRate, sampleRate);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments[0], {
    text: "First sentence.",
    startSec: 0,
    endSec: 0.5
  });
  assert.equal(result.segments[1].text, "Second sentence.");
  assert.equal(Number(result.segments[1].startSec.toFixed(2)), 0.5 + KOKORO_CHUNK_GAP_SEC);
  assert.equal(Number(result.segments[1].endSec.toFixed(2)), 0.75 + KOKORO_CHUNK_GAP_SEC);
  assert.equal(Number(result.durationSec.toFixed(2)), 0.75 + KOKORO_CHUNK_GAP_SEC);
  assert.ok(result.wavBuffer.length > 44);
});
