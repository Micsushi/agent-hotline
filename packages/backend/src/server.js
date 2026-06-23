const http = require("http");
const fs = require("fs");
const path = require("path");

const { READ_BEHAVIORS, TTS_ENGINES, createSettingsStore } = require("./settings-store");
const { createSpeechQueueStore } = require("./speech-queue-store");
const { createSpoolStore } = require("./spool-store");

const PORT = Number(process.env.AGENT_HOTLINE_PORT || process.env.VOICE_QUESTION_LOOP_PORT || 4777);
const HOST = "127.0.0.1";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const QUESTIONS_FILE = process.env.QUESTION_FILE || path.join(DATA_DIR, "questions.json");
const REQUEST_LIMIT_BYTES = 1_000_000;
const ALLOWED_CORS_METHODS = "GET, POST, PATCH, PUT, OPTIONS";
const ALLOWED_CORS_HEADERS = "Content-Type";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function markdownEscape(value) {
  return String(value || "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function createQuestionStore(options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const questionsFile =
    options.questionsFile || process.env.QUESTION_FILE || path.join(dataDir, "questions.json");
  const answersFile = options.answersFile || path.join(dataDir, "answers.json");

  if (options.ensureFiles !== false && !fs.existsSync(questionsFile)) {
    writeJson(questionsFile, []);
  }

  function loadQuestions() {
    const questions = readJson(questionsFile, []);
    return Array.isArray(questions) ? questions : [];
  }

  function loadAnswers() {
    const answers = readJson(answersFile, []);
    return Array.isArray(answers) ? answers : [];
  }

  function nextQuestion() {
    const questions = loadQuestions();
    const answered = new Set(loadAnswers().map((answer) => answer.question_id));
    return questions.find((question) => !answered.has(question.id)) || null;
  }

  function saveAnswer(input) {
    if (!input.question_id || !input.answer_text) {
      throw createHttpError(400, "invalid_request", "question_id and answer_text are required");
    }

    const question = loadQuestions().find((candidate) => candidate.id === input.question_id);
    if (!question) {
      throw createHttpError(404, "not_found", "question_id does not match a queued question");
    }

    const answers = loadAnswers();
    const existingIndex = answers.findIndex((answer) => answer.question_id === input.question_id);
    const nextAnswer = {
      question_id: input.question_id,
      answer_text: input.answer_text,
      source: input.source || "typed",
      timestamp: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      answers[existingIndex] = nextAnswer;
    } else {
      answers.push(nextAnswer);
    }

    writeJson(answersFile, answers);
  }

  function exportMarkdown() {
    const questions = loadQuestions();
    const answersByQuestion = new Map(loadAnswers().map((answer) => [answer.question_id, answer]));
    const lines = [
      "# Agent Hotline Decisions",
      "",
      `Exported: ${new Date().toISOString()}`,
      "",
      "| Stage | Question | Recommendation | Answer | Source | Timestamp |",
      "| --- | --- | --- | --- | --- | --- |"
    ];

    for (const question of questions) {
      const answer = answersByQuestion.get(question.id) || {};
      lines.push(
        [
          markdownEscape(question.stage),
          markdownEscape(question.question),
          markdownEscape(question.recommendation),
          markdownEscape(answer.answer_text),
          markdownEscape(answer.source),
          markdownEscape(answer.timestamp)
        ]
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |")
      );
    }

    return `${lines.join("\n")}\n`;
  }

  return {
    answersFile,
    questionsFile,
    loadQuestions,
    loadAnswers,
    nextQuestion,
    saveAnswer,
    exportMarkdown
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isAllowedLocalOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;

  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:", "tauri:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "::1", "tauri.localhost"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedLocalOrigin(origin)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_CORS_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_CORS_HEADERS);
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function sendCorsPreflight(req, res) {
  if (!applyCors(req, res)) {
    sendError(res, createHttpError(403, "forbidden_origin", "CORS origin is not allowed"));
    return;
  }

  res.writeHead(204, { "Content-Length": "0" });
  res.end();
}

function createHttpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function sendError(res, error) {
  const status = error.status || 500;
  sendJson(res, status, {
    error: {
      code: error.code || "internal_error",
      message: status >= 500 ? "Internal server error" : error.message,
      ...(error.details ? { details: error.details } : {})
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > REQUEST_LIMIT_BYTES) {
        reject(createHttpError(413, "body_too_large", "Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw createHttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function requirePlainObject(value, message = "Request body must be a JSON object") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createHttpError(400, "invalid_request", message);
  }
}

function validateSettingsPatch(patch) {
  requirePlainObject(patch, "Settings update must be a JSON object");
  const allowed = new Set([
    "readBehavior",
    "mute",
    "engine",
    "voice",
    "kokoroVoice",
    "rate",
    "volume",
    "skipRules",
    "codexEnabled",
    "claudeEnabled"
  ]);
  const allowedSkipRules = new Set([
    "codeBlocks",
    "diffs",
    "logs",
    "tables",
    "json",
    "longBulletLists"
  ]);
  const errors = [];

  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) errors.push(`${key} is not a supported setting`);
  }

  if ("readBehavior" in patch && !READ_BEHAVIORS.includes(patch.readBehavior)) {
    errors.push("readBehavior must be manual, auto, or ask_every_time");
  }
  if ("mute" in patch && typeof patch.mute !== "boolean") errors.push("mute must be boolean");
  if ("engine" in patch && !TTS_ENGINES.includes(patch.engine)) {
    errors.push("engine must be webview or kokoro");
  }
  if ("voice" in patch && typeof patch.voice !== "string") errors.push("voice must be string");
  if ("kokoroVoice" in patch && typeof patch.kokoroVoice !== "string") {
    errors.push("kokoroVoice must be string");
  }
  if ("rate" in patch && (!Number.isFinite(patch.rate) || patch.rate < 0.1 || patch.rate > 10)) {
    errors.push("rate must be a number from 0.1 to 10");
  }
  if (
    "volume" in patch &&
    (!Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 1)
  ) {
    errors.push("volume must be a number from 0 to 1");
  }
  if ("codexEnabled" in patch && typeof patch.codexEnabled !== "boolean") {
    errors.push("codexEnabled must be boolean");
  }
  if ("claudeEnabled" in patch && typeof patch.claudeEnabled !== "boolean") {
    errors.push("claudeEnabled must be boolean");
  }
  if ("skipRules" in patch) {
    if (!patch.skipRules || typeof patch.skipRules !== "object" || Array.isArray(patch.skipRules)) {
      errors.push("skipRules must be an object");
    } else {
      for (const key of Object.keys(patch.skipRules)) {
        if (!allowedSkipRules.has(key)) errors.push(`skipRules.${key} is not supported`);
        if (typeof patch.skipRules[key] !== "boolean")
          errors.push(`skipRules.${key} must be boolean`);
      }
    }
  }

  if (errors.length > 0) {
    throw createHttpError(400, "invalid_settings", "Settings update is invalid", errors);
  }
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw createHttpError(400, "invalid_request", `${fieldName} must be a non-empty string`);
  }
}

function queueState(queueStore) {
  const state = queueStore.getState();
  return {
    ...state,
    pending: queueStore.getPending(),
    current: queueStore.getCurrent(),
    latest: queueStore.getLatest()
  };
}

function getPathname(req) {
  return new URL(req.url, "http://127.0.0.1").pathname;
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Hotline</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, Segoe UI, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #eef2f4; }
    main { width: min(860px, calc(100vw - 32px)); }
    .panel { border: 1px solid #2b343c; border-radius: 8px; padding: 24px; background: #171d22; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
    .stage { color: #8fb7ff; font-size: 14px; margin-bottom: 16px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 16px; letter-spacing: 0; }
    .rec { color: #c7d0d8; border-left: 3px solid #58c48d; padding-left: 12px; margin: 18px 0; }
    textarea { width: 100%; min-height: 130px; box-sizing: border-box; border-radius: 6px; border: 1px solid #34404a; background: #0f1418; color: #eef2f4; padding: 12px; font: inherit; resize: vertical; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; align-items: center; }
    button { border: 1px solid #34404a; background: #202a31; color: #eef2f4; border-radius: 6px; padding: 10px 14px; cursor: pointer; font: inherit; }
    button.primary { background: #2e7d5b; border-color: #39a36f; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    a { color: #9fc4ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { color: #9ba8b2; font-size: 13px; margin-top: 16px; }
    .done { color: #8ee6b0; }
  </style>
</head>
<body>
  <main class="panel">
    <div id="stage" class="stage"></div>
    <h1 id="question">Loading...</h1>
    <div id="recommendation" class="rec"></div>
    <textarea id="answer" placeholder="Answer here, or use voice if your browser supports it."></textarea>
    <div class="row">
      <button id="speak">Read aloud</button>
      <button id="voice">Voice answer</button>
      <button id="save" class="primary">Save answer</button>
      <button id="refresh">Next question</button>
      <a href="/api/export.md" target="_blank" rel="noreferrer">Export Markdown</a>
      <a href="/api/export" target="_blank" rel="noreferrer">Export JSON</a>
    </div>
    <div id="meta" class="meta"></div>
  </main>
  <script>
    let current = null;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    async function load() {
      const res = await fetch("/api/next");
      const data = await res.json();
      current = data.question;
      document.getElementById("answer").value = "";
      if (!current) {
        document.getElementById("stage").textContent = "";
        document.getElementById("question").textContent = "All questions answered.";
        document.getElementById("question").className = "done";
        document.getElementById("recommendation").textContent = "";
        document.getElementById("meta").textContent = data.total + " total questions, " + data.answered + " answered.";
        return;
      }
      document.getElementById("stage").textContent = current.stage || "";
      document.getElementById("question").textContent = current.question;
      document.getElementById("recommendation").textContent = current.recommendation ? "Recommendation: " + current.recommendation : "";
      document.getElementById("meta").textContent = data.answered + " answered of " + data.total + ". Current id: " + current.id;
    }

    function speak() {
      if (!current || !window.speechSynthesis) return;
      const text = [current.stage, current.question, current.recommendation ? "Recommendation: " + current.recommendation : ""].filter(Boolean).join(". ");
      const utterance = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }

    function voice() {
      if (!SpeechRecognition) {
        alert("This browser does not expose speech recognition. Typed answers still work.");
        return;
      }
      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onresult = (event) => {
        const text = Array.from(event.results).map((result) => result[0].transcript).join(" ");
        document.getElementById("answer").value = text;
      };
      recognition.start();
    }

    async function save() {
      if (!current) return;
      const answer = document.getElementById("answer").value.trim();
      if (!answer) return;
      await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: current.id, answer_text: answer, source: "browser" })
      });
      await load();
    }

    document.getElementById("speak").addEventListener("click", speak);
    document.getElementById("voice").addEventListener("click", voice);
    document.getElementById("save").addEventListener("click", save);
    document.getElementById("refresh").addEventListener("click", load);
    load();
  </script>
</body>
</html>`;
}

function createServer(options = {}) {
  const settingsStore =
    options.settingsStore ||
    createSettingsStore({
      dataDir: options.dataDir,
      settingsPath: options.settingsPath
    });
  const queueStore =
    options.queueStore ||
    createSpeechQueueStore({
      dataDir: options.dataDir,
      filePath: options.queuePath
    });
  const questionStore =
    options.questionStore ||
    createQuestionStore({
      dataDir: options.questionDataDir || options.dataDir,
      questionsFile: options.questionsFile,
      answersFile: options.answersFile,
      ensureFiles: options.ensureQuestionFiles
    });

  // Drain any messages the hook buffered offline while the backend was down,
  // in order, into the live queue.
  const spoolStore =
    options.spoolStore ||
    createSpoolStore({ dataDir: options.dataDir, filePath: options.spoolPath });
  try {
    spoolStore.drain((item) => queueStore.enqueue(item));
  } catch {
    // A broken spool must never stop the server from starting.
  }

  return http.createServer(async (req, res) => {
    try {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        sendCorsPreflight(req, res);
        return;
      }

      const pathname = getPathname(req);

      if (req.method === "GET" && pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page());
        return;
      }

      if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
        sendJson(res, 200, { ok: true, service: "agent-hotline", host: HOST });
        return;
      }

      if (req.method === "GET" && pathname === "/api/settings") {
        sendJson(res, 200, { settings: settingsStore.load() });
        return;
      }

      if ((req.method === "PATCH" || req.method === "PUT") && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        validateSettingsPatch(body);
        sendJson(res, 200, { settings: settingsStore.update(body) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/mute") {
        sendJson(res, 200, { settings: settingsStore.update({ mute: true }) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/unmute") {
        sendJson(res, 200, { settings: settingsStore.update({ mute: false }) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/queue") {
        sendJson(res, 200, { queue: queueState(queueStore) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/queue") {
        const body = await readJsonBody(req);
        requirePlainObject(body);
        requireString(body.rawSource, "rawSource");
        requireString(body.speakableText, "speakableText");
        requireString(body.sourceApp, "sourceApp");
        const item = queueStore.enqueue({
          id: body.id,
          rawSource: body.rawSource,
          speakableText: body.speakableText,
          sourceApp: body.sourceApp,
          threadId: body.threadId,
          threadLabel: body.threadLabel
        });
        sendJson(res, 201, { item, queue: queueState(queueStore) });
        return;
      }

      const playingMatch = pathname.match(/^\/api\/queue\/([^/]+)\/playing$/);
      if (req.method === "POST" && playingMatch) {
        const item = queueStore.markPlaying(decodeURIComponent(playingMatch[1]));
        sendJson(res, 200, { item, queue: queueState(queueStore) });
        return;
      }

      const playedMatch = pathname.match(/^\/api\/queue\/([^/]+)\/played$/);
      if (req.method === "POST" && playedMatch) {
        const item = queueStore.markPlayed(decodeURIComponent(playedMatch[1]));
        sendJson(res, 200, { item, queue: queueState(queueStore) });
        return;
      }

      const skippedMatch = pathname.match(/^\/api\/queue\/([^/]+)\/skipped$/);
      if (req.method === "POST" && skippedMatch) {
        const body = await readJsonBody(req);
        requirePlainObject(body);
        requireString(body.reason, "reason");
        const item = queueStore.markSkipped(decodeURIComponent(skippedMatch[1]), body.reason);
        sendJson(res, 200, { item, queue: queueState(queueStore) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/queue/replay-latest") {
        const item = queueStore.replayLatest();
        if (!item) {
          throw createHttpError(404, "not_found", "No replayable queue item exists");
        }
        sendJson(res, 201, { item, queue: queueState(queueStore) });
        return;
      }

      const replayMatch = pathname.match(/^\/api\/queue\/([^/]+)\/replay$/);
      if (req.method === "POST" && replayMatch) {
        const item = queueStore.replayItem(decodeURIComponent(replayMatch[1]));
        if (!item) {
          throw createHttpError(404, "not_found", "Queue item cannot be replayed");
        }
        sendJson(res, 201, { item, queue: queueState(queueStore) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/next") {
        const questions = questionStore.loadQuestions();
        const answers = questionStore.loadAnswers();
        sendJson(res, 200, {
          question: questionStore.nextQuestion(),
          total: questions.length,
          answered: answers.length
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/export") {
        sendJson(res, 200, {
          questions: questionStore.loadQuestions(),
          answers: questionStore.loadAnswers()
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/export.md") {
        sendText(res, 200, questionStore.exportMarkdown(), "text/markdown; charset=utf-8");
        return;
      }

      if (req.method === "POST" && pathname === "/api/answer") {
        questionStore.saveAnswer(await readJsonBody(req));
        sendJson(res, 200, { ok: true });
        return;
      }

      throw createHttpError(404, "not_found", "Not found");
    } catch (error) {
      if (!error.status && /Queue item not found/.test(error.message)) {
        sendError(res, createHttpError(404, "not_found", error.message));
        return;
      }
      if (!error.status && /(must be|already exists)/.test(error.message)) {
        sendError(res, createHttpError(400, "invalid_request", error.message));
        return;
      }
      sendError(res, error);
    }
  });
}

function listen(options = {}) {
  const port = Number(options.port || PORT);
  const server = createServer(options);
  server.listen(port, HOST, () => {
    console.log(`Agent Hotline listening on http://${HOST}:${port}`);
    console.log(`Question file: ${options.questionsFile || QUESTIONS_FILE}`);
  });
  return server;
}

if (require.main === module) {
  listen();
}

module.exports = {
  HOST,
  PORT,
  createServer,
  listen
};
