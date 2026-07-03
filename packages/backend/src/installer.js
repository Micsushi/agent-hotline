const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildHookScript: renderHookScript,
  buildPs1: renderPs1,
  buildSh: renderSh,
  hookScriptExtension,
  toPowerShellSingleQuoted
} = require("./hook-script");

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

function buildPs1(options = {}) {
  return renderPs1({ ...options, hookCommand: options.hookCommand || defaultHookCommand() });
}

function buildSh(options = {}) {
  return renderSh({ ...options, hookCommand: options.hookCommand || defaultHookCommand() });
}

function buildHookScript(options = {}) {
  return renderHookScript({ ...options, hookCommand: options.hookCommand || defaultHookCommand() });
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

function chmodExecutable(filePath, platform = process.platform) {
  if (platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
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

function powershellHookEntry(scriptPath) {
  return {
    type: "command",
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    timeout: 5
  };
}

function shellHookEntry(scriptPath) {
  return {
    type: "command",
    command: "/bin/sh",
    args: [scriptPath],
    timeout: 5
  };
}

function codexHookEntry(scriptPath, platform = process.platform) {
  const base = {
    type: "command",
    timeout: 5,
    statusMessage: "Queueing response for Agent Hotline"
  };

  if (platform === "win32") {
    return {
      ...base,
      commandWindows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
    };
  }

  return {
    ...base,
    command: `/bin/sh "${scriptPath.replace(/"/g, '\\"')}"`
  };
}

function hookMatches(existing, candidate) {
  if (candidate.commandWindows) return existing.commandWindows === candidate.commandWindows;
  if (candidate.command) {
    return (
      existing.command === candidate.command &&
      JSON.stringify(existing.args || []) === JSON.stringify(candidate.args || [])
    );
  }
  return false;
}

function mergeStopHook(existing, newEntry, flavor) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (!base.hooks || typeof base.hooks !== "object") base.hooks = {};
  if (!Array.isArray(base.hooks.Stop)) base.hooks.Stop = [];

  const already = base.hooks.Stop.some((group) => {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    return hooks.some((hook) => hookMatches(hook, newEntry));
  });

  if (!already) {
    base.hooks.Stop.push({ ...(flavor === "codex" ? {} : { matcher: "" }), hooks: [newEntry] });
  }
  return base;
}

function buildHookEntry({ harnessKey, scriptPath, platform = process.platform }) {
  if (harnessKey === "codex") return codexHookEntry(scriptPath, platform);
  if (platform === "win32") return powershellHookEntry(scriptPath);
  return shellHookEntry(scriptPath);
}

function installOneHook({
  harnessKey,
  scope = "global",
  home,
  repo = process.cwd(),
  hookCommand,
  platform = process.platform
}) {
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
  const scriptPath = path.join(hooksDir, `agent-hotline-stop.${hookScriptExtension(platform)}`);
  const configName = isRepo ? harness.repoConfigName : harness.hooksConfigName;
  const configPath = path.join(configDir, configName);

  writeFile(
    scriptPath,
    buildHookScript({
      platform,
      source: harness.source,
      schema: harness.schema,
      hookCommand
    })
  );
  chmodExecutable(scriptPath, platform);

  const entry = buildHookEntry({ harnessKey, scriptPath, platform });
  const existing = readJsonSafe(configPath);
  const merged = mergeStopHook(existing, entry, harnessKey === "codex" ? "codex" : "powershell");
  writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    harness: harnessKey,
    label: harness.label,
    scope,
    scriptPath,
    configPath
  };
}

function installHooks(options = {}) {
  const harness = normalizeHarness(options.harness || "all");
  const home = options.home || defaultHome();
  const repo = options.repo || process.cwd();
  const hookCommand = options.hookCommand || defaultHookCommand();
  const scope = options.scope || "global";
  const platform = options.platform || process.platform;

  validateChoice("harness", harness, VALID_HARNESSES);
  validateChoice("scope", scope, VALID_SCOPES);

  if (harness === "all") {
    const keys =
      scope === "repo" ? ["claude-code", "codex"] : ["antigravity", "claude-code", "codex"];
    return keys.map((key) =>
      installOneHook({ harnessKey: key, scope, home, repo, hookCommand, platform })
    );
  }

  return [installOneHook({ harnessKey: harness, scope, home, repo, hookCommand, platform })];
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
  buildSh,
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
