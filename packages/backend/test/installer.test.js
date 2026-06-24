const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  installHooks,
  installSkills,
  managedInstructionBlock,
  parseArgs,
  upsertManagedBlock
} = require("../src/installer");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-installer-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("installHooks supports all harnesses in non-interactive mode", () => {
  const home = tempDir();
  const repo = tempDir();

  const results = installHooks({
    harness: "all",
    home,
    repo,
    hookCommand: "agent-hotline hook"
  });

  assert.deepEqual(
    results.map((result) => result.harness),
    ["antigravity", "claude-code", "codex"]
  );

  const antigravity = readJson(path.join(home, ".gemini", "config", "hooks.json"));
  const claude = readJson(path.join(home, ".claude", "settings.json"));
  const codex = readJson(path.join(home, ".codex", "hooks.json"));

  assert.equal(antigravity.hooks.Stop.length, 1);
  assert.equal(claude.hooks.Stop.length, 1);
  assert.equal(codex.hooks.Stop.length, 1);

  const ps1 = readText(path.join(home, ".codex", "hooks", "agent-hotline-stop.ps1"));
  assert.match(ps1, /agent-hotline hook/);
  assert.match(ps1, /cmd\.exe \/d \/s \/c/);
});

test("installHooks merges without duplicating existing hook entries", () => {
  const home = tempDir();

  installHooks({ harness: "codex", home, hookCommand: "agent-hotline hook" });
  installHooks({ harness: "codex", home, hookCommand: "agent-hotline hook" });

  const codex = readJson(path.join(home, ".codex", "hooks.json"));
  assert.equal(codex.hooks.Stop.length, 1);
});

test("installHooks supports repo scope for Codex and Claude Code", () => {
  const home = tempDir();
  const repo = tempDir();

  installHooks({ harness: "codex", scope: "repo", home, repo });
  installHooks({ harness: "claude-code", scope: "repo", home, repo });

  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), true);
  assert.equal(fs.existsSync(path.join(repo, ".claude", "settings.local.json")), true);
});

test("installSkills installs Antigravity skill and managed global instructions", () => {
  const home = tempDir();

  const results = installSkills({ target: "all", home });

  assert.deepEqual(
    results.map((result) => result.target),
    ["antigravity", "claude-code", "codex"]
  );
  assert.equal(
    fs.existsSync(
      path.join(home, ".gemini", "config", "skills", "agent-hotline-spoken", "SKILL.md")
    ),
    true
  );
  assert.match(readText(path.join(home, ".claude", "CLAUDE.md")), /AGENT_HOTLINE_SPOKEN_START/);
  assert.match(readText(path.join(home, ".codex", "AGENTS.md")), /AGENT_HOTLINE_SPOKEN_START/);
});

test("managed instruction block is idempotent", () => {
  const dir = tempDir();
  const file = path.join(dir, "AGENTS.md");

  upsertManagedBlock(file);
  upsertManagedBlock(file);

  const text = readText(file);
  assert.equal(text.match(/AGENT_HOTLINE_SPOKEN_START/g).length, 1);
  assert.match(text, new RegExp(managedInstructionBlock().split("\n")[1]));
});

test("parseArgs captures flags and positional commands", () => {
  assert.deepEqual(parseArgs(["install", "--harness", "all", "--scope", "global"]), {
    _: ["install"],
    harness: "all",
    scope: "global"
  });
});
