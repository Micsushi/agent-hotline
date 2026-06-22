const SOURCE_APPS = Object.freeze({
  CODEX: "Codex",
  CLAUDE: "Claude",
  UNKNOWN: "Unknown"
});

function parseHookInput(text) {
  if (typeof text !== "string") {
    return skipResult("invalid_input", "Hook input must be a string.");
  }

  // PowerShell 5.1 prepends a UTF-8 BOM when piping to node, which breaks
  // JSON.parse. Strip a leading BOM and surrounding whitespace defensively so
  // hook wrappers on any shell work.
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

    return {
      ok: true,
      action: "accept",
      sourceApp,
      assistantText: extracted.text,
      schema: extracted.schema,
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

  const eventName = lowerString(payload.event || payload.hook_event_name || payload.event_name);
  if (eventName.includes("codex")) {
    return SOURCE_APPS.CODEX;
  }
  if (eventName === "stop" || eventName.includes("claude")) {
    return SOURCE_APPS.CLAUDE;
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
