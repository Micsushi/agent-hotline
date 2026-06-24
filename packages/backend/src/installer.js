const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "agent-hotline-spoken";
const MANAGED_BLOCK_START = "<!-- AGENT_HOTLINE_SPOKEN_START -->";
const MANAGED_BLOCK_END = "<!-- AGENT_HOTLINE_SPOKEN_END -->";

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
    ``,
    `try {`,
    `  $inputJson = [Console]::In.ReadToEnd()`,
    `  if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }`,
    ``,
    `  $payload = $inputJson | ConvertFrom-Json`,
    `  $assistantText = $payload.last_assistant_message`,
    `  if ([string]::IsNullOrWhiteSpace($assistantText)) { exit 0 }`,
    ``,
    `  $normalizedJson = @{`,
    `    source = "${source}"`,
    `    hook_event_name = "Stop"`,
    `    ${responseKey} = @{ text = $assistantText }`,
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
    `    $hookCommand = ${JSON.stringify(hookCommand)}`,
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
  if (!harness) throw new Error(`Unknown harness "${harnessKey}"`);
  if (!harness.scopes.includes(scope)) {
    throw new Error(`Scope "${scope}" not valid for ${harness.label}`);
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

  if (harness === "all") {
    return ["antigravity", "claude-code", "codex"].map((key) =>
      installOneHook({ harnessKey: key, scope: "global", home, repo, hookCommand })
    );
  }

  return [installOneHook({ harnessKey: harness, scope, home, repo, hookCommand })];
}

function managedInstructionBlock() {
  return [
    MANAGED_BLOCK_START,
    'Agent Hotline read-aloud: when the user says "hotline on", "read aloud on",',
    '"start read-aloud", or "spoken mode", format every response with these sections:',
    "",
    "Spoken:",
    "A short conversational summary for text-to-speech. Use 2 to 6 short sentences.",
    "Do not include code, file paths, commands, symbols, or markdown.",
    "",
    "==========",
    "",
    "Displayed:",
    "The full normal answer with code, commands, paths, diffs, steps, and detail.",
    "",
    "Keep both labels alone on their own lines. Agent Hotline reads only Spoken.",
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
    const filePath =
      scope === "repo" ? path.join(repo, "AGENTS.md") : path.join(home, ".codex", "AGENTS.md");
    upsertManagedBlock(filePath);
    return { target, scope, path: filePath, mode: "instructions" };
  }

  if (target === "claude-code") {
    const filePath =
      scope === "repo" ? path.join(repo, "CLAUDE.md") : path.join(home, ".claude", "CLAUDE.md");
    upsertManagedBlock(filePath);
    return { target, scope, path: filePath, mode: "instructions" };
  }

  throw new Error(`Unknown skill target "${target}"`);
}

function installSkills(options = {}) {
  const target = normalizeHarness(options.target || options.harness || "all");
  const home = options.home || defaultHome();
  const repo = options.repo || process.cwd();
  const scope = options.scope || "global";
  const sourcePath = options.sourcePath || skillSourcePath();

  if (target === "all") {
    return ["antigravity", "claude-code", "codex"].map((key) =>
      installOneSkill({ target: key, scope: "global", home, repo, sourcePath })
    );
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
  defaultHookCommand,
  defaultHome,
  harnessDefinitions,
  installHooks,
  installSkills,
  managedInstructionBlock,
  normalizeHarness,
  parseArgs,
  repoRoot,
  skillSourcePath,
  upsertManagedBlock
};
