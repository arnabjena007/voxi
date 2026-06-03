// Make the floating canvas controls (mic / music / sfx) draggable by their
// grip, so they can be moved out of the way of the drawing. Position is kept
// inside the canvas area, persisted in localStorage, and re-clamped when the
// canvas resizes. Until the user drags, the cluster keeps its CSS default
// (top-right, right-anchored) so it stays put responsively.

const STORAGE_POS = "pastel.settings.pos";
const MARGIN = 8;

export function makeSettingsDraggable(cluster: HTMLElement, handle: HTMLElement): void {
  const wrap = cluster.parentElement;
  if (!wrap) return;

  let pos = loadPos();

  function applyClamped(): void {
    if (!pos) return; // never dragged -> leave the CSS default in place
    const maxX = Math.max(MARGIN, wrap!.clientWidth - cluster.offsetWidth - MARGIN);
    const maxY = Math.max(MARGIN, wrap!.clientHeight - cluster.offsetHeight - MARGIN);
    pos = {
      x: Math.min(Math.max(MARGIN, pos.x), maxX),
      y: Math.min(Math.max(MARGIN, pos.y), maxY),
    };
    cluster.style.left = `${pos.x}px`;
    cluster.style.top = `${pos.y}px`;
    cluster.style.right = "auto";
  }

  applyClamped();
  // The canvas-wrap resizes with the canvas (responsive + aspect-ratio), so
  // re-clamp whenever it changes to keep the cluster on-canvas.
  new ResizeObserver(() => applyClamped()).observe(wrap);

  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;
  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    const rect = cluster.getBoundingClientRect();
    const wrapRect = wrap!.getBoundingClientRect();
    origX = pos?.x ?? rect.left - wrapRect.left;
    origY = pos?.y ?? rect.top - wrapRect.top;
    cluster.classList.add("canvas-settings--dragging");
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pos = { x: origX + (e.clientX - startX), y: origY + (e.clientY - startY) };
    applyClamped();
  });

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    cluster.classList.remove("canvas-settings--dragging");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {}
    if (pos) window.localStorage.setItem(STORAGE_POS, JSON.stringify(pos));
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function loadPos(): { x: number; y: number } | null {
  const s = window.localStorage.getItem(STORAGE_POS);
  if (!s) return null;
  try {
    const p = JSON.parse(s);
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {
    // fall through
  }
  return null;
}
