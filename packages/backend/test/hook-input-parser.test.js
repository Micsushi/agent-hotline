const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const os = require("os");

const {
  SOURCE_APPS,
  detectSourceApp,
  extractAssistantText,
  extractUserMessages,
  parseHookInput
} = require("../src/hook-input-parser");

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "response-fixtures.json"), "utf8")
);

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

function testCodexFixturesParseAssistantText() {
  for (const fixture of fixtures) {
    const result = parseHookInput(JSON.stringify(fixture.codexLike));

    assert.equal(result.ok, true, fixture.id);
    assert.equal(result.action, "accept", fixture.id);
    assert.equal(result.sourceApp, SOURCE_APPS.CODEX, fixture.id);
    assert.equal(result.assistantText, fixture.rawText, fixture.id);
    assert.equal(result.schema, "response", fixture.id);
  }
}

function testClaudeFixturesParseAssistantText() {
  for (const fixture of fixtures) {
    const result = parseHookInput(JSON.stringify(fixture.claudeLike));

    assert.equal(result.ok, true, fixture.id);
    assert.equal(result.action, "accept", fixture.id);
    assert.equal(result.sourceApp, SOURCE_APPS.CLAUDE, fixture.id);
    assert.equal(result.assistantText, fixture.rawText, fixture.id);
    assert.equal(result.schema, "assistant_response", fixture.id);
  }
}

function testMalformedJsonSkipsSafely() {
  const result = parseHookInput(readFixture("malformed-hook-input.txt"));

  assert.equal(result.ok, false);
  assert.equal(result.action, "skip");
  assert.equal(result.sourceApp, SOURCE_APPS.UNKNOWN);
  assert.equal(result.assistantText, "");
  assert.equal(result.reason, "malformed_json");
  assert.equal(typeof result.error, "string");
}

function testUnknownSchemaSkipsWithStructuredReason() {
  const result = parseHookInput(
    JSON.stringify({
      source: "future-agent",
      version: 2,
      payload: {
        done: true
      }
    })
  );

  assert.deepEqual(
    {
      ok: result.ok,
      action: result.action,
      sourceApp: result.sourceApp,
      assistantText: result.assistantText,
      reason: result.reason
    },
    {
      ok: false,
      action: "skip",
      sourceApp: SOURCE_APPS.UNKNOWN,
      assistantText: "",
      reason: "missing_assistant_text"
    }
  );
}

function testParserHandlesNonStringInputWithoutThrowing() {
  const result = parseHookInput({ source: "codex" });

  assert.equal(result.ok, false);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "invalid_input");
}

function testFutureTextShapesCanStillBeExtracted() {
  const payload = {
    source: "codex-cli",
    response: {
      role: "assistant",
      output: [
        { content: [{ type: "output_text", text: "First paragraph." }] },
        { output_text: "Second paragraph." }
      ]
    }
  };

  const result = parseHookInput(JSON.stringify(payload));

  assert.equal(result.ok, true);
  assert.equal(result.sourceApp, SOURCE_APPS.CODEX);
  assert.equal(result.assistantText, "First paragraph.\n\nSecond paragraph.");
}

function testExportedHelpersDoNotThrowForUnexpectedValues() {
  assert.equal(detectSourceApp(null), SOURCE_APPS.UNKNOWN);
  assert.deepEqual(extractAssistantText(null), { text: "", schema: "unknown" });
}

function testBomPrefixedJsonStillParses() {
  // PowerShell 5.1 prepends a UTF-8 BOM when piping to node.
  const bom = String.fromCharCode(0xfeff);
  const payload = bom + JSON.stringify({ source: "claude", assistant_response: { text: "Hi" } });
  const result = parseHookInput(payload);

  assert.equal(result.ok, true);
  assert.equal(result.sourceApp, SOURCE_APPS.CLAUDE);
  assert.equal(result.assistantText, "Hi");
}

function testThreadIdAndLabelExtracted() {
  const result = parseHookInput(
    JSON.stringify({
      source: "claude",
      session_id: "abcdef12-3456-7890",
      cwd: "C:\\Users\\me\\Documents\\Github\\agent-hotline",
      assistant_response: { text: "Done." }
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.threadId, "abcdef12-3456-7890");
  assert.equal(result.threadLabel, "agent-hotline  -  abcdef12");
}

function testAntigravitySourceDetectedBySourceField() {
  const result = parseHookInput(
    JSON.stringify({
      source: "antigravity",
      hook_event_name: "Stop",
      assistant_response: { text: "Spoken:\nThis is the spoken part.\n\nDisplayed:\nDetails." }
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.sourceApp, SOURCE_APPS.ANTIGRAVITY);
  assert.equal(result.assistantText.includes("Spoken:"), true);
}

function testAntigravitySourceDetectedByEventName() {
  const result = parseHookInput(
    JSON.stringify({
      hook_event_name: "antigravity-stop",
      assistant_response: { text: "Spoken:\nEvent-based detection works." }
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.sourceApp, SOURCE_APPS.ANTIGRAVITY);
}

function testCodexInputMessagesBecomeUserMessages() {
  const result = parseHookInput(
    JSON.stringify({
      source: "codex",
      "input-messages": ["first prompt\n", "  ", "second prompt"],
      response: { text: "Spoken:\nReply." }
    })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.userMessages, ["first prompt", "second prompt"]);
}

function testCodexLastUserMessageBecomesUserMessage() {
  const result = parseHookInput(
    JSON.stringify({
      source: "codex",
      last_user_message: "explain the uncommitted code",
      response: { text: "Spoken:\nReply." }
    })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.userMessages, ["explain the uncommitted code"]);
}

function testCodexUserMessageRecoveredFromSessionFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-session-"));
  const threadId = "019f020f-9b5c-7053-9c2e-f1564e13e14a";
  const sessionPath = path.join(dir, `rollout-test-${threadId}.jsonl`);
  const lines = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "restore my prompts" }]
      }
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Spoken:\nRecovered." }]
      }
    }
  ];
  fs.writeFileSync(sessionPath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  const result = parseHookInput(
    JSON.stringify({
      source: "codex",
      session_id: threadId,
      response: { text: "Spoken:\nRecovered." }
    }),
    { codexSessionFile: sessionPath }
  );
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.userMessages, ["restore my prompts"]);
}

function testClaudeUserMessagesReadFromTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-transcript-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "old turn" } },
    { type: "assistant", message: { role: "assistant", content: "old reply" } },
    { type: "user", message: { role: "user", content: "fix the ui" } },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ignored" }]
      }
    },
    { type: "user", isMeta: true, message: { role: "user", content: "meta noise" } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "and add tests" }] } },
    { type: "assistant", message: { role: "assistant", content: "Spoken:\nDone." } }
  ];
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  const messages = extractUserMessages({ source: "claude", transcript_path: transcriptPath });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(messages, ["fix the ui", "and add tests"]);
}

function testMissingTranscriptYieldsNoUserMessages() {
  const messages = extractUserMessages({
    source: "claude",
    transcript_path: path.join(os.tmpdir(), "does-not-exist-ah.jsonl")
  });
  assert.deepEqual(messages, []);
}

function testProjectResolvesToRepoRootFromSubdir() {
  const repoRoot = "C:\\Users\\me\\Documents\\Github\\agent-hotline";
  const subdir = path.join(repoRoot, "packages", "desktop");
  const gitMarker = path.join(repoRoot, ".git");
  const result = parseHookInput(
    JSON.stringify({
      source: "claude",
      session_id: "abcdef12-3456-7890",
      cwd: subdir,
      assistant_response: { text: "Done." }
    }),
    { existsSync: (p) => p === gitMarker }
  );

  assert.equal(result.ok, true);
  assert.equal(result.projectName, "agent-hotline");
  assert.equal(result.projectPath, repoRoot);
  assert.equal(result.threadLabel, "agent-hotline  -  abcdef12");
}

function testProjectFallsBackToCwdBasenameWithoutMarker() {
  const subdir = "C:\\Users\\me\\Documents\\Github\\agent-hotline\\packages\\desktop";
  const result = parseHookInput(
    JSON.stringify({
      source: "claude",
      cwd: subdir,
      assistant_response: { text: "Done." }
    }),
    { existsSync: () => false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.projectName, "desktop");
  assert.equal(result.projectPath, subdir);
}

function testProjectRecoveredFromTranscriptCwdWhenPayloadOmitsIt() {
  // SDK / editor-extension Stop hooks omit the top-level cwd, but Claude writes
  // the real cwd on every transcript line -- recover it so the item groups under
  // its real project instead of the "Claude" catch-all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-transcript-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  const repoRoot = "C:\\Users\\me\\Documents\\Github\\agent-hotline";
  const lines = [
    { type: "queue-operation", operation: "enqueue" },
    { type: "user", cwd: repoRoot, message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant", content: "Done." } }
  ];
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  const gitMarker = path.join(repoRoot, ".git");
  const result = parseHookInput(
    JSON.stringify({
      source: "claude",
      session_id: "abcdef12-3456-7890",
      transcript_path: transcriptPath,
      assistant_response: { text: "Done." }
    }),
    { existsSync: (p) => p === gitMarker }
  );
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.projectName, "agent-hotline");
  assert.equal(result.projectPath, repoRoot);
  assert.equal(result.threadLabel, "agent-hotline  -  abcdef12");
}

function testProjectFallsBackToEncodedTranscriptDirWhenNoCwdAnywhere() {
  // No inline cwd and the transcript carries no cwd line: decode the stable
  // ".../projects/<encoded>/<sid>.jsonl" segment so items still group together.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-transcript-"));
  const encoded = "c--Users-me-Documents-Github-agent-hotline";
  const projectsDir = path.join(dir, "projects", encoded);
  fs.mkdirSync(projectsDir, { recursive: true });
  const transcriptPath = path.join(projectsDir, "sid.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Done." } }),
    "utf8"
  );
  const result = parseHookInput(
    JSON.stringify({
      source: "claude",
      transcript_path: transcriptPath,
      assistant_response: { text: "Done." }
    }),
    { existsSync: () => false }
  );
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.projectPath, encoded);
  assert.equal(result.projectName, encoded);
}

const tests = [
  testProjectResolvesToRepoRootFromSubdir,
  testProjectFallsBackToCwdBasenameWithoutMarker,
  testProjectRecoveredFromTranscriptCwdWhenPayloadOmitsIt,
  testProjectFallsBackToEncodedTranscriptDirWhenNoCwdAnywhere,
  testCodexFixturesParseAssistantText,
  testCodexInputMessagesBecomeUserMessages,
  testCodexLastUserMessageBecomesUserMessage,
  testCodexUserMessageRecoveredFromSessionFile,
  testClaudeUserMessagesReadFromTranscript,
  testMissingTranscriptYieldsNoUserMessages,
  testClaudeFixturesParseAssistantText,
  testThreadIdAndLabelExtracted,
  testBomPrefixedJsonStillParses,
  testMalformedJsonSkipsSafely,
  testUnknownSchemaSkipsWithStructuredReason,
  testParserHandlesNonStringInputWithoutThrowing,
  testFutureTextShapesCanStillBeExtracted,
  testExportedHelpersDoNotThrowForUnexpectedValues,
  testAntigravitySourceDetectedBySourceField,
  testAntigravitySourceDetectedByEventName
];

for (const test of tests) {
  test();
}

console.log(`hook-input-parser: ${tests.length} tests passed`);
