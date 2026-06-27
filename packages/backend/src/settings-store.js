const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "Agent Hotline";
const SETTINGS_FILE = "settings.json";
const READ_BEHAVIORS = new Set(["manual", "auto"]);
const TTS_ENGINES = new Set(["webview", "kokoro", "kokoro-ts"]);
const NOTIFICATION_OPENS = new Set(["full", "mini"]);
const AUDIO_CACHE_LIMIT_MAX_MB = 100000;
const DEFAULT_RATE = 0.9;

const DEFAULT_SETTINGS = Object.freeze({
  readBehavior: "manual",
  mute: false,
  engine: "webview",
  voice: "",
  audioOutputDeviceId: "",
  kokoroVoice: "af_heart",
  rate: DEFAULT_RATE,
  volume: 1,
  skipRules: Object.freeze({
    codeBlocks: true,
    diffs: true,
    logs: true,
    tables: true,
    json: true,
    longBulletLists: true
  }),
  codexEnabled: true,
  claudeEnabled: true,
  antigravityEnabled: true,
  notifyOnNewReply: false,
  notificationOpens: "full",
  highlightSpokenText: false,
  audioCacheLimitMb: 1024,
  startupSplash: true,
  startupJingle: true
});

function getDefaultDataDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_NAME);
}

function getSettingsPath(options = {}) {
  if (options.settingsPath) {
    return options.settingsPath;
  }

  return path.join(
    options.dataDir || getDefaultDataDir(options.env, options.platform),
    SETTINGS_FILE
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanOrDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function finiteNumberOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberInRangeOrDefault(value, fallback, min, max) {
  const number = finiteNumberOrDefault(value, fallback);
  return number >= min && number <= max ? number : fallback;
}

function normalizeRate(value, fallback) {
  const rate = numberInRangeOrDefault(value, fallback, 0.1, 10);
  return rate === 0.92 ? DEFAULT_RATE : rate;
}

function normalizeSettings(input) {
  const source = isPlainObject(input) ? input : {};
  const defaults = DEFAULT_SETTINGS;
  const sourceSkipRules = isPlainObject(source.skipRules) ? source.skipRules : {};

  return {
    readBehavior: READ_BEHAVIORS.has(source.readBehavior)
      ? source.readBehavior
      : defaults.readBehavior,
    mute: booleanOrDefault(source.mute, defaults.mute),
    engine: TTS_ENGINES.has(source.engine) ? source.engine : defaults.engine,
    voice: stringOrDefault(source.voice, defaults.voice),
    audioOutputDeviceId: stringOrDefault(source.audioOutputDeviceId, defaults.audioOutputDeviceId),
    kokoroVoice: stringOrDefault(source.kokoroVoice, defaults.kokoroVoice),
    rate: normalizeRate(source.rate, defaults.rate),
    volume: numberInRangeOrDefault(source.volume, defaults.volume, 0, 1),
    skipRules: {
      codeBlocks: booleanOrDefault(sourceSkipRules.codeBlocks, defaults.skipRules.codeBlocks),
      diffs: booleanOrDefault(sourceSkipRules.diffs, defaults.skipRules.diffs),
      logs: booleanOrDefault(sourceSkipRules.logs, defaults.skipRules.logs),
      tables: booleanOrDefault(sourceSkipRules.tables, defaults.skipRules.tables),
      json: booleanOrDefault(sourceSkipRules.json, defaults.skipRules.json),
      longBulletLists: booleanOrDefault(
        sourceSkipRules.longBulletLists,
        defaults.skipRules.longBulletLists
      )
    },
    codexEnabled: booleanOrDefault(source.codexEnabled, defaults.codexEnabled),
    claudeEnabled: booleanOrDefault(source.claudeEnabled, defaults.claudeEnabled),
    antigravityEnabled: booleanOrDefault(source.antigravityEnabled, defaults.antigravityEnabled),
    notifyOnNewReply: booleanOrDefault(source.notifyOnNewReply, defaults.notifyOnNewReply),
    notificationOpens: NOTIFICATION_OPENS.has(source.notificationOpens)
      ? source.notificationOpens
      : defaults.notificationOpens,
    highlightSpokenText: booleanOrDefault(source.highlightSpokenText, defaults.highlightSpokenText),
    audioCacheLimitMb: numberInRangeOrDefault(
      source.audioCacheLimitMb,
      defaults.audioCacheLimitMb,
      10,
      AUDIO_CACHE_LIMIT_MAX_MB
    ),
    startupSplash: booleanOrDefault(source.startupSplash, defaults.startupSplash),
    startupJingle: booleanOrDefault(source.startupJingle, defaults.startupJingle)
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

function loadSettings(options = {}) {
  return normalizeSettings(readJson(getSettingsPath(options)));
}

function saveSettings(settings, options = {}) {
  const nextSettings = normalizeSettings(settings);
  writeJson(getSettingsPath(options), nextSettings);
  return nextSettings;
}

function updateSettings(patch, options = {}) {
  const current = loadSettings(options);
  const source = isPlainObject(patch) ? patch : {};
  const nextSettings = normalizeSettings({
    ...current,
    ...source,
    skipRules: {
      ...current.skipRules,
      ...(isPlainObject(source.skipRules) ? source.skipRules : {})
    }
  });

  return saveSettings(nextSettings, options);
}

function createSettingsStore(options = {}) {
  return {
    path: getSettingsPath(options),
    load() {
      return loadSettings(options);
    },
    save(settings) {
      return saveSettings(settings, options);
    },
    update(patch) {
      return updateSettings(patch, options);
    }
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  AUDIO_CACHE_LIMIT_MAX_MB,
  READ_BEHAVIORS: Array.from(READ_BEHAVIORS),
  TTS_ENGINES: Array.from(TTS_ENGINES),
  createSettingsStore,
  getDefaultDataDir,
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings,
  updateSettings
};
