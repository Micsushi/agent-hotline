const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "Agent Hotline";
const SETTINGS_FILE = "settings.json";
const READ_BEHAVIORS = new Set(["manual", "auto", "ask_every_time"]);

const DEFAULT_SETTINGS = Object.freeze({
  readBehavior: "manual",
  mute: false,
  voice: "",
  rate: 0.92,
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
  claudeEnabled: true
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

function normalizeSettings(input) {
  const source = isPlainObject(input) ? input : {};
  const defaults = DEFAULT_SETTINGS;
  const sourceSkipRules = isPlainObject(source.skipRules) ? source.skipRules : {};

  return {
    readBehavior: READ_BEHAVIORS.has(source.readBehavior)
      ? source.readBehavior
      : defaults.readBehavior,
    mute: booleanOrDefault(source.mute, defaults.mute),
    voice: stringOrDefault(source.voice, defaults.voice),
    rate: numberInRangeOrDefault(source.rate, defaults.rate, 0.1, 10),
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
    claudeEnabled: booleanOrDefault(source.claudeEnabled, defaults.claudeEnabled)
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
  READ_BEHAVIORS: Array.from(READ_BEHAVIORS),
  createSettingsStore,
  getDefaultDataDir,
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings,
  updateSettings
};
