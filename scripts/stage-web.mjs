// Stage the built desktop UI into packages/backend/web for the npm package.
// Copies everything except the heavy local-TTS assets (Kokoro model + ONNX
// wasm) so the published package stays light; the browser UI still works with
// browser TTS, and the native installer keeps the full assets. Runs on prepack.
import { rm, mkdir, cp, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "packages", "desktop", "dist");
const out = path.join(root, "packages", "backend", "web");

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

if (!(await isFile(path.join(dist, "index.html")))) {
  execSync("npm run build:ui --workspace @agent-hotline/desktop", {
    cwd: root,
    stdio: "inherit"
  });
}

// Heavy local-TTS assets excluded from the light npm bundle: the Kokoro model
// chunk, the ONNX runtime wasm, and the bundled HeadTTS voices/dictionaries.
// Browser TTS needs none of these; the native installer keeps the full set.
const HEAVY_FILE = /^kokoro-|\.wasm$/;

function included(src) {
  const rel = path.relative(dist, src);
  if (rel === "headtts" || rel.startsWith(`headtts${path.sep}`)) return false;
  return !HEAVY_FILE.test(path.basename(src));
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(dist, out, { recursive: true, filter: included });

console.log(`Staged web UI -> ${path.relative(root, out)} (excluded heavy TTS assets)`);
