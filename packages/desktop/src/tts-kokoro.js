const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

const MAX_CHARS_PER_CHUNK = 300;
const CHUNK_GAP_SEC = 0.08;

function chunkText(text, maxChars) {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [text];
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (current && current.length + 1 + sentence.length > maxChars) flush();
    current = current ? `${current} ${sentence}` : sentence;

    while (current.length > maxChars) {
      let cut = current.lastIndexOf(" ", maxChars);
      if (cut <= 0) cut = maxChars;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(cut).trim();
    }
  }
  flush();
  return chunks;
}

function concatSamples(buffers, gapSamples) {
  const total =
    buffers.reduce((sum, b) => sum + b.length, 0) + gapSamples * Math.max(0, buffers.length - 1);
  const merged = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    merged.set(buffers[i], offset);
    offset += buffers[i].length;
    if (i < buffers.length - 1) offset += gapSamples;
  }
  return merged;
}

let loadPromise = null;
let loadedDevice = null;
let cachedVoices = null;

async function loadModel(preferredDevice) {
  const { KokoroTTS } = await import("kokoro-js");
  const order = preferredDevice === "wasm" ? ["wasm"] : ["webgpu", "wasm"];

  let lastError = null;
  for (const device of order) {
    try {
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: device === "webgpu" ? "fp32" : "q8",
        device
      });
      loadedDevice = device;
      cachedVoices = Object.keys(tts.voices || {});
      return tts;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Kokoro model failed to load on every device.");
}

export function warmKokoro(preferredDevice) {
  if (!loadPromise) {
    loadPromise = loadModel(preferredDevice).catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export function getKokoroDevice() {
  return loadedDevice;
}

export function getKokoroVoices() {
  return cachedVoices ? [...cachedVoices] : [];
}

export function isKokoroReady() {
  return Boolean(loadedDevice);
}

export async function generateKokoroAudio(text, voice, speed, preferredDevice) {
  const tts = await warmKokoro(preferredDevice);
  const useVoice = cachedVoices?.includes(voice) ? voice : DEFAULT_KOKORO_VOICE;
  const useSpeed = Number.isFinite(speed) ? speed : 1;

  const chunks = chunkText(text, MAX_CHARS_PER_CHUNK);
  if (chunks.length <= 1) {
    const result = await tts.generate(text, { voice: useVoice, speed: useSpeed });
    const endSec = result.audio.length / result.sampling_rate;
    return {
      samples: result.audio,
      sampleRate: result.sampling_rate,
      segments: [{ text: text.trim(), startSec: 0, endSec }]
    };
  }

  const buffers = [];
  let sampleRate = 24000;
  for (const chunk of chunks) {
    const result = await tts.generate(chunk, { voice: useVoice, speed: useSpeed });
    buffers.push(result.audio);
    sampleRate = result.sampling_rate;
  }

  const gapSamples = Math.round(sampleRate * CHUNK_GAP_SEC);
  const segments = [];
  let cursor = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    const startSec = cursor / sampleRate;
    cursor += buffers[i].length;
    segments.push({ text: chunks[i], startSec, endSec: cursor / sampleRate });
    if (i < buffers.length - 1) cursor += gapSamples;
  }

  return { samples: concatSamples(buffers, gapSamples), sampleRate, segments };
}
