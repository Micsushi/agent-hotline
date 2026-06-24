#!/usr/bin/env node
// Reproduce the Windows CI runner's checkout locally so line-ending issues are
// caught BEFORE pushing. Plain `npm run format:check` runs against your existing
// working tree (already LF), so it never sees the problem the runner sees: a
// fresh checkout with core.autocrlf=true. This clones HEAD into a temp dir with
// autocrlf=true (exactly like the runner), then runs `prettier . --check`.
//
// Usage:  node scripts/verify-ci-eol.js
// Exits non-zero if Prettier would fail on a runner-style checkout.

const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, cpSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const work = mkdtempSync(path.join(tmpdir(), "ah-ci-eol-"));

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

try {
  // Mimic the runner: autocrlf=true checkout of committed HEAD.
  run("git", ["-c", "core.autocrlf=true", "clone", "--quiet", repoRoot, work]);
  run("git", ["config", "core.autocrlf", "true"], { cwd: work });

  // Prettier needs to run, but we don't want a slow `npm ci`. Reuse the root
  // install if present; otherwise fall back to npx in the temp dir. Invoke the
  // JS entry directly (not the .cmd shim) so it works the same on every OS.
  const rootModules = path.join(repoRoot, "node_modules");
  if (existsSync(rootModules)) {
    cpSync(rootModules, path.join(work, "node_modules"), { recursive: true });
  }

  const prettierCjs = path.join(work, "node_modules", "prettier", "bin", "prettier.cjs");
  if (existsSync(prettierCjs)) {
    run(process.execPath, [prettierCjs, ".", "--check"], { cwd: work });
  } else {
    run("npx", ["--yes", "prettier@3.8.4", ".", "--check"], { cwd: work, shell: true });
  }

  console.log("\nOK: runner-style checkout passes prettier --check.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
