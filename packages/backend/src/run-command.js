const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_PORT = "4777";

function backendServerPath() {
  return path.join(__dirname, "server.js");
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

module.exports = {
  backendServerPath,
  launchBackend
};
