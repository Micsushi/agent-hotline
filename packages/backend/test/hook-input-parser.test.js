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

const tests = [
  testCodexFixturesParseAssistantText,
  testCodexInputMessagesBecomeUserMessages,
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
