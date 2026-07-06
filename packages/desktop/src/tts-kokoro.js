import { env as transformersEnv } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";
export const KOKORO_CHUNK_GAP_SEC = 0.08;

const MAX_CHARS_PER_CHUNK = 300;
const KOKORO_LOCAL_MODEL_PATH = "/models/";
const KOKORO_VOICE_CACHE = "kokoro-voices";
const KOKORO_VOICE_BASE_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";
const KOKORO_LOCAL_VOICE_BASE = "/kokoro-voices";

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

export function getKokoroChunks(text) {
  return chunkText(String(text || ""), MAX_CHARS_PER_CHUNK);
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
const voiceCachePromises = new Map();

function configureLocalModelLoading() {
  // Full desktop builds ship Kokoro under /models. If those files are absent
  // (for the lightweight npm/browser bundle), Transformers falls back to its
  // normal remote download + browser cache path.
  transformersEnv.allowLocalModels = true;
  transformersEnv.localModelPath = KOKORO_LOCAL_MODEL_PATH;
}

async function seedLocalVoiceCache(voice) {
  const name = String(voice || DEFAULT_KOKORO_VOICE).trim() || DEFAULT_KOKORO_VOICE;
  if (voiceCachePromises.has(name)) return voiceCachePromises.get(name);

  const promise = (async () => {
    if (typeof caches === "undefined" || typeof fetch !== "function") return;
    try {
      const local = await fetch(`${KOKORO_LOCAL_VOICE_BASE}/${name}.bin`, { cache: "force-cache" });
      if (!local.ok) return;
      const cache = await caches.open(KOKORO_VOICE_CACHE);
      await cache.put(`${KOKORO_VOICE_BASE_URL}/${name}.bin`, local.clone());
    } catch {
      // The light npm/browser bundle does not include local voice files. Let
      // kokoro-js fetch and cache the voice from Hugging Face in that build.
    }
  })();

  voiceCachePromises.set(name, promise);
  return promise;
}

async function loadModel(preferredDevice) {
  configureLocalModelLoading();
  const { KokoroTTS } = await import("kokoro-js");
  const order = preferredDevice === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];

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

export async function generateKokoroChunk(text, voice, speed, preferredDevice) {
  const tts = await warmKokoro(preferredDevice);
  const useVoice = cachedVoices?.includes(voice) ? voice : DEFAULT_KOKORO_VOICE;
  await seedLocalVoiceCache(useVoice);
  const useSpeed = Number.isFinite(speed) ? speed : 1;
  const result = await tts.generate(text, { voice: useVoice, speed: useSpeed });
  return { samples: result.audio, sampleRate: result.sampling_rate };
}

export async function generateKokoroAudio(text, voice, speed, preferredDevice) {
  const chunks = getKokoroChunks(text);
  if (chunks.length <= 1) {
    const result = await generateKokoroChunk(text, voice, speed, preferredDevice);
    const endSec = result.samples.length / result.sampleRate;
    return {
      samples: result.samples,
      sampleRate: result.sampleRate,
      segments: [{ text: text.trim(), startSec: 0, endSec }]
    };
  }

  const buffers = [];
  let sampleRate = 24000;
  for (const chunk of chunks) {
    const result = await generateKokoroChunk(chunk, voice, speed, preferredDevice);
    buffers.push(result.samples);
    sampleRate = result.sampleRate;
  }

  const gapSamples = Math.round(sampleRate * KOKORO_CHUNK_GAP_SEC);
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
