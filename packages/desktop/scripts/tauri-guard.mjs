import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "dev") {
  console.error("Raw Agent Hotline Tauri dev is disabled for desktop lifecycle safety.");
  console.error("Use npm run dev or npm run restart from the repo root.");
  process.exit(1);
}

const bin = process.platform === "win32" ? "tauri.cmd" : "tauri";
const result = spawnSync(bin, args, {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
