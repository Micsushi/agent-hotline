const { parseHookInput, SOURCE_APPS } = require("./hook-input-parser");
const { filterSpeakableText } = require("./speakable-filter");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4777;
const REQUEST_TIMEOUT_MS = 750;

function getDefaultBaseUrl(env = process.env) {
  if (typeof env.AGENT_HOTLINE_URL === "string" && env.AGENT_HOTLINE_URL.trim()) {
    return trimTrailingSlash(env.AGENT_HOTLINE_URL.trim());
  }

  const port = env.AGENT_HOTLINE_PORT || env.VOICE_QUESTION_LOOP_PORT || DEFAULT_PORT;
  return `http://${DEFAULT_HOST}:${port}`;
}

async function readStdin(stream = process.stdin) {
  stream.setEncoding("utf8");

  let input = "";
  for await (const chunk of stream) {
    input += chunk;
  }

  return input;
}

async function runHookCommand(options = {}) {
  const input = typeof options.input === "string" ? options.input : await readStdin(options.stdin);
  const baseUrl = trimTrailingSlash(options.baseUrl || getDefaultBaseUrl(options.env));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    return recoverable("fetch_unavailable", "This Node runtime does not expose fetch.");
  }

  const parsed = parseHookInput(input);
  if (!parsed.ok) {
    return skipped(parsed.reason, parsed.message);
  }

  if (!isSupportedSource(parsed.sourceApp)) {
    return skipped("unsupported_source", "Hook source must be Codex or Claude.");
  }

  const filtered = filterSpeakableText(parsed.assistantText);
  if (!filtered.shouldSpeak) {
    return skipped(filtered.reason, "No speakable text after filtering.");
  }

  const settingsResult = await requestJson(fetchImpl, `${baseUrl}/api/settings`, {
    method: "GET",
    timeoutMs
  });
  if (!settingsResult.ok) {
    return recoverable(
      "backend_unavailable",
      "Agent Hotline backend is not available.",
      settingsResult.error
    );
  }

  const settings = settingsResult.body && settingsResult.body.settings;
  if (!isSourceEnabled(settings, parsed.sourceApp)) {
    return skipped("source_disabled", `${parsed.sourceApp} hook playback is disabled.`);
  }

  const enqueueResult = await requestJson(fetchImpl, `${baseUrl}/api/queue`, {
    method: "POST",
    timeoutMs,
    body: {
      rawSource: parsed.assistantText,
      speakableText: filtered.text,
      sourceApp: parsed.sourceApp
    }
  });
  if (!enqueueResult.ok) {
    return recoverable(
      "enqueue_failed",
      "Speakable text could not be queued.",
      enqueueResult.error
    );
  }

  return {
    ok: true,
    action: "enqueued",
    sourceApp: parsed.sourceApp,
    reason: filtered.reason,
    item: enqueueResult.body && enqueueResult.body.item
  };
}

async function requestJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const body = await readResponseJson(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body,
        error: responseError(response, body)
      };
    }

    return { ok: true, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error.name,
        message: error.message
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(response, body) {
  const apiError = body && body.error;
  if (apiError && typeof apiError.message === "string") {
    return {
      status: response.status,
      code: apiError.code,
      message: apiError.message
    };
  }

  return {
    status: response.status,
    message: `HTTP ${response.status}`
  };
}

function isSupportedSource(sourceApp) {
  return sourceApp === SOURCE_APPS.CODEX || sourceApp === SOURCE_APPS.CLAUDE;
}

function isSourceEnabled(settings, sourceApp) {
  if (!settings || typeof settings !== "object") {
    return true;
  }

  if (sourceApp === SOURCE_APPS.CODEX) {
    return settings.codexEnabled !== false;
  }

  if (sourceApp === SOURCE_APPS.CLAUDE) {
    return settings.claudeEnabled !== false;
  }

  return false;
}

function skipped(reason, message) {
  return {
    ok: true,
    action: "skipped",
    reason,
    message
  };
}

function recoverable(reason, message, error) {
  return {
    ok: true,
    action: "recoverable_failure",
    reason,
    message,
    ...(error ? { error } : {})
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function main(options = {}) {
  const env = options.env || process.env;
  const result = await runHookCommand({
    ...options,
    env
  });

  if (env.AGENT_HOTLINE_HOOK_DEBUG === "1" && result.action !== "enqueued") {
    const stderr = options.stderr || process.stderr;
    stderr.write(`agent-hotline-hook: ${result.action} ${result.reason}\n`);
  }

  return 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 0;
    });
}

module.exports = {
  getDefaultBaseUrl,
  isSourceEnabled,
  main,
  readStdin,
  requestJson,
  runHookCommand
};
