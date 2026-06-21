const READ_BEHAVIORS = new Set(["manual", "auto", "ask_every_time"]);
const SKIP_RULES = ["codeBlocks", "diffs", "logs", "tables", "json", "longBulletLists"];

const DEFAULT_SETTINGS = {
  readBehavior: "manual",
  mute: false,
  voice: "",
  rate: 1,
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
    voice: typeof source.voice === "string" ? source.voice : DEFAULT_SETTINGS.voice,
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

function formatRate(value) {
  return `${Number(value).toFixed(1)}x`;
}

function formatVolume(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

export function initSettingsUi({ backendUrl, onSettingsChanged }) {
  const state = document.querySelector("#settings-state");
  const error = document.querySelector("#settings-error");
  const readBehaviorInputs = Array.from(document.querySelectorAll("input[name='read-behavior']"));
  const mute = document.querySelector("#setting-mute");
  const codex = document.querySelector("#setting-codex");
  const claude = document.querySelector("#setting-claude");
  const voice = document.querySelector("#setting-voice");
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

    mute.checked = currentSettings.mute;
    codex.checked = currentSettings.codexEnabled;
    claude.checked = currentSettings.claudeEnabled;
    setSelectOptions(voice, currentSettings);

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

  mute.addEventListener("change", () => savePatch({ mute: mute.checked }));
  codex.addEventListener("change", () => savePatch({ codexEnabled: codex.checked }));
  claude.addEventListener("change", () => savePatch({ claudeEnabled: claude.checked }));
  voice.addEventListener("change", () => savePatch({ voice: voice.value }));

  rate.addEventListener("input", () => {
    rateValue.value = formatRate(rate.value);
  });
  rate.addEventListener("change", () =>
    savePatch({ rate: clampNumber(rate.value, currentSettings.rate, 0.1, 10) })
  );

  volume.addEventListener("input", () => {
    volumeValue.value = formatVolume(volume.value);
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
