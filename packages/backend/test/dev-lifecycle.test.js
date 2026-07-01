const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const rootPackage = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "package.json"), "utf8")
);
const desktopPackage = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "packages", "desktop", "package.json"),
    "utf8"
  )
);

test("root dev lifecycle uses one orchestrated backend plus desktop command", () => {
  assert.equal(rootPackage.scripts.dev, "node scripts/dev-lifecycle.mjs");
  assert.equal(rootPackage.scripts.restart, "node scripts/dev-lifecycle.mjs");
  assert.equal(rootPackage.scripts.start, "npm run dev");
});

test("old split dev commands are hard-disabled", () => {
  assert.equal(
    rootPackage.scripts["dev:backend"],
    "node scripts/split-dev-command.mjs dev:backend"
  );
  assert.equal(
    rootPackage.scripts["dev:desktop"],
    "node scripts/split-dev-command.mjs dev:desktop"
  );
});

test("desktop workspace dev commands are guarded behind root lifecycle", () => {
  assert.equal(desktopPackage.scripts.dev, "node scripts/guarded-dev.mjs");
  assert.equal(desktopPackage.scripts["dev:ui"], "node scripts/guarded-ui-dev.mjs");
  assert.equal(desktopPackage.scripts.tauri, "node scripts/tauri-guard.mjs");
});
