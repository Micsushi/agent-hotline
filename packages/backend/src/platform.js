const os = require("os");
const path = require("path");

const APP_NAME = "Agent Hotline";

function getDefaultDataDir(env = process.env, platform = process.platform) {
  if (env.AGENT_HOTLINE_DATA_DIR) return env.AGENT_HOTLINE_DATA_DIR;

  if (platform === "win32") {
    return path.win32.join(
      env.APPDATA || path.win32.join(os.homedir(), "AppData", "Roaming"),
      APP_NAME
    );
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_NAME);
}

function defaultSeaTargetTriple(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  if (platform === "darwin")
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "linux")
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported SEA target platform "${platform}".`);
}

module.exports = {
  APP_NAME,
  defaultSeaTargetTriple,
  getDefaultDataDir
};
