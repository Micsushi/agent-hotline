const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const {
  SOURCE_APPS,
  detectSourceApp,
  extractAssistantText,
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

const tests = [
  testCodexFixturesParseAssistantText,
  testClaudeFixturesParseAssistantText,
  testBomPrefixedJsonStillParses,
  testMalformedJsonSkipsSafely,
  testUnknownSchemaSkipsWithStructuredReason,
  testParserHandlesNonStringInputWithoutThrowing,
  testFutureTextShapesCanStillBeExtracted,
  testExportedHelpersDoNotThrowForUnexpectedValues
];

for (const test of tests) {
  test();
}

console.log(`hook-input-parser: ${tests.length} tests passed`);
