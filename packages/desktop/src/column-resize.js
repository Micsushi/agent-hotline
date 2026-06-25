const COLUMNS = [
  {
    selector: ".col-projects",
    cssVar: "--col-projects-width",
    storeKey: "agent-hotline.col-projects-width"
  },
  {
    selector: ".col-sessions",
    cssVar: "--col-sessions-width",
    storeKey: "agent-hotline.col-sessions-width"
  }
];

function cssNumber(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clampWidth(px) {
  const min = cssNumber("--col-min-width", 180);
  const max = cssNumber("--col-max-width", 520);
  return Math.max(min, Math.min(max, px));
}

function setWidth(cssVar, px) {
  document.documentElement.style.setProperty(cssVar, `${px}px`);
}

function restore(col) {
  const saved = parseFloat(localStorage.getItem(col.storeKey) || "");
  if (Number.isFinite(saved)) setWidth(col.cssVar, clampWidth(saved));
}

function attachHandle(el, col) {
  if (el.querySelector(":scope > .col-resizer")) return;
  const handle = document.createElement("div");
  handle.className = "col-resizer";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = el.getBoundingClientRect().width;
    handle.classList.add("is-dragging");
    document.body.classList.add("is-col-resizing");
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const next = clampWidth(startWidth + (ev.clientX - startX));
      setWidth(col.cssVar, next);
    };
    const onUp = () => {
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-col-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      const final = cssNumber(col.cssVar, startWidth);
      localStorage.setItem(col.storeKey, String(final));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  handle.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty(col.cssVar);
    localStorage.removeItem(col.storeKey);
  });

  el.appendChild(handle);
}

export function initColumnResize() {
  for (const col of COLUMNS) {
    restore(col);
    document.querySelectorAll(col.selector).forEach((el) => attachHandle(el, col));
  }
}
