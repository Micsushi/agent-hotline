const assert = require("assert");
const test = require("node:test");

const { launchBackend, launchSourceDesktop } = require("../src/run-command");
const { main: cliMain } = require("../bin/agent-hotline");

test("launchBackend starts the server as a detached background process", () => {
  let unrefCalled = false;
  const calls = [];
  const child = {
    pid: 12345,
    unref() {
      unrefCalled = true;
    }
  };

  const result = launchBackend({
    execPath: "node",
    port: 4888,
    serverPath: String.raw`C:\agent-hotline\packages\backend\src\server.js`,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  });

  assert.equal(result.pid, 12345);
  assert.equal(result.port, "4888");
  assert.equal(result.url, "http://127.0.0.1:4888");
  assert.equal(unrefCalled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, [String.raw`C:\agent-hotline\packages\backend\src\server.js`]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.AGENT_HOTLINE_PORT, "4888");
});

test("launchSourceDesktop starts the local desktop lifecycle when source files exist", () => {
  let unrefCalled = false;
  const calls = [];
  const child = {
    pid: 12345,
    unref() {
      unrefCalled = true;
    }
  };

  const result = launchSourceDesktop({
    execPath: "node",
    port: 4888,
    root: String.raw`C:\agent-hotline`,
    launcherPath: String.raw`C:\agent-hotline\scripts\dev-lifecycle.mjs`,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  });

  assert.equal(result.pid, 12345);
  assert.equal(result.port, "4888");
  assert.equal(result.url, "http://127.0.0.1:4888");
  assert.equal(unrefCalled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, [String.raw`C:\agent-hotline\scripts\dev-lifecycle.mjs`]);
  assert.equal(calls[0].options.cwd, String.raw`C:\agent-hotline`);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.AGENT_HOTLINE_PORT, "4888");
  assert.equal(calls[0].options.env.AGENT_HOTLINE_URL, "http://127.0.0.1:4888");
});

test("launchSourceDesktop returns null when no local desktop launcher is available", () => {
  const result = launchSourceDesktop({
    root: String.raw`C:\packaged-agent-hotline`,
    launcherPath: null,
    spawn() {
      throw new Error("spawn should not be called");
    }
  });

  assert.equal(result, null);
});

test("CLI run starts local desktop app when source checkout is available", async () => {
  const launchCalls = [];
  const backendCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999"], {
    launchSourceDesktop(options) {
      launchCalls.push(options);
      return { pid: 12345, port: "4999", url: "http://127.0.0.1:4999" };
    },
    launchBackend(options) {
      backendCalls.push(options);
      return { pid: 999, port: "4999", url: "http://127.0.0.1:4999" };
    },
    openUrl(url) {
      openCalls.push(url);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(launchCalls, [{ port: "4999" }]);
  assert.deepEqual(backendCalls, []);
  assert.deepEqual(openCalls, []);
});

test("CLI run falls back to backend and browser panel without source desktop", async () => {
  const launchCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999"], {
    launchSourceDesktop() {
      return null;
    },
    launchBackend(options) {
      launchCalls.push(options);
      return { pid: 12345, port: "4999", url: "http://127.0.0.1:4999" };
    },
    openUrl(url) {
      openCalls.push(url);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(launchCalls, [{ port: "4999" }]);
  assert.deepEqual(openCalls, ["http://127.0.0.1:4999"]);
});

test("CLI run --browser forces backend and browser panel", async () => {
  const desktopCalls = [];
  const backendCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999", "--browser"], {
    launchSourceDesktop(options) {
      desktopCalls.push(options);
      return { pid: 12345, port: "4999", url: "http://127.0.0.1:4999" };
    },
    launchBackend(options) {
      backendCalls.push(options);
      return { pid: 999, port: "4999", url: "http://127.0.0.1:4999" };
    },
    openUrl(url) {
      openCalls.push(url);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(desktopCalls, []);
  assert.deepEqual(backendCalls, [{ port: "4999" }]);
  assert.deepEqual(openCalls, ["http://127.0.0.1:4999"]);
});

test("CLI run supports backend-only mode", async () => {
  const desktopCalls = [];
  const launchCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999", "--no-open"], {
    launchSourceDesktop(options) {
      desktopCalls.push(options);
      return { pid: 12345, port: "4999", url: "http://127.0.0.1:4999" };
    },
    launchBackend(options) {
      launchCalls.push(options);
      return { pid: 12345, port: "4999", url: "http://127.0.0.1:4999" };
    },
    openUrl(url) {
      openCalls.push(url);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(desktopCalls, []);
  assert.deepEqual(launchCalls, [{ port: "4999" }]);
  assert.deepEqual(openCalls, []);
});
