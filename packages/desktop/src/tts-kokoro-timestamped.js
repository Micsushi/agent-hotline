const ASSET_BASE = "/headtts";
const HEADTTS_GLOBAL_LOADER = `${ASSET_BASE}/headtts-global.mjs`;
const HEADTTS_GLOBAL_KEY = "__AgentHotlineHeadTTS";
const HEADTTS_LOADED_EVENT = "agent-hotline-headtts-loaded";
const TRANSFORMERS_MODULE =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0/dist/transformers.min.js";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";

const AVAILABLE_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis"
];
export const DEFAULT_TS_VOICE = "af_heart";

let loadPromise = null;
let loadedReady = false;
let classPromise = null;

function loadHeadTTSClass() {
  if (window[HEADTTS_GLOBAL_KEY]) return Promise.resolve(window[HEADTTS_GLOBAL_KEY]);
  if (!classPromise) {
    classPromise = new Promise((resolve, reject) => {
      const onLoaded = () => resolve(window[HEADTTS_GLOBAL_KEY]);
      window.addEventListener(HEADTTS_LOADED_EVENT, onLoaded, { once: true });

      const script = document.createElement("script");
      script.type = "module";
      script.src = HEADTTS_GLOBAL_LOADER;
      script.onerror = () => {
        window.removeEventListener(HEADTTS_LOADED_EVENT, onLoaded);
        classPromise = null;
        reject(new Error("Failed to load the HeadTTS module."));
      };
      document.head.append(script);
    });
  }
  return classPromise;
}

async function loadHeadTTS(preferredDevice) {
  const HeadTTS = await loadHeadTTSClass();
  const endpoints = preferredDevice === "wasm" ? ["wasm"] : ["webgpu", "wasm"];

  const headtts = new HeadTTS({
    endpoints,
    transformersModule: TRANSFORMERS_MODULE,
    model: MODEL_ID,
    languages: ["en-us"],
    voices: [DEFAULT_TS_VOICE],
    dictionaryURL: `${ASSET_BASE}/dictionaries/`,
    voiceURL: `${ASSET_BASE}/voices/`,
    dtypeWebgpu: "fp32",
    dtypeWasm: "q8",
    trace: 0
  });

  await headtts.connect();
  loadedReady = true;
  return headtts;
}

export function warmKokoroTimestamped(preferredDevice) {
  if (!loadPromise) {
    loadPromise = loadHeadTTS(preferredDevice).catch((error) => {
      loadPromise = null;
      loadedReady = false;
      throw error;
    });
  }
  return loadPromise;
}

export function isKokoroTimestampedReady() {
  return loadedReady;
}

export function getKokoroTimestampedVoices() {
  return [...AVAILABLE_VOICES];
}

function isPunctuationOnly(token) {
  return !/[\p{L}\p{N}]/u.test(token);
}

function appendSegments(segments, data, offsetSec) {
  const words = Array.isArray(data?.words) ? data.words : [];
  const wtimes = Array.isArray(data?.wtimes) ? data.wtimes : [];
  const wdurations = Array.isArray(data?.wdurations) ? data.wdurations : [];

  for (let i = 0; i < words.length; i += 1) {
    const raw = String(words[i] ?? "");
    const token = raw.trim();
    if (!token) continue;

    const startSec = offsetSec + (Number(wtimes[i]) || 0) / 1000;
    const endSec = offsetSec + ((Number(wtimes[i]) || 0) + (Number(wdurations[i]) || 0)) / 1000;

    const prev = segments[segments.length - 1];
    if (prev && isPunctuationOnly(token)) {
      prev.text += token;
      prev.endSec = Math.max(prev.endSec, endSec);
    } else {
      segments.push({ text: token, startSec, endSec });
    }
  }
}

function concatFloat32(buffers) {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(buffer, offset);
    offset += buffer.length;
  }
  return merged;
}

export async function generateKokoroTimestampedAudio(text, voice, speed, preferredDevice) {
  const headtts = await warmKokoroTimestamped(preferredDevice);
  const useVoice = AVAILABLE_VOICES.includes(voice) ? voice : DEFAULT_TS_VOICE;
  const useSpeed = Number.isFinite(speed) ? speed : 1;

  headtts.setup({
    voice: useVoice,
    language: "en-us",
    speed: useSpeed,
    audioEncoding: "wav"
  });

  const results = await headtts.synthesize({ input: String(text || "") });
  const parts = (Array.isArray(results) ? results : [results])
    .map((message) => message?.data)
    .filter((data) => data && data.audio);

  if (parts.length === 0) {
    throw new Error("HeadTTS returned no audio.");
  }

  const buffers = [];
  const segments = [];
  let sampleRate = 24000;
  let offsetSec = 0;

  for (const data of parts) {
    const audioBuffer = data.audio;
    sampleRate = audioBuffer.sampleRate;
    const channel = audioBuffer.getChannelData(0);
    buffers.push(new Float32Array(channel));
    appendSegments(segments, data, offsetSec);
    offsetSec += audioBuffer.duration;
  }

  return { samples: concatFloat32(buffers), sampleRate, segments, wordAccurate: true };
}
