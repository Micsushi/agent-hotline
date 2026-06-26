const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  buildPs1,
  defaultHookCommand,
  installHooks,
  installSkills,
  managedInstructionBlock,
  npxHookCommand,
  parseArgs,
  toPowerShellSingleQuoted,
  upsertManagedBlock
} = require("../src/installer");
const { main: cliMain } = require("../bin/agent-hotline");

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

test("buildPs1 embeds the hook command as a parseable PowerShell literal", () => {
  // The real default command carries both double quotes and Windows backslashes:
  //   node "C:\...\agent-hotline.js" hook
  // The old code used JSON.stringify here, emitting `"node \"C:\\...\" hook"`,
  // which is a PowerShell PARSE error (backslash is not its escape char). The
  // script then died before its try/catch and silently enqueued nothing.
  const ps1 = buildPs1({ source: "claude", schema: "assistant_response" });

  // Must use single-quoted literal form, never the JSON backslash-escape form.
  assert.ok(!ps1.includes('\\"'), "ps1 must not contain JSON-escaped quotes");
  const cmd = defaultHookCommand();
  assert.ok(
    ps1.includes(`$hookCommand = '${cmd}'`),
    "hook command must be a single-quoted PowerShell literal"
  );

  // The embedded command line round-trips verbatim out of the single quotes.
  const match = ps1.match(/\$hookCommand = '([^]*?)'\r?\n/);
  assert.ok(match, "hook command assignment line is present");
  assert.equal(match[1].replace(/''/g, "'"), cmd);
});

test("buildPs1 forwards user prompt fields for chat display", () => {
  const ps1 = buildPs1({ source: "codex", schema: "response" });

  assert.match(ps1, /\$inputMessages = \$payload\.'input-messages'/);
  assert.match(ps1, /"input-messages" = \$inputMessages/);
  assert.match(ps1, /last_user_message = \$payload\.last_user_message/);
  assert.match(ps1, /lastUserMessage = \$payload\.lastUserMessage/);
});

test("toPowerShellSingleQuoted escapes embedded single quotes by doubling", () => {
  assert.equal(toPowerShellSingleQuoted("plain"), "'plain'");
  assert.equal(toPowerShellSingleQuoted(`a'b`), "'a''b'");
  // Backslashes and double quotes are taken verbatim -- the whole point.
  assert.equal(toPowerShellSingleQuoted('node "C:\\x\\y.js"'), `'node "C:\\x\\y.js"'`);
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

test("installHooks with all and repo scope installs only repo-capable harnesses", () => {
  const home = tempDir();
  const repo = tempDir();

  const results = installHooks({ harness: "all", scope: "repo", home, repo });

  assert.deepEqual(
    results.map((result) => result.harness),
    ["claude-code", "codex"]
  );
  assert.equal(fs.existsSync(path.join(repo, ".claude", "settings.local.json")), true);
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".gemini", "config", "hooks.json")), false);
});

test("installHooks reports valid values for invalid harness and scope", () => {
  assert.throws(
    () => installHooks({ harness: "nope", home: tempDir() }),
    /Invalid harness "nope".*antigravity, claude-code, codex, all/
  );
  assert.throws(
    () => installHooks({ harness: "codex", scope: "machine", home: tempDir() }),
    /Invalid scope "machine".*global, repo/
  );
});

test("CLI can write durable npx hook commands", async () => {
  const home = tempDir();

  const code = await cliMain([
    "install-hooks",
    "--harness",
    "codex",
    "--home",
    home,
    "--use-npx-hook"
  ]);

  assert.equal(code, 0);
  const ps1 = readText(path.join(home, ".codex", "hooks", "agent-hotline-stop.ps1"));
  assert.match(ps1, /npx --yes @micsushi\/agent-hotline hook/);
});

test("CLI uses durable npx hook command when launched by npm exec", async () => {
  const home = tempDir();
  const oldNpmCommand = process.env.npm_command;
  process.env.npm_command = "exec";

  try {
    const code = await cliMain(["install-hooks", "--harness", "codex", "--home", home]);
    assert.equal(code, 0);
  } finally {
    if (oldNpmCommand === undefined) {
      delete process.env.npm_command;
    } else {
      process.env.npm_command = oldNpmCommand;
    }
  }

  const ps1 = readText(path.join(home, ".codex", "hooks", "agent-hotline-stop.ps1"));
  assert.equal(npxHookCommand(), "npx --yes @micsushi/agent-hotline hook");
  assert.match(ps1, /npx --yes @micsushi\/agent-hotline hook/);
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
