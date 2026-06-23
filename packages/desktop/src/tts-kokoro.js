// Local neural TTS via kokoro-js. Runs the Kokoro-82M ONNX model in the WebView,
// preferring WebGPU (GPU) and falling back to wasm (CPU). Model weights download
// once and are cached by the WebView, so later loads are fast.

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

// Kokoro tokenizes to ~510 phoneme tokens max and silently truncates longer
// input (its generate() uses truncation:true), which cut off the end of long
// replies mid-sentence. Stay well under that with a conservative character
// budget per chunk; phonemes run a bit longer than characters.
const MAX_CHARS_PER_CHUNK = 300;
// Brief pause stitched between chunks so concatenated sentences don't run on.
const CHUNK_GAP_SEC = 0.08;

// Split text into sentence-based chunks under maxChars. Sentences longer than
// the budget are hard-split on word boundaries as a last resort.
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
    buffers.reduce((sum, b) => sum + b.length, 0) +
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

// Idempotent. First call starts the load; later calls share the same promise.
export function warmKokoro(preferredDevice) {
  if (!loadPromise) {
    loadPromise = loadModel(preferredDevice).catch((error) => {
      loadPromise = null; // allow retry on next attempt
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

// Generate speech, returning raw PCM samples so the caller can play them through
// the Web Audio API. Web Audio is used instead of an <audio> element so browser
// extensions that hijack media playbackRate (e.g. Video Speed Controller) cannot
// affect our speed; we own the rate via the AudioBufferSourceNode.
export async function generateKokoroAudio(text, voice, speed, preferredDevice) {
  const tts = await warmKokoro(preferredDevice);
  const useVoice = cachedVoices?.includes(voice) ? voice : DEFAULT_KOKORO_VOICE;
  // Kokoro's native speed time-stretches without shifting pitch, unlike Web Audio
  // playbackRate. So speed is baked in at generation; playback runs at rate 1.
  const useSpeed = Number.isFinite(speed) ? speed : 1;

  // Chunk so we never exceed Kokoro's token cap (which would truncate the end
  // of long replies). Short replies stay a single generate() call.
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

  // Build a timeline mapping each chunk to its exact span in the concatenated
  // buffer (sentence-accurate, since each chunk's audio length is known).
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
