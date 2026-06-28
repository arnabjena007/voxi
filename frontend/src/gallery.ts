// End-of-game gallery: a wall of every drawing from the game with its word.
// Tap a drawing to open its shareable card; rate the ones you didn't make with
// up to 3 hearts. When voting closes, the most-loved drawing is crowned and the
// player whose drawings earned the most hearts is named Best Artist.

import { renderDrawing, type DrawingRecord } from "./canvas";
import { openShareCard } from "./share";
import { openDrawingReplay } from "./reveal";
import { confettiBurst } from "./celebrate";
import type { ArtistWinner, VoteWinner } from "./proto";

const MAX_HEARTS = 3;

export interface GalleryItem {
  word: string;
  records: DrawingRecord[];
  drawerName?: string;
  drawerId: number;
  turn: number;
  isOwn: boolean;
}

export interface VoteOutcome {
  tally: [number, number][];
  topDrawing: VoteWinner | null;
  artist: ArtistWinner | null;
  artistName: string | null;
}

export interface GalleryVoting {
  enabled: boolean;
  /** turn -> hearts (1..3) the local player has assigned. */
  myHearts: Map<number, number>;
  onRate: (turn: number, hearts: number) => void;
  result: VoteOutcome | null;
}

export interface GalleryHandle {
  applyVoteResult(result: VoteOutcome): void;
  close(): void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function heartRow(turn: number, hearts: number): string {
  let cells = "";
  for (let i = 1; i <= MAX_HEARTS; i++) {
    const on = i <= hearts;
    cells += `<button class="gallery-heart" type="button" data-h="${i}" data-turn="${turn}" aria-label="${i} heart${i === 1 ? "" : "s"}"><i class="${on ? "ph-fill" : "ph"} ph-heart" aria-hidden="true"></i></button>`;
  }
  return cells;
}

export function openGallery(
  items: GalleryItem[],
  voting?: GalleryVoting,
  onClose?: () => void,
): GalleryHandle {
  const myHearts = voting?.myHearts ?? new Map<number, number>();
  let result = voting?.result ?? null;

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
      <p class="gallery-banner"></p>
      <div class="gallery-grid"></div>
    </div>
  `;
  const grid = overlay.querySelector<HTMLElement>(".gallery-grid")!;
  const banner = overlay.querySelector<HTMLElement>(".gallery-banner")!;
  overlay
    .querySelector(".gallery-replay")
    ?.addEventListener("click", () => openDrawingReplay(items));

  if (items.length === 0) {
    grid.innerHTML = `<p class="gallery-empty">No drawings this game.</p>`;
  }

  // turn -> tile element, so we can update ratings/result in place.
  const tiles = new Map<number, HTMLElement>();

  for (const item of items) {
    const tile = document.createElement("div");
    tile.className = "gallery-tile";
    tile.innerHTML = `
      <button class="gallery-body" type="button" aria-label="Share this drawing">
        <span class="gallery-thumb"></span>
        <span class="gallery-share-hint"><i class="ph ph-share-network" aria-hidden="true"></i></span>
        <span class="gallery-crown" aria-hidden="true"><i class="ph-fill ph-crown"></i></span>
      </button>
      <div class="gallery-meta">
        <span class="gallery-word">${escapeHtml(item.word)}</span>
        ${item.drawerName ? `<span class="gallery-by">${escapeHtml(item.drawerName)}</span>` : ""}
      </div>
      <div class="gallery-foot">
        ${
          item.isOwn
            ? `<span class="gallery-mine">your drawing</span>`
            : `<div class="gallery-rate" role="group" aria-label="Rate this drawing">${heartRow(item.turn, myHearts.get(item.turn) ?? 0)}</div>`
        }
        <span class="gallery-score" aria-hidden="true"></span>
      </div>
    `;
    const thumb = document.createElement("canvas");
    thumb.width = 400;
    thumb.height = 250;
    thumb.className = "gallery-thumb-canvas";
    renderDrawing(thumb, item.records, { background: "#ffffff" });
    tile.querySelector(".gallery-thumb")!.appendChild(thumb);

    tile.querySelector(".gallery-body")?.addEventListener("click", () => {
      void openShareCard({ records: item.records, word: item.word, drawerName: item.drawerName });
    });

    if (!item.isOwn) {
      tile.querySelectorAll<HTMLButtonElement>(".gallery-heart").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (result) return; // voting closed
          const i = Number(btn.dataset.h);
          const cur = myHearts.get(item.turn) ?? 0;
          const next = cur === i ? i - 1 : i; // tap the top filled heart to step down
          if (next <= 0) myHearts.delete(item.turn);
          else myHearts.set(item.turn, next);
          voting?.onRate(item.turn, next);
          paintHearts(item.turn);
        });
      });
    }

    tiles.set(item.turn, tile);
    grid.appendChild(tile);
  }

  function paintHearts(turn: number): void {
    const tile = tiles.get(turn);
    if (!tile) return;
    const n = myHearts.get(turn) ?? 0;
    tile.querySelectorAll<HTMLElement>(".gallery-heart").forEach((btn) => {
      const i = Number((btn as HTMLElement).dataset.h);
      const icon = btn.querySelector("i");
      if (icon) icon.className = `${i <= n ? "ph-fill" : "ph"} ph-heart`;
    });
    tile.classList.toggle("gallery-tile--rated", n > 0);
  }

  function renderState(): void {
    overlay.classList.toggle("gallery-modal--voting", !result && !!voting?.enabled);
    overlay.classList.toggle("gallery-modal--results", !!result);

    if (result) {
      const counts = new Map(result.tally);
      const topTurn = result.topDrawing?.turn ?? null;
      const artistId = result.artist?.player ?? null;
      for (const [turn, tile] of tiles) {
        const n = counts.get(turn) ?? 0;
        const scoreEl = tile.querySelector<HTMLElement>(".gallery-score");
        if (scoreEl) {
          scoreEl.innerHTML = `<i class="ph-fill ph-heart" aria-hidden="true"></i>${n}`;
          scoreEl.classList.add("gallery-score--show");
        }
        tile.classList.toggle("gallery-tile--winner", topTurn !== null && turn === topTurn);
      }
      // Ring every drawing by the winning artist.
      for (const item of items) {
        tiles
          .get(item.turn)
          ?.classList.toggle("gallery-tile--artist", artistId !== null && item.drawerId === artistId);
      }
      const a = result.artist;
      const top = result.topDrawing;
      if (a) {
        const name = result.artistName ?? "Someone";
        banner.innerHTML =
          `<span class="gallery-banner-main">🏆 Best artist: <strong>${escapeHtml(name)}</strong> <span class="gallery-banner-hearts"><i class="ph-fill ph-heart"></i>${a.hearts}</span></span>` +
          (top
            ? `<span class="gallery-banner-sub">top drawing: <strong>"${escapeHtml(top.word)}"</strong></span>`
            : "");
      } else {
        banner.innerHTML = `<span class="gallery-banner-main">No votes this time.</span>`;
      }
      banner.classList.add("gallery-banner--show");
    } else if (voting?.enabled) {
      banner.innerHTML = `Rate the drawings you love — up to ${MAX_HEARTS} <i class="ph-fill ph-heart"></i> each`;
      banner.classList.add("gallery-banner--show");
      for (const turn of tiles.keys()) paintHearts(turn);
    } else {
      banner.classList.remove("gallery-banner--show");
    }
  }
  renderState();

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("gallery-modal--in"));

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.classList.remove("gallery-modal--in");
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      overlay.remove();
    };
    overlay.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 300); // fallback if no transition fires
    onClose?.();
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".gallery-close")?.addEventListener("click", close);

  return {
    applyVoteResult(r: VoteOutcome): void {
      result = r;
      renderState();
      // Confetti from the crowned drawing (or a centered burst as fallback).
      const tile = r.topDrawing ? tiles.get(r.topDrawing.turn) : null;
      if (tile) {
        const rect = tile.getBoundingClientRect();
        confettiBurst({ count: 90, originX: rect.left + rect.width / 2, originY: rect.top });
      } else if (r.artist) {
        confettiBurst({ count: 90 });
      }
    },
    close,
  };
}
