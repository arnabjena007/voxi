// On-demand stroke-by-stroke replay: plays every drawing in sequence in a
// dismissible overlay. Opened from the gallery's "Replay" button.

import { replayDrawing, type DrawingRecord } from "./canvas";

export interface RevealItem {
  word: string;
  records: DrawingRecord[];
  drawerName?: string;
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => window.setTimeout(r, ms));

// Only one replay overlay at a time (the "Replay" button can be tapped twice).
let replayOpen = false;

export function openDrawingReplay(items: RevealItem[]): void {
  if (items.length === 0 || replayOpen) return;
  replayOpen = true;

  const overlay = document.createElement("div");
  overlay.className = "reveal reveal--manual";
  overlay.innerHTML = `
    <button class="reveal-close" type="button" aria-label="Close">×</button>
    <div class="reveal-inner">
      <div class="reveal-eyebrow">replay</div>
      <div class="reveal-stage"><canvas class="reveal-canvas reveal-canvas--in"></canvas></div>
      <div class="reveal-caption"></div>
      <div class="reveal-progress"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("reveal--in"));

  const canvas = overlay.querySelector<HTMLCanvasElement>(".reveal-canvas")!;
  canvas.width = 720;
  canvas.height = 450;
  const caption = overlay.querySelector<HTMLElement>(".reveal-caption")!;
  const progress = overlay.querySelector<HTMLElement>(".reveal-progress")!;

  let cancelled = false;
  const close = (): void => {
    cancelled = true;
    replayOpen = false;
    overlay.classList.remove("reveal--in");
    window.setTimeout(() => overlay.remove(), 240);
  };
  overlay.querySelector(".reveal-close")?.addEventListener("click", close);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });

  void (async () => {
    for (let i = 0; i < items.length; i++) {
      if (cancelled) return;
      const item = items[i];
      caption.textContent = item.drawerName
        ? `"${item.word}" by ${item.drawerName}`
        : `"${item.word}"`;
      progress.textContent = `${i + 1} / ${items.length}`;
      await replayDrawing(canvas, item.records, 2200, () => cancelled);
      if (cancelled) return;
      await wait(800); // hold the finished drawing before the next one
    }
    if (!cancelled) close();
  })();
}
