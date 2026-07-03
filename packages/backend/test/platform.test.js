const assert = require("assert/strict");
const test = require("node:test");

const { defaultSeaTargetTriple } = require("../src/platform");

test("defaultSeaTargetTriple maps macOS architectures", () => {
  assert.equal(defaultSeaTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(defaultSeaTargetTriple("darwin", "x64"), "x86_64-apple-darwin");
});

test("defaultSeaTargetTriple maps Windows architecture", () => {
  assert.equal(defaultSeaTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
});
