const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { installSkills, managedInstructionBlock } = require("../src/installer");
const { filterSpeakableText } = require("../src/speakable-filter");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertPressureRules(name, text) {
  assert.match(
    text,
    /urgent|time-sensitive|safety-critical/i,
    `${name}: urgent answers must not be deferred`
  );
  assert.match(
    text,
    /complete answer|complete response|all details/i,
    `${name}: explicitly complete answers must not be chunked`
  );
  assert.match(
    text,
    /Displayed[^.\n]*(required|must)/i,
    `${name}: exact technical material must require Displayed`
  );
  assert.match(
    text,
    /Spoken[^.\n]*(tell|say|name)[^.\n]*Displayed|tell the listener[^.\n]*Displayed/i,
    `${name}: Spoken must hand exact technical material off to Displayed`
  );
}

function assertHarnessSmokeUsesSeparator(relativePath) {
  const text = readRepoFile(relativePath);
  assert.match(
    text,
    /Spoken:`n[^"\r\n]*`n`n==========`n`nDisplayed:/,
    `${relativePath}: smoke payload must use the required separator`
  );
}

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
    "I would update the installer-generated instruction block first, because future Codex and Claude installs reuse it. The source skill and docs should match it, and the test should keep the old fixed sentence limit from coming back. The exact assertions are shown in Displayed.",
    "",
    "==========",
    "",
    "Displayed:",
    "```js",
    "assert.doesNotMatch(text, /2 to 6 short sentences/);",
    "assert.match(text, /Displayed is required/);",
    "```"
  ].join("\n"),
  expectedSpeech:
    "I'd update the installer-generated instruction block first, because future Codex and Claude installs reuse it. The source skill and docs should match it, and the test should keep the old fixed sentence limit from coming back. The exact assertions are shown in Displayed.",
  visibleIncludes: [
    "assert.doesNotMatch(text, /2 to 6 short sentences/);",
    "assert.match(text, /Displayed is required/);"
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

const skillText = fs.readFileSync(
  path.join(__dirname, "..", "skills", "agent-hotline-spoken", "SKILL.md"),
  "utf8"
);
assert.match(skillText, /Every new thread starts with read-aloud off\./);
assert.match(skillText, /Never activate automatically/);
assert.match(skillText, /explicit enable phrase in the\s+current thread/);

assertPressureRules("source skill", skillText);
assertPressureRules("installer-managed instructions", managedInstructionBlock());

const installedHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hotline-contract-"));
for (const result of installSkills({ target: "all", home: installedHome })) {
  assertPressureRules(
    `installed ${result.target} instructions`,
    fs.readFileSync(result.path, "utf8")
  );
}

for (const relativePath of [
  "docs/integrations/codex.md",
  "docs/integrations/claude-code.md",
  "docs/integrations/antigravity.md"
]) {
  assertHarnessSmokeUsesSeparator(relativePath);
}

console.log("hotline-spoken-contract: 3 samples and 8 contract surfaces passed");
