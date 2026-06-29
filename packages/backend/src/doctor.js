const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function globalBinFromPrefix(prefix, platform = process.platform) {
  const trimmed = String(prefix || "").trim();
  if (!trimmed) return "";
  return platform === "win32" ? trimmed : path.join(trimmed, "bin");
}

function npmGlobalPrefix(options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const platform = options.platform || process.platform;
  const result = spawnSyncImpl("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    if (platform === "win32" && process.env.APPDATA) {
      return path.join(process.env.APPDATA, "npm");
    }
    return "";
  }
  return String(result.stdout || "").trim();
}

function pathEntries(value = process.env.PATH || "") {
  return String(value)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pathContains(dir, value = process.env.PATH || "", platform = process.platform) {
  const normalize =
    platform === "win32" ? (entry) => entry.toLowerCase().replace(/[\\/]+$/, "") : (entry) => entry;
  const target = normalize(dir);
  return pathEntries(value).some((entry) => normalize(entry) === target);
}

function windowsPathFixCommand(binDir) {
  const escaped = String(binDir).replace(/'/g, "''");
  return [
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    `$bin = '${escaped}'`,
    "if ($null -eq $userPath) { $userPath = '' }",
    "if (($userPath -split ';') -notcontains $bin) {",
    "  $nextPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $bin } else { $userPath.TrimEnd(';') + ';' + $bin }",
    "  [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')",
    "}",
    "Write-Host 'Restart your terminal after updating PATH.'"
  ].join("; ");
}

function fixWindowsUserPath(binDir, options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsPathFixCommand(binDir)],
    {
      encoding: "utf8",
      windowsHide: true
    }
  );
  return {
    ok: !result.error && result.status === 0,
    error: result.error ? result.error.message : String(result.stderr || "").trim()
  };
}

function createDoctorReport(options = {}) {
  const platform = options.platform || process.platform;
  const prefix = options.prefix || npmGlobalPrefix(options);
  const binDir = globalBinFromPrefix(prefix, platform);
  const onPath = binDir
    ? pathContains(binDir, options.pathValue || process.env.PATH || "", platform)
    : false;
  const hasGlobalInstall = !!options.hasGlobalInstall;

  return {
    platform,
    node: process.version,
    prefix,
    binDir,
    onPath,
    hasGlobalInstall,
    pathFixCommand: platform === "win32" && binDir ? windowsPathFixCommand(binDir) : ""
  };
}

function formatDoctorReport(report) {
  const lines = [
    "Agent Hotline doctor",
    `Node: ${report.node}`,
    `npm global bin: ${report.binDir || "not found"}`,
    `npm global bin on PATH: ${report.onPath ? "yes" : "no"}`,
    ""
  ];

  if (!report.onPath && report.platform === "win32" && report.pathFixCommand) {
    lines.push("To add npm global commands like ah to PATH:");
    lines.push(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${report.pathFixCommand.replace(/"/g, '\\"')}"`
    );
    lines.push("");
  }

  lines.push("Recommended first run:");
  lines.push("  npx --yes @micsushi/agent-hotline install --harness all --skill all");
  lines.push("  npx --yes @micsushi/agent-hotline run");

  if (report.platform === "win32") {
    lines.push("");
    lines.push("Windows desktop installer:");
    lines.push("  https://github.com/Micsushi/agent-hotline/releases/latest");
  }

  return lines.join(os.EOL);
}

module.exports = {
  createDoctorReport,
  fixWindowsUserPath,
  formatDoctorReport,
  globalBinFromPrefix,
  npmGlobalPrefix,
  pathContains,
  windowsPathFixCommand
};
