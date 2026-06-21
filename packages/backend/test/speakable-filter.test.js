const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const { filterSpeakableText } = require("../src/speakable-filter");

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "response-fixtures.json"), "utf8")
);

function fixture(id) {
  const match = fixtures.find((item) => item.id === id);
  assert.ok(match, `Missing fixture: ${id}`);
  return match.rawText;
}

function testShortExplanationBecomesSpeakable() {
  const result = filterSpeakableText(fixture("short-conversational-answer"));

  assert.deepEqual(result, {
    shouldSpeak: true,
    text: "Yep, that looks right. The backend should keep the queue local, and the tray can ask for the next speakable item when it is ready.",
    reason: "speakable_text",
    source: "prose"
  });
}

function testSpokenSectionWinsOverDisplayedDetails() {
  const result = filterSpeakableText(fixture("answer-with-spoken-and-displayed"));

  assert.equal(result.shouldSpeak, true);
  assert.equal(
    result.text,
    "The backend queue is ready, and the next step is to connect it to the local hook command."
  );
  assert.equal(result.reason, "spoken_section");
  assert.equal(result.source, "spoken");
  assert.equal(result.text.includes("Queue shape"), false);
}

function testCodeBlockIsRemovedButSurroundingSummaryRemains() {
  const result = filterSpeakableText(fixture("answer-with-code-block"));

  assert.equal(result.shouldSpeak, true);
  assert.equal(result.text.includes("function nextPending"), false);
  assert.equal(result.text.includes("Add this helper near the queue code:"), true);
  assert.equal(result.text.includes("That keeps playback selection deterministic"), true);
  assert.equal(result.source, "prose");
}

function testDiffJsonLogsAndTablesAreReducedToProse() {
  for (const id of [
    "answer-with-diff",
    "answer-with-json",
    "answer-with-logs",
    "answer-with-table"
  ]) {
    const result = filterSpeakableText(fixture(id));

    assert.equal(result.shouldSpeak, true, id);
    assert.equal(result.source, "prose", id);
    assert.equal(result.text.includes("```"), false, id);
    assert.equal(result.text.includes("| ---"), false, id);
    assert.equal(result.text.includes("ECONNREFUSED"), false, id);
    assert.equal(result.text.includes('"readBehavior"'), false, id);
    assert.equal(result.text.length > 20, true, id);
  }
}

function testCodeHeavyOutputIsSkipped() {
  const result = filterSpeakableText(`
\`\`\`js
const app = createServer();
app.listen(4777);
\`\`\`

\`\`\`text
Error: listen EADDRINUSE
    at Server.setupListenHandle (node:net:1817:16)
\`\`\`
`);

  assert.deepEqual(result, {
    shouldSpeak: false,
    text: "",
    reason: "no_speakable_text",
    source: "filtered"
  });
}

function testLongBulletListIsSkipped() {
  const result = filterSpeakableText(
    [
      "Implementation notes:",
      "- one",
      "- two",
      "- three",
      "- four",
      "- five",
      "- six",
      "- seven"
    ].join("\n")
  );

  assert.equal(result.shouldSpeak, false);
  assert.equal(result.reason, "no_speakable_text");
  assert.equal(result.source, "filtered");
}

const tests = [
  testShortExplanationBecomesSpeakable,
  testSpokenSectionWinsOverDisplayedDetails,
  testCodeBlockIsRemovedButSurroundingSummaryRemains,
  testDiffJsonLogsAndTablesAreReducedToProse,
  testCodeHeavyOutputIsSkipped,
  testLongBulletListIsSkipped
];

for (const test of tests) {
  test();
}

console.log(`speakable-filter: ${tests.length} tests passed`);
