// Floating, draggable tool panel for phones. Exposes palette tabs, the full
// swatch grid, a thickness selector (via tool widths), and the clear action.
// On desktop the inline toolbar already provides all of this; this module is
// only mounted under the (max-width: 760px) breakpoint.
//
// State lives in localStorage so it stays in sync with the desktop toolbar
// across viewport changes.

import {
  PALETTES,
  TOOLS,
  findColor,
  findTool,
  rgbToCss,
  type Tool,
} from "./palette";

const STORAGE_COLOR = "pastel.color";
const STORAGE_TOOL = "pastel.tool";
const STORAGE_PALETTE = "pastel.palette";
const STORAGE_POS = "pastel.mtool.pos";
const STORAGE_OPEN = "pastel.mtool.open";

const DISPLAY_DOT: Record<string, number> = {
  pen: 6,
  nib: 8,
  pencil: 11,
  brush: 14,
  pastel: 18,
  crayon: 22,
  eraser: 14,
};

export interface MobileToolsHandlers {
  onColor: (rgb: number) => void;
  onTool: (tool: Tool) => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onHistoryChange: (cb: (canUndo: boolean, canRedo: boolean) => void) => void;
}

export function mountMobileTools(handlers: MobileToolsHandlers): void {
  const state = {
    color: loadColor(),
    tool: loadTool(),
    palette: loadPalette(),
    open: window.localStorage.getItem(STORAGE_OPEN) === "1",
    pos: loadPos(),
  };

  const fab = document.createElement("button");
  fab.className = "mtool-fab";
  fab.type = "button";
  fab.setAttribute("aria-label", "Open drawing tools");
  fab.setAttribute("aria-expanded", String(state.open));
  fab.innerHTML = `
    <span class="mtool-fab-ring"></span>
    <span class="mtool-fab-dot"></span>
    <span class="mtool-fab-label">tools</span>
  `;
  const canvasWrap = document.querySelector<HTMLElement>(".canvas-wrap");
  (canvasWrap ?? document.body).appendChild(fab);

  const panel = document.createElement("div");
  panel.className = "mtool-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Drawing tools");
  panel.dataset.open = String(state.open);
  panel.innerHTML = `
    <header class="mtool-head">
      <span class="mtool-grip" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
      <span class="mtool-title">tools</span>
      <button class="mtool-close" type="button" aria-label="Close">×</button>
    </header>
    <nav class="mtool-section mtool-tabs" role="tablist" aria-label="Palette"></nav>
    <div class="mtool-section mtool-swatches" role="listbox" aria-label="Colours"></div>
    <div class="mtool-section mtool-sizes" role="toolbar" aria-label="Thickness"></div>
    <div class="mtool-section mtool-history" role="group" aria-label="Undo / Redo">
      <button class="mtool-history-btn mtool-undo" type="button"
              aria-label="Undo" disabled>
        <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
        <span>undo</span>
      </button>
      <button class="mtool-history-btn mtool-redo" type="button"
              aria-label="Redo" disabled>
        <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        <span>redo</span>
      </button>
    </div>
    <div class="mtool-section mtool-actions">
      <button class="mtool-clear" type="button">
        <span class="mtool-clear-x" aria-hidden="true">×</span>
        <span>Clear canvas</span>
      </button>
    </div>
  `;
  document.body.appendChild(panel);
  applyPanelPos();

  const head = panel.querySelector<HTMLElement>(".mtool-head")!;
  const closeBtn = panel.querySelector<HTMLButtonElement>(".mtool-close")!;
  const tabsEl = panel.querySelector<HTMLElement>(".mtool-tabs")!;
  const swatchesEl = panel.querySelector<HTMLDivElement>(".mtool-swatches")!;
  const sizesEl = panel.querySelector<HTMLDivElement>(".mtool-sizes")!;
  const clearBtn = panel.querySelector<HTMLButtonElement>(".mtool-clear")!;
  const undoBtn = panel.querySelector<HTMLButtonElement>(".mtool-undo")!;
  const redoBtn = panel.querySelector<HTMLButtonElement>(".mtool-redo")!;
  undoBtn.addEventListener("click", () => handlers.onUndo());
  redoBtn.addEventListener("click", () => handlers.onRedo());
  handlers.onHistoryChange((canUndo, canRedo) => {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  });

  for (const p of PALETTES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mtool-tab";
    tab.dataset.paletteId = p.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(p.id === state.palette));
    tab.textContent = p.label;
    tab.addEventListener("click", () => {
      state.palette = p.id;
      window.localStorage.setItem(STORAGE_PALETTE, p.id);
      for (const t of tabsEl.querySelectorAll<HTMLButtonElement>(".mtool-tab")) {
        t.setAttribute("aria-selected", String(t.dataset.paletteId === p.id));
      }
      renderSwatches();
    });
    tabsEl.appendChild(tab);
  }

  renderSwatches();
  renderSizes();
  refreshFab();

  fab.addEventListener("click", () => {
    setOpen(!state.open);
  });
  closeBtn.addEventListener("click", () => setOpen(false));

  // Confirmation + drawer/non-drawer routing happens in main.ts. Delegate.
  clearBtn.addEventListener("click", () => handlers.onClear());

  attachDrag(head, panel);

  function setOpen(o: boolean): void {
    state.open = o;
    panel.dataset.open = String(o);
    fab.setAttribute("aria-expanded", String(o));
    fab.classList.toggle("mtool-fab--active", o);
    window.localStorage.setItem(STORAGE_OPEN, o ? "1" : "0");
  }

  function renderSwatches(): void {
    swatchesEl.innerHTML = "";
    const palette = PALETTES.find((p) => p.id === state.palette) ?? PALETTES[0];
    for (const c of palette.colors) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mtool-swatch";
      btn.dataset.colorRgb = String(c.rgb);
      btn.setAttribute("aria-pressed", String(c.rgb === state.color));
      btn.title = c.name;
      btn.style.backgroundColor = rgbToCss(c.rgb);
      btn.addEventListener("click", () => {
        state.color = c.rgb;
        window.localStorage.setItem(STORAGE_COLOR, String(c.rgb));
        syncSwatches();
        if (state.tool.forcedColor !== undefined) {
          state.tool = findTool("pencil")!;
          window.localStorage.setItem(STORAGE_TOOL, state.tool.id);
          syncSizes();
          handlers.onTool(state.tool);
        }
        refreshFab();
        handlers.onColor(c.rgb);
      });
      swatchesEl.appendChild(btn);
    }
  }

  function renderSizes(): void {
    sizesEl.innerHTML = "";
    for (const t of TOOLS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        t.id === "eraser" ? "mtool-size mtool-size--eraser" : "mtool-size";
      btn.dataset.toolId = t.id;
      btn.setAttribute("aria-pressed", String(t.id === state.tool.id));
      btn.title = t.label;
      if (t.id === "eraser") {
        btn.innerHTML = `
          <i class="ph ph-eraser mtool-size-icon" aria-hidden="true"></i>
          <span class="mtool-size-label">erase</span>
        `;
      } else {
        const dot = DISPLAY_DOT[t.id] ?? 12;
        btn.innerHTML = `<span class="mtool-size-dot" style="width:${dot}px;height:${dot}px"></span>`;
      }
      btn.addEventListener("click", () => {
        state.tool = t;
        window.localStorage.setItem(STORAGE_TOOL, t.id);
        syncSizes();
        if (t.forcedColor !== undefined) {
          handlers.onColor(t.forcedColor);
        } else {
          handlers.onColor(state.color);
        }
        refreshFab();
        handlers.onTool(t);
      });
      sizesEl.appendChild(btn);
    }
  }

  function syncSwatches(): void {
    for (const b of swatchesEl.querySelectorAll<HTMLButtonElement>(".mtool-swatch")) {
      b.setAttribute(
        "aria-pressed",
        String(Number(b.dataset.colorRgb) === state.color),
      );
    }
  }

  function syncSizes(): void {
    for (const b of sizesEl.querySelectorAll<HTMLButtonElement>(".mtool-size")) {
      b.setAttribute("aria-pressed", String(b.dataset.toolId === state.tool.id));
    }
  }

  function refreshFab(): void {
    const ring = fab.querySelector<HTMLElement>(".mtool-fab-ring")!;
    const dot = fab.querySelector<HTMLElement>(".mtool-fab-dot")!;
    const color =
      state.tool.forcedColor !== undefined
        ? "#ffffff"
        : rgbToCss(state.color);
    ring.style.background = color;
    const size = DISPLAY_DOT[state.tool.id] ?? 12;
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    if (state.tool.forcedColor !== undefined) {
      fab.classList.add("mtool-fab--eraser");
    } else {
      fab.classList.remove("mtool-fab--eraser");
    }
  }

  function applyPanelPos(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const px = Math.max(8, Math.min(vw - 260 - 8, state.pos.x));
    const py = Math.max(8, Math.min(vh - 80, state.pos.y));
    panel.style.left = `${px}px`;
    panel.style.top = `${py}px`;
  }

  function attachDrag(handle: HTMLElement, target: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".mtool-close")) return;
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      origX = state.pos.x;
      origY = state.pos.y;
      panel.classList.add("mtool-panel--dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tw = target.offsetWidth;
      const th = target.offsetHeight;
      const nx = Math.max(8, Math.min(vw - tw - 8, origX + (e.clientX - startX)));
      const ny = Math.max(8, Math.min(vh - th - 8, origY + (e.clientY - startY)));
      state.pos.x = nx;
      state.pos.y = ny;
      target.style.left = `${nx}px`;
      target.style.top = `${ny}px`;
    });
    const stop = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("mtool-panel--dragging");
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      window.localStorage.setItem(STORAGE_POS, JSON.stringify(state.pos));
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
}

function loadColor(): number {
  const stored = window.localStorage.getItem(STORAGE_COLOR);
  if (stored !== null) {
    const n = Number(stored);
    if (Number.isFinite(n) && findColor(n)) return n;
  }
  return PALETTES[0].colors[0].rgb;
}

function loadTool(): Tool {
  const stored = window.localStorage.getItem(STORAGE_TOOL);
  if (stored) {
    const t = findTool(stored);
    if (t) return t;
  }
  return findTool("pencil")!;
}

function loadPalette(): string {
  return window.localStorage.getItem(STORAGE_PALETTE) ?? PALETTES[0].id;
}

function loadPos(): { x: number; y: number } {
  const stored = window.localStorage.getItem(STORAGE_POS);
  if (stored) {
    try {
      const p = JSON.parse(stored);
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    } catch {
      // fall through to default
    }
  }
  const vw = typeof window !== "undefined" ? window.innerWidth : 360;
  const vh = typeof window !== "undefined" ? window.innerHeight : 640;
  return { x: Math.max(8, vw - 260 - 16), y: Math.max(60, vh - 420) };
}
