const SOURCE_APPS = Object.freeze({
  CODEX: "Codex",
  CLAUDE: "Claude",
  ANTIGRAVITY: "Antigravity",
  UNKNOWN: "Unknown"
});

function parseHookInput(text) {
  if (typeof text !== "string") {
    return skipResult("invalid_input", "Hook input must be a string.");
  }

  const cleaned = text.replace(/^\uFEFF/, "").trim();

  let payload;
  try {
    payload = JSON.parse(cleaned);
  } catch (error) {
    return skipResult("malformed_json", "Hook input is not valid JSON.", {
      error: error.message
    });
  }

  try {
    const sourceApp = detectSourceApp(payload);
    const extracted = extractAssistantText(payload);

    if (!extracted.text) {
      return skipResult("missing_assistant_text", "No assistant response text was found.", {
        sourceApp,
        payload
      });
    }

    const thread = extractThread(payload, sourceApp);
    const project = extractProject(payload);

    return {
      ok: true,
      action: "accept",
      sourceApp,
      assistantText: extracted.text,
      schema: extracted.schema,
      threadId: thread.threadId,
      threadLabel: thread.threadLabel,
      sessionName: extractSessionName(payload),
      projectPath: project.projectPath,
      projectName: project.projectName,
      payload
    };
  } catch (error) {
    return skipResult("parser_error", "Hook input could not be normalized.", {
      error: error.message,
      sourceApp: detectSourceApp(payload),
      payload
    });
  }
}

function extractThread(payload, sourceApp) {
  if (!isPlainObject(payload)) {
    return { threadId: undefined, threadLabel: undefined };
  }

  const threadId =
    firstString(
      payload.session_id,
      payload.sessionId,
      payload.conversation_id,
      payload.conversationId,
      payload.thread_id,
      payload.threadId
    ) || undefined;

  const cwd = firstString(payload.cwd, payload.workspace, payload.project_dir);
  const folder = cwd
    ? cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop()
    : "";
  const shortId = threadId ? threadId.slice(0, 8) : "";
  const labelParts = [folder || sourceApp];
  if (shortId) labelParts.push(shortId);
  const threadLabel = labelParts.filter(Boolean).join("  -  ") || undefined;

  return { threadId, threadLabel };
}

function extractProject(payload) {
  if (!isPlainObject(payload)) {
    return { projectPath: undefined, projectName: undefined };
  }
  const cwd = firstString(payload.cwd, payload.workspace, payload.project_dir);
  if (!cwd) {
    return { projectPath: undefined, projectName: undefined };
  }
  const projectName =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || undefined;
  return { projectPath: cwd, projectName };
}

function extractSessionName(payload) {
  if (!isPlainObject(payload)) return undefined;
  return firstString(payload.sessionName, payload.session_name, payload.thread_name) || undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function detectSourceApp(payload) {
  if (!isPlainObject(payload)) {
    return SOURCE_APPS.UNKNOWN;
  }

  const source = lowerString(
    payload.source || payload.source_app || payload.app || payload.provider
  );
  if (source.includes("codex")) {
    return SOURCE_APPS.CODEX;
  }
  if (source.includes("claude")) {
    return SOURCE_APPS.CLAUDE;
  }
  if (source.includes("antigravity")) {
    return SOURCE_APPS.ANTIGRAVITY;
  }

  const eventName = lowerString(payload.event || payload.hook_event_name || payload.event_name);
  if (eventName.includes("codex")) {
    return SOURCE_APPS.CODEX;
  }
  if (eventName === "stop" || eventName.includes("claude")) {
    return SOURCE_APPS.CLAUDE;
  }
  if (eventName.includes("antigravity")) {
    return SOURCE_APPS.ANTIGRAVITY;
  }

  if (isPlainObject(payload.assistant_response)) {
    return SOURCE_APPS.CLAUDE;
  }
  if (isPlainObject(payload.response)) {
    return SOURCE_APPS.CODEX;
  }

  return SOURCE_APPS.UNKNOWN;
}

function extractAssistantText(payload) {
  const candidates = [
    ["response", payload && payload.response],
    ["assistant_response", payload && payload.assistant_response],
    ["message", payload && payload.message],
    ["assistant", payload && payload.assistant],
    ["result", payload && payload.result]
  ];

  for (const [schema, value] of candidates) {
    const text = extractTextFromValue(value);
    if (text) {
      return { text, schema };
    }
  }

  const directText = extractTextFromValue(payload);
  return directText ? { text: directText, schema: "root" } : { text: "", schema: "unknown" };
}

function extractTextFromValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return joinText(value.map(extractTextFromValue));
  }

  if (!isPlainObject(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text.trim();
  }

  if (typeof value.output_text === "string") {
    return value.output_text.trim();
  }

  if (typeof value.content === "string") {
    return value.content.trim();
  }

  if (Array.isArray(value.content)) {
    return joinText(value.content.map(extractTextFromContentPart));
  }

  if (Array.isArray(value.output)) {
    return joinText(value.output.map(extractTextFromValue));
  }

  return "";
}

function extractTextFromContentPart(part) {
  if (typeof part === "string") {
    return part.trim();
  }

  if (!isPlainObject(part)) {
    return "";
  }

  if (typeof part.text === "string") {
    return part.text.trim();
  }

  if (typeof part.output_text === "string") {
    return part.output_text.trim();
  }

  if (Array.isArray(part.content)) {
    return joinText(part.content.map(extractTextFromContentPart));
  }

  return "";
}

function joinText(parts) {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function skipResult(reason, message, extra = {}) {
  return {
    ok: false,
    action: "skip",
    sourceApp: extra.sourceApp || SOURCE_APPS.UNKNOWN,
    assistantText: "",
    reason,
    message,
    ...extra
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lowerString(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

module.exports = {
  SOURCE_APPS,
  detectSourceApp,
  extractAssistantText,
  parseHookInput
};
