import {
  generateKokoroAudio,
  generateKokoroChunk,
  getKokoroChunks,
  KOKORO_CHUNK_GAP_SEC
} from "./tts-kokoro.js";
import { generateKokoroTimestampedAudio } from "./tts-kokoro-timestamped.js";
import { cacheGeneratedAudio, getAudio, getCachedAudio, withGenLock } from "./audio-cache.js";

const RATE_MIN = 0.25;
const RATE_MAX = 4;
const DEFAULT_RATE = 0.9;

const KOKORO_SAFE_SPEED = 1.5;

const STRETCH_LEADIN_SEC = 0.2;

// High-rate audio quality. Above LIVE_INSTANT_MAX the WSOLA pitch-compensation
// ratio (1 / playbackRate inside the SoundTouch worklet) gets large enough to
// smear formants and starve the real-time buffer (dropouts). So for higher
// rates we offload part of the speed-up to Kokoro's native phoneme-duration
// speed control and let WSOLA cover only the residual. The native part is
// quantized into a few bands so the cache holds few variants and the live
// slider only triggers a regeneration when it crosses a band boundary.
const LIVE_INSTANT_MAX = 2; // <= this: generate at 1x, WSOLA does all of it (instant slider)
const NATIVE_SPEED_CAP = 2; // never ask Kokoro to natively speak faster than this
const GEN_SPEED_STEP = 0.25; // quantize native gen speed to these increments

// Split a target playback rate into a native Kokoro generation speed and a
// residual real-time stretch rate. canStretch false => fall back to the old
// native-only path (capped, no WSOLA available).
function planSpeed(rate, canStretch) {
  const target = clampNumber(Number(rate), 1, RATE_MIN, RATE_MAX);
  if (!canStretch) {
    return { genSpeed: Math.min(target, KOKORO_SAFE_SPEED), stretchRate: 1 };
  }
  if (target <= LIVE_INSTANT_MAX) {
    return { genSpeed: 1, stretchRate: target };
  }
  // Geometric split: share the speed-up evenly across both stages so neither
  // hits an extreme ratio, then quantize the native part into bands.
  const ideal = Math.min(NATIVE_SPEED_CAP, Math.sqrt(target));
  const genSpeed = Math.max(1, Math.round(ideal / GEN_SPEED_STEP) * GEN_SPEED_STEP);
  return { genSpeed, stretchRate: target / genSpeed };
}

const SPEECH_STRETCH_PARAMS = {
  sequenceMs: 40,
  seekWindowMs: 15,
  overlapMs: 8,
  quickSeek: false
};

const CODE_HEAVY_PATTERNS = [
  /```/,
  /^\s*(diff --git|\+\+\+|---)\s/m,
  /^\s*(const|let|var|function|class|import|export)\s+\S+/m,
  /[{}`;$<>]{12,}/
];

function getSpeechSynthesis() {
  return window.speechSynthesis || null;
}

function getUtteranceConstructor() {
  return window.SpeechSynthesisUtterance || null;
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function clampNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function loadVoices(synth) {
  const initialVoices = synth.getVoices();
  if (initialVoices.length > 0) return initialVoices;

  await new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 500);
    const finish = () => {
      window.clearTimeout(timeout);
      resolve();
    };

    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", finish, { once: true });
    } else {
      synth.onvoiceschanged = finish;
    }
  });

  return synth.getVoices();
}

function scoreVoice(voice) {
  const haystack = `${voice.name || ""} ${voice.voiceURI || ""} ${voice.lang || ""}`.toLowerCase();
  let score = 0;

  if (haystack.includes("natural")) score += 80;
  if (haystack.includes("online")) score += 70;
  if (haystack.includes("neural")) score += 70;
  if (haystack.includes("aria")) score += 50;
  if (haystack.includes("jenny")) score += 45;
  if (haystack.includes("guy")) score += 35;
  if (haystack.includes("zira")) score += 25;
  if (haystack.includes("david")) score += 15;
  if (haystack.includes("english")) score += 10;
  if (haystack.includes("en-us")) score += 10;
  if (haystack.includes("desktop")) score -= 20;

  return score;
}

function selectVoice(voices, preferredName) {
  const name = String(preferredName || "").trim();
  if (name) {
    return voices.find((voice) => voice.name === name || voice.voiceURI === name) || null;
  }

  return [...voices].sort((left, right) => scoreVoice(right) - scoreVoice(left))[0] || null;
}

function normalizeSpeakableText(item) {
  return String(item?.speakableText || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSkipReason(item) {
  const text = normalizeSpeakableText(item);
  if (!text) return "No speakable text is available for playback.";
  if (CODE_HEAVY_PATTERNS.some((pattern) => pattern.test(item.speakableText))) {
    return "Speakable text still looks code-heavy, so playback was skipped.";
  }
  return "";
}

export function createPlaybackController({
  backendUrl,
  onUpdate,
  onStateChanged,
  onItemFinished,
  kokoroGenerateAudio = generateKokoroAudio,
  kokoroGenerateChunk = generateKokoroChunk,
  kokoroGetChunks = getKokoroChunks
}) {
  let activeUtterance = null;
  let audioContext = null;
  let activeSource = null;
  let activeStretch = null;
  let activeGain = null;
  let activeGenSpeed = 1;
  let activeItem = null;
  let playbackState = "idle";
  let playbackToken = 0;
  let stretchRegistration = null;
  let StretchNodeClass = null;

  let activeBuffer = null;
  let activeLeadInSec = 0;
  let activeSpeechDuration = 0;
  let activeSegments = [];
  let activeWordAccurate = false;
  let activeUseStretch = false;
  let activeStretchRate = 1;
  let activeStream = null;
  let activeStreamChunk = null;
  let activeSinkId = "";
  let basePosSec = 0;
  let baseCtxTime = 0;

  function getAudioContext() {
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioContext = Ctx ? new Ctx() : null;
    }
    return audioContext;
  }

  async function applyOutputDevice(settings) {
    const context = getAudioContext();
    const sinkId = String(settings?.audioOutputDeviceId || "");
    if (!context || activeSinkId === sinkId) return;
    if (typeof context.setSinkId !== "function") {
      activeSinkId = "";
      if (sinkId) notify("This WebView cannot choose an output device; using system default.");
      return;
    }
    try {
      await context.setSinkId(sinkId || "");
      activeSinkId = sinkId;
    } catch (error) {
      activeSinkId = "";
      notify(`Could not switch output device: ${error.message}`);
    }
  }

  async function ensureStretch(context) {
    if (typeof context.audioWorklet === "undefined") return false;
    if (!stretchRegistration) {
      stretchRegistration = (async () => {
        const [{ SoundTouchNode }, { default: processorUrl }] = await Promise.all([
          import("@soundtouchjs/audio-worklet"),
          import("@soundtouchjs/audio-worklet/processor?url")
        ]);
        await SoundTouchNode.register(context, processorUrl);
        StretchNodeClass = SoundTouchNode;
        return true;
      })().catch(() => {
        stretchRegistration = null;
        return false;
      });
    }
    return stretchRegistration;
  }

  function hasActiveAudio() {
    return Boolean(activeSource);
  }

  function concatSamples(buffers, sampleRate) {
    const gapSamples = Math.round(sampleRate * KOKORO_CHUNK_GAP_SEC);
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

  function createPlaybackBuffer(
    samples,
    sampleRate,
    { leadInSamples = 0, tailSilenceSamples = 0 } = {}
  ) {
    const buffer = audioContext.createBuffer(
      1,
      leadInSamples + samples.length + tailSilenceSamples,
      sampleRate
    );
    buffer.copyToChannel(samples, 0, leadInSamples);
    return buffer;
  }

  function teardownSource() {
    if (activeSource) {
      activeSource.onended = null;
      try {
        activeSource.stop();
      } catch {}
      try {
        activeSource.disconnect();
      } catch {}
    }
    if (activeStretch) {
      try {
        activeStretch.disconnect();
      } catch {}
    }
    activeSource = null;
    activeStretch = null;
  }

  function cancelActiveStream() {
    if (activeStream) activeStream.cancelled = true;
    activeStream = null;
  }

  function releaseActiveAudio() {
    cancelActiveStream();
    teardownSource();
    if (activeGain) {
      try {
        activeGain.disconnect();
      } catch {}
    }
    activeGain = null;
    activeGenSpeed = 1;
    activeBuffer = null;
    activeSegments = [];
    activeWordAccurate = false;
    activeSpeechDuration = 0;
    activeLeadInSec = 0;
    activeStreamChunk = null;
    basePosSec = 0;
    baseCtxTime = 0;
  }

  function getCurrentSpeechSec() {
    if ((!activeBuffer && !activeStream) || !audioContext) return 0;
    const rate = activeUseStretch ? activeStretchRate : 1;
    const elapsed = (audioContext.currentTime - baseCtxTime) * rate;
    return Math.min(activeSpeechDuration, Math.max(0, basePosSec + elapsed));
  }

  function connectSourceFrom(offsetSpeechSec, includeLeadIn) {
    const context = audioContext;
    const source = context.createBufferSource();
    source.buffer = activeBuffer;

    if (activeUseStretch && StretchNodeClass) {
      const stretch = new StretchNodeClass({ context, outputChannelCount: 1 });
      if (typeof stretch.setStretchParameters === "function") {
        stretch.setStretchParameters(SPEECH_STRETCH_PARAMS);
      }
      source.playbackRate.value = activeStretchRate;
      stretch.playbackRate.value = activeStretchRate;
      source.connect(stretch);
      stretch.connect(activeGain);
      activeStretch = stretch;
    } else {
      source.playbackRate.value = 1;
      source.connect(activeGain);
    }

    const token = playbackToken;
    const playingItem = activeItem;
    source.onended = async () => {
      if (playbackToken !== token) return;
      teardownSource();
      basePosSec = activeSpeechDuration;
      baseCtxTime = audioContext ? audioContext.currentTime : 0;
      setPlaybackState("ended");
      if (typeof onItemFinished === "function" && playingItem) onItemFinished(playingItem.id);
      try {
        await markPlayed(playingItem);
        notify("Read aloud finished.");
      } catch (error) {
        notify(`Playback finished, but queue state could not be saved: ${error.message}`);
      }
    };

    const bufferStart = includeLeadIn ? 0 : activeLeadInSec + offsetSpeechSec;
    source.start(0, bufferStart);
    activeSource = source;
    basePosSec = includeLeadIn ? -activeLeadInSec : offsetSpeechSec;
    baseCtxTime = context.currentTime;
  }

  // Wraps generated samples in an AudioBuffer + gain graph and starts playback.
  // Shared by initial play and the band-crossing speed regeneration. `plan`
  // carries { genSpeed, stretchRate, useStretch }; offsetFraction resumes from a
  // proportional position; resume controls whether the context is woken (kept
  // suspended when re-installing while paused).
  async function installGeneratedBuffer(
    generated,
    settings,
    plan,
    { offsetFraction = 0, resume = true } = {}
  ) {
    const context = audioContext;
    if (resume && context.state === "suspended") await context.resume();

    const useStretch = Boolean(plan.useStretch && StretchNodeClass);
    const leadInSamples = useStretch ? Math.round(generated.sampleRate * STRETCH_LEADIN_SEC) : 0;
    const buffer = context.createBuffer(
      1,
      leadInSamples + generated.samples.length,
      generated.sampleRate
    );
    buffer.copyToChannel(generated.samples, 0, leadInSamples);

    const gain = context.createGain();
    gain.gain.value = clampNumber(Number(settings.volume), 1, 0, 1);
    gain.connect(context.destination);

    activeBuffer = buffer;
    activeGain = gain;
    activeGenSpeed = plan.genSpeed;
    activeLeadInSec = leadInSamples / generated.sampleRate;
    activeSpeechDuration = generated.samples.length / generated.sampleRate;
    activeSegments = Array.isArray(generated.segments) ? generated.segments : [];
    activeWordAccurate = Boolean(generated.wordAccurate);
    activeUseStretch = useStretch;
    activeStretchRate = useStretch ? plan.stretchRate : 1;

    const offsetSec = Math.min(
      activeSpeechDuration,
      Math.max(0, Number(offsetFraction) * activeSpeechDuration)
    );
    const includeLeadIn = offsetSec <= 0.0001;
    connectSourceFrom(includeLeadIn ? 0 : offsetSec, includeLeadIn);
  }

  function connectStreamSource(stream, chunkResult, offsetWithinChunkSec = 0) {
    const source = audioContext.createBufferSource();
    source.buffer = chunkResult.buffer;

    if (activeUseStretch && StretchNodeClass) {
      const stretch = new StretchNodeClass({ context: audioContext, outputChannelCount: 1 });
      if (typeof stretch.setStretchParameters === "function") {
        stretch.setStretchParameters(SPEECH_STRETCH_PARAMS);
      }
      source.playbackRate.value = activeStretchRate;
      stretch.playbackRate.value = activeStretchRate;
      source.connect(stretch);
      stretch.connect(activeGain);
      activeStretch = stretch;
    } else {
      source.playbackRate.value = 1;
      source.connect(activeGain);
    }

    source.onended = async () => {
      if (playbackToken !== stream.token || stream.cancelled) return;
      teardownSource();
      baseCtxTime = audioContext ? audioContext.currentTime : 0;

      if (chunkResult.index < stream.chunks.length - 1) {
        if (!stream.results[chunkResult.index + 1]) {
          setPlaybackState("loading");
          notify("Buffering next Kokoro chunk...");
        }
        await playStreamChunk(stream, chunkResult.index + 1);
        return;
      }

      activeStream = null;
      setPlaybackState("ended");
      if (typeof onItemFinished === "function" && stream.playingItem) {
        onItemFinished(stream.playingItem.id);
      }
      try {
        await markPlayed(stream.playingItem);
        notify("Read aloud finished.");
      } catch (error) {
        notify(`Playback finished, but queue state could not be saved: ${error.message}`);
      }
    };

    activeSource = source;
    activeStreamChunk = chunkResult;
    const offsetSec = Math.max(0, Number(offsetWithinChunkSec) || 0);
    basePosSec =
      chunkResult.index === 0 && offsetSec <= 0
        ? -activeLeadInSec
        : chunkResult.startSec + offsetSec;
    baseCtxTime = audioContext.currentTime;
    const bufferOffset =
      (chunkResult.index === 0 ? activeLeadInSec : 0) +
      Math.min(chunkResult.endSec - chunkResult.startSec, offsetSec);
    source.start(0, bufferOffset);
  }

  async function playStreamChunk(stream, index) {
    let chunkResult;
    try {
      chunkResult = await stream.chunkPromises[index];
    } catch (error) {
      if (playbackToken !== stream.token || stream.cancelled) return;
      activeStream = null;
      activeItem = null;
      releaseActiveAudio();
      setPlaybackState("idle");
      const reason = `Local Kokoro speech failed: ${error.message}`;
      await markSkipped(stream.playingItem, reason);
      notify(`${reason} The speakable preview remains visible.`);
      return;
    }

    if (playbackToken !== stream.token || stream.cancelled) return;
    if (audioContext.state === "suspended") await audioContext.resume();
    if (playbackToken !== stream.token || stream.cancelled) return;

    activeSpeechDuration = Math.max(activeSpeechDuration, chunkResult.afterGapSec);
    activeSegments = stream.segments.slice();
    connectStreamSource(stream, chunkResult);
    setPlaybackState("speaking");
    notify(
      `Reading from ${stream.playingItem.sourceApp} with Kokoro${activeUseStretch ? " (live speed)" : ""}.`
    );
  }

  function prepareStream({
    token,
    target,
    playingItem,
    chunks,
    voice,
    genSpeed,
    useCache,
    leadInSec
  }) {
    const stream = {
      token,
      target,
      playingItem,
      chunks,
      cancelled: false,
      buffers: [],
      segments: [],
      sampleRate: 24000,
      cursorSamples: 0,
      chunkPromises: [],
      results: []
    };

    let tail = Promise.resolve();
    stream.chunkPromises = chunks.map((chunk, index) => {
      tail = tail.then(async () => {
        if (stream.cancelled || playbackToken !== token) throw new Error("Playback was cancelled.");
        const generated = await withGenLock(() => kokoroGenerateChunk(chunk, voice, genSpeed));
        if (stream.cancelled || playbackToken !== token) throw new Error("Playback was cancelled.");

        stream.sampleRate = generated.sampleRate;
        const gapSamples =
          index < chunks.length - 1 ? Math.round(generated.sampleRate * KOKORO_CHUNK_GAP_SEC) : 0;
        const startSec = stream.cursorSamples / generated.sampleRate;
        stream.cursorSamples += generated.samples.length;
        const endSec = stream.cursorSamples / generated.sampleRate;
        stream.segments.push({ text: chunk, startSec, endSec });
        stream.buffers[index] = generated.samples;
        stream.cursorSamples += gapSamples;

        const result = {
          index,
          samples: generated.samples,
          sampleRate: generated.sampleRate,
          startSec,
          endSec,
          afterGapSec: stream.cursorSamples / generated.sampleRate,
          buffer: createPlaybackBuffer(generated.samples, generated.sampleRate, {
            leadInSamples: index === 0 ? Math.round(generated.sampleRate * leadInSec) : 0,
            tailSilenceSamples: gapSamples
          })
        };
        stream.results[index] = result;
        return result;
      });
      return tail;
    });

    stream.finalPromise = tail.then(async () => {
      if (stream.cancelled || playbackToken !== token) return null;
      const generated = {
        samples: concatSamples(stream.buffers, stream.sampleRate),
        sampleRate: stream.sampleRate,
        segments: stream.segments.slice(),
        wordAccurate: false
      };
      if (stream.cancelled || playbackToken !== token) return null;
      activeBuffer = createPlaybackBuffer(generated.samples, generated.sampleRate, {
        leadInSamples: Math.round(generated.sampleRate * leadInSec)
      });
      activeSegments = generated.segments;
      activeSpeechDuration = generated.samples.length / generated.sampleRate;
      if (useCache) await cacheGeneratedAudio(backendUrl, target, generated);
      return generated;
    });
    stream.finalPromise.catch(() => {});

    return stream;
  }

  function notify(message) {
    if (typeof onUpdate === "function") onUpdate(message);
  }

  function refresh() {
    if (typeof onStateChanged === "function") onStateChanged();
  }

  function setPlaybackState(nextState) {
    playbackState = nextState;
    refresh();
  }

  async function markSkipped(item, reason) {
    await postJson(`${backendUrl}/api/queue/${encodeURIComponent(item.id)}/skipped`, { reason });
    refresh();
  }

  async function markPlayed(item) {
    await postJson(`${backendUrl}/api/queue/${encodeURIComponent(item.id)}/played`);
    refresh();
  }

  async function markPlaying(item) {
    const result = await postJson(`${backendUrl}/api/queue/${encodeURIComponent(item.id)}/playing`);
    refresh();
    return result.item || item;
  }

  async function speakItem(item, settings) {
    const skipReason = getSkipReason(item);
    if (skipReason) {
      await markSkipped(item, skipReason);
      notify(skipReason);
      return;
    }

    if (settings.engine === "kokoro" || settings.engine === "kokoro-ts") {
      await speakWithKokoro(item, settings);
      return;
    }

    const synth = getSpeechSynthesis();
    const Utterance = getUtteranceConstructor();
    if (!synth || !Utterance) {
      const reason =
        "This WebView does not expose speechSynthesis. The speakable preview remains available to read on screen.";
      await markSkipped(item, reason);
      notify(reason);
      return;
    }

    const token = playbackToken + 1;
    playbackToken = token;
    synth.cancel();
    await wait(0);

    const playingItem = await markPlaying(item);
    const voices = await loadVoices(synth);
    const utterance = new Utterance(normalizeSpeakableText(playingItem));
    const voice = selectVoice(voices, settings.voice);

    if (voice) utterance.voice = voice;
    utterance.rate = clampNumber(Number(settings.rate), DEFAULT_RATE, 0.1, 10);
    utterance.volume = clampNumber(Number(settings.volume), 1, 0, 1);

    activeUtterance = utterance;
    activeItem = playingItem;
    setPlaybackState("speaking");
    notify(`Reading speakable text from ${playingItem.sourceApp}.`);

    utterance.onend = async () => {
      if (playbackToken !== token) return;
      activeUtterance = null;
      activeItem = null;
      setPlaybackState("idle");
      try {
        await markPlayed(playingItem);
        notify("Read aloud finished.");
      } catch (error) {
        notify(`Playback finished, but queue state could not be saved: ${error.message}`);
      }
    };

    utterance.onerror = async () => {
      if (playbackToken !== token) return;
      activeUtterance = null;
      activeItem = null;
      setPlaybackState("idle");
      const reason = "Browser speech playback failed before completion.";
      try {
        await markSkipped(playingItem, reason);
      } finally {
        notify(`${reason} The speakable preview remains visible.`);
      }
    };

    try {
      synth.speak(utterance);
    } catch {
      if (playbackToken !== token) return;
      activeUtterance = null;
      activeItem = null;
      setPlaybackState("idle");
      const reason = "Browser speech playback could not start.";
      await markSkipped(playingItem, reason);
      notify(`${reason} The speakable preview remains visible.`);
    }
  }

  function resolveKokoro(settings) {
    const engine = settings.engine === "kokoro-ts" ? "kokoro-ts" : "kokoro";
    const voice = settings.kokoroVoice;
    const rawGenerate =
      engine === "kokoro-ts" ? generateKokoroTimestampedAudio : kokoroGenerateAudio;
    return { engine, voice, rawGenerate };
  }

  async function speakWithKokoro(item, settings) {
    const token = playbackToken + 1;
    playbackToken = token;

    const synth = getSpeechSynthesis();
    if (synth) synth.cancel();
    releaseActiveAudio();

    const context = getAudioContext();
    if (!context) {
      const reason = "This WebView does not expose Web Audio, so Kokoro cannot play.";
      await markSkipped(item, reason);
      notify(reason);
      return;
    }
    await applyOutputDevice(settings);

    const playingItem = await markPlaying(item);
    activeItem = playingItem;
    if (playbackToken === token) setPlaybackState("loading");
    const rate = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);

    const canStretch = await ensureStretch(context);
    if (playbackToken !== token) return;
    const { engine, voice, rawGenerate } = resolveKokoro(settings);
    const text = normalizeSpeakableText(playingItem);
    const { genSpeed, stretchRate } = planSpeed(rate, canStretch);
    let generated = null;
    let useStreaming = false;
    const target = { itemId: playingItem.id, engine, voice, speed: genSpeed };
    try {
      notify(
        `${engine === "kokoro" ? "Preparing" : "Generating natural"} Kokoro speech${genSpeed > 1 ? ` at ${genSpeed.toFixed(2)}x` : ""}...`
      );
      if (engine === "kokoro") {
        generated = await getCachedAudio(backendUrl, target).catch(() => null);
        if (!generated) notify("Regenerating audio because the saved copy was deleted.");
        useStreaming = !generated;
      } else {
        generated = await getAudio(
          backendUrl,
          {
            ...target,
            onPersistentMiss: () => notify("Regenerating audio because the saved copy was deleted.")
          },
          () => withGenLock(() => rawGenerate(text, voice, genSpeed))
        );
      }
    } catch (error) {
      if (playbackToken !== token) return;
      activeItem = null;
      setPlaybackState("idle");
      const reason = `Local Kokoro speech failed: ${error.message}`;
      await markSkipped(playingItem, reason);
      notify(`${reason} The speakable preview remains visible.`);
      return;
    }
    const useStretch = canStretch && Math.abs(stretchRate - 1) > 0.001;

    if (playbackToken !== token) return;

    try {
      if (useStreaming) {
        if (context.state === "suspended") await context.resume();
        const leadInSec = useStretch && StretchNodeClass ? STRETCH_LEADIN_SEC : 0;
        const gain = context.createGain();
        gain.gain.value = clampNumber(Number(settings.volume), 1, 0, 1);
        gain.connect(context.destination);

        activeGain = gain;
        activeGenSpeed = genSpeed;
        activeUseStretch = Boolean(useStretch && StretchNodeClass);
        activeStretchRate = activeUseStretch ? stretchRate : 1;

        const chunks = kokoroGetChunks(text);
        if (chunks.length === 0) throw new Error("No speakable text is available for playback.");
        const stream = prepareStream({
          token,
          target,
          playingItem,
          chunks,
          voice,
          genSpeed,
          useCache: genSpeed === 1,
          leadInSec
        });
        activeStream = stream;
        activeItem = playingItem;
        activeLeadInSec = leadInSec;
        activeSpeechDuration = 0;
        activeSegments = [];
        activeWordAccurate = false;
        notify("Generating first Kokoro chunk...");
        await playStreamChunk(stream, 0);
        return;
      }

      await installGeneratedBuffer(generated, settings, { genSpeed, stretchRate, useStretch });
      setPlaybackState("speaking");
      notify(
        `Reading from ${playingItem.sourceApp} with Kokoro${useStretch ? " (live speed)" : ""}.`
      );
    } catch (error) {
      if (playbackToken !== token) return;
      releaseActiveAudio();
      activeItem = null;
      setPlaybackState("idle");
      const reason = `Local Kokoro audio playback failed: ${error.message}`;
      await markSkipped(playingItem, reason);
      notify(`${reason} The speakable preview remains visible.`);
    }
  }

  async function prewarm(item, settings) {
    if (!item || !settings) return;
    if (settings.engine !== "kokoro" && settings.engine !== "kokoro-ts") return;
    if (getSkipReason(item)) return;
    const { engine, voice, rawGenerate } = resolveKokoro(settings);
    const text = normalizeSpeakableText(item);
    if (!text) return;
    try {
      await getAudio(backendUrl, { itemId: item.id, engine, voice }, () =>
        withGenLock(() => rawGenerate(text, voice, 1))
      );
    } catch (error) {
      console.debug("Audio prewarm failed; playback will retry on demand.", error);
    }
  }

  function applyLiveSettings(settings) {
    if (!settings) return;
    applyOutputDevice(settings);
    if (activeStream && !activeBuffer && activeSource && Number.isFinite(Number(settings.rate))) {
      const target = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);
      const chunk = activeStreamChunk;
      if (chunk) {
        const currentSec = getCurrentSpeechSec();
        const chunkOffset = Math.min(
          chunk.endSec - chunk.startSec,
          Math.max(0, currentSec - chunk.startSec)
        );
        const residual = clampNumber(target / (activeGenSpeed || 1), 1, RATE_MIN, RATE_MAX);
        const nextUseStretch = Boolean(StretchNodeClass && Math.abs(residual - 1) > 0.001);
        activeUseStretch = nextUseStretch;
        activeStretchRate = nextUseStretch ? residual : 1;
        teardownSource();
        connectStreamSource(activeStream, chunk, chunkOffset);
      }
    } else if (activeStretch && activeSource && Number.isFinite(Number(settings.rate))) {
      const target = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);
      const residual = clampNumber(target / (activeGenSpeed || 1), 1, RATE_MIN, RATE_MAX);
      basePosSec = getCurrentSpeechSec();
      baseCtxTime = audioContext ? audioContext.currentTime : 0;
      activeStretchRate = residual;
      activeSource.playbackRate.value = residual;
      activeStretch.playbackRate.value = residual;
    }
    if (activeGain && Number.isFinite(Number(settings.volume))) {
      activeGain.gain.value = clampNumber(Number(settings.volume), 1, 0, 1);
    }
  }

  // Commit a target rate. Within the same native-gen band this just live-adjusts
  // the WSOLA stretch (instant). Crossing a band boundary requires regenerating
  // the audio at the new native Kokoro speed; that is done here while preserving
  // the current position and play/pause state. Call on slider release, not drag.
  async function changeSpeed(rate, settings = {}) {
    if (!activeBuffer && !activeStream) return;
    const target = clampNumber(Number(rate), 1, RATE_MIN, RATE_MAX);
    const canStretch = Boolean(StretchNodeClass);
    const plan = planSpeed(target, canStretch);

    if (Math.abs(plan.genSpeed - activeGenSpeed) < 0.001) {
      applyLiveSettings({ rate: target, volume: settings.volume });
      return;
    }

    if (activeStream && !activeBuffer) {
      applyLiveSettings({ rate: target, volume: settings.volume });
      return;
    }

    const context = getAudioContext();
    if (!context) return;

    const token = playbackToken + 1;
    playbackToken = token;
    const wasPaused = playbackState === "paused";
    const fraction = activeSpeechDuration > 0 ? getCurrentSpeechSec() / activeSpeechDuration : 0;
    const { engine, voice, rawGenerate } = resolveKokoro(settings);
    const text = normalizeSpeakableText(activeItem);
    setPlaybackState("loading");

    let generated = null;
    try {
      generated = await getAudio(
        backendUrl,
        {
          itemId: activeItem.id,
          engine,
          voice,
          speed: plan.genSpeed,
          onPersistentMiss: () => notify("Regenerating audio because the saved copy was deleted.")
        },
        () => withGenLock(() => rawGenerate(text, voice, plan.genSpeed))
      );
    } catch (error) {
      if (playbackToken !== token) return;
      notify(`Could not change speed: ${error.message}`);
      setPlaybackState(wasPaused ? "paused" : "speaking");
      return;
    }
    if (playbackToken !== token) return;

    const useStretch = canStretch && Math.abs(plan.stretchRate - 1) > 0.001;
    releaseActiveAudio();
    try {
      await installGeneratedBuffer(
        generated,
        settings,
        { genSpeed: plan.genSpeed, stretchRate: plan.stretchRate, useStretch },
        { offsetFraction: fraction, resume: !wasPaused }
      );
      if (wasPaused) {
        await context.suspend();
        setPlaybackState("paused");
      } else {
        setPlaybackState("speaking");
      }
    } catch (error) {
      releaseActiveAudio();
      activeItem = null;
      setPlaybackState("idle");
      notify(`Speed change failed: ${error.message}`);
    }
  }

  function getPlaybackPosition() {
    if (!activeBuffer && !activeStream) return null;
    const currentSec = getCurrentSpeechSec();
    const totalSec = activeSpeechDuration;
    let segmentIndex = activeSegments.findIndex(
      (seg) => currentSec >= seg.startSec && currentSec < seg.endSec
    );
    if (segmentIndex === -1 && activeSegments.length && currentSec >= totalSec) {
      segmentIndex = activeSegments.length - 1;
    }
    return {
      fraction: totalSec > 0 ? currentSec / totalSec : 0,
      currentSec,
      totalSec,
      segmentIndex,
      segments: activeSegments,
      wordAccurate: activeWordAccurate
    };
  }

  function findGeneratedStreamChunk(targetSec) {
    if (!activeStream) return null;
    return (
      activeStream.results.find(
        (result) => result && targetSec >= result.startSec && targetSec < result.endSec
      ) ||
      activeStream.results.find(
        (result) => result && Math.abs(targetSec - result.endSec) <= KOKORO_CHUNK_GAP_SEC
      ) ||
      null
    );
  }

  function seek(fraction) {
    if ((!activeBuffer && !activeStream) || !audioContext) return;
    const target = Math.min(
      activeSpeechDuration,
      Math.max(0, Number(fraction) * activeSpeechDuration)
    );
    if (activeStream && !activeBuffer) {
      const chunk = findGeneratedStreamChunk(target);
      if (!chunk) {
        notify("That part is still generating.");
        return;
      }
      teardownSource();
      if (audioContext.state === "suspended") audioContext.resume();
      connectStreamSource(activeStream, chunk, Math.max(0, target - chunk.startSec));
      setPlaybackState("speaking");
      return;
    }
    teardownSource();
    if (audioContext.state === "suspended") audioContext.resume();
    connectSourceFrom(target, false);
    setPlaybackState("speaking");
  }

  function replayCurrent() {
    if ((!activeBuffer && !activeStream) || !audioContext) return false;
    if (activeStream && !activeBuffer) {
      const firstChunk = activeStream.results[0];
      if (!firstChunk) {
        notify("The first audio chunk is still generating.");
        return false;
      }
      teardownSource();
      if (audioContext.state === "suspended") audioContext.resume();
      connectStreamSource(activeStream, firstChunk, 0);
      setPlaybackState("speaking");
      notify("Replaying from the start.");
      return true;
    }
    teardownSource();
    if (audioContext.state === "suspended") audioContext.resume();
    connectSourceFrom(0, true);
    setPlaybackState("speaking");
    notify("Replaying from the start.");
    return true;
  }

  async function playItem(item, settings = {}) {
    if (!item) {
      notify("No item is selected to read.");
      return;
    }
    if (settings.mute) {
      notify("Muted. The speakable preview remains available to read on screen.");
      return;
    }
    await speakItem(item, settings);
  }

  async function readNextPending({ settings, queue }) {
    const item = Array.isArray(queue.pending) ? queue.pending[0] : null;
    if (!item) {
      notify("No pending speakable item is waiting.");
      return;
    }
    if (settings.mute) {
      notify("Muted. The speakable preview remains available to read on screen.");
      return;
    }

    await speakItem(item, settings);
  }

  function pause() {
    if (hasActiveAudio() && playbackState === "speaking") {
      audioContext?.suspend();
      setPlaybackState("paused");
      notify("Paused Kokoro playback.");
      return;
    }

    const synth = getSpeechSynthesis();
    if (!synth || !activeUtterance || playbackState !== "speaking") {
      notify("No active speech is available to pause.");
      return;
    }

    synth.pause();
    setPlaybackState("paused");
    notify("Paused browser speech playback.");
  }

  function resume() {
    if (hasActiveAudio() && playbackState === "paused") {
      audioContext?.resume();
      setPlaybackState("speaking");
      notify("Resumed Kokoro playback.");
      return;
    }

    const synth = getSpeechSynthesis();
    if (!synth || !activeUtterance || playbackState !== "paused") {
      notify("No paused speech is available to resume.");
      return;
    }

    synth.resume();
    setPlaybackState("speaking");
    notify("Resumed browser speech playback.");
  }

  async function stop(reason = "User stopped playback.") {
    const item = activeItem;
    const hadActiveSpeech = Boolean(activeUtterance || hasActiveAudio() || item);
    playbackToken += 1;
    activeUtterance = null;
    releaseActiveAudio();
    activeItem = null;
    setPlaybackState("idle");

    if (audioContext?.state === "suspended") audioContext.resume();

    const synth = getSpeechSynthesis();
    if (synth) synth.cancel();

    if (!hadActiveSpeech) {
      notify("No active speech is available to stop.");
      return;
    }

    if (item) {
      await markSkipped(item, reason);
    }
    notify("Stopped browser speech playback.");
  }

  async function replayLatest(settings = {}) {
    if (activeUtterance || activeItem) {
      await stop("User stopped playback to replay the latest item.");
    }

    const result = await postJson(`${backendUrl}/api/queue/replay-latest`);
    const item = result.item;
    if (!item) {
      notify("No replayable speakable item exists.");
      refresh();
      return;
    }

    if (settings.mute) {
      notify("Replay is queued, but mute is on.");
      refresh();
      return;
    }

    await speakItem(item, settings);
  }

  async function setMute(muted) {
    if (muted && (activeUtterance || activeItem)) {
      await stop("User muted playback.");
    }

    const endpoint = muted ? "mute" : "unmute";
    await postJson(`${backendUrl}/api/${endpoint}`);
    notify(muted ? "Muted playback." : "Unmuted playback.");
    refresh();
  }

  return {
    pause,
    resume,
    stop,
    replayLatest,
    setMute,
    applyLiveSettings,
    changeSpeed,
    seek,
    replayCurrent,
    getPlaybackPosition,
    playItem,
    readNextPending,
    prewarm,
    get isSpeaking() {
      return playbackState === "speaking";
    },
    get isPaused() {
      return playbackState === "paused";
    },
    get isEnded() {
      return playbackState === "ended";
    },
    // True when a buffer is loaded and the play head has reached the end,
    // regardless of whether the state settled on "ended" (it can linger as
    // speaking/paused through the stretch tail). Lets the play button restart
    // from the start instead of resuming silence at the end.
    get isAtEnd() {
      if (!activeBuffer || activeSpeechDuration <= 0) return false;
      return getCurrentSpeechSec() >= activeSpeechDuration - 0.05;
    },
    get isLoading() {
      return playbackState === "loading";
    },
    get activeItemId() {
      return activeItem?.id || null;
    },
    get state() {
      return playbackState;
    }
  };
}
