import { generateKokoroAudio } from "./tts-kokoro.js";

const RATE_MIN = 0.25;
const RATE_MAX = 4;

// Above this rate the SoundTouch pitch-compensation (resample-up +
// WSOLA-pitch-shift-down) starts dropping whole phonemes/words and leaves
// residual pitch, so we keep the live stretch factor at or below it.
const STRETCH_SAFE_MAX = 1.5;

// Above this generation speed Kokoro's duration predictor starts dropping the
// LEADING words entirely (worse the faster you go). So we never generate faster
// than this; any extra speed is carried by the live WSOLA stretch instead.
const KOKORO_SAFE_SPEED = 1.5;

// The SoundTouch worklet swallows its first input chunk while priming, which
// clips the start of the first word (worse at higher stretch). Prepend this much
// silence so the warm-up eats silence instead of speech. Input-time, so it's
// independent of the stretch factor.
const STRETCH_LEADIN_SEC = 0.2;

// WSOLA timing tuned for speech instead of the auto music defaults. Shorter
// sequence/seek with exhaustive seek (quickSeek off) reduces stitch artifacts
// across the 1.0–1.5x live range. See @soundtouchjs setStretchParameters.
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

export function createPlaybackController({ backendUrl, onUpdate, onStateChanged }) {
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

  // Seek + position tracking (Kokoro / Web Audio path). Times are in "speech
  // seconds" (the generated buffer's own timeline, excluding the silent lead-in).
  let activeBuffer = null;
  let activeLeadInSec = 0;
  let activeSpeechDuration = 0;
  let activeSegments = [];
  let activeUseStretch = false;
  let activeStretchRate = 1;
  let basePosSec = 0; // speech seconds at the last (re)base point
  let baseCtxTime = 0; // audioContext.currentTime at that point

  function getAudioContext() {
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioContext = Ctx ? new Ctx() : null;
    }
    return audioContext;
  }

  // Register the SoundTouch worklet once per context. Returns true when the
  // pitch-preserving time-stretch node is usable; false means we fall back to
  // baking speed into generation instead.
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

  // True while a Kokoro buffer is playing through Web Audio.
  function hasActiveAudio() {
    return Boolean(activeSource);
  }

  // Stop just the source + stretch node (keeps the gain + buffer so seek can
  // rebuild the source from the same audio).
  function teardownSource() {
    if (activeSource) {
      activeSource.onended = null;
      try {
        activeSource.stop();
      } catch {
        // ignore: source may not have started or already stopped
      }
      try {
        activeSource.disconnect();
      } catch {
        // ignore
      }
    }
    if (activeStretch) {
      try {
        activeStretch.disconnect();
      } catch {
        // ignore
      }
    }
    activeSource = null;
    activeStretch = null;
  }

  function releaseActiveAudio() {
    teardownSource();
    if (activeGain) {
      try {
        activeGain.disconnect();
      } catch {
        // ignore
      }
    }
    activeGain = null;
    activeGenSpeed = 1;
    activeBuffer = null;
    activeSegments = [];
    activeSpeechDuration = 0;
    activeLeadInSec = 0;
  }

  // Current playback position in speech seconds. The AudioContext clock freezes
  // while suspended (paused), so elapsed time is automatically correct.
  function getCurrentSpeechSec() {
    if (!activeBuffer || !audioContext) return 0;
    const rate = activeUseStretch ? activeStretchRate : 1;
    const elapsed = (audioContext.currentTime - baseCtxTime) * rate;
    return Math.min(activeSpeechDuration, Math.max(0, basePosSec + elapsed));
  }

  // Build a fresh source (+ stretch node) from the active buffer and start it.
  // includeLeadIn plays the silent warm-up at the very start; a seek skips it.
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
      releaseActiveAudio();
      activeItem = null;
      setPlaybackState("idle");
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

    if (settings.engine === "kokoro") {
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
    const rate = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);

    // Split the requested speed between Kokoro generation and the live WSOLA
    // stretch so neither is pushed into its word-dropping regime:
    //   - up to STRETCH_SAFE_MAX: generate at 1x, stretch live (pitch-perfect)
    //   - above it: generate up to KOKORO_SAFE_SPEED, stretch carries the rest
    // Kokoro drops the LEADING words past KOKORO_SAFE_SPEED, so we never bake a
    // faster speed than that into generation.
    const canStretch = await ensureStretch(context);
    if (playbackToken !== token) return;
    let genSpeed;
    let stretchRate;
    if (!canStretch) {
      genSpeed = Math.min(rate, KOKORO_SAFE_SPEED);
      stretchRate = 1;
    } else if (rate <= STRETCH_SAFE_MAX) {
      genSpeed = 1;
      stretchRate = rate;
    } else {
      genSpeed = Math.min(rate / STRETCH_SAFE_MAX, KOKORO_SAFE_SPEED);
      stretchRate = rate / genSpeed;
    }
    const useStretch = canStretch && Math.abs(stretchRate - 1) > 0.001;
    notify(`Generating natural Kokoro speech${genSpeed > 1 ? ` at ${genSpeed.toFixed(2)}x` : ""}...`);

    let generated = null;
    try {
      generated = await generateKokoroAudio(
        normalizeSpeakableText(playingItem),
        settings.kokoroVoice,
        genSpeed
      );
    } catch (error) {
      if (playbackToken !== token) return;
      setPlaybackState("idle");
      const reason = `Local Kokoro speech failed: ${error.message}`;
      await markSkipped(playingItem, reason);
      notify(`${reason} The speakable preview remains visible.`);
      return;
    }

    if (playbackToken !== token) return;

    try {
      if (context.state === "suspended") await context.resume();

      // Pad a silent lead-in only when the stretch node is in the graph, so its
      // priming swallows silence rather than the first word.
      const leadInSamples =
        useStretch && StretchNodeClass
          ? Math.round(generated.sampleRate * STRETCH_LEADIN_SEC)
          : 0;
      const buffer = context.createBuffer(
        1,
        leadInSamples + generated.samples.length,
        generated.sampleRate
      );
      buffer.copyToChannel(generated.samples, 0, leadInSamples);

      const gain = context.createGain();
      gain.gain.value = clampNumber(Number(settings.volume), 1, 0, 1);
      gain.connect(context.destination);

      // Store the timeline so the UI can show position and seek.
      activeBuffer = buffer;
      activeGain = gain;
      activeGenSpeed = genSpeed;
      activeLeadInSec = leadInSamples / generated.sampleRate;
      activeSpeechDuration = generated.samples.length / generated.sampleRate;
      activeSegments = Array.isArray(generated.segments) ? generated.segments : [];
      activeUseStretch = Boolean(useStretch && StretchNodeClass);
      activeStretchRate = activeUseStretch ? stretchRate : 1;
      activeItem = playingItem;

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

  // Live-apply rate/volume to a Kokoro buffer that is already playing. Rate is
  // live only when the SoundTouch stretch node is active (pitch-preserved); set
  // both the source and stretch playbackRate so pitch stays compensated. Without
  // the stretch node, speed was baked into generation and applies on next read.
  function applyLiveSettings(settings) {
    if (!settings) return;
    if (activeStretch && activeSource && Number.isFinite(Number(settings.rate))) {
      // The baked generation speed is fixed for this read; the stretch node
      // carries the residual factor. Solve for it from the requested total so
      // dragging the slider stays pitch-preserved without re-generating. The
      // next read re-splits optimally.
      const target = clampNumber(Number(settings.rate), 1, RATE_MIN, RATE_MAX);
      const residual = clampNumber(target / (activeGenSpeed || 1), 1, RATE_MIN, RATE_MAX);
      // Rebase the position clock before the rate changes, or elapsed time would
      // be scaled by the wrong factor.
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

  // Position for the seek bar + text highlight, or null when nothing is loaded.
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
      segments: activeSegments
    };
  }

  // Jump to a fraction (0..1) of the current read. Rebuilds the source at the
  // offset; preserves paused state (the context stays suspended).
  function seek(fraction) {
    if (!activeBuffer || !audioContext) return;
    const target = Math.min(
      activeSpeechDuration,
      Math.max(0, Number(fraction) * activeSpeechDuration)
    );
    teardownSource();
    connectSourceFrom(target, false);
  }

  // Play a specific item (from history or the current selection).
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
    getPlaybackPosition,
    playItem,
    readNextPending,
    get isSpeaking() {
      return playbackState === "speaking";
    },
    get isPaused() {
      return playbackState === "paused";
    },
    get state() {
      return playbackState;
    }
  };
}
