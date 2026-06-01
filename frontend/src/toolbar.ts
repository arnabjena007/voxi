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

export interface ToolbarHandlers {
  onColor: (rgb: number) => void;
  onTool: (tool: Tool) => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  // Register to be told when undo/redo availability flips. Caller invokes
  // the returned function once immediately with current state.
  onHistoryChange: (cb: (canUndo: boolean, canRedo: boolean) => void) => void;
}

const DRAWING_TOOLS = TOOLS.filter((t) => t.forcedColor === undefined);
const ERASER = TOOLS.find((t) => t.id === "eraser")!;

// Display sizes for the brush preview dot. The wire width is `tool.width`,
// but a 2px dot is invisible, so we scale for the icon only.
const DISPLAY_DOT: Record<string, number> = {
  pen: 6,
  nib: 9,
  pencil: 12,
  brush: 16,
  pastel: 20,
  crayon: 24,
  eraser: 16,
};

export function loadInitialColor(): number {
  const stored = window.localStorage.getItem(STORAGE_COLOR);
  if (stored !== null) {
    const n = Number(stored);
    if (Number.isFinite(n) && findColor(n)) return n;
  }
  return PALETTES[0].colors[0].rgb;
}

export function isPhoneViewport(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 760px)").matches;
}

export function loadInitialTool(): Tool {
  const stored = window.localStorage.getItem(STORAGE_TOOL);
  if (stored) {
    const t = findTool(stored);
    if (t) return t;
  }
  return findTool("pencil")!;
}

function activePaletteId(): string {
  return window.localStorage.getItem(STORAGE_PALETTE) ?? PALETTES[0].id;
}

export function mountToolbar(root: HTMLElement, handlers: ToolbarHandlers): void {
  const state = {
    color: loadInitialColor(),
    tool: loadInitialTool(),
    palette: activePaletteId(),
  };

  root.innerHTML = "";
  root.classList.add("toolbar");
  root.innerHTML = `
    <div class="toolbar-row">
      <div class="tb-group" role="toolbar" aria-label="Brushes">
        <div class="brushes"></div>
        <div class="tb-divider tb-divider--vertical"></div>
        <div class="eraser-slot"></div>
      </div>
      <div class="tb-divider tb-divider--vertical"></div>
      <div class="tb-group palette-group">
        <nav class="palette-tabs" role="tablist" aria-label="Palettes"></nav>
      </div>
      <div class="tb-spacer"></div>
      <button type="button" class="clear-btn" title="Clear the canvas for everyone">
        <span class="clear-x" aria-hidden="true">×</span>
        <span>Clear</span>
      </button>
    </div>
    <div class="toolbar-row toolbar-row--swatches">
      <div class="swatches" role="listbox" aria-label="Colours"></div>
      <div class="tb-history" role="group" aria-label="Undo / Redo">
        <button type="button" class="history-btn history-undo"
                title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
          <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
        </button>
        <button type="button" class="history-btn history-redo"
                title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled>
          <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;

  const brushesEl = root.querySelector<HTMLDivElement>(".brushes")!;
  const eraserSlot = root.querySelector<HTMLDivElement>(".eraser-slot")!;
  const tabsEl = root.querySelector<HTMLElement>(".palette-tabs")!;
  const swatchesEl = root.querySelector<HTMLDivElement>(".swatches")!;
  const clearBtn = root.querySelector<HTMLButtonElement>(".clear-btn")!;

  // --- brushes ---
  for (const t of DRAWING_TOOLS) {
    brushesEl.appendChild(buildToolButton(t));
  }
  eraserSlot.appendChild(buildToolButton(ERASER));

  // --- palette tabs ---
  for (const p of PALETTES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "palette-tab";
    tab.dataset.paletteId = p.id;
    tab.role = "tab";
    tab.setAttribute("aria-selected", String(p.id === state.palette));
    tab.textContent = p.label;
    tab.addEventListener("click", () => {
      state.palette = p.id;
      window.localStorage.setItem(STORAGE_PALETTE, p.id);
      for (const t of tabsEl.querySelectorAll<HTMLButtonElement>(".palette-tab")) {
        t.setAttribute("aria-selected", String(t.dataset.paletteId === p.id));
      }
      renderSwatches();
    });
    tabsEl.appendChild(tab);
  }

  renderSwatches();

  // The confirmation dialog + drawer/non-drawer routing lives in main.ts so
  // the message can adapt to game phase. Just delegate the click.
  clearBtn.addEventListener("click", () => handlers.onClear());

  // History row: undo / redo. Buttons start disabled; reflect availability
  // from the surface via the registered listener so they enable / disable
  // as the user draws, undoes, redoes, or a round resets.
  const undoBtn = root.querySelector<HTMLButtonElement>(".history-undo")!;
  const redoBtn = root.querySelector<HTMLButtonElement>(".history-redo")!;
  undoBtn.addEventListener("click", () => handlers.onUndo());
  redoBtn.addEventListener("click", () => handlers.onRedo());
  handlers.onHistoryChange((canUndo, canRedo) => {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  });

  function renderSwatches(): void {
    swatchesEl.innerHTML = "";
    const palette = PALETTES.find((p) => p.id === state.palette) ?? PALETTES[0];
    for (const c of palette.colors) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch-btn";
      btn.dataset.colorRgb = String(c.rgb);
      btn.setAttribute("aria-pressed", String(c.rgb === state.color));
      btn.title = c.name;
      btn.style.backgroundColor = rgbToCss(c.rgb);
      btn.addEventListener("click", () => onSwatch(c.rgb));
      swatchesEl.appendChild(btn);
    }
  }

  function buildToolButton(t: Tool): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = t.id === "eraser" ? "tool-btn tool-btn--eraser" : "tool-btn";
    btn.dataset.toolId = t.id;
    btn.setAttribute("aria-pressed", String(t.id === state.tool.id));
    btn.title = t.label;
    const dot = DISPLAY_DOT[t.id] ?? 12;
    btn.innerHTML = `
      <span class="tool-dot" style="width:${dot}px;height:${dot}px"></span>
      <span class="tool-name">${t.label}</span>
    `;
    btn.addEventListener("click", () => onTool(t));
    return btn;
  }

  function onTool(t: Tool): void {
    state.tool = t;
    window.localStorage.setItem(STORAGE_TOOL, t.id);
    syncToolPressedState();
    if (t.forcedColor !== undefined) {
      handlers.onColor(t.forcedColor);
    } else {
      handlers.onColor(state.color);
    }
    handlers.onTool(t);
  }

  function onSwatch(rgb: number): void {
    state.color = rgb;
    window.localStorage.setItem(STORAGE_COLOR, String(rgb));
    syncSwatchPressedState();
    if (state.tool.forcedColor !== undefined) {
      state.tool = findTool("pencil")!;
      window.localStorage.setItem(STORAGE_TOOL, state.tool.id);
      syncToolPressedState();
      handlers.onTool(state.tool);
    }
    handlers.onColor(rgb);
  }

  function syncToolPressedState(): void {
    for (const b of root.querySelectorAll<HTMLButtonElement>(".tool-btn")) {
      b.setAttribute("aria-pressed", String(b.dataset.toolId === state.tool.id));
    }
  }

  function syncSwatchPressedState(): void {
    for (const b of swatchesEl.querySelectorAll<HTMLButtonElement>(".swatch-btn")) {
      b.setAttribute(
        "aria-pressed",
        String(Number(b.dataset.colorRgb) === state.color),
      );
    }
  }
}
