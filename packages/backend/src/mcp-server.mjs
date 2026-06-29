#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createAudioCacheStore } = require("./audio-cache-store.js");
const { createSettingsStore } = require("./settings-store.js");
const { createSpeechQueueStore } = require("./speech-queue-store.js");

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function sessionKeyOf(item) {
  return item.sessionKey || item.threadId || `app:${item.sourceApp}`;
}

function projectKeyOf(item) {
  if (!item.projectPath) return `direct:${item.sourceApp}`;
  return String(item.projectPath).replace(/[\\/]/g, "").toLowerCase();
}

function projectLabelOf(item) {
  if (!item.projectPath) return item.sourceApp || "Direct";
  const raw = item.projectName || item.projectPath || "";
  return (
    String(raw)
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ||
    item.sourceApp ||
    "Direct"
  );
}

function sessionLabelOf(item) {
  const id = item.threadId ? item.threadId.slice(0, 8) : "";
  if (item.sessionName && id) return `${item.sessionName} - ${id}`;
  if (item.sessionName) return item.sessionName;
  if (id) return id;
  return `${item.sourceApp} - direct`;
}

function visibleItems(queueStore) {
  return queueStore.getState().items.filter((item) => item.speakableText && !item.trashedAt);
}

function trashedItems(queueStore) {
  return queueStore.getState().items.filter((item) => item.speakableText && item.trashedAt);
}

function compactItem(item) {
  return {
    id: item.id,
    sourceApp: item.sourceApp,
    projectKey: projectKeyOf(item),
    projectName: projectLabelOf(item),
    sessionKey: sessionKeyOf(item),
    sessionName: sessionLabelOf(item),
    threadId: item.threadId || null,
    createdAt: item.timestamps?.createdAt || null,
    status: item.status,
    trashedAt: item.trashedAt || null,
    preview: String(item.speakableText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220)
  };
}

function groupItems(items) {
  const projects = new Map();
  for (const item of items) {
    const projectKey = projectKeyOf(item);
    if (!projects.has(projectKey)) {
      projects.set(projectKey, {
        key: projectKey,
        label: projectLabelOf(item),
        sessions: new Map(),
        itemCount: 0
      });
    }
    const project = projects.get(projectKey);
    project.itemCount += 1;
    const sessionKey = sessionKeyOf(item);
    if (!project.sessions.has(sessionKey)) {
      project.sessions.set(sessionKey, {
        key: sessionKey,
        label: sessionLabelOf(item),
        itemCount: 0,
        latestAt: ""
      });
    }
    const session = project.sessions.get(sessionKey);
    session.itemCount += 1;
    session.latestAt = item.timestamps?.createdAt || session.latestAt;
  }
  return [...projects.values()].map((project) => ({
    ...project,
    sessions: [...project.sessions.values()]
  }));
}

function normalize(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function searchItems(items, query) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return items
    .filter((item) => {
      const haystack = normalize(
        [
          item.id,
          item.threadId,
          item.threadLabel,
          item.sessionName,
          projectLabelOf(item),
          sessionLabelOf(item),
          item.speakableText,
          ...(Array.isArray(item.userMessages) ? item.userMessages : [])
        ].join(" ")
      );
      return terms.every((term) => haystack.includes(term));
    })
    .map(compactItem);
}

function queueTargetSchema() {
  return {
    itemIds: z.array(z.string()).optional(),
    projectKey: z.string().optional(),
    sessionKey: z.string().optional(),
    all: z.boolean().optional()
  };
}

function applyTarget(queueStore, args, mode) {
  if (Array.isArray(args.itemIds)) {
    return mode === "trash"
      ? queueStore.trashItems(args.itemIds)
      : queueStore.restoreItems(args.itemIds);
  }
  if (args.projectKey) {
    return mode === "trash"
      ? queueStore.trashByProject(args.projectKey)
      : queueStore.restoreByProject(args.projectKey);
  }
  if (args.sessionKey) {
    return mode === "trash"
      ? queueStore.trashBySession(args.sessionKey)
      : queueStore.restoreBySession(args.sessionKey);
  }
  if (args.all === true) {
    return mode === "trash" ? queueStore.trashAll() : queueStore.restoreAll();
  }
  throw new Error("Provide itemIds, projectKey, sessionKey, or all=true.");
}

function idsByProject(queueStore, projectKey) {
  return visibleItems(queueStore)
    .filter((item) => projectKeyOf(item) === projectKey)
    .map((item) => item.id);
}

function idsBySession(queueStore, sessionKey) {
  return visibleItems(queueStore)
    .filter((item) => sessionKeyOf(item) === sessionKey)
    .map((item) => item.id);
}

function registerAgentHotlineTools(server, { queueStore, settingsStore, audioCacheStore }) {
  server.registerTool(
    "get_state",
    {
      title: "Get Agent Hotline State",
      description: "Return settings plus compact visible and trashed chat counts."
    },
    async () =>
      textResult({
        settings: settingsStore.load(),
        visibleCount: visibleItems(queueStore).length,
        trashedCount: trashedItems(queueStore).length,
        pending: queueStore.getPending().map(compactItem),
        current: queueStore.getCurrent() ? compactItem(queueStore.getCurrent()) : null,
        latest: queueStore.getLatest() ? compactItem(queueStore.getLatest()) : null
      })
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: "List visible Agent Hotline projects and sessions."
    },
    async () => textResult(groupItems(visibleItems(queueStore)))
  );

  server.registerTool(
    "list_messages",
    {
      title: "List Messages",
      description: "List visible messages, optionally scoped to a project/session.",
      inputSchema: {
        projectKey: z.string().optional(),
        sessionKey: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async ({ projectKey, sessionKey, limit }) => {
      let items = visibleItems(queueStore);
      if (projectKey) items = items.filter((item) => projectKeyOf(item) === projectKey);
      if (sessionKey) items = items.filter((item) => sessionKeyOf(item) === sessionKey);
      return textResult(items.slice(-limit).map(compactItem));
    }
  );

  server.registerTool(
    "read_message",
    {
      title: "Read Message",
      description: "Read one full visible or trashed message by id.",
      inputSchema: { itemId: z.string() }
    },
    async ({ itemId }) => {
      const item = queueStore.getState().items.find((entry) => entry.id === itemId);
      if (!item) throw new Error(`Message not found: ${itemId}`);
      return textResult({
        ...compactItem(item),
        speakableText: item.speakableText,
        userMessages: item.userMessages || []
      });
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search Messages",
      description:
        "Search visible messages by keyword, project, session, id, prompt, or spoken text.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(25) }
    },
    async ({ query, limit }) =>
      textResult(searchItems(visibleItems(queueStore), query).slice(0, limit))
  );

  server.registerTool(
    "list_trash",
    {
      title: "List Trash",
      description: "List trashed Agent Hotline projects, sessions, and messages."
    },
    async () =>
      textResult({
        groups: groupItems(trashedItems(queueStore)),
        messages: trashedItems(queueStore).map(compactItem)
      })
  );

  server.registerTool(
    "move_to_trash",
    {
      title: "Move Chats To Trash",
      description: "Move messages/projects/sessions to trash and delete their saved audio.",
      inputSchema: queueTargetSchema()
    },
    async (args) => {
      const ids = applyTarget(queueStore, args, "trash");
      const removedAudio = audioCacheStore.removeByItemIds(ids);
      return textResult({ trashed: ids, removedAudio });
    }
  );

  server.registerTool(
    "restore_from_trash",
    {
      title: "Restore Chats From Trash",
      description: "Restore trashed messages/projects/sessions.",
      inputSchema: queueTargetSchema()
    },
    async (args) => textResult({ restored: applyTarget(queueStore, args, "restore") })
  );

  server.registerTool(
    "list_audio_cache",
    {
      title: "List Audio Cache",
      description: "List saved audio recordings."
    },
    async () => textResult(audioCacheStore.list())
  );

  server.registerTool(
    "delete_audio_cache",
    {
      title: "Delete Audio Cache",
      description: "Delete saved audio only, leaving chats visible.",
      inputSchema: {
        itemId: z.string().optional(),
        projectKey: z.string().optional(),
        sessionKey: z.string().optional(),
        all: z.boolean().optional()
      }
    },
    async ({ itemId, projectKey, sessionKey, all }) => {
      let removed;
      if (itemId) removed = audioCacheStore.removeOne(itemId);
      else if (projectKey)
        removed = audioCacheStore.removeByItemIds(idsByProject(queueStore, projectKey));
      else if (sessionKey)
        removed = audioCacheStore.removeByItemIds(idsBySession(queueStore, sessionKey));
      else if (all === true) removed = audioCacheStore.clearAll();
      else throw new Error("Provide itemId, projectKey, sessionKey, or all=true.");
      return textResult({ removed });
    }
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get Settings",
      description: "Read Agent Hotline settings."
    },
    async () => textResult(settingsStore.load())
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update Settings",
      description: "Update safe Agent Hotline settings.",
      inputSchema: {
        readBehavior: z.enum(["manual", "auto"]).optional(),
        mute: z.boolean().optional(),
        engine: z.enum(["webview", "kokoro"]).optional(),
        voice: z.string().optional(),
        audioOutputDeviceId: z.string().optional(),
        kokoroVoice: z.string().optional(),
        rate: z.number().min(0.1).max(10).optional(),
        volume: z.number().min(0).max(1).optional(),
        notifyOnNewReply: z.boolean().optional(),
        notificationOpens: z.enum(["full", "mini"]).optional(),
        highlightSpokenText: z.boolean().optional(),
        audioCacheLimitMb: z.number().min(10).max(100000).optional()
      }
    },
    async (args) => textResult(settingsStore.update(args))
  );
}

export async function createAgentHotlineMcpServer(options = {}) {
  const settingsStore = options.settingsStore || createSettingsStore({ dataDir: options.dataDir });
  const queueStore = options.queueStore || createSpeechQueueStore({ dataDir: options.dataDir });
  const audioCacheStore =
    options.audioCacheStore ||
    createAudioCacheStore({
      dataDir: options.dataDir,
      getMaxBytes: () => Number(settingsStore.load().audioCacheLimitMb) * 1024 * 1024
    });
  const server = new McpServer({ name: "agent-hotline", version: "0.1.0" });
  registerAgentHotlineTools(server, { queueStore, settingsStore, audioCacheStore });
  return server;
}

export async function runStdioServer() {
  const server = await createAgentHotlineMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
