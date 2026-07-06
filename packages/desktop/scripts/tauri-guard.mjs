import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "dev") {
  console.error("Raw Agent Hotline Tauri dev is disabled for desktop lifecycle safety.");
  console.error("Use npm run dev or npm run restart from the repo root.");
  process.exit(1);
}

const bin = process.platform === "win32" ? "tauri.cmd" : "tauri";
const env = { ...process.env };
const cargoCheck = spawnSync("cargo", ["--version"], {
  encoding: "utf8",
  windowsHide: true
});

if (cargoCheck.error && cargoCheck.error.code === "ENOENT") {
  const cargoPath = spawnSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (!cargoPath.error && cargoPath.status === 0 && cargoPath.stdout.trim()) {
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    env[pathKey] =
      `${dirname(cargoPath.stdout.trim())}${process.platform === "win32" ? ";" : ":"}${env[pathKey] || ""}`;
  }
}

const result = spawnSync(bin, args, {
  env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
