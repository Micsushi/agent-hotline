const STORAGE_KEY = "agent-hotline.project-colors";
export const RAINBOW = "rainbow";

const BRANDED = {
  codex: "#4f8cf0",
  antigravity: RAINBOW,
  claude: "#d97757",
  gemini: "#4f8cf0"
};

const OWNER_COLORS = {
  Codex: "#4f8cf0",
  Claude: "#ef7d3a",
  Antigravity: RAINBOW,
  Gemini: "#7aa2f7"
};

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

export function swatchBackground(color) {
  return color === RAINBOW ? RAINBOW_SWATCH : color;
}

export function stripeBackground(color) {
  return color === RAINBOW ? RAINBOW_STRIPE : color;
}

function paintStripe(treeItem, color) {
  treeItem.style.setProperty("--project-color", color === RAINBOW ? "#c084fc" : color);
  treeItem.style.setProperty("--project-stripe", stripeBackground(color));
  treeItem.classList.add("has-project-color");
}

export function applyProjectColor(treeItem, project) {
  paintStripe(treeItem, colorForProject(project));
}

export function colorForOwner(owner) {
  return OWNER_COLORS[owner] || "#718195";
}

export function ownerSolidColor(owner) {
  const color = colorForOwner(owner);
  return color === RAINBOW ? "#c084fc" : color;
}

export function applyOwnerColor(treeItem, owner) {
  paintStripe(treeItem, colorForOwner(owner));
}
