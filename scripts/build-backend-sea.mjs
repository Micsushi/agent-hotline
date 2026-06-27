// Build a self-contained backend executable (Node Single Executable Application)
// for the desktop installer. The backend has no third-party runtime deps, so we
// bundle its source into one CJS file with esbuild, generate a SEA blob, and
// inject it into a copy of the Node runtime with postject. The result is dropped
// where Tauri's externalBin expects it (suffixed with the target triple).
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "packages", "backend");
const workDir = path.join(backend, "build");
const binDir = path.join(root, "packages", "desktop", "src-tauri", "binaries");

const isWin = process.platform === "win32";
const triple = process.env.SEA_TARGET_TRIPLE || "x86_64-pc-windows-msvc";
const exeSuffix = isWin ? ".exe" : "";
const outExe = path.join(binDir, `agent-hotline-backend-${triple}${exeSuffix}`);

const bundlePath = path.join(workDir, "backend-bundle.cjs");
const blobPath = path.join(workDir, "backend.blob");
const seaConfigPath = path.join(workDir, "sea-config.json");

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // 1. Bundle the backend entry + its source into a single CJS file.
  await build({
    entryPoints: [path.join(backend, "sea-entry.cjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: bundlePath,
    logLevel: "info"
  });

  // 2. Generate the SEA blob from the bundle.
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true },
      null,
      2
    )
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit"
  });

  // 3. Copy the Node runtime and inject the blob via postject's API (avoids
  // spawning the npx shim, which is awkward to invoke cross-platform).
  copyFileSync(process.execPath, outExe);
  await inject(outExe, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined
  });

  if (!existsSync(outExe)) {
    throw new Error(`SEA build did not produce ${outExe}`);
  }
  console.log(`Built self-contained backend -> ${path.relative(root, outExe)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
