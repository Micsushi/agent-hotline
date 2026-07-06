import { dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";

if (process.env.AGENT_HOTLINE_LIFECYCLE !== "1") {
  console.error(
    "Agent Hotline desktop dev is managed by the root lifecycle. Use npm run dev or npm run restart from the repo root."
  );
  process.exit(1);
}

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

const child = spawn(process.platform === "win32" ? "tauri.cmd" : "tauri", ["dev"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
