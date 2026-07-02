const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_FILE = "hotline-session-state.json";

function createHotlineStateStore(options = {}) {
  const filePath = options.filePath || path.join(options.dataDir || defaultDataDir(), STATE_FILE);

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function write(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  return {
    isEnabled(key) {
      return read()[key] === true;
    },

    setEnabled(key, enabled) {
      const state = read();
      state[key] = enabled === true;
      write(state);
    },

    filePath
  };
}

function defaultDataDir() {
  if (process.env.AGENT_HOTLINE_DATA_DIR) return process.env.AGENT_HOTLINE_DATA_DIR;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Agent Hotline");
  }
  return path.join(os.homedir(), ".agent-hotline");
}

module.exports = { createHotlineStateStore };
