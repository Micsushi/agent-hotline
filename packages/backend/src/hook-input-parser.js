const SOURCE_APPS = Object.freeze({
  CODEX: "Codex",
  CLAUDE: "Claude",
  ANTIGRAVITY: "Antigravity",
  UNKNOWN: "Unknown"
});

const MAX_CODEX_SESSION_FILES = 3000;

function parseHookInput(text, deps = {}) {
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
    let extracted = extractAssistantText(payload);

    // Claude Code's Stop hook carries no inline reply text, only transcript_path;
    // fall back to the last assistant turn in the transcript so its responses can
    // still be spoken.
    if (!extracted.text) {
      const fromTranscript = extractAssistantFromTranscript(payload);
      if (fromTranscript) extracted = { text: fromTranscript, schema: "transcript" };
    }

    if (!extracted.text) {
      return skipResult("missing_assistant_text", "No assistant response text was found.", {
        sourceApp,
        payload
      });
    }

    const thread = extractThread(payload, sourceApp, deps);
    const project = extractProject(payload, deps);

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
      userMessages: extractUserMessages(payload, deps, extracted.text),
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

function extractThread(payload, sourceApp, deps = {}) {
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

  const cwd = resolveCwd(payload, deps);
  const folder = cwd ? pathBasename(resolveProjectRoot(cwd, deps)) : "";
  const shortId = threadId ? threadId.slice(0, 8) : "";
  const labelParts = [folder || sourceApp];
  if (shortId) labelParts.push(shortId);
  const threadLabel = labelParts.filter(Boolean).join("  -  ") || undefined;

  return { threadId, threadLabel };
}

// Repo-root markers. The hook only reports the shell cwd, which drifts into
// subdirectories during a session (e.g. running a build from packages/desktop).
// Naively using the cwd basename then splinters one repo into several phantom
// "projects". Resolving up to the enclosing repo root keeps subdir work grouped
// under the real project.
const PROJECT_ROOT_MARKERS = [".git"];

function pathBasename(value) {
  return (
    String(value)
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || undefined
  );
}

function resolveProjectRoot(cwd, deps = {}) {
  const existsSync = deps.existsSync || require("fs").existsSync;
  const path = require("path");
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  if (!normalized) return normalized;

  let current = normalized;
  for (let depth = 0; depth < 64; depth += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      let hit = false;
      try {
        hit = existsSync(path.join(current, marker));
      } catch {
        hit = false;
      }
      if (hit) return current;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  // No marker found (path missing, or not under a repo): keep the cwd as-is.
  return normalized;
}

// Resolve the working directory used for project/session grouping. Order:
//   1. inline payload field (normal Codex/Claude CLI Stop hooks ship this)
//   2. the transcript's own per-line `cwd` (Claude Code writes the real cwd on
//      every JSONL entry, so SDK/editor-extension hooks that omit the top-level
//      cwd can still be grouped -- and because this is the exact path, it merges
//      with that project's CLI items instead of spawning a separate bucket)
//   3. the encoded ".../projects/<dir>/<sid>.jsonl" segment as a last-resort
//      stable identity when the transcript can't be read.
// Returning "" here is what makes grouping.js fall back to `direct:<sourceApp>`
// (the "Claude" catch-all bucket), so we exhaust every signal before that.
function resolveCwd(payload, deps = {}) {
  const direct = firstString(payload.cwd, payload.workspace, payload.project_dir);
  if (direct) return direct;
  const fromTranscript = cwdFromTranscript(payload, deps);
  if (fromTranscript) return fromTranscript;
  return projectDirFromTranscriptPath(payload);
}

function cwdFromTranscript(payload, deps = {}) {
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  if (!transcriptPath) return "";
  const readFileSync = deps.readFileSync || require("fs").readFileSync;
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const cwd = firstString(obj.cwd, obj.workspace);
      if (cwd) return cwd;
    } catch {
      // Skip non-JSON lines; keep scanning for the first entry that carries cwd.
    }
  }
  return "";
}

// Claude Code stores transcripts at "<home>/.claude/projects/<encoded>/<sid>.jsonl"
// where <encoded> is the cwd with separators/colon replaced by '-'. The encoding
// is lossy (a literal '-' in a folder name is indistinguishable from a separator),
// so we can't reconstruct the exact path -- but the encoded segment is stable, so
// using it verbatim still groups every item from that project together under one
// bucket instead of scattering into the generic harness catch-all.
function projectDirFromTranscriptPath(payload) {
  const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
  if (!transcriptPath) return "";
  const normalized = String(transcriptPath).replace(/\\/g, "/");
  const match = normalized.match(/\/projects\/([^/]+)\/[^/]*$/i);
  return match ? match[1] : "";
}

function extractProject(payload, deps = {}) {
  if (!isPlainObject(payload)) {
    return { projectPath: undefined, projectName: undefined };
  }
  const cwd = resolveCwd(payload, deps);
  if (!cwd) {
    return { projectPath: undefined, projectName: undefined };
  }
  const root = resolveProjectRoot(cwd, deps);
  return { projectPath: root, projectName: pathBasename(root) };
}

function extractSessionName(payload) {
  if (!isPlainObject(payload)) return undefined;
  return firstString(payload.sessionName, payload.session_name, payload.thread_name) || undefined;
}

// User-side prompt text, captured for display only (never spoken). Codex hands us
// the prompts inline as "input-messages"; Claude's Stop hook only points at a
// transcript file, so we read the trailing run of user turns from it. Best-effort:
// any failure yields [] so a missing/locked transcript never blocks playback.
function extractUserMessages(payload, deps = {}, assistantText = "") {
  try {
    if (!isPlainObject(payload)) return [];

    const inline = payload["input-messages"] || payload.input_messages || payload.inputMessages;
    if (Array.isArray(inline)) {
      const out = inline
        .map((entry) => (typeof entry === "string" ? entry.trim() : extractTextFromValue(entry)))
        .filter(Boolean);
      if (out.length) return out;
    }

    const prompt = firstString(
      payload.prompt,
      payload.user_prompt,
      payload.userPrompt,
      payload.user_message,
      payload.userMessage,
      payload.last_user_message,
      payload.lastUserMessage,
      payload.input
    );
    if (prompt) return [prompt];

    const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
    if (transcriptPath) {
      return readUserMessagesFromTranscript(transcriptPath, deps);
    }

    if (detectSourceApp(payload) === SOURCE_APPS.CODEX) {
      return readUserMessagesFromCodexSession(payload, assistantText, deps);
    }

    return [];
  } catch {
    return [];
  }
}

function readUserMessagesFromCodexSession(payload, assistantText, deps = {}) {
  const threadId = firstString(
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
    payload.thread_id,
    payload.threadId
  );
  if (!threadId) return [];

  const filePath = findCodexSessionFile(threadId, deps);
  if (!filePath) return [];

  const readFileSync = deps.readFileSync || require("fs").readFileSync;
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const turns = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = codexMessageTurn(obj);
    if (turn) turns.push(turn);
  }

  const assistantIndex = findAssistantTurnIndex(turns, assistantText);
  if (assistantIndex <= 0) return [];

  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (turns[i].role === "user" && turns[i].text) return [turns[i].text];
  }
  return [];
}

function findAssistantTurnIndex(turns, assistantText) {
  const target = normalizeForMatch(assistantText);
  if (target) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].role !== "assistant") continue;
      const candidate = normalizeForMatch(turns[i].text);
      if (candidate === target || candidate.includes(target) || target.includes(candidate)) {
        return i;
      }
    }
  }
  return turns.map((turn) => turn.role).lastIndexOf("assistant");
}

function codexMessageTurn(obj) {
  if (!isPlainObject(obj) || obj.type !== "response_item" || !isPlainObject(obj.payload)) {
    return null;
  }
  const payload = obj.payload;
  if (payload.type !== "message" || !["user", "assistant"].includes(payload.role)) return null;
  const text = extractCodexMessageText(payload.content);
  return text ? { role: payload.role, text } : null;
}

function extractCodexMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part.trim());
      continue;
    }
    if (!isPlainObject(part)) continue;
    if (typeof part.text === "string") parts.push(part.text.trim());
    if (typeof part.output_text === "string") parts.push(part.output_text.trim());
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function findCodexSessionFile(threadId, deps = {}) {
  if (deps.codexSessionFile) return deps.codexSessionFile;

  const fs = deps.fs || require("fs");
  const path = deps.path || require("path");
  const roots = [];
  if (deps.codexSessionsDir) roots.push(deps.codexSessionsDir);
  const codexHome =
    deps.codexHome ||
    process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || require("os").homedir(), ".codex");
  roots.push(path.join(codexHome, "sessions"));

  for (const root of roots) {
    let found = "";
    let seen = 0;
    const visit = (dir) => {
      if (found || seen > MAX_CODEX_SESSION_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found || seen > MAX_CODEX_SESSION_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.isFile()) {
          seen += 1;
          if (entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
            found = full;
            return;
          }
        }
      }
    };
    visit(root);
    if (found) return found;
  }
  return "";
}

function readUserMessagesFromTranscript(transcriptPath, deps = {}) {
  const readFileSync = deps.readFileSync || require("fs").readFileSync;
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  // Reduce the transcript to meaningful events, collapsing tool roundtrips: a
  // tool_result-only user entry yields no text (skipped), and tool-use assistant
  // blocks carry no prose. A real turn looks like one human prompt followed by the
  // assistant working (often several prose + tool entries) before its final reply.
  const seq = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const role = obj.type || (isPlainObject(obj.message) ? obj.message.role : undefined);
    if (role === "assistant") {
      seq.push({ role: "assistant" });
    } else if (role === "user") {
      if (obj.isMeta || obj.isVisibleInTranscript === false) continue;
      const text = extractUserTextFromTranscriptEntry(obj);
      if (text) seq.push({ role: "user", text });
    }
  }

  // Skip every trailing assistant entry (the just-finished reply plus any
  // intermediate prose/tool turns), then take the contiguous run of real user
  // prompts that started this turn. Using the whole trailing assistant block --
  // not just the last entry -- keeps the prompt attached even when the assistant
  // wrote prose or ran tools mid-turn.
  let i = seq.length - 1;
  while (i >= 0 && seq[i].role === "assistant") i -= 1;
  const out = [];
  for (; i >= 0; i -= 1) {
    if (seq[i].role !== "user") break;
    out.unshift(seq[i].text);
  }
  return out;
}

// Pull the most recent assistant reply text out of a Claude Code transcript
// (JSONL). The Stop hook fires right after the turn is written, so the last
// assistant entry with text is the reply we want to speak. Tool-use/result blocks
// are ignored; only the prose is kept. Best-effort: any failure yields "".
function extractAssistantFromTranscript(payload, deps = {}) {
  try {
    if (!isPlainObject(payload)) return "";
    const transcriptPath = firstString(payload.transcript_path, payload.transcriptPath);
    if (!transcriptPath) return "";

    const readFileSync = deps.readFileSync || require("fs").readFileSync;
    let raw;
    try {
      raw = readFileSync(transcriptPath, "utf8");
    } catch {
      return "";
    }

    let lastText = "";
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const role = obj.type || (isPlainObject(obj.message) ? obj.message.role : undefined);
      if (role !== "assistant") continue;
      const message = isPlainObject(obj.message) ? obj.message : obj;
      const text = extractAssistantTextFromTranscriptEntry(message.content);
      if (text) lastText = text;
    }
    return lastText;
  } catch {
    return "";
  }
}

function extractAssistantTextFromTranscriptEntry(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part.trim());
      continue;
    }
    if (!isPlainObject(part)) continue;
    if (part.type === "tool_use" || part.type === "tool_result" || part.type === "thinking")
      continue;
    if (typeof part.text === "string") parts.push(part.text.trim());
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function extractUserTextFromTranscriptEntry(obj) {
  const message = isPlainObject(obj.message) ? obj.message : obj;
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part.trim());
      continue;
    }
    if (!isPlainObject(part)) continue;
    if (part.type === "tool_result") continue;
    if (typeof part.text === "string") parts.push(part.text.trim());
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function normalizeForMatch(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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
  extractAssistantFromTranscript,
  extractUserMessages,
  resolveProjectRoot,
  parseHookInput
};
