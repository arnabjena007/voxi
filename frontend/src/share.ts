// Shareable result card. Composes the drawing + the word + pastel branding
// into a portrait PNG, then shows a small preview modal offering native share
// (Web Share API, great on phones) or a download fallback.

import { renderDrawing, type DrawingRecord } from "./canvas";

const CARD_W = 1080;
const CARD_H = 1350;
const SITE = "playpastel.com";

export interface ShareCardOpts {
  records: DrawingRecord[];
  word: string;
  drawerName?: string;
}

export async function openShareCard(opts: ShareCardOpts): Promise<void> {
  // Make sure the brand fonts are ready before we paint text to the canvas.
  try {
    await (document as Document).fonts?.ready;
  } catch {
    // fonts API unavailable -> fall back to system fonts
  }
  const card = buildCard(opts);
  showModal(card, opts.word);
}

function buildCard({ records, word, drawerName }: ShareCardOpts): HTMLCanvasElement {
  const card = document.createElement("canvas");
  card.width = CARD_W;
  card.height = CARD_H;
  const ctx = card.getContext("2d")!;

  // Background: warm paper with two soft pastel blooms.
  ctx.fillStyle = "#fdfbf7";
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  bloom(ctx, CARD_W * 0.2, CARD_H * 0.08, 520, "rgba(242,164,176,0.20)");
  bloom(ctx, CARD_W * 0.85, CARD_H * 0.95, 560, "rgba(142,202,196,0.20)");

  // Header: wordmark + tagline.
  ctx.textAlign = "center";
  ctx.fillStyle = "#e58aa0";
  ctx.font = "700 92px Fredoka, sans-serif";
  ctx.fillText("pastel", CARD_W / 2, 150);
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "500 30px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText("draw. guess. laugh.", CARD_W / 2, 196);

  // Drawing panel: white rounded card with the drawing rendered crisply.
  const margin = 80;
  const panelX = margin;
  const panelY = 280;
  const panelW = CARD_W - margin * 2;
  const panelH = Math.round((panelW * 10) / 16);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, panelX, panelY, panelW, panelH, 30);
  ctx.fill();
  ctx.restore();

  const inner = document.createElement("canvas");
  inner.width = panelW * 2;
  inner.height = panelH * 2;
  renderDrawing(inner, records, { background: "#ffffff" });
  ctx.save();
  roundRect(ctx, panelX, panelY, panelW, panelH, 30);
  ctx.clip();
  ctx.drawImage(inner, panelX, panelY, panelW, panelH);
  ctx.restore();

  // The word, big, in a quote.
  const wordY = panelY + panelH + 130;
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "600 30px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText("THE WORD WAS", CARD_W / 2, wordY - 64);
  ctx.fillStyle = "#2a2a2e";
  ctx.font = `700 ${wordFontSize(word)}px Fredoka, sans-serif`;
  ctx.fillText(`"${word}"`, CARD_W / 2, wordY);

  if (drawerName) {
    ctx.fillStyle = "#76767c";
    ctx.font = "500 34px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText(`drawn by ${drawerName}`, CARD_W / 2, wordY + 64);
  }

  // Footer.
  ctx.fillStyle = "#b7b7bd";
  ctx.font = "600 36px Fredoka, sans-serif";
  ctx.fillText(SITE, CARD_W / 2, CARD_H - 70);

  return card;
}

function wordFontSize(word: string): number {
  const len = word.length;
  if (len <= 8) return 110;
  if (len <= 14) return 84;
  return 64;
}

function bloom(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(253,251,247,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function showModal(card: HTMLCanvasElement, word: string): void {
  const overlay = document.createElement("div");
  overlay.className = "share-modal";
  overlay.innerHTML = `
    <div class="share-card">
      <button class="share-close" type="button" aria-label="Close">×</button>
      <div class="share-preview"></div>
      <div class="share-actions">
        <button class="share-do" type="button">
          <i class="ph ph-share-network" aria-hidden="true"></i><span>Share</span>
        </button>
        <button class="share-download" type="button">
          <i class="ph ph-download-simple" aria-hidden="true"></i><span>Download</span>
        </button>
      </div>
    </div>
  `;
  const preview = overlay.querySelector<HTMLElement>(".share-preview")!;
  card.classList.add("share-preview-img");
  preview.appendChild(card);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("share-modal--in"));

  const close = (): void => {
    overlay.classList.remove("share-modal--in");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".share-close")?.addEventListener("click", close);

  const shareBtn = overlay.querySelector<HTMLButtonElement>(".share-do")!;
  const dlBtn = overlay.querySelector<HTMLButtonElement>(".share-download")!;
  const filename = `pastel-${slug(word)}.png`;

  // Hide native share if the platform can't share files.
  const probe = new File([new Blob()], filename, { type: "image/png" });
  if (!navigator.canShare?.({ files: [probe] })) {
    shareBtn.style.display = "none";
  }

  shareBtn.addEventListener("click", () => {
    card.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], filename, { type: "image/png" });
      try {
        await navigator.share({
          files: [file],
          text: `I drew "${word}" on pastel!`,
        });
      } catch {
        // user cancelled or share failed -> no-op
      }
    }, "image/png");
  });

  dlBtn.addEventListener("click", () => {
    card.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "drawing";
}
