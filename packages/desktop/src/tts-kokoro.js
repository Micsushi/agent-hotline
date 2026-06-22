// Local neural TTS via kokoro-js. Runs the Kokoro-82M ONNX model in the WebView,
// preferring WebGPU (GPU) and falling back to wasm (CPU). Model weights download
// once and are cached by the WebView, so later loads are fast.

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

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
  const result = await tts.generate(text, { voice: useVoice, speed: useSpeed });
  return {
    samples: result.audio,
    sampleRate: result.sampling_rate
  };
}
