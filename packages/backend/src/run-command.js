const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DEFAULT_PORT = "4777";

function backendServerPath() {
  return path.join(__dirname, "server.js");
}

function repoRootFromBackend() {
  return path.resolve(__dirname, "..", "..", "..");
}

function sourceDesktopLauncherPath(root = repoRootFromBackend()) {
  const lifecyclePath = path.join(root, "scripts", "dev-lifecycle.mjs");
  const tauriConfigPath = path.join(root, "packages", "desktop", "src-tauri", "tauri.conf.json");

  if (!fs.existsSync(lifecyclePath) || !fs.existsSync(tauriConfigPath)) {
    return null;
  }

  return lifecyclePath;
}

function launchBackend(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const execPath = options.execPath || process.execPath;
  const serverPath = options.serverPath || backendServerPath();
  const port = String(options.port || process.env.AGENT_HOTLINE_PORT || DEFAULT_PORT);
  const child = spawnImpl(execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    detached: true,
    env: {
      ...process.env,
      AGENT_HOTLINE_PORT: port
    },
    stdio: "ignore",
    windowsHide: true
  });

  if (typeof child.unref === "function") {
    child.unref();
  }

  return {
    pid: child.pid,
    port,
    url: `http://127.0.0.1:${port}`
  };
}

function launchSourceDesktop(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const execPath = options.execPath || process.execPath;
  const root = options.root || repoRootFromBackend();
  const launcherPath = options.launcherPath || sourceDesktopLauncherPath(root);
  const port = String(options.port || process.env.AGENT_HOTLINE_PORT || DEFAULT_PORT);

  if (!launcherPath) {
    return null;
  }

  const child = spawnImpl(execPath, [launcherPath], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      AGENT_HOTLINE_PORT: port,
      AGENT_HOTLINE_URL: `http://127.0.0.1:${port}`
    },
    stdio: "ignore",
    windowsHide: true
  });

  if (typeof child.unref === "function") {
    child.unref();
  }

  return {
    pid: child.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    launcherPath
  };
}

function openUrl(url, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const platform = options.platform || process.platform;
  let command;
  let args;

  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  if (typeof child.unref === "function") {
    child.unref();
  }

  return { command, args };
}

module.exports = {
  backendServerPath,
  launchBackend,
  launchSourceDesktop,
  openUrl
};
