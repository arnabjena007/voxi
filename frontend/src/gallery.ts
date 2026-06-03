// End-of-game gallery: a wall of every drawing from the game with its word.
// Tap any drawing to open the shareable card for it.

import { renderDrawing, type DrawingRecord } from "./canvas";
import { openShareCard } from "./share";
import { openDrawingReplay } from "./reveal";

export interface GalleryItem {
  word: string;
  records: DrawingRecord[];
  drawerName?: string;
  roundIndex: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function openGallery(items: GalleryItem[]): void {
  const overlay = document.createElement("div");
  overlay.className = "gallery-modal";
  overlay.innerHTML = `
    <div class="gallery-sheet">
      <header class="gallery-head">
        <h2>The gallery</h2>
        <div class="gallery-head-actions">
          <button class="gallery-replay" type="button">
            <i class="ph ph-play-circle" aria-hidden="true"></i><span>Replay</span>
          </button>
          <button class="gallery-close" type="button" aria-label="Close">×</button>
        </div>
      </header>
      <div class="gallery-grid"></div>
    </div>
  `;
  const grid = overlay.querySelector<HTMLElement>(".gallery-grid")!;
  overlay
    .querySelector(".gallery-replay")
    ?.addEventListener("click", () => openDrawingReplay(items));

  if (items.length === 0) {
    grid.innerHTML = `<p class="gallery-empty">No drawings this game.</p>`;
  }

  for (const item of items) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "gallery-tile";
    tile.innerHTML = `
      <span class="gallery-thumb"></span>
      <span class="gallery-word">${escapeHtml(item.word)}</span>
      ${item.drawerName ? `<span class="gallery-by">${escapeHtml(item.drawerName)}</span>` : ""}
      <span class="gallery-share-hint"><i class="ph ph-share-network" aria-hidden="true"></i></span>
    `;
    const thumb = document.createElement("canvas");
    thumb.width = 400;
    thumb.height = 250;
    thumb.className = "gallery-thumb-canvas";
    renderDrawing(thumb, item.records, { background: "#ffffff" });
    tile.querySelector(".gallery-thumb")!.appendChild(thumb);
    tile.addEventListener("click", () => {
      void openShareCard({
        records: item.records,
        word: item.word,
        drawerName: item.drawerName,
      });
    });
    grid.appendChild(tile);
  }

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("gallery-modal--in"));

  const close = (): void => {
    overlay.classList.remove("gallery-modal--in");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".gallery-close")?.addEventListener("click", close);
}
