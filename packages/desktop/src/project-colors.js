// Per-project colour: each project row in the Chats/Storage trees carries a
// colour swatch + left accent stripe. Colours resolve in three tiers:
//   1. user override   (right-click -> pick, persisted in localStorage)
//   2. branded default (Codex / Antigravity / Claude / Gemini have set looks)
//   3. deterministic    (hash the project key into a stable hue, so a project
//                        keeps the same "random" colour across reloads)
//
// A colour value is either a hex string (e.g. "#7c6cf0") or the literal token
// "rainbow", which renders as a multi-hue gradient.

const STORAGE_KEY = "agent-hotline.project-colors";
export const RAINBOW = "rainbow";

// Branded looks keyed by project label / harness name (case-insensitive).
const BRANDED = {
  codex: "#7c6cf0", // blueish purple
  antigravity: RAINBOW, // rainbow + white
  claude: "#d97757",
  gemini: "#4f8cf0"
};

// AI-type (harness owner) colours. Sessions are coloured by the harness that
// owns them, matching the owner-badge chip palette. Antigravity stays rainbow.
const OWNER_COLORS = {
  Codex: "#5bd6a6",
  Claude: "#f0a98a",
  Antigravity: RAINBOW,
  Gemini: "#7aa2f7"
};

// Discrete palette offered in the right-click menu (plus rainbow + reset).
export const SWATCHES = [
  "#7c6cf0",
  "#4f8cf0",
  "#2dd4bf",
  "#34d399",
  "#a3e635",
  "#facc15",
  "#fb923c",
  "#f87171",
  "#f472b6",
  "#c084fc",
  "#94a3b8",
  RAINBOW
];

const RAINBOW_SWATCH =
  "conic-gradient(from 0deg, #f87171, #facc15, #34d399, #38bdf8, #c084fc, #f472b6, #f87171)";
const RAINBOW_STRIPE =
  "linear-gradient(180deg, #f87171, #facc15, #34d399, #38bdf8, #c084fc, #f472b6)";

let overrides = load();

function load() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {}
}

// FNV-1a hash -> hue, so a given project key always lands on the same colour.
function hashHue(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

function deterministicColor(key) {
  const hue = hashHue(key);
  return `hsl(${hue} 62% 60%)`;
}

// Resolve the active colour for a project (override > branded > deterministic).
export function colorForProject(project) {
  const key = project.key;
  if (overrides[key]) return overrides[key];
  const branded =
    BRANDED[
      String(project.label || "")
        .trim()
        .toLowerCase()
    ];
  if (branded) return branded;
  return deterministicColor(key);
}

export function isOverridden(key) {
  return Boolean(overrides[key]);
}

export function setProjectColor(key, color) {
  overrides[key] = color;
  persist();
}

export function clearProjectColor(key) {
  delete overrides[key];
  persist();
}

// CSS background for a swatch / stripe given a colour value.
export function swatchBackground(color) {
  return color === RAINBOW ? RAINBOW_SWATCH : color;
}

export function stripeBackground(color) {
  return color === RAINBOW ? RAINBOW_STRIPE : color;
}

// Paint a tree-item's left accent stripe a given colour value.
function paintStripe(treeItem, color) {
  treeItem.style.setProperty("--project-color", color === RAINBOW ? "#c084fc" : color);
  treeItem.style.setProperty("--project-stripe", stripeBackground(color));
  treeItem.classList.add("has-project-color");
}

// Project rows: stripe = the project's own (override/branded/random) colour.
export function applyProjectColor(treeItem, project) {
  paintStripe(treeItem, colorForProject(project));
}

export function colorForOwner(owner) {
  return OWNER_COLORS[owner] || "#718195";
}

// Session rows: stripe = the AI type (harness owner) colour.
export function applyOwnerColor(treeItem, owner) {
  paintStripe(treeItem, colorForOwner(owner));
}
