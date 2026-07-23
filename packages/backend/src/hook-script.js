const WINDOWS = "win32";

function toPowerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toPosixSingleQuoted(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookNormalizerSource({ source, schema }) {
  const responseKey = schema === "response" ? "response" : "assistant_response";
  return `
const { spawnSync } = require("child_process");
const hookCommand = process.argv[1] || "";
let inputJson = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputJson += chunk;
});
process.stdin.on("end", () => {
  try {
    if (!inputJson.trim()) process.exit(0);
    const payload = JSON.parse(inputJson);
    const assistantText = payload.last_assistant_message;
    const transcriptPath = payload.transcript_path;
    const inputMessages =
      payload["input-messages"] || payload.input_messages || payload.inputMessages;
    if (
      (!assistantText || String(assistantText).trim() === "") &&
      (!transcriptPath || String(transcriptPath).trim() === "")
    ) {
      process.exit(0);
    }
    const normalized = {
      source: ${JSON.stringify(source)},
      hook_event_name: "Stop",
      ${JSON.stringify(responseKey)}: { text: assistantText },
      "input-messages": inputMessages,
      input_messages: payload.input_messages,
      inputMessages: payload.inputMessages,
      prompt: payload.prompt,
      user_prompt: payload.user_prompt,
      userPrompt: payload.userPrompt,
      user_message: payload.user_message,
      userMessage: payload.userMessage,
      last_user_message: payload.last_user_message,
      lastUserMessage: payload.lastUserMessage,
      input: payload.input,
      transcript_path: transcriptPath,
      session_id: payload.session_id,
      thread_id: payload.thread_id || payload.threadId || payload["thread-id"],
      thread_name: payload.thread_name,
      session_name: payload.session_name,
      cwd: payload.cwd,
      workspace: payload.workspace,
      project_dir: payload.project_dir
    };
    spawnSync(hookCommand, {
      input: JSON.stringify(normalized),
      shell: true,
      stdio: ["pipe", "ignore", "ignore"],
      encoding: "utf8"
    });
  } catch {
    process.exit(0);
  }
});
`;
}

function buildPs1({ source, schema, hookCommand }) {
  const responseKey = schema === "response" ? "response" : "assistant_response";
  return [
    `$ErrorActionPreference = "Stop"`,
    `$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false`,
    `[Console]::InputEncoding = $utf8NoBom`,
    `[Console]::OutputEncoding = $utf8NoBom`,
    `$OutputEncoding = $utf8NoBom`,
    ``,
    `try {`,
    `  $inputJson = [Console]::In.ReadToEnd()`,
    `  if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }`,
    ``,
    `  $payload = $inputJson | ConvertFrom-Json`,
    `  $assistantText = $payload.last_assistant_message`,
    `  $transcriptPath = $payload.transcript_path`,
    `  $inputMessages = $payload.'input-messages'`,
    `  if ($null -eq $inputMessages) { $inputMessages = $payload.input_messages }`,
    `  if ($null -eq $inputMessages) { $inputMessages = $payload.inputMessages }`,
    `  $threadId = $payload.thread_id`,
    `  if ($null -eq $threadId) { $threadId = $payload.threadId }`,
    `  if ($null -eq $threadId) { $threadId = $payload.'thread-id' }`,
    `  if ([string]::IsNullOrWhiteSpace($assistantText) -and [string]::IsNullOrWhiteSpace($transcriptPath)) { exit 0 }`,
    ``,
    `  $normalizedJson = @{`,
    `    source = "${source}"`,
    `    hook_event_name = "Stop"`,
    `    ${responseKey} = @{ text = $assistantText }`,
    `    "input-messages" = $inputMessages`,
    `    input_messages = $payload.input_messages`,
    `    inputMessages = $payload.inputMessages`,
    `    prompt = $payload.prompt`,
    `    user_prompt = $payload.user_prompt`,
    `    userPrompt = $payload.userPrompt`,
    `    user_message = $payload.user_message`,
    `    userMessage = $payload.userMessage`,
    `    last_user_message = $payload.last_user_message`,
    `    lastUserMessage = $payload.lastUserMessage`,
    `    input = $payload.input`,
    `    transcript_path = $transcriptPath`,
    `    session_id = $payload.session_id`,
    `    thread_id = $threadId`,
    `    thread_name = $payload.thread_name`,
    `    session_name = $payload.session_name`,
    `    cwd = $payload.cwd`,
    `    workspace = $payload.workspace`,
    `    project_dir = $payload.project_dir`,
    `  } | ConvertTo-Json -Depth 8`,
    ``,
    `  $hookCommand = $env:AGENT_HOTLINE_HOOK_CMD`,
    `  if ([string]::IsNullOrWhiteSpace($hookCommand)) {`,
    `    $hookCommand = ${toPowerShellSingleQuoted(hookCommand)}`,
    `  }`,
    ``,
    `  $normalizedJson | cmd.exe /d /s /c $hookCommand`,
    `} catch {`,
    `  exit 0`,
    `}`,
    ``,
    `exit 0`,
    ``
  ].join("\r\n");
}

function buildSh({ source, schema, hookCommand }) {
  const normalizer = hookNormalizerSource({ source, schema }).trim();
  return [
    "#!/bin/sh",
    `hook_command=\${AGENT_HOTLINE_HOOK_CMD:-${toPosixSingleQuoted(hookCommand)}}`,
    `node -e ${toPosixSingleQuoted(normalizer)} "$hook_command"`,
    "exit 0",
    ""
  ].join("\n");
}

function buildHookScript({ platform = process.platform, source, schema, hookCommand }) {
  if (platform === WINDOWS) return buildPs1({ source, schema, hookCommand });
  return buildSh({ source, schema, hookCommand });
}

function hookScriptExtension(platform = process.platform) {
  return platform === WINDOWS ? "ps1" : "sh";
}

module.exports = {
  buildHookScript,
  buildPs1,
  buildSh,
  hookScriptExtension,
  toPowerShellSingleQuoted,
  toPosixSingleQuoted
};
