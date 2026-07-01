import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEALTH_URL = process.env.AGENT_HOTLINE_URL || "http://127.0.0.1:4777/health";

function runPowerShell(script, { allowFailure = false } = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: ROOT,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "PowerShell command failed.";
    if (allowFailure) {
      if (detail.trim() !== "PowerShell command failed.") {
        console.log(`Agent Hotline cleanup warning: ${detail.trim()}`);
      }
      return result.stdout.trim();
    }
    throw new Error(detail.trim());
  }

  return result.stdout.trim();
}

function stopWindowsProcesses() {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$self = $PID
$ancestorIds = @{}
$cursor = $self
while ($cursor) {
  $ancestorIds[$cursor] = $true
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
  if ($null -eq $proc -or $null -eq $proc.ParentProcessId -or $ancestorIds.ContainsKey($proc.ParentProcessId)) { break }
  $cursor = $proc.ParentProcessId
}
$matches = Get-CimInstance Win32_Process | Where-Object {
  -not ($ancestorIds.ContainsKey($_.ProcessId)) -and
  (
    $_.ExecutablePath -like "*\agent-hotline\packages\desktop\src-tauri\target\debug\agent-hotline-desktop.exe" -or
    $_.CommandLine -like "*backend/src/server.js*" -or
    ($_.CommandLine -like "*@agent-hotline/desktop run dev*" -and $_.CommandLine -like "*agent-hotline*") -or
    ($_.CommandLine -like "*@tauri-apps*tauri.js* dev*" -and $_.CommandLine -like "*agent-hotline*") -or
    ($_.CommandLine -like "*vite*--port 4778*" -and $_.CommandLine -like "*agent-hotline*")
  )
}
foreach ($process in $matches) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
$matches | ForEach-Object { "$($_.ProcessId) $($_.Name)" }
`;
  const stopped = runPowerShell(script, { allowFailure: true });
  if (stopped) {
    console.log(`Stopped old Agent Hotline processes:\n${stopped}`);
  } else {
    console.log("No old Agent Hotline processes were running.");
  }
}

async function waitForBackend() {
  const deadline = Date.now() + 60_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL, { cache: "no-store" });
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(500);
  }

  throw new Error(`Backend did not become healthy at ${HEALTH_URL}: ${lastError}`);
}

function startDesktopDev() {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm --workspace @agent-hotline/desktop run dev"]
      : ["--workspace", "@agent-hotline/desktop", "run", "dev"];
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
}

async function main() {
  if (process.platform === "win32") {
    stopWindowsProcesses();
  } else {
    console.warn("Automatic process cleanup is currently implemented for Windows dev only.");
  }

  startDesktopDev();
  await waitForBackend();
  console.log(`Agent Hotline backend is healthy at ${HEALTH_URL}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
