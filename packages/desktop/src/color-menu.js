// Floating "pick a colour" menu shown on right-clicking a project row. One menu
// element is reused; it closes on outside click, Escape, scroll, or selection.
import {
  SWATCHES,
  RAINBOW,
  swatchBackground,
  setProjectColor,
  clearProjectColor,
  isOverridden
} from "./project-colors.js";

let menuEl = null;
let onPick = null;

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.className = "color-menu";
  menuEl.hidden = true;
  document.body.append(menuEl);
  document.addEventListener("click", (e) => {
    if (menuEl.hidden) return;
    if (!menuEl.contains(e.target)) closeColorMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeColorMenu();
  });
  window.addEventListener("scroll", () => closeColorMenu(), true);
  return menuEl;
}

export function closeColorMenu() {
  if (menuEl) menuEl.hidden = true;
}

// Open the menu for one project at the cursor. `onChanged` re-renders the tree.
export function openColorMenu(event, project, onChanged) {
  event.preventDefault();
  onPick = onChanged;
  const menu = ensureMenu();
  menu.replaceChildren();

  const grid = document.createElement("div");
  grid.className = "color-menu-grid";
  for (const color of SWATCHES) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "color-menu-swatch";
    swatch.style.background = swatchBackground(color);
    swatch.title = color === RAINBOW ? "Rainbow" : color;
    swatch.addEventListener("click", () => {
      setProjectColor(project.key, color);
      closeColorMenu();
      onPick?.();
    });
    grid.append(swatch);
  }
  menu.append(grid);

  if (isOverridden(project.key)) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "color-menu-reset";
    reset.textContent = "Reset to default";
    reset.addEventListener("click", () => {
      clearProjectColor(project.key);
      closeColorMenu();
      onPick?.();
    });
    menu.append(reset);
  }

  // Show off-screen first to measure, then clamp inside the viewport.
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}
