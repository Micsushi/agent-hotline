#!/usr/bin/env node

import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    env: options.env || process.env,
    stdio: "inherit",
    windowsHide: true
  });
}

const cargoArgs = process.argv.slice(2);
let result = run("cargo", cargoArgs);

if (result.error && result.error.code === "ENOENT") {
  const cargoPath = spawnSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (!cargoPath.error && cargoPath.status === 0 && cargoPath.stdout.trim()) {
    const cargoBin = dirname(cargoPath.stdout.trim());
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    result = run(cargoPath.stdout.trim(), cargoArgs, {
      env: {
        ...process.env,
        [pathKey]: `${cargoBin}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey] || ""}`
      }
    });
  } else {
    result = run("rustup", ["run", "stable", "cargo", ...cargoArgs]);
  }
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
