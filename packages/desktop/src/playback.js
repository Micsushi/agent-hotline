import { generateKokoroAudio } from "./tts-kokoro.js";
import { generateKokoroTimestampedAudio } from "./tts-kokoro-timestamped.js";
import { getAudio, withGenLock } from "./audio-cache.js";

const RATE_MIN = 0.25;
const RATE_MAX = 4;

const KOKORO_SAFE_SPEED = 1.5;

const STRETCH_LEADIN_SEC = 0.2;

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

export function createPlaybackController({ backendUrl, onUpdate, onStateChanged, onItemFinished }) {
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
  let basePosSec = 0;
  let baseCtxTime = 0;

  function getAudioContext() {
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioContext = Ctx ? new Ctx() : null;
    }
    return audioContext;
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

  function releaseActiveAudio() {
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
  }

  function getCurrentSpeechSec() {
    if (!activeBuffer || !audioContext) return 0;
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
    utterance.rate = clampNumber(Number(settings.rate), 0.92, 0.1, 10);
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
      engine === "kokoro-ts" ? generateKokoroTimestampedAudio : generateKokoroAudio;
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

    const playingItem = await markPlaying(item);
    activeItem = playingItem;
    if (playbackToken === token) setPlaybackState("loading");
    const rate = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);

    const canStretch = await ensureStretch(context);
    if (playbackToken !== token) return;
    const { engine, voice, rawGenerate } = resolveKokoro(settings);
    const text = normalizeSpeakableText(playingItem);
    let genSpeed;
    let stretchRate;
    let generated = null;
    try {
      if (canStretch) {
        genSpeed = 1;
        stretchRate = rate;
        notify("Generating natural Kokoro speech...");
        generated = await getAudio(backendUrl, { itemId: playingItem.id, engine, voice }, () =>
          withGenLock(() => rawGenerate(text, voice, 1))
        );
      } else {
        genSpeed = Math.min(rate, KOKORO_SAFE_SPEED);
        stretchRate = 1;
        notify(
          `Generating natural Kokoro speech${genSpeed > 1 ? ` at ${genSpeed.toFixed(2)}x` : ""}...`
        );
        generated = await withGenLock(() => rawGenerate(text, voice, genSpeed));
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
      if (context.state === "suspended") await context.resume();

      const leadInSamples =
        useStretch && StretchNodeClass ? Math.round(generated.sampleRate * STRETCH_LEADIN_SEC) : 0;
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
      activeGenSpeed = genSpeed;
      activeLeadInSec = leadInSamples / generated.sampleRate;
      activeSpeechDuration = generated.samples.length / generated.sampleRate;
      activeSegments = Array.isArray(generated.segments) ? generated.segments : [];
      activeWordAccurate = Boolean(generated.wordAccurate);
      activeUseStretch = Boolean(useStretch && StretchNodeClass);
      activeStretchRate = activeUseStretch ? stretchRate : 1;
      connectSourceFrom(0, true);
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
    if (activeStretch && activeSource && Number.isFinite(Number(settings.rate))) {
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

  function getPlaybackPosition() {
    if (!activeBuffer) return null;
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

  function seek(fraction) {
    if (!activeBuffer || !audioContext) return;
    const target = Math.min(
      activeSpeechDuration,
      Math.max(0, Number(fraction) * activeSpeechDuration)
    );
    teardownSource();
    if (audioContext.state === "suspended") audioContext.resume();
    connectSourceFrom(target, false);
    setPlaybackState("speaking");
  }

  function replayCurrent() {
    if (!activeBuffer || !audioContext) return false;
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
