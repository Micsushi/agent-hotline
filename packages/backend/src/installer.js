const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "agent-hotline-spoken";
const MANAGED_BLOCK_START = "<!-- AGENT_HOTLINE_SPOKEN_START -->";
const MANAGED_BLOCK_END = "<!-- AGENT_HOTLINE_SPOKEN_END -->";
const VALID_HARNESSES = ["antigravity", "claude-code", "codex", "all"];
const VALID_SCOPES = ["global", "repo"];
const NPX_PACKAGE_NAME = "@micsushi/agent-hotline";
const NPX_HOOK_COMMAND = `npx --yes ${NPX_PACKAGE_NAME} hook`;

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function repoRoot() {
  return path.resolve(packageRoot(), "..", "..");
}

function defaultHome() {
  return os.homedir();
}

function defaultHookCommand() {
  return `node "${path.join(packageRoot(), "bin", "agent-hotline.js")}" hook`;
}

function npxHookCommand() {
  return NPX_HOOK_COMMAND;
}

// Embed an arbitrary string into the generated .ps1 as a PowerShell single-quoted
// literal. Single quotes take their contents verbatim -- no backslash or
// double-quote processing -- so the only escaping needed is doubling embedded
// single quotes. This is the ONLY supported way to inline a value into the ps1.
// Never use JSON.stringify() for this: its \" and \\ escapes are JSON syntax, not
// PowerShell (which escapes with backticks), so a Windows command like
// `node "C:\path\x.js" hook` becomes `"node \"C:\\path\\x.js\" hook"`, which
// PowerShell fails to PARSE -- the script dies before its try/catch and never
// runs. That class of bug is impossible once everything routes through here.
function toPowerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function skillSourcePath() {
  return path.join(packageRoot(), "skills", SKILL_NAME, "SKILL.md");
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFile(filePath));
  } catch {
    return null;
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function normalizeHarness(value) {
  const key = String(value || "").toLowerCase();
  if (key === "claude") return "claude-code";
  if (key === "all") return "all";
  return key;
}

function validateChoice(name, value, validValues) {
  if (!validValues.includes(value)) {
    throw new Error(`Invalid ${name} "${value}". Use one of: ${validValues.join(", ")}.`);
  }
}

function harnessDefinitions(home = defaultHome()) {
  return {
    antigravity: {
      label: "Antigravity",
      scopes: ["global"],
      globalDir: path.join(home, ".gemini", "config"),
      hooksDirName: "hooks",
      hooksConfigName: "hooks.json",
      source: "antigravity",
      schema: "assistant_response",
      skillTargets: ["antigravity"]
    },
    "claude-code": {
      label: "Claude Code",
      scopes: ["global", "repo"],
      globalDir: path.join(home, ".claude"),
      hooksDirName: "hooks",
      hooksConfigName: "settings.json",
      repoConfigName: "settings.local.json",
      source: "claude",
      schema: "assistant_response",
      skillTargets: ["claude-code"]
    },
    codex: {
      label: "Codex",
      scopes: ["global", "repo"],
      globalDir: path.join(home, ".codex"),
      hooksDirName: "hooks",
      hooksConfigName: "hooks.json",
      repoConfigName: "hooks.json",
      source: "codex",
      schema: "response",
      skillTargets: ["codex"]
    }
  };
}

function buildPs1({ source, schema, hookCommand = defaultHookCommand() }) {
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
    // Codex hands us the reply text inline (last_assistant_message); Claude Code's
    // Stop hook only points at a transcript file, so the Node parser reads the
    // last assistant turn from transcript_path. Bail only when we have neither.
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
    `    thread_id = $payload.thread_id`,
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

function powershellHookEntry(ps1Path) {
  return {
    type: "command",
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
    timeout: 5
  };
}

function codexHookEntry(ps1Path) {
  return {
    type: "command",
    commandWindows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`,
    timeout: 5,
    statusMessage: "Queueing response for Agent Hotline"
  };
}

function mergeStopHook(existing, newEntry, flavor) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (!base.hooks || typeof base.hooks !== "object") base.hooks = {};
  if (!Array.isArray(base.hooks.Stop)) base.hooks.Stop = [];

  const already = base.hooks.Stop.some((group) => {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    return hooks.some((hook) => {
      if (flavor === "codex") return hook.commandWindows === newEntry.commandWindows;
      const target = newEntry.args && newEntry.args[newEntry.args.length - 1];
      return (
        hook.command === "powershell.exe" && Array.isArray(hook.args) && hook.args.includes(target)
      );
    });
  });

  if (!already) {
    base.hooks.Stop.push({ ...(flavor === "codex" ? {} : { matcher: "" }), hooks: [newEntry] });
  }
  return base;
}

function installOneHook({ harnessKey, scope = "global", home, repo = process.cwd(), hookCommand }) {
  const definitions = harnessDefinitions(home);
  const harness = definitions[harnessKey];
  if (!harness) {
    throw new Error(`Invalid harness "${harnessKey}". Use one of: ${VALID_HARNESSES.join(", ")}.`);
  }
  if (!harness.scopes.includes(scope)) {
    throw new Error(
      `Scope "${scope}" is not valid for ${harness.label}. Valid scopes: ${harness.scopes.join(", ")}.`
    );
  }

  const isRepo = scope === "repo";
  const configDir = isRepo
    ? path.join(repo, harnessKey === "codex" ? ".codex" : ".claude")
    : harness.globalDir;
  const hooksDir = path.join(configDir, harness.hooksDirName);
  const ps1Path = path.join(hooksDir, "agent-hotline-stop.ps1");
  const configName = isRepo ? harness.repoConfigName : harness.hooksConfigName;
  const configPath = path.join(configDir, configName);

  writeFile(ps1Path, buildPs1({ source: harness.source, schema: harness.schema, hookCommand }));

  const entry = harnessKey === "codex" ? codexHookEntry(ps1Path) : powershellHookEntry(ps1Path);
  const existing = readJsonSafe(configPath);
  const merged = mergeStopHook(existing, entry, harnessKey === "codex" ? "codex" : "powershell");
  writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    harness: harnessKey,
    label: harness.label,
    scope,
    ps1Path,
    configPath
  };
}

function installHooks(options = {}) {
  const harness = normalizeHarness(options.harness || "all");
  const home = options.home || defaultHome();
  const repo = options.repo || process.cwd();
  const hookCommand = options.hookCommand || defaultHookCommand();
  const scope = options.scope || "global";

  validateChoice("harness", harness, VALID_HARNESSES);
  validateChoice("scope", scope, VALID_SCOPES);

  if (harness === "all") {
    const keys =
      scope === "repo" ? ["claude-code", "codex"] : ["antigravity", "claude-code", "codex"];
    return keys.map((key) => installOneHook({ harnessKey: key, scope, home, repo, hookCommand }));
  }

  return [installOneHook({ harnessKey: harness, scope, home, repo, hookCommand })];
}

function managedInstructionBlock() {
  return [
    MANAGED_BLOCK_START,
    'Agent Hotline read-aloud: when the user says "hotline on", "read aloud on",',
    '"start read-aloud", or "spoken mode", every response must include Spoken.',
    "Displayed is optional and should be used only for visual or dense supporting detail.",
    "",
    "Spoken:",
    "The primary answer for text-to-speech. It must stand on its own for a listener.",
    "Write the smallest useful spoken answer, not the shortest possible answer.",
    "Name options, recommendations, statuses, caveats, and next steps clearly.",
    "Do not include code, commands, file paths, diffs, logs, tables, or markdown.",
    "Avoid vague references like option one, this, that approach, or the above.",
    "Keep the whole response to one conversational chunk; if more remains, briefly name it and wait.",
    "Do not create a multi-screen Displayed dump that Spoken cannot cover.",
    "",
    "==========",
    "",
    "Displayed:",
    "Optional. Use only for code, commands, paths, diffs, logs, tables, diagrams, exact method/class references, or dense detail that is better read than heard.",
    "Do not restate the spoken answer in full.",
    "",
    "Keep labels alone on their own lines. If Displayed is omitted, omit the separator too.",
    "Agent Hotline reads only Spoken.",
    'Stop this format when the user says "hotline off" or "stop read-aloud".',
    MANAGED_BLOCK_END
  ].join("\n");
}

function upsertManagedBlock(filePath, block = managedInstructionBlock()) {
  const current = fs.existsSync(filePath) ? readFile(filePath) : "";
  const start = current.indexOf(MANAGED_BLOCK_START);
  const end = current.indexOf(MANAGED_BLOCK_END);

  let next;
  if (start !== -1 && end !== -1 && end > start) {
    next = `${current.slice(0, start)}${block}${current.slice(end + MANAGED_BLOCK_END.length)}`;
  } else {
    const prefix = current.trimEnd();
    next = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
  }

  writeFile(filePath, next);
  return filePath;
}

function installOneSkill({
  target,
  scope = "global",
  home,
  repo = process.cwd(),
  sourcePath = skillSourcePath()
}) {
  if (target === "antigravity") {
    const targetPath = path.join(home, ".gemini", "config", "skills", SKILL_NAME, "SKILL.md");
    copyFile(sourcePath, targetPath);
    return { target, scope: "global", path: targetPath, mode: "skill" };
  }

  if (target === "codex") {
    const targetPath =
      scope === "repo"
        ? path.join(repo, ".codex", "skills", SKILL_NAME, "SKILL.md")
        : path.join(home, ".codex", "skills", SKILL_NAME, "SKILL.md");
    copyFile(sourcePath, targetPath);
    return { target, scope, path: targetPath, mode: "skill" };
  }

  if (target === "claude-code") {
    const targetPath =
      scope === "repo"
        ? path.join(repo, ".claude", "skills", SKILL_NAME, "SKILL.md")
        : path.join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
    copyFile(sourcePath, targetPath);
    return { target, scope, path: targetPath, mode: "skill" };
  }

  throw new Error(`Invalid skill target "${target}". Use one of: ${VALID_HARNESSES.join(", ")}.`);
}

function installSkills(options = {}) {
  const target = normalizeHarness(options.target || options.harness || "all");
  const home = options.home || defaultHome();
  const repo = options.repo || process.cwd();
  const scope = options.scope || "global";
  const sourcePath = options.sourcePath || skillSourcePath();

  validateChoice("target", target, VALID_HARNESSES);
  validateChoice("scope", scope, VALID_SCOPES);

  if (target === "all") {
    const keys =
      scope === "repo" ? ["claude-code", "codex"] : ["antigravity", "claude-code", "codex"];
    return keys.map((key) => installOneSkill({ target: key, scope, home, repo, sourcePath }));
  }

  return [installOneSkill({ target, scope, home, repo, sourcePath })];
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

module.exports = {
  SKILL_NAME,
  buildPs1,
  defaultHookCommand,
  defaultHome,
  harnessDefinitions,
  installHooks,
  installSkills,
  managedInstructionBlock,
  normalizeHarness,
  NPX_PACKAGE_NAME,
  npxHookCommand,
  parseArgs,
  repoRoot,
  skillSourcePath,
  toPowerShellSingleQuoted,
  upsertManagedBlock
};
