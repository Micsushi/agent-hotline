import { spawn } from "node:child_process";

if (process.env.AGENT_HOTLINE_LIFECYCLE !== "1") {
  console.error(
    "Agent Hotline UI dev is managed by the root lifecycle. Use npm run dev or npm run restart from the repo root."
  );
  process.exit(1);
}

await import("./write-runtime-config.mjs");

const child = spawn(
  process.platform === "win32" ? "vite.cmd" : "vite",
  ["--host", "127.0.0.1", "--port", "4778", "--strictPort"],
  {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
