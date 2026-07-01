const assert = require("assert/strict");

const { filterSpeakableText } = require("../src/speakable-filter");

function visibleSection(text) {
  const match = text.match(/^Displayed:\s*\n([\s\S]*)$/m);
  return match ? match[1].trim() : "";
}

function assertSpokenOnly({ name, text, expectedSpeech }) {
  const result = filterSpeakableText(text);

  assert.equal(result.shouldSpeak, true, name);
  assert.equal(result.reason, "spoken_section", name);
  assert.equal(result.source, "spoken", name);
  assert.equal(result.text, expectedSpeech, name);
  assert.equal(visibleSection(text), "", name);
}

function assertDisplayedSupport({ name, text, expectedSpeech, visibleIncludes }) {
  const result = filterSpeakableText(text);
  const displayed = visibleSection(text);

  assert.equal(result.shouldSpeak, true, name);
  assert.equal(result.reason, "spoken_section", name);
  assert.equal(result.source, "spoken", name);
  assert.equal(result.text, expectedSpeech, name);
  assert.equal(result.text.includes("```"), false, name);

  for (const snippet of visibleIncludes) {
    assert.equal(displayed.includes(snippet), true, `${name}: missing ${snippet}`);
  }
}

function assertChunkedBroadAnswer({ name, text, expectedSpeech, forbiddenDisplayed }) {
  const result = filterSpeakableText(text);
  const displayed = visibleSection(text);

  assert.equal(result.shouldSpeak, true, name);
  assert.equal(result.reason, "spoken_section", name);
  assert.equal(result.source, "spoken", name);
  assert.equal(result.text, expectedSpeech, name);
  assert.equal(displayed, "", name);

  for (const snippet of forbiddenDisplayed) {
    assert.equal(text.includes(snippet), false, `${name}: should not dump ${snippet}`);
  }
}

assertSpokenOnly({
  name: "simple status can be fully spoken",
  text: [
    "Spoken:",
    "Yes, Hotline mode is on. The current answer is simple enough that it does not need a displayed section."
  ].join("\n"),
  expectedSpeech:
    "Yes, Hotline mode is on. The current answer is simple enough that it doesn't need a displayed section."
});

assertDisplayedSupport({
  name: "code-heavy answer keeps code visible but explains the decision aloud",
  text: [
    "Spoken:",
    "I would update the installer-generated instruction block first, because future Codex and Claude installs reuse it. The source skill and docs should match it, and the test should keep the old fixed sentence limit from coming back.",
    "",
    "==========",
    "",
    "Displayed:",
    "```js",
    "assert.doesNotMatch(text, /2 to 6 short sentences/);",
    "assert.match(text, /Displayed is optional/);",
    "```"
  ].join("\n"),
  expectedSpeech:
    "I'd update the installer-generated instruction block first, because future Codex and Claude installs reuse it. The source skill and docs should match it, and the test should keep the old fixed sentence limit from coming back.",
  visibleIncludes: [
    "assert.doesNotMatch(text, /2 to 6 short sentences/);",
    "assert.match(text, /Displayed is optional/);"
  ]
});

assertChunkedBroadAnswer({
  name: "broad answer maps chunks instead of dumping several screens",
  text: [
    "Spoken:",
    "There are three useful chunks here: the instruction contract, the backend parser behavior, and the live installed copies. I would handle the instruction contract first, because it controls future installs and most of the bad output shape. After that, I can walk through parser behavior next."
  ].join("\n"),
  expectedSpeech:
    "There are three useful chunks here: the instruction contract, the backend parser behavior, and the live installed copies. I'd handle the instruction contract first, because it controls future installs and most of the bad output shape. After that, I can walk through parser behavior next.",
  forbiddenDisplayed: ["Full parser audit", "Live installed files audit", "Multi-screen evidence"]
});

console.log("hotline-spoken-contract: 3 samples passed");
