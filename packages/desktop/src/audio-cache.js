const MEM_MAX_ENTRIES = 16;
const memCache = new Map();

function memKey(itemId, engine, voice, speed = 1) {
  return `${itemId}__${engine}__${voice}__${Number(speed).toFixed(2)}`;
}

function memGet(key) {
  const value = memCache.get(key);
  if (!value) return null;
  memCache.delete(key);
  memCache.set(key, value);
  return value;
}

function memSet(key, value) {
  memCache.delete(key);
  memCache.set(key, value);
  while (memCache.size > MEM_MAX_ENTRIES) {
    memCache.delete(memCache.keys().next().value);
  }
}

export function evictMem(predicate) {
  if (typeof predicate !== "function") {
    memCache.clear();
    return;
  }
  for (const key of [...memCache.keys()]) {
    if (predicate(key)) memCache.delete(key);
  }
}

function evictItems(entries) {
  const itemIds = new Set(entries.map((entry) => entry.itemId).filter(Boolean));
  if (itemIds.size === 0) return;
  evictMem((key) => [...itemIds].some((itemId) => key.startsWith(`${itemId}__`)));
}

export function encodeWav(samples, sampleRate) {
  const length = samples.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const sampleRate = view.getUint32(24, true);

  let offset = 12;
  let dataOffset = 44;
  let dataLength = arrayBuffer.byteLength - 44;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  const count = Math.floor(dataLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000;
  }
  return { samples, sampleRate };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let genTail = Promise.resolve();

export function withGenLock(fn) {
  const run = genTail.then(fn, fn);
  genTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function fetchBackendCached(backendUrl, itemId, engine, voice) {
  const query = `engine=${encodeURIComponent(engine)}&voice=${encodeURIComponent(voice)}`;
  const id = encodeURIComponent(itemId);
  const manifestResp = await fetch(`${backendUrl}/api/queue/${id}/audio?${query}`, {
    cache: "no-store"
  });
  if (!manifestResp.ok) return null;
  const manifest = await manifestResp.json();
  if (!manifest.cached) return null;

  const wavResp = await fetch(`${backendUrl}/api/queue/${id}/audio.wav?${query}`, {
    cache: "no-store"
  });
  if (!wavResp.ok) return null;
  const { samples, sampleRate } = decodeWav(await wavResp.arrayBuffer());
  return {
    samples,
    sampleRate: manifest.sampleRate || sampleRate,
    segments: Array.isArray(manifest.segments) ? manifest.segments : [],
    wordAccurate: Boolean(manifest.wordAccurate)
  };
}

export async function getCachedAudio(backendUrl, { itemId, engine, voice, speed = 1 }) {
  const key = memKey(itemId, engine, voice, speed);

  const cachedMem = memGet(key);
  if (cachedMem) return cachedMem;
  if (Number(speed) !== 1) return null;

  const fromBackend = await fetchBackendCached(backendUrl, itemId, engine, voice);
  if (fromBackend) {
    memSet(key, fromBackend);
    return fromBackend;
  }
  return null;
}

export async function storeCached(backendUrl, { itemId, engine, voice }, generated) {
  const wavBuffer = encodeWav(generated.samples, generated.sampleRate);
  const body = JSON.stringify({
    sampleRate: generated.sampleRate,
    durationSec: generated.samples.length / generated.sampleRate,
    wordAccurate: Boolean(generated.wordAccurate),
    segments: Array.isArray(generated.segments) ? generated.segments : [],
    wav: bytesToBase64(new Uint8Array(wavBuffer))
  });
  const query = `engine=${encodeURIComponent(engine)}&voice=${encodeURIComponent(voice)}`;
  const id = encodeURIComponent(itemId);
  const response = await fetch(`${backendUrl}/api/queue/${id}/audio?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function cacheGeneratedAudio(backendUrl, target, generated) {
  const speed = "speed" in target ? target.speed : 1;
  const key = memKey(target.itemId, target.engine, target.voice, speed);
  memSet(key, generated);
  if (Number(speed) === 1) {
    try {
      await storeCached(backendUrl, target, generated);
    } catch {}
  }
  return generated;
}

const inFlight = new Map();

export async function getAudio(backendUrl, { itemId, engine, voice, speed = 1 }, generate) {
  const target = { itemId, engine, voice, speed };
  const key = memKey(itemId, engine, voice, speed);

  const cached = await getCachedAudio(backendUrl, target).catch(() => null);
  if (cached) return cached;

  if (inFlight.has(key)) return inFlight.get(key);

  // Only the canonical 1x render is persisted to the backend cache. Sped-up
  // variants (generated natively for high playback rates) differ in samples and
  // segment timing, so they live in the in-memory LRU only and regenerate on
  // demand when a speed band is re-entered.
  const promise = (async () => {
    const generated = await generate();
    return cacheGeneratedAudio(backendUrl, target, generated);
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

export async function listCache(backendUrl) {
  const response = await fetch(`${backendUrl}/api/audio-cache`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function deleteCacheAll(backendUrl) {
  evictMem();
  const response = await fetch(`${backendUrl}/api/audio-cache?all=true`, { method: "DELETE" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function deleteCacheSession(backendUrl, sessionKey) {
  const before = await listCache(backendUrl);
  const response = await fetch(
    `${backendUrl}/api/audio-cache?session=${encodeURIComponent(sessionKey)}`,
    { method: "DELETE" }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  evictItems((before.entries || []).filter((entry) => entry.sessionKey === sessionKey));
  return result;
}

export async function deleteCacheProject(backendUrl, projectKey) {
  const before = await listCache(backendUrl);
  const response = await fetch(
    `${backendUrl}/api/audio-cache?project=${encodeURIComponent(projectKey)}`,
    { method: "DELETE" }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  evictItems((before.entries || []).filter((entry) => entry.projectKey === projectKey));
  return result;
}

export async function deleteCacheItem(backendUrl, itemId, engine, voice) {
  const params = new URLSearchParams();
  if (engine) params.set("engine", engine);
  if (voice) params.set("voice", voice);
  evictMem((key) => key.startsWith(`${itemId}__`));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(
    `${backendUrl}/api/audio-cache/${encodeURIComponent(itemId)}${suffix}`,
    { method: "DELETE" }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
