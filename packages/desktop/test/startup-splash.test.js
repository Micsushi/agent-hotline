import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");

function cssBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing CSS block for ${selector}`);
  const bodyStart = styles.indexOf("{", start) + 1;
  const bodyEnd = styles.indexOf("\n}", bodyStart);
  return styles.slice(bodyStart, bodyEnd);
}

test("startup splash does not replay an opacity-zero entrance animation after inline paint", () => {
  assert.equal(cssBlock(".startup-splash").includes("animation:"), false);
  assert.equal(cssBlock(".startup-image").includes("splash-pop"), false);
  assert.equal(styles.includes("@keyframes splash-backdrop-in"), false);
  assert.equal(styles.includes("@keyframes splash-pop"), false);
});
