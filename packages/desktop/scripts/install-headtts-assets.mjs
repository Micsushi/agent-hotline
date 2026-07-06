import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

const ALL_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis"
];

const VOICE_BASE_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_MODEL_BASE_URL = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main`;
const KOKORO_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model.onnx",
  "onnx/model_quantized.onnx"
];

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(root, "public/headtts");
const voicesRoot = join(outputRoot, "voices");
const kokoroModelsRoot = resolve(root, "public/models", KOKORO_MODEL_ID);
const kokoroVoicesRoot = resolve(root, "public/kokoro-voices");
const headttsRoot = dirname(require.resolve("@met4citizen/headtts/package.json"));
const kokoroRoot = resolve(dirname(require.resolve("kokoro-js")), "..");

function optionValue(name) {
  const match = process.argv.find((arg) => arg === name || arg.startsWith(`${name}=`));
  if (!match) return null;
  if (match === name) return "true";
  return match.slice(name.length + 1);
}

function selectedVoices() {
  const raw = optionValue("--voices") || process.env.AGENT_HOTLINE_HEADTTS_VOICES || "all";
  if (raw === "all") return ALL_VOICES;
  if (raw === "none") return [];

  const voices = raw
    .split(",")
    .map((voice) => voice.trim())
    .filter(Boolean);
  const unknown = voices.filter((voice) => !ALL_VOICES.includes(voice));
  if (unknown.length > 0) {
    throw new Error(`Unknown HeadTTS voice(s): ${unknown.join(", ")}`);
  }
  return voices;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyDir(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function downloadVoice(voice) {
  const filePath = join(voicesRoot, `${voice}.bin`);
  if (await exists(filePath)) {
    console.log(`HeadTTS voice already present: ${voice}`);
    return;
  }

  const url = `${VOICE_BASE_URL}/${voice}.bin`;
  console.log(`Downloading HeadTTS voice: ${voice}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, bytes);
}

async function downloadFile(url, filePath, label) {
  if (await exists(filePath)) {
    console.log(`${label} already present.`);
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  console.log(`Downloading ${label}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, bytes);
}

async function installKokoroAssets() {
  if (process.env.AGENT_HOTLINE_SKIP_KOKORO_INSTALL === "1") {
    console.log("Skipping Kokoro asset install.");
    return;
  }

  for (const file of KOKORO_MODEL_FILES) {
    await downloadFile(
      `${KOKORO_MODEL_BASE_URL}/${file}`,
      join(kokoroModelsRoot, file),
      `Kokoro model asset: ${file}`
    );
  }

  await mkdir(kokoroVoicesRoot, { recursive: true });
  await copyDir(join(kokoroRoot, "voices"), kokoroVoicesRoot);
}

if (process.env.AGENT_HOTLINE_SKIP_HEADTTS_INSTALL === "1") {
  console.log("Skipping HeadTTS asset install.");
  process.exit(0);
}

await mkdir(outputRoot, { recursive: true });
await mkdir(voicesRoot, { recursive: true });
await copyDir(join(headttsRoot, "modules"), join(outputRoot, "modules"));
await copyDir(join(headttsRoot, "dictionaries"), join(outputRoot, "dictionaries"));
await copyFile(join(headttsRoot, "LICENSE"), join(outputRoot, "LICENSE-HeadTTS"));
await writeFile(
  join(outputRoot, "headtts-global.mjs"),
  [
    'import { HeadTTS } from "./modules/headtts.mjs";',
    "window.__AgentHotlineHeadTTS = HeadTTS;",
    'window.dispatchEvent(new CustomEvent("agent-hotline-headtts-loaded"));',
    ""
  ].join("\n"),
  "utf8"
);

for (const voice of selectedVoices()) {
  await downloadVoice(voice);
}
await installKokoroAssets();

console.log("HeadTTS assets are ready.");
