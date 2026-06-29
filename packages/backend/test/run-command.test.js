const assert = require("assert");
const test = require("node:test");

const { launchBackend } = require("../src/run-command");
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

test("CLI run starts backend and opens the browser panel", async () => {
  const launchCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999"], {
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

test("CLI run supports backend-only mode", async () => {
  const launchCalls = [];
  const openCalls = [];
  const code = await cliMain(["run", "--port", "4999", "--no-open"], {
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
  assert.deepEqual(openCalls, []);
});
