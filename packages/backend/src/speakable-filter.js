const SPOKEN_HEADING = /^\s*Spoken\s*:\s*$/imu;
const SECTION_HEADING =
  /^\s*(Displayed|Display|Details|Detail|Code|Commands?|Logs?|Output)\s*:\s*$/imu;
const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`\n]{1,120})`/g;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const STACK_TRACE = /^\s*at\s+\S.*\([^)]+:\d+:\d+\)\s*$/;
const LOG_LINE = /^\s*(?:\[[^\]]+\]\s*)?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i;
const DIFF_LINE = /^\s*(?:diff --git|index [a-f0-9]|@@\s|[-+]{3}\s|[-+](?![-+]))/;

function filterSpeakableText(input) {
  if (typeof input !== "string" || input.trim() === "") {
    return skipResult();
  }

  const spoken = extractSpokenSection(input);
  if (spoken) {
    const text = normalizeSpeakableText(removeUnsafeBlocks(spoken));
    if (isSpeakable(text)) {
      return {
        shouldSpeak: true,
        text,
        reason: "spoken_section",
        source: "spoken"
      };
    }
  }

  const text = normalizeSpeakableText(removeUnsafeBlocks(input));
  if (!isSpeakable(text)) {
    return skipResult();
  }

  return {
    shouldSpeak: true,
    text,
    reason: "speakable_text",
    source: "prose"
  };
}

function skipResult() {
  return {
    shouldSpeak: false,
    text: "",
    reason: "no_speakable_text",
    source: "filtered"
  };
}

function extractSpokenSection(input) {
  const match = SPOKEN_HEADING.exec(input);
  if (!match) {
    return "";
  }

  const start = match.index + match[0].length;
  const rest = input.slice(start);
  const nextSection = SECTION_HEADING.exec(rest);
  return (nextSection ? rest.slice(0, nextSection.index) : rest).trim();
}

function removeUnsafeBlocks(input) {
  const withoutFences = input.replace(FENCED_BLOCK, "\n");
  const lines = withoutFences.split(/\r?\n/);
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (isJsonBlockStart(line)) {
      index = skipJsonBlock(lines, index);
      continue;
    }

    if (isLongBulletListAt(lines, index)) {
      index = skipLineRun(lines, index, (candidate) => BULLET.test(candidate));
      continue;
    }

    if (shouldSkipLine(line)) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(INLINE_CODE, "$1");
}

function shouldSkipLine(line) {
  return (
    TABLE_SEPARATOR.test(line) ||
    TABLE_ROW.test(line) ||
    DIFF_LINE.test(line) ||
    LOG_LINE.test(line) ||
    STACK_TRACE.test(line) ||
    looksLikeJsonLine(line)
  );
}

function isLongBulletListAt(lines, start) {
  if (!BULLET.test(lines[start])) {
    return false;
  }

  let count = 0;
  for (let index = start; index < lines.length && BULLET.test(lines[index]); index += 1) {
    count += 1;
  }

  return count >= 6;
}

function skipLineRun(lines, start, predicate) {
  let index = start;
  while (index + 1 < lines.length && predicate(lines[index + 1])) {
    index += 1;
  }
  return index;
}

function isJsonBlockStart(line) {
  return /^\s*[{[]\s*$/.test(line);
}

function skipJsonBlock(lines, start) {
  let depth = 0;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    depth += countMatches(line, /[{[]/g);
    depth -= countMatches(line, /[}\]]/g);

    if (depth <= 0 && index > start) {
      return index;
    }
  }

  return start;
}

function countMatches(value, pattern) {
  return (value.match(pattern) || []).length;
}

function looksLikeJsonLine(line) {
  return /^\s*"[^"]+"\s*:/.test(line) || /^\s*[}\]],?\s*$/.test(line);
}

function normalizeSpeakableText(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSpeakable(text) {
  if (!text) {
    return false;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) {
    return false;
  }

  return !/:\s*$/.test(text);
}

module.exports = {
  filterSpeakableText
};
