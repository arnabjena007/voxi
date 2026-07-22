// Floating drawing tools for phones. A small draggable puck (like iOS
// AssistiveTouch) snaps to the nearest screen edge and fades when idle; tapping
// it expands a compact tool sheet that opens inward (away from the docked edge)
// and closes on tap-outside. Exposes palette tabs, the full swatch grid, a
// thickness selector (via tool widths), undo/redo, and the clear action.
//
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

// Puck diameter (keep in sync with .mtool-puck in style.css). Used for
// clamping, edge-snapping, and anchoring the panel.
const PUCK = 52;
const EDGE = 8; // gap from the viewport edge
const PANEL_GAP = 10; // gap between puck and panel
const TAP_SLOP = 6; // movement under this (px) counts as a tap, not a drag
const IDLE_MS = 2500; // fade the puck after this much inactivity

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
  // Declared up here (not in the idle section below) so the early wake() call
  // isn't reading a `let` still in its temporal dead zone.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const puck = document.createElement("button");
  puck.className = "mtool-puck";
  puck.type = "button";
  puck.setAttribute("aria-label", "Drawing tools");
  puck.setAttribute("aria-expanded", String(state.open));
  puck.innerHTML = `
    <span class="mtool-puck-ring"></span>
    <span class="mtool-puck-dot"></span>
  `;
  document.body.appendChild(puck);

  const panel = document.createElement("div");
  panel.className = "mtool-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Drawing tools");
  panel.dataset.open = String(state.open);
  panel.innerHTML = `
    <header class="mtool-head">
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
  refreshPuck();
  applyPuckPos();
  wake();
  if (state.open) setOpen(true);

  closeBtn.addEventListener("click", () => setOpen(false));

  // Confirmation + drawer/non-drawer routing happens in main.ts. Delegate.
  clearBtn.addEventListener("click", () => handlers.onClear());

  attachPuckDrag();

  // Tap-outside closes the panel. Capture phase so we react before the canvas
  // handles the same pointerdown; we never preventDefault, so starting a stroke
  // both draws and dismisses the panel.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!state.open) return;
      const t = e.target as Node;
      if (panel.contains(t) || puck.contains(t)) return;
      setOpen(false);
    },
    true,
  );

  window.addEventListener("resize", () => {
    snapToEdge(); // re-clamp and re-dock to the nearest edge
    if (state.open) positionPanel();
  });

  // --- idle fade ---
  function wake(): void {
    puck.classList.remove("mtool-puck--idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!state.open) {
      idleTimer = setTimeout(() => puck.classList.add("mtool-puck--idle"), IDLE_MS);
    }
  }

  function setOpen(o: boolean): void {
    state.open = o;
    panel.dataset.open = String(o);
    puck.setAttribute("aria-expanded", String(o));
    puck.classList.toggle("mtool-puck--active", o);
    window.localStorage.setItem(STORAGE_OPEN, o ? "1" : "0");
    if (o) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      puck.classList.remove("mtool-puck--idle");
      positionPanel();
    } else {
      wake();
    }
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
        refreshPuck();
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
        refreshPuck();
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

  function refreshPuck(): void {
    const ring = puck.querySelector<HTMLElement>(".mtool-puck-ring")!;
    const dot = puck.querySelector<HTMLElement>(".mtool-puck-dot")!;
    const color =
      state.tool.forcedColor !== undefined ? "#ffffff" : rgbToCss(state.color);
    ring.style.background = color;
    const size = DISPLAY_DOT[state.tool.id] ?? 12;
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    puck.classList.toggle("mtool-puck--eraser", state.tool.forcedColor !== undefined);
  }

  // Place the puck from state.pos: horizontally clamped to the viewport,
  // vertically clamped to the canvas band so the tools stay over the drawing
  // and never drift down over the chat panel on phones.
  function applyPuckPos(): void {
    const vw = window.innerWidth;
    const band = puckYRange();
    state.pos.x = clamp(state.pos.x, EDGE, vw - PUCK - EDGE);
    state.pos.y = clamp(state.pos.y, band.min, band.max);
    puck.style.left = `${state.pos.x}px`;
    puck.style.top = `${state.pos.y}px`;
  }

  // Snap horizontally to whichever edge the puck's centre is nearest.
  function snapToEdge(): void {
    const vw = window.innerWidth;
    const center = state.pos.x + PUCK / 2;
    state.pos.x = center < vw / 2 ? EDGE : vw - PUCK - EDGE;
    applyPuckPos();
    window.localStorage.setItem(STORAGE_POS, JSON.stringify(state.pos));
  }

  // Anchor the panel beside the puck, opening toward screen centre and clamped
  // fully on-screen. Reading offsetWidth/Height forces the layout we need.
  function positionPanel(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const dockedLeft = state.pos.x + PUCK / 2 < vw / 2;
    const rawLeft = dockedLeft
      ? state.pos.x + PUCK + PANEL_GAP
      : state.pos.x - PANEL_GAP - pw;
    const left = clamp(rawLeft, EDGE, vw - pw - EDGE);
    const top = clamp(state.pos.y, EDGE, vh - ph - EDGE);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function attachPuckDrag(): void {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let moved = 0;
    let dragging = false;

    puck.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = 0;
      puck.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      origX = state.pos.x;
      origY = state.pos.y;
      puck.classList.add("mtool-puck--dragging");
      wake();
    });
    puck.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      moved = Math.max(moved, Math.hypot(dx, dy));
      const vw = window.innerWidth;
      const band = puckYRange();
      state.pos.x = clamp(origX + dx, EDGE, vw - PUCK - EDGE);
      state.pos.y = clamp(origY + dy, band.min, band.max);
      puck.style.left = `${state.pos.x}px`;
      puck.style.top = `${state.pos.y}px`;
      if (state.open) positionPanel();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      puck.classList.remove("mtool-puck--dragging");
      try {
        puck.releasePointerCapture(e.pointerId);
      } catch {}
      if (moved < TAP_SLOP) {
        setOpen(!state.open);
      } else {
        snapToEdge();
        if (state.open) positionPanel();
      }
      wake();
    };
    puck.addEventListener("pointerup", end);
    puck.addEventListener("pointercancel", end);
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
  // Default: docked to the right edge just below the canvas -- off the drawing,
  // in the free right side of the control dock, clear of the chat below.
  const vw = typeof window !== "undefined" ? window.innerWidth : 360;
  const band = puckYRange();
  return { x: vw - PUCK - EDGE, y: band.min };
}

// The vertical band the puck may occupy: the margin BELOW the canvas, so the
// floating tools never sit over the drawing. Falls back to above the canvas on
// short screens, then to the full viewport before the canvas lays out.
function puckYRange(): { min: number; max: number } {
  const vh = typeof window !== "undefined" ? window.innerHeight : 640;
  const wrap =
    typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".canvas-wrap")
      : null;
  const rect = wrap?.getBoundingClientRect();
  if (!rect || rect.height < PUCK) {
    return { min: EDGE, max: Math.max(EDGE, vh - PUCK - EDGE) };
  }
  const belowMin = Math.round(rect.bottom + EDGE);
  const belowMax = Math.round(vh - PUCK - EDGE);
  if (belowMax - belowMin >= PUCK) {
    return { min: belowMin, max: belowMax };
  }
  const aboveMax = Math.round(rect.top - PUCK - EDGE);
  if (aboveMax > EDGE) {
    return { min: EDGE, max: aboveMax };
  }
  return { min: EDGE, max: Math.max(EDGE, vh - PUCK - EDGE) };
}

function clamp(v: number, lo: number, hi: number): number {
  // hi can fall below lo on very small viewports; prefer the low edge.
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
