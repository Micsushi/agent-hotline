import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-mcp-"));
}

async function withMcp(dataDir, callback) {
  const client = new Client({ name: "agent-hotline-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("bin/agent-hotline-mcp.js")],
    cwd: path.resolve("."),
    env: { ...process.env, APPDATA: dataDir },
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
  }
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}

test("MCP exposes search, trash, restore, and settings tools", async () => {
  const dataDir = tempDir();
  const runtimeDir = path.join(dataDir, "Agent Hotline");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "speech-queue.json"),
    `${JSON.stringify(
      {
        items: [
          {
            id: "mcp-item-1",
            rawSource: "raw",
            speakableText: "Searchable MCP reply about output devices.",
            sourceApp: "Codex",
            status: "pending",
            threadId: "thread-mcp",
            sessionName: "MCP Session",
            projectPath: "C:\\Repo\\AgentHotline",
            projectName: "AgentHotline",
            timestamps: {
              createdAt: "2026-06-26T01:00:00.000Z",
              updatedAt: "2026-06-26T01:00:00.000Z"
            }
          }
        ]
      },
      null,
      2
    )}\n`
  );

  await withMcp(dataDir, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("search_messages"));
    assert.ok(names.includes("move_to_trash"));
    assert.ok(names.includes("restore_from_trash"));
    assert.ok(names.includes("update_settings"));

    const search = parseToolJson(
      await client.callTool({
        name: "search_messages",
        arguments: { query: "output devices" }
      })
    );
    assert.equal(search[0].id, "mcp-item-1");

    const settings = parseToolJson(
      await client.callTool({
        name: "update_settings",
        arguments: { audioOutputDeviceId: "speaker-test" }
      })
    );
    assert.equal(settings.audioOutputDeviceId, "speaker-test");

    const trashed = parseToolJson(
      await client.callTool({
        name: "move_to_trash",
        arguments: { itemIds: ["mcp-item-1"] }
      })
    );
    assert.deepEqual(trashed.trashed, ["mcp-item-1"]);

    const trash = parseToolJson(await client.callTool({ name: "list_trash", arguments: {} }));
    assert.equal(trash.messages[0].id, "mcp-item-1");

    const restored = parseToolJson(
      await client.callTool({
        name: "restore_from_trash",
        arguments: { itemIds: ["mcp-item-1"] }
      })
    );
    assert.deepEqual(restored.restored, ["mcp-item-1"]);
  });
});
