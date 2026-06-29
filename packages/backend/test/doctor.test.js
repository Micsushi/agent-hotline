const assert = require("assert");
const path = require("path");
const test = require("node:test");

const {
  createDoctorReport,
  formatDoctorReport,
  globalBinFromPrefix,
  npmGlobalPrefix,
  pathContains
} = require("../src/doctor");
const { main: cliMain } = require("../bin/agent-hotline");

test("globalBinFromPrefix uses npm prefix directly on Windows", () => {
  assert.equal(
    globalBinFromPrefix(String.raw`C:\Users\Someone\AppData\Roaming\npm`, "win32"),
    String.raw`C:\Users\Someone\AppData\Roaming\npm`
  );
});

test("globalBinFromPrefix appends bin on Unix-like platforms", () => {
  assert.equal(globalBinFromPrefix("/usr/local", "linux"), path.join("/usr/local", "bin"));
});

test("pathContains matches Windows PATH case-insensitively", () => {
  assert.equal(
    pathContains(
      String.raw`C:\Users\Someone\AppData\Roaming\npm`,
      String.raw`C:\WINDOWS;C:\Users\someone\AppData\Roaming\npm`,
      "win32"
    ),
    true
  );
});

test("npmGlobalPrefix falls back to AppData npm dir on Windows", () => {
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = String.raw`C:\Users\Someone\AppData\Roaming`;

  try {
    const prefix = npmGlobalPrefix({
      platform: "win32",
      spawnSync() {
        return { status: 1, error: new Error("npm missing") };
      }
    });
    assert.equal(prefix, String.raw`C:\Users\Someone\AppData\Roaming\npm`);
  } finally {
    if (oldAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = oldAppData;
    }
  }
});

test("doctor report includes first-run commands", () => {
  const report = createDoctorReport({
    platform: "win32",
    prefix: String.raw`C:\Users\Someone\AppData\Roaming\npm`,
    pathValue: String.raw`C:\Windows`
  });
  const text = formatDoctorReport(report);

  assert.match(text, /npm global bin on PATH: no/);
  assert.match(text, /install --harness all --skill all/);
  assert.match(text, /releases\/latest/);
});

test("CLI exposes doctor command", async () => {
  const code = await cliMain(["doctor"]);
  assert.equal(code, 0);
});
