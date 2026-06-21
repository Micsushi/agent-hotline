const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  DEFAULT_SETTINGS,
  createSettingsStore,
  getDefaultDataDir,
  loadSettings,
  saveSettings,
  updateSettings
} = require("../src/settings-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-settings-"));
}

test("settings load with defaults when no file exists", () => {
  const dataDir = tempDir();

  assert.deepEqual(loadSettings({ dataDir }), DEFAULT_SETTINGS);
  assert.equal(fs.existsSync(path.join(dataDir, "settings.json")), false);
});

test("settings persist after edit and reload", () => {
  const dataDir = tempDir();
  const store = createSettingsStore({ dataDir });

  store.save({
    readBehavior: "auto",
    mute: true,
    voice: "Test Voice",
    rate: 1.25,
    volume: 0.6,
    skipRules: {
      ...DEFAULT_SETTINGS.skipRules,
      tables: false
    },
    codexEnabled: false,
    claudeEnabled: true
  });

  const restartedStore = createSettingsStore({ dataDir });
  assert.deepEqual(restartedStore.load(), {
    readBehavior: "auto",
    mute: true,
    voice: "Test Voice",
    rate: 1.25,
    volume: 0.6,
    skipRules: {
      codeBlocks: true,
      diffs: true,
      logs: true,
      tables: false,
      json: true,
      longBulletLists: true
    },
    codexEnabled: false,
    claudeEnabled: true
  });
});

test("settings update merges nested skip rules", () => {
  const dataDir = tempDir();

  saveSettings(DEFAULT_SETTINGS, { dataDir });
  const settings = updateSettings(
    {
      readBehavior: "ask_every_time",
      skipRules: {
        json: false
      }
    },
    { dataDir }
  );

  assert.equal(settings.readBehavior, "ask_every_time");
  assert.equal(settings.skipRules.json, false);
  assert.equal(settings.skipRules.codeBlocks, true);
});

test("invalid settings file falls back safely", () => {
  const dataDir = tempDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), "{ not json", "utf8");

  assert.deepEqual(loadSettings({ dataDir }), DEFAULT_SETTINGS);
});

test("invalid settings fields fall back safely", () => {
  const dataDir = tempDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    JSON.stringify({
      readBehavior: "always",
      mute: "yes",
      voice: 42,
      rate: 99,
      volume: -1,
      skipRules: {
        codeBlocks: "no",
        diffs: false
      },
      codexEnabled: "true",
      claudeEnabled: null
    }),
    "utf8"
  );

  assert.deepEqual(loadSettings({ dataDir }), {
    ...DEFAULT_SETTINGS,
    skipRules: {
      ...DEFAULT_SETTINGS.skipRules,
      diffs: false
    }
  });
});

test("default Windows runtime dir uses AppData Agent Hotline folder", () => {
  assert.equal(
    getDefaultDataDir({ APPDATA: "C:\\Users\\Test\\AppData\\Roaming" }, "win32"),
    "C:\\Users\\Test\\AppData\\Roaming\\Agent Hotline"
  );
});
