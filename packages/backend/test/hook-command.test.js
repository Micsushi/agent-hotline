const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const { runHookCommand } = require("../src/hook-command");
const { createServer, HOST } = require("../src/server");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-hook-"));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withServer(options, callback) {
  const dataDir = tempDir();
  const server = createServer({ dataDir, ...options });
  const port = await listen(server);
  const baseUrl = `http://${HOST}:${port}`;

  try {
    await callback({ baseUrl, dataDir, server });
  } finally {
    await close(server);
  }
}

function codexPayload(text) {
  return JSON.stringify({
    source: "codex",
    event: "agent_response_completed",
    response: {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text
        }
      ]
    }
  });
}

function claudePayload(text) {
  return JSON.stringify({
    source: "claude",
    hook_event_name: "Stop",
    assistant_response: {
      role: "assistant",
      content: [
        {
          type: "text",
          text
        }
      ]
    }
  });
}

test("hook command enqueues speakable text through the localhost API", async () => {
  await withServer({}, async ({ baseUrl, dataDir }) => {
    const result = await runHookCommand({
      input: codexPayload(
        "Spoken:\nThe hook command can now queue this short local playback summary."
      ),
      baseUrl
    });

    assert.equal(result.action, "enqueued");
    assert.equal(result.sourceApp, "Codex");
    assert.equal(result.item.status, "pending");

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "speech-queue.json"), "utf8"));
    assert.equal(persisted.items.length, 1);
    assert.equal(
      persisted.items[0].speakableText,
      "The hook command can now queue this short local playback summary."
    );
    assert.equal(persisted.items[0].rawSource.includes("Spoken:"), true);
  });
});

test("hook command filters Claude output before queueing for playback", async () => {
  await withServer({}, async ({ baseUrl, dataDir }) => {
    const result = await runHookCommand({
      input: claudePayload(
        [
          "Here is the short answer to read aloud.",
          "",
          "```js",
          "const displayedOnly = true;",
          "```"
        ].join("\n")
      ),
      baseUrl
    });

    assert.equal(result.action, "enqueued");
    assert.equal(result.sourceApp, "Claude");
    assert.equal(result.item.status, "pending");

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "speech-queue.json"), "utf8"));
    assert.equal(persisted.items.length, 1);
    assert.equal(persisted.items[0].sourceApp, "Claude");
    assert.equal(persisted.items[0].speakableText, "Here is the short answer to read aloud.");
    assert.equal(persisted.items[0].rawSource.includes("displayedOnly"), true);
  });
});

test("hook command skips disabled sources before enqueueing", async () => {
  await withServer({}, async ({ baseUrl, dataDir }) => {
    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codexEnabled: false })
    });
    assert.equal(settingsResponse.status, 200);

    const result = await runHookCommand({
      input: codexPayload("This is a normal assistant response that would otherwise be queued."),
      baseUrl
    });

    assert.equal(result.action, "skipped");
    assert.equal(result.reason, "source_disabled");
    assert.equal(fs.existsSync(path.join(dataDir, "speech-queue.json")), false);
  });
});

test("hook command returns recoverable failure when backend is not running", async () => {
  const result = await runHookCommand({
    input: codexPayload("This should not break the calling agent when the backend is down."),
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 100
  });

  assert.equal(result.action, "recoverable_failure");
  assert.equal(result.reason, "backend_unavailable");
});

test("hook command skips malformed or unspeakable input safely", async () => {
  const malformed = await runHookCommand({
    input: "{ not json",
    fetchImpl: async () => {
      throw new Error("fetch should not run for malformed input");
    }
  });
  assert.equal(malformed.action, "skipped");
  assert.equal(malformed.reason, "malformed_json");

  const unspeakable = await runHookCommand({
    input: codexPayload("```js\nconst onlyCode = true;\n```"),
    fetchImpl: async () => {
      throw new Error("fetch should not run for unspeakable input");
    }
  });
  assert.equal(unspeakable.action, "skipped");
  assert.equal(unspeakable.reason, "no_speakable_text");
});

test("hook CLI exits zero and keeps stdout quiet when backend is unavailable", () => {
  const binPath = path.resolve(__dirname, "..", "bin", "agent-hotline-hook.js");
  const child = spawnSync(process.execPath, [binPath], {
    input: codexPayload("This backend-down hook call should be silent and recoverable."),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_HOTLINE_URL: "http://127.0.0.1:9"
    },
    timeout: 5000
  });

  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
});
