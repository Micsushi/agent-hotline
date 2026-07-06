const path = require("path");

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_KOKORO_VOICE = "af_heart";
const DEFAULT_SAMPLE_RATE = 24000;
const MAX_CHARS_PER_CHUNK = 300;
const KOKORO_CHUNK_GAP_SEC = 0.08;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function encodeWav(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * bytesPerSample);
  }

  return buffer;
}

function defaultModelRoot() {
  return path.resolve(__dirname, "../../desktop/public/models");
}

function getKokoroChunks(text, maxChars = MAX_CHARS_PER_CHUNK) {
  const sentences = String(text || "").match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [String(text || "")];
  const chunks = [];

  for (const raw of sentences) {
    let sentence = raw.trim();
    if (!sentence) continue;

    while (sentence.length > maxChars) {
      let cut = sentence.lastIndexOf(" ", maxChars);
      if (cut <= 0) cut = maxChars;
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }

    if (sentence) chunks.push(sentence);
  }
  return chunks;
}

function concatFloat32(buffers, gapSamples) {
  const total =
    buffers.reduce((sum, buffer) => sum + buffer.length, 0) +
    gapSamples * Math.max(0, buffers.length - 1);
  const merged = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    merged.set(buffers[i], offset);
    offset += buffers[i].length;
    if (i < buffers.length - 1) offset += gapSamples;
  }
  return merged;
}

function createNativeKokoroTts(options = {}) {
  const modelId = options.modelId || MODEL_ID;
  const modelRoot = options.modelRoot || defaultModelRoot();
  const dtype = options.dtype || "q8";
  const device = options.device || "cpu";
  const maxCharsPerChunk = clampNumber(options.maxCharsPerChunk, MAX_CHARS_PER_CHUNK, 20, 1000);
  let loadPromise = null;

  async function loadModel() {
    if (!loadPromise) {
      loadPromise = (async () => {
        if (options.loadModel) return options.loadModel();
        const { env: transformersEnv } = require("@huggingface/transformers");
        transformersEnv.allowLocalModels = true;
        transformersEnv.localModelPath = modelRoot;
        const { KokoroTTS } = require("kokoro-js");
        return KokoroTTS.from_pretrained(modelId, { dtype, device });
      })().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  async function generate({ text, voice, speed }) {
    const speakableText = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!speakableText) {
      const error = new Error("text must be a non-empty string");
      error.code = "invalid_request";
      throw error;
    }

    const tts = await loadModel();
    const voices = Object.keys(tts.voices || {});
    const selectedVoice = voices.includes(voice) ? voice : DEFAULT_KOKORO_VOICE;
    const rate = clampNumber(speed, 1, 0.25, 4);
    const chunks = getKokoroChunks(speakableText, maxCharsPerChunk);
    const buffers = [];
    let sampleRate = DEFAULT_SAMPLE_RATE;

    for (const chunk of chunks) {
      const audio = await tts.generate(chunk, { voice: selectedVoice, speed: rate });
      const samples = audio.audio || audio.data;
      if (!samples || typeof samples.length !== "number") {
        throw new Error("Kokoro generated audio without PCM samples");
      }
      sampleRate = Number(audio.sampling_rate || audio.sampleRate) || DEFAULT_SAMPLE_RATE;
      buffers.push(samples);
    }

    const gapSamples = Math.round(sampleRate * KOKORO_CHUNK_GAP_SEC);
    const samples = concatFloat32(buffers, gapSamples);
    const wavBuffer = encodeWav(samples, sampleRate);
    const durationSec = samples.length / sampleRate;
    const segments = [];
    let cursor = 0;
    for (let i = 0; i < buffers.length; i += 1) {
      const startSec = cursor / sampleRate;
      cursor += buffers[i].length;
      segments.push({ text: chunks[i], startSec, endSec: cursor / sampleRate });
      if (i < buffers.length - 1) cursor += gapSamples;
    }

    return {
      wavBuffer,
      sampleRate,
      durationSec,
      segments,
      wordAccurate: false,
      voice: selectedVoice
    };
  }

  return {
    generate,
    warm: loadModel
  };
}

module.exports = {
  DEFAULT_KOKORO_VOICE,
  KOKORO_CHUNK_GAP_SEC,
  createNativeKokoroTts,
  encodeWav,
  getKokoroChunks
};
