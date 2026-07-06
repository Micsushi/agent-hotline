const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile: execFileCallback } = require("child_process");

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileCallback(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function scoreMacosVoice(name, lang) {
  const haystack = `${name || ""} ${lang || ""}`.toLowerCase();
  if (/\b(online|cloud|remote|network|google)\b/.test(haystack)) return -10_000;

  let score = 0;

  if (haystack.includes("en_us") || haystack.includes("en-us")) score += 50;
  if (haystack.includes("english (us)")) score += 45;
  if (haystack.includes("en_gb") || haystack.includes("en-gb")) score += 25;
  if (haystack.includes("english")) score += 20;

  if (haystack.includes("alex")) score += 120;
  if (haystack.includes("samantha") && haystack.includes("enhanced")) score += 115;
  else if (haystack.includes("samantha")) score += 105;
  if (haystack.includes("ava") && haystack.includes("enhanced")) score += 100;
  else if (haystack.includes("ava")) score += 90;
  if (haystack.includes("tom") && haystack.includes("enhanced")) score += 85;
  else if (haystack.includes("tom")) score += 75;
  if (haystack.includes("zoe") && haystack.includes("premium")) score += 70;
  else if (haystack.includes("zoe")) score += 65;

  if (haystack.includes("natural")) score += 15;
  if (haystack.includes("enhanced")) score += 10;
  if (haystack.includes("premium")) score += 5;

  if (haystack.includes("siri")) score -= 500;
  if (haystack.includes("flo")) score -= 50;
  if (haystack.includes("shelley")) score -= 50;
  if (haystack.includes("reed")) score -= 50;
  if (haystack.includes("rocko")) score -= 50;
  if (haystack.includes("eddy")) score -= 50;
  if (haystack.includes("grandma")) score -= 50;
  if (haystack.includes("grandpa")) score -= 50;
  if (haystack.includes("sandy")) score -= 50;
  if (haystack.includes("bad news")) score -= 200;
  if (haystack.includes("bahh")) score -= 200;
  if (haystack.includes("bells")) score -= 200;
  if (haystack.includes("boing")) score -= 200;
  if (haystack.includes("bubbles")) score -= 200;
  if (haystack.includes("cellos")) score -= 200;
  if (haystack.includes("jester")) score -= 200;
  if (haystack.includes("organ")) score -= 200;
  if (haystack.includes("superstar")) score -= 200;
  if (haystack.includes("trinoids")) score -= 200;
  if (haystack.includes("whisper")) score -= 200;
  if (haystack.includes("zarvox")) score -= 200;

  return score;
}

function parseMacosVoices(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(.+?)\s+([a-z]{2}(?:_[A-Z0-9]+)?)\s+#\s*(.*)$/);
      if (!match) return null;
      const name = match[1].trim();
      const lang = match[2].trim();
      return {
        name,
        lang,
        sample: match[3].trim(),
        score: scoreMacosVoice(name, lang)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function selectMacosVoice(voices, preferredName) {
  const requested = String(preferredName || "").trim();
  if (requested) {
    const exact = voices.find((voice) => voice.name === requested);
    if (exact) return exact.name;
    return requested;
  }
  return voices.find((voice) => Number(voice.score) > -10_000)?.name || "";
}

function parseWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    return { sampleRate: 24000, durationSec: 0 };
  }

  const sampleRate = buffer.readUInt32LE(24);
  const bytesPerSecond = buffer.readUInt32LE(28);
  let offset = 12;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  return {
    sampleRate: Number(sampleRate) || 24000,
    durationSec: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0
  };
}

function createNativeTts(options = {}) {
  const platform = options.platform || process.platform;
  const execFile = options.execFile || execFileAsync;
  const tmpRoot = options.tmpRoot || os.tmpdir();

  async function generateMacos({ text, voice, rate }) {
    if (platform !== "darwin") {
      const error = new Error("macOS native speech is only available on macOS.");
      error.code = "unsupported_platform";
      throw error;
    }

    const speakableText = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!speakableText) {
      const error = new Error("text must be a non-empty string");
      error.code = "invalid_request";
      throw error;
    }

    const dir = fs.mkdtempSync(path.join(tmpRoot, "agent-hotline-tts-"));
    const aiffPath = path.join(dir, "speech.aiff");
    const wavPath = path.join(dir, "speech.wav");
    const wpm = Math.round(175 * clampNumber(rate, 0.9, 0.1, 10));

    let resolvedVoice = typeof voice === "string" && voice.trim() ? voice.trim() : "";
    if (!resolvedVoice) {
      try {
        resolvedVoice = selectMacosVoice(await listMacosVoices(), "");
      } catch {
        resolvedVoice = "";
      }
    }

    const sayArgs = [];
    if (resolvedVoice) {
      sayArgs.push("-v", resolvedVoice);
    }
    sayArgs.push("-r", String(wpm), "-o", aiffPath, speakableText);

    try {
      await execFile("say", sayArgs);
      await execFile("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", aiffPath, wavPath]);
      const wavBuffer = fs.readFileSync(wavPath);
      const info = parseWavInfo(wavBuffer);
      return {
        wavBuffer,
        sampleRate: info.sampleRate,
        durationSec: info.durationSec,
        segments: [{ text: speakableText, startSec: 0, endSec: info.durationSec }],
        wordAccurate: false,
        voice: resolvedVoice || "default"
      };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  async function listMacosVoices() {
    if (platform !== "darwin") return [];
    const { stdout } = await execFile("say", ["-v", "?"]);
    return parseMacosVoices(stdout);
  }

  return {
    generateMacos,
    listMacosVoices
  };
}

module.exports = {
  createNativeTts,
  parseMacosVoices,
  parseWavInfo
};
