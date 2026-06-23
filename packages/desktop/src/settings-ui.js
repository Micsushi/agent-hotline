import { getKokoroVoices } from "./tts-kokoro.js";

const READ_BEHAVIORS = new Set(["manual", "auto", "ask_every_time"]);
const TTS_ENGINES = new Set(["webview", "kokoro"]);
const SKIP_RULES = ["codeBlocks", "diffs", "logs", "tables", "json", "longBulletLists"];

// Curated Kokoro-82M v1.0 voices. The full set is read from the model once it
// loads; this list keeps the dropdown useful before the first warm-up.
const KOKORO_VOICES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_sarah",
  "af_sky",
  "am_michael",
  "am_adam",
  "am_eric",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_lewis"
];

const DEFAULT_SETTINGS = {
  readBehavior: "manual",
  mute: false,
  engine: "webview",
  voice: "",
  kokoroVoice: "af_heart",
  rate: 0.92,
  volume: 1,
  skipRules: {
    codeBlocks: true,
    diffs: true,
    logs: true,
    tables: true,
    json: true,
    longBulletLists: true
  },
  codexEnabled: true,
  claudeEnabled: true
};

function getSpeechVoices() {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices();
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const skipRules =
    source.skipRules && typeof source.skipRules === "object" ? source.skipRules : {};

  return {
    readBehavior: READ_BEHAVIORS.has(source.readBehavior)
      ? source.readBehavior
      : DEFAULT_SETTINGS.readBehavior,
    mute: typeof source.mute === "boolean" ? source.mute : DEFAULT_SETTINGS.mute,
    engine: TTS_ENGINES.has(source.engine) ? source.engine : DEFAULT_SETTINGS.engine,
    voice: typeof source.voice === "string" ? source.voice : DEFAULT_SETTINGS.voice,
    kokoroVoice:
      typeof source.kokoroVoice === "string" ? source.kokoroVoice : DEFAULT_SETTINGS.kokoroVoice,
    rate: clampNumber(source.rate, DEFAULT_SETTINGS.rate, 0.1, 10),
    volume: clampNumber(source.volume, DEFAULT_SETTINGS.volume, 0, 1),
    skipRules: Object.fromEntries(
      SKIP_RULES.map((key) => [
        key,
        typeof skipRules[key] === "boolean" ? skipRules[key] : DEFAULT_SETTINGS.skipRules[key]
      ])
    ),
    codexEnabled:
      typeof source.codexEnabled === "boolean"
        ? source.codexEnabled
        : DEFAULT_SETTINGS.codexEnabled,
    claudeEnabled:
      typeof source.claudeEnabled === "boolean"
        ? source.claudeEnabled
        : DEFAULT_SETTINGS.claudeEnabled
  };
}

export function formatSettingsError(body, status) {
  const error = body?.error && typeof body.error === "object" ? body.error : body;
  const details =
    Array.isArray(error?.details) && error.details.length > 0 ? ` ${error.details.join(" ")}` : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const fallback = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  return `${message || fallback}${details}`;
}

async function parseError(response) {
  try {
    const body = await response.json();
    return formatSettingsError(body, response.status);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function setSelectOptions(select, settings) {
  const voices = getSpeechVoices();
  const currentVoice = settings.voice || "";
  const options = [{ value: "", label: "System default" }];

  for (const voice of voices) {
    options.push({
      value: voice.name,
      label: voice.lang ? `${voice.name} (${voice.lang})` : voice.name
    });
  }

  if (currentVoice && !options.some((option) => option.value === currentVoice)) {
    options.push({ value: currentVoice, label: `${currentVoice} (saved)` });
  }

  select.replaceChildren(
    ...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    })
  );
  select.value = currentVoice;
  select.disabled = !("speechSynthesis" in window);
}

function setKokoroVoiceOptions(select, settings) {
  const current = settings.kokoroVoice || "af_heart";
  const loaded = getKokoroVoices();
  const values = loaded.length > 0 ? loaded : KOKORO_VOICES;
  const all = [...new Set([...values, current])];

  select.replaceChildren(
    ...all.map((value) => {
      const element = document.createElement("option");
      element.value = value;
      element.textContent = value;
      return element;
    })
  );
  select.value = current;
}

function formatRate(value) {
  return `${parseFloat(Number(value).toFixed(2))}x`;
}

function formatVolume(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

export function initSettingsUi({ backendUrl, onSettingsChanged, onLivePreview }) {
  const state = document.querySelector("#settings-state");
  const error = document.querySelector("#settings-error");
  const readBehaviorInputs = Array.from(document.querySelectorAll("input[name='read-behavior']"));
  const readAloud = document.querySelector("#setting-readaloud");
  const readAloudSub = document.querySelector("#readaloud-sub");
  const mute = document.querySelector("#setting-mute");
  const codex = document.querySelector("#setting-codex");
  const claude = document.querySelector("#setting-claude");
  const engine = document.querySelector("#setting-engine");
  const voice = document.querySelector("#setting-voice");
  const kokoroVoice = document.querySelector("#setting-kokoro-voice");
  const kokoroVoiceRow = document.querySelector("#kokoro-voice-row");
  const rate = document.querySelector("#setting-rate");
  const rateValue = document.querySelector("#setting-rate-value");
  const volume = document.querySelector("#setting-volume");
  const volumeValue = document.querySelector("#setting-volume-value");
  const skipRuleInputs = Array.from(document.querySelectorAll("[data-skip-rule]"));

  let currentSettings = normalizeSettings();
  let isRendering = false;

  function showMessage(kind, message) {
    state.textContent = message;
    state.className = `settings-state is-${kind}`;
  }

  function showError(message) {
    error.hidden = false;
    error.textContent = message;
    showMessage("error", "Error");
  }

  function clearError() {
    error.hidden = true;
    error.textContent = "";
  }

  function render(settings) {
    currentSettings = normalizeSettings(settings);
    isRendering = true;

    for (const input of readBehaviorInputs) {
      input.checked = input.value === currentSettings.readBehavior;
    }

    if (readAloud) readAloud.checked = !currentSettings.mute;
    if (readAloudSub) {
      readAloudSub.textContent = currentSettings.mute
        ? "Off — replies are still captured to history, just not read."
        : "On — captured replies will be read.";
    }
    mute.checked = currentSettings.mute;
    codex.checked = currentSettings.codexEnabled;
    claude.checked = currentSettings.claudeEnabled;
    engine.value = currentSettings.engine;
    setSelectOptions(voice, currentSettings);
    setKokoroVoiceOptions(kokoroVoice, currentSettings);

    const usingKokoro = currentSettings.engine === "kokoro";
    voice.closest(".field-row").hidden = usingKokoro;
    kokoroVoiceRow.hidden = !usingKokoro;
    // Do not warm the model here. TTS must only start on an explicit user action
    // (clicking Read), so Kokoro loads lazily on first playback instead.

    rate.value = String(currentSettings.rate);
    rateValue.value = formatRate(currentSettings.rate);
    volume.value = String(currentSettings.volume);
    volumeValue.value = formatVolume(currentSettings.volume);

    for (const input of skipRuleInputs) {
      input.checked = currentSettings.skipRules[input.dataset.skipRule] === true;
    }

    clearError();
    showMessage("saved", "Saved");
    isRendering = false;
  }

  async function savePatch(patch) {
    if (isRendering) return;
    clearError();
    showMessage("saving", "Saving");

    try {
      const response = await fetch(`${backendUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });

      if (!response.ok) {
        throw new Error(await parseError(response));
      }

      const body = await response.json();
      render(body.settings);
      onSettingsChanged?.(body.settings);
    } catch (saveError) {
      render(currentSettings);
      showError(String(saveError?.message || saveError));
    }
  }

  for (const input of readBehaviorInputs) {
    input.addEventListener("change", () => {
      if (input.checked) savePatch({ readBehavior: input.value });
    });
  }

  if (readAloud) {
    readAloud.addEventListener("change", () => savePatch({ mute: !readAloud.checked }));
  }
  mute.addEventListener("change", () => savePatch({ mute: mute.checked }));
  codex.addEventListener("change", () => savePatch({ codexEnabled: codex.checked }));
  claude.addEventListener("change", () => savePatch({ claudeEnabled: claude.checked }));
  engine.addEventListener("change", () => savePatch({ engine: engine.value }));
  voice.addEventListener("change", () => savePatch({ voice: voice.value }));
  kokoroVoice.addEventListener("change", () => savePatch({ kokoroVoice: kokoroVoice.value }));

  rate.addEventListener("input", () => {
    rateValue.value = formatRate(rate.value);
    onLivePreview?.({ rate: clampNumber(rate.value, currentSettings.rate, 0.25, 4) });
  });
  rate.addEventListener("change", () =>
    savePatch({ rate: clampNumber(rate.value, currentSettings.rate, 0.25, 4) })
  );

  volume.addEventListener("input", () => {
    volumeValue.value = formatVolume(volume.value);
    onLivePreview?.({ volume: clampNumber(volume.value, currentSettings.volume, 0, 1) });
  });
  volume.addEventListener("change", () =>
    savePatch({ volume: clampNumber(volume.value, currentSettings.volume, 0, 1) })
  );

  for (const input of skipRuleInputs) {
    input.addEventListener("change", () => {
      savePatch({ skipRules: { [input.dataset.skipRule]: input.checked } });
    });
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.addEventListener("voiceschanged", () =>
      setSelectOptions(voice, currentSettings)
    );
  }

  showMessage("loading", "Loading");

  return {
    render,
    showUnavailable(message) {
      showError(message);
    }
  };
}
