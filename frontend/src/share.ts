// Shareable result card. The downloaded / shared image is a branded portrait
// PNG (drawing + word + pastel mark); the in-app preview shows just the drawing
// for a clean look. Native share (Web Share API) with a download fallback.

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
  await loadFonts();
  const card = buildCard(opts); // branded card -> what gets shared/downloaded
  const preview = buildDrawingPreview(opts.records); // drawing only -> shown
  preview.classList.add("share-preview-img");
  presentShare(card, preview, slug(opts.word), `I drew "${opts.word}" on pastel!`);
}

export interface ScoreEntry {
  name: string;
  score: number;
}

// Share the final standings. The downloaded/shared file is the branded canvas
// card; the preview is a crisp DOM render of the same standings.
export async function openScoreCardShare(standings: ScoreEntry[]): Promise<void> {
  await loadFonts();
  const card = buildScoreCard(standings);
  const preview = buildScoreCardPreview(standings);
  presentShare(card, preview, "scorecard", "Final scores on pastel!");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// A DOM render of the scorecard for the preview (matches the exported card but
// renders crisply as text instead of a scaled-down image).
function buildScoreCardPreview(standings: ScoreEntry[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "share-sc";
  const winner = standings[0];
  const rows = standings
    .slice(0, 8)
    .map(
      (e, i) => `
      <li class="share-sc-row">
        <span class="share-sc-rank share-sc-rank--${Math.min(i + 1, 4)}">${i + 1}</span>
        <span class="share-sc-name">${escapeHtml(e.name)}</span>
        <span class="share-sc-score">${e.score}</span>
      </li>`,
    )
    .join("");
  el.innerHTML = `
    <div class="share-sc-head">
      <span class="share-sc-logo">pastel</span>
      <span class="share-sc-sub">final scores</span>
    </div>
    ${winner ? `<div class="share-sc-winner">🏆 ${escapeHtml(winner.name)} wins!</div>` : ""}
    <ul class="share-sc-list">${rows}</ul>
    <div class="share-sc-foot">playpastel.com</div>
  `;
  return el;
}

// Explicitly load the brand fonts at the sizes we paint, so the canvas text is
// crisp instead of falling back to a system font on first render.
async function loadFonts(): Promise<void> {
  const f = (document as Document).fonts;
  if (!f?.load) return;
  try {
    await Promise.all([
      f.load("700 92px Fredoka"),
      f.load("700 110px Fredoka"),
      f.load("600 36px Fredoka"),
      f.load("700 26px 'Plus Jakarta Sans'"),
      f.load("500 32px 'Plus Jakarta Sans'"),
    ]);
  } catch {
    // fall back to system fonts
  }
}

function buildDrawingPreview(records: DrawingRecord[]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 1000;
  c.height = 625;
  renderDrawing(c, records, { background: "#ffffff" });
  return c;
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

  // Header: wordmark + tagline (top baseline throughout for predictable stacks).
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#e58aa0";
  ctx.font = "700 92px Fredoka, sans-serif";
  ctx.fillText("pastel", CARD_W / 2, 70);
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "500 30px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText("draw. guess. laugh.", CARD_W / 2, 176);

  // Drawing panel: white rounded card with the drawing rendered crisply.
  const margin = 80;
  const panelX = margin;
  const panelY = 270;
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

  // Word + attribution, cleanly stacked below the panel.
  let ty = panelY + panelH + 54;
  ctx.fillStyle = "#b3b3b9";
  ctx.font = "700 26px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText("THE WORD WAS", CARD_W / 2, ty);
  ty += 44;

  ctx.fillStyle = "#2a2a2e";
  const wf = wordFontSize(word);
  ctx.font = `700 ${wf}px Fredoka, sans-serif`;
  ctx.fillText(`"${word}"`, CARD_W / 2, ty);
  ty += wf + 22;

  if (drawerName) {
    ctx.fillStyle = "#76767c";
    ctx.font = "500 32px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText(`drawn by ${drawerName}`, CARD_W / 2, ty);
  }

  // Footer.
  ctx.fillStyle = "#b7b7bd";
  ctx.font = "600 36px Fredoka, sans-serif";
  ctx.fillText(SITE, CARD_W / 2, CARD_H - 96);

  return card;
}

function wordFontSize(word: string): number {
  const len = word.length;
  if (len <= 8) return 104;
  if (len <= 14) return 78;
  return 60;
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

// Generic share preview modal. `shareCanvas` is the image exported on
// share/download; `previewCanvas` is what's shown (may be the same).
function presentShare(
  shareCanvas: HTMLCanvasElement,
  previewEl: HTMLElement,
  name: string,
  shareText: string,
): void {
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
  overlay.querySelector(".share-preview")!.appendChild(previewEl);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("share-modal--in"));

  const close = (): void => {
    overlay.classList.remove("share-modal--in");
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      overlay.remove();
    };
    overlay.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 300); // fallback if no transition fires
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".share-close")?.addEventListener("click", close);

  const shareBtn = overlay.querySelector<HTMLButtonElement>(".share-do")!;
  const dlBtn = overlay.querySelector<HTMLButtonElement>(".share-download")!;
  const filename = `pastel-${name}.png`;

  const probe = new File([new Blob()], filename, { type: "image/png" });
  if (!navigator.canShare?.({ files: [probe] })) {
    shareBtn.style.display = "none";
  }

  shareBtn.addEventListener("click", () => {
    shareCanvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], filename, { type: "image/png" });
      try {
        await navigator.share({ files: [file], text: shareText });
      } catch {
        // cancelled / failed -> no-op
      }
    }, "image/png");
  });

  dlBtn.addEventListener("click", () => {
    shareCanvas.toBlob((blob) => {
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

// --- scorecard image ---
function buildScoreCard(standings: ScoreEntry[]): HTMLCanvasElement {
  const card = document.createElement("canvas");
  card.width = CARD_W;
  card.height = CARD_H;
  const ctx = card.getContext("2d")!;

  ctx.fillStyle = "#fdfbf7";
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  bloom(ctx, CARD_W * 0.18, CARD_H * 0.06, 540, "rgba(242,164,176,0.22)");
  bloom(ctx, CARD_W * 0.85, CARD_H * 0.96, 560, "rgba(142,202,196,0.22)");

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#e58aa0";
  ctx.font = "700 92px Fredoka, sans-serif";
  ctx.fillText("pastel", CARD_W / 2, 80);
  ctx.fillStyle = "#9a9aa0";
  ctx.font = "500 30px 'Plus Jakarta Sans', sans-serif";
  ctx.fillText("final scores", CARD_W / 2, 186);

  const winner = standings[0];
  if (winner) {
    ctx.fillStyle = "#caa53a";
    ctx.font = "700 44px Fredoka, sans-serif";
    ctx.fillText(`\u{1F3C6} ${winner.name} wins!`, CARD_W / 2, 256);
  }

  // Rows.
  const rankColors = ["#f5c6d0", "#d5c6e0", "#fce4b8", "#e6e6e6"];
  const rowH = 96;
  const listX = 130;
  const listW = CARD_W - listX * 2;
  let y = 360;
  ctx.textBaseline = "middle";
  const top = standings.slice(0, 8);
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const cy = y + rowH / 2;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, listX, y, listW, rowH - 14, 18);
    ctx.fill();
    // rank chip
    ctx.fillStyle = rankColors[Math.min(i, rankColors.length - 1)];
    ctx.beginPath();
    ctx.arc(listX + 48, cy, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2a2a2e";
    ctx.font = "700 30px Fredoka, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), listX + 48, cy + 1);
    // name
    ctx.textAlign = "left";
    ctx.font = "600 38px 'Plus Jakarta Sans', sans-serif";
    ctx.fillText(truncate(ctx, e.name, listW - 240), listX + 92, cy + 1);
    // score
    ctx.textAlign = "right";
    ctx.fillStyle = "#76767c";
    ctx.font = "700 38px Fredoka, sans-serif";
    ctx.fillText(String(e.score), listX + listW - 28, cy + 1);
    y += rowH;
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#b7b7bd";
  ctx.font = "600 36px Fredoka, sans-serif";
  ctx.fillText(SITE, CARD_W / 2, CARD_H - 70);

  return card;
}

function truncate(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(out + "…").width > maxW) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "drawing";
}
