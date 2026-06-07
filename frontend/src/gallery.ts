// End-of-game gallery: a wall of every drawing from the game with its word.
// Tap a drawing to open its shareable card; tap its heart to vote for the best
// drawing (server-tallied). When the vote closes the winner is revealed.

import { renderDrawing, type DrawingRecord } from "./canvas";
import { openShareCard } from "./share";
import { openDrawingReplay } from "./reveal";
import { confettiBurst } from "./celebrate";
import type { VoteWinner } from "./proto";

export interface GalleryItem {
  word: string;
  records: DrawingRecord[];
  drawerName?: string;
  turn: number;
  isOwn: boolean;
}

export interface VoteOutcome {
  tally: [number, number][];
  winner: VoteWinner | null;
}

export interface GalleryVoting {
  enabled: boolean;
  myVote: number | null;
  onVote: (turn: number) => void;
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

export function openGallery(
  items: GalleryItem[],
  voting?: GalleryVoting,
  onClose?: () => void,
): GalleryHandle {
  let myVote = voting?.myVote ?? null;
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

  // turn -> tile element, so we can update votes/result in place.
  const tiles = new Map<number, HTMLElement>();

  for (const item of items) {
    const tile = document.createElement("div");
    tile.className = "gallery-tile";
    tile.innerHTML = `
      <button class="gallery-body" type="button" aria-label="Share this drawing">
        <span class="gallery-thumb"></span>
        <span class="gallery-word">${escapeHtml(item.word)}</span>
        ${item.drawerName ? `<span class="gallery-by">${escapeHtml(item.drawerName)}</span>` : ""}
        <span class="gallery-share-hint"><i class="ph ph-share-network" aria-hidden="true"></i></span>
      </button>
      <button class="gallery-vote" type="button" aria-label="Vote for this drawing">
        <i class="ph ph-heart" aria-hidden="true"></i>
      </button>
      <span class="gallery-count"></span>
      <span class="gallery-crown" aria-hidden="true"><i class="ph-fill ph-crown"></i></span>
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

    const voteBtn = tile.querySelector<HTMLButtonElement>(".gallery-vote")!;
    // No heart on your own drawing (the server rejects self-votes anyway).
    if (item.isOwn) voteBtn.remove();
    else {
      voteBtn.addEventListener("click", () => {
        if (result) return; // voting closed
        myVote = item.turn;
        voting?.onVote(item.turn);
        refreshVoteStates();
      });
    }

    tiles.set(item.turn, tile);
    grid.appendChild(tile);
  }

  function refreshVoteStates(): void {
    for (const [turn, tile] of tiles) {
      const voted = !result && myVote === turn;
      tile.classList.toggle("gallery-tile--voted", voted);
      const icon = tile.querySelector<HTMLElement>(".gallery-vote i");
      if (icon) icon.className = voted ? "ph-fill ph-heart" : "ph ph-heart";
    }
  }

  function renderState(): void {
    overlay.classList.toggle("gallery-modal--voting", !result && !!voting?.enabled);
    overlay.classList.toggle("gallery-modal--results", !!result);
    if (result) {
      const counts = new Map(result.tally);
      for (const [turn, tile] of tiles) {
        const n = counts.get(turn) ?? 0;
        const countEl = tile.querySelector<HTMLElement>(".gallery-count");
        if (countEl) {
          countEl.textContent = n > 0 ? `${n}` : "";
          countEl.style.display = n > 0 ? "" : "none";
        }
        tile.classList.toggle(
          "gallery-tile--winner",
          result.winner != null && result.winner.turn === turn,
        );
      }
      const w = result.winner;
      banner.innerHTML = w
        ? `🏆 Best drawing: <strong>"${escapeHtml(w.word)}"</strong>${
            w.votes ? ` — ${w.votes} vote${w.votes === 1 ? "" : "s"}` : ""
          }`
        : "No votes this time.";
      banner.classList.add("gallery-banner--show");
    } else if (voting?.enabled) {
      banner.textContent = "Tap a heart to vote for the best drawing 💜";
      banner.classList.add("gallery-banner--show");
      refreshVoteStates();
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
      if (r.winner) {
        const tile = tiles.get(r.winner.turn);
        if (tile) {
          const rect = tile.getBoundingClientRect();
          confettiBurst({ count: 80, originX: rect.left + rect.width / 2, originY: rect.top });
        } else {
          confettiBurst({ count: 80 });
        }
      }
    },
    close,
  };
}
