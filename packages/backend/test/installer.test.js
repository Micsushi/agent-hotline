const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
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

test("buildPs1 keeps Unicode punctuation intact through native command pipes", () => {
  const ps1 = buildPs1({ source: "codex", schema: "response" });

  assert.match(ps1, /\[Console\]::InputEncoding = \$utf8NoBom/);
  assert.match(ps1, /\[Console\]::OutputEncoding = \$utf8NoBom/);
  assert.match(ps1, /\$OutputEncoding = \$utf8NoBom/);
  assert.ok(
    ps1.indexOf("$OutputEncoding = $utf8NoBom") < ps1.indexOf("[Console]::In.ReadToEnd()"),
    "pipe encoding must be configured before reading or forwarding hook JSON"
  );
});

test(
  "buildPs1 round-trips common Unicode punctuation through PowerShell",
  { skip: process.platform !== "win32" },
  () => {
    const dir = tempDir();
    const capturePath = path.join(dir, "capture.js");
    const outputPath = path.join(dir, "output.json");
    const ps1Path = path.join(dir, "hook.ps1");
    const sample = "I’m testing em dash — ellipsis … and “quotes”.";

    fs.writeFileSync(
      capturePath,
      [
        'const fs = require("fs");',
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => { input += chunk; });",
        "process.stdin.on('end', () => { fs.writeFileSync(process.argv[2], input, 'utf8'); });",
        ""
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      ps1Path,
      buildPs1({
        source: "codex",
        schema: "response",
        hookCommand: `node "${capturePath}" "${outputPath}"`
      }),
      "utf8"
    );

    const payload = JSON.stringify({ last_assistant_message: sample });
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
      { input: payload, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const normalized = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(normalized.response.text, sample);
  }
);

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

test("installSkills installs harness skills without global response-format instructions", () => {
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
  assert.equal(
    fs.existsSync(path.join(home, ".claude", "skills", "agent-hotline-spoken", "SKILL.md")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(home, ".codex", "skills", "agent-hotline-spoken", "SKILL.md")),
    true
  );
  assert.equal(fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false);
});

test("managed instruction block makes Spoken primary and Displayed optional", () => {
  const text = managedInstructionBlock();

  assert.match(text, /every response must include Spoken/);
  assert.match(text, /Displayed is optional/);
  assert.match(text, /smallest useful spoken answer/);
  assert.match(text, /must stand on its own for a listener/);
  assert.match(text, /Do not restate the spoken answer in full/);
  assert.match(text, /one conversational chunk/);
  assert.match(text, /multi-screen Displayed dump/);
  assert.doesNotMatch(text, /2 to 6 short sentences/);
  assert.doesNotMatch(text, /full normal answer/);
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
