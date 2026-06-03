// UI for the game loop overlays: mode picker, word pick, drawing banner
// (mask + timer + round counter), round-end reveal, game-over podium.

import type { GamePhase } from "./game";

export interface GameUIHandlers {
  onStart: () => void;
  onPickWord: (index: number) => void;
  onRematch: () => void;
  onAddBot: (difficulty: string) => void;
}

export interface RenderContext {
  you: number | null;
  host: number | null;
  playerCount: number;
  nameOf: (id: number) => string;
  avatarOf: (id: number) => string;
  modeBadge: string;
  playerAvatars: { id: number; name: string; avatarHtml: string }[];
  onCopyInvite: () => void;
  // Background-music only (no sfx / no voice): surfaced on overlay cards since
  // the floating canvas control cluster is hidden while an overlay is up.
  musicOn: boolean;
  onToggleMusic: () => void;
}

export interface GameUI {
  render(phase: GamePhase, ctx: RenderContext): void;
  /// Returns the current word/mask to render in the top banner. null if no
  /// game is running.
  bannerText(phase: GamePhase): string | null;
}

export function mountGameUI(root: HTMLElement, handlers: GameUIHandlers): GameUI {
  root.classList.add("game-overlay");
  root.innerHTML = "";

  function clear(): void {
    root.innerHTML = "";
    root.classList.remove("game-overlay--visible");
  }

  function visible(): void {
    root.classList.add("game-overlay--visible");
  }

  function renderLobby(phase: Extract<GamePhase, { kind: "Lobby" }>, ctx: RenderContext): void {
    visible();
    const isHost = ctx.you !== null && ctx.you === ctx.host;
    const canStart = isHost && ctx.playerCount >= 2;
    const avatarChips = ctx.playerAvatars
      .map(
        (p) => `<div class="lobby-player" title="${escapeHtml(p.name)}">
          <span class="lobby-player-avatar">${p.avatarHtml}</span>
          <span class="lobby-player-name">${escapeHtml(p.name)}</span>
        </div>`,
      )
      .join("");
    const hostName = ctx.host !== null ? ctx.nameOf(ctx.host) : "the host";
    const startSection = isHost
      ? `<button type="button" class="lobby-start" ${canStart ? "" : "disabled"}>
           Let's go!
         </button>
         ${
           ctx.playerCount < 2
             ? '<p class="lobby-hint">Need at least 2 to play. Share the link!</p>'
             : `<p class="lobby-hint">${ctx.playerCount} player${ctx.playerCount !== 1 ? "s" : ""} here. Ready when you are</p>`
         }`
      : `<p class="lobby-waiting"><strong>${escapeHtml(hostName)}</strong> will kick things off soon</p>`;

    const timerSection = phase.deadline !== undefined
      ? `<div class="lobby-timer" data-deadline="${phase.deadline}">
           <span class="lobby-timer-label">Room expires in</span>
           <span class="lobby-timer-value" id="lobbyTimerValue">--</span>
         </div>`
      : "";

    root.innerHTML = `
      <div class="overlay-card overlay-card--lobby">
        ${musicChip(ctx)}
        <div class="lobby-head">
          <h2>Waiting room</h2>
          <span class="lobby-mode-badge">${escapeHtml(ctx.modeBadge)}</span>
        </div>
        ${timerSection}
        <div class="lobby-players">${avatarChips}</div>
        <div class="lobby-actions">
          ${startSection}
        </div>
        <div class="lobby-invite">
          <button type="button" class="invite-secondary">Share invite link</button>
          ${isHost ? `<span class="lobby-bot-group">
            <button type="button" class="lobby-bot" data-diff="easy">+ chill bot</button>
            <button type="button" class="lobby-bot" data-diff="medium">+ normal bot</button>
            <button type="button" class="lobby-bot" data-diff="hard">+ sweaty bot</button>
          </span>
          <span class="lobby-bot-tip-wrap">
            <span class="lobby-bot-tip-trigger">how do bots work?</span>
            <span class="lobby-bot-tip">Bots draw real human sketches from Google's Quick Draw dataset. They guess by matching the word mask and narrowing candidates as hints appear. They don't know the answer. Chill bots are patient, sweaty bots are relentless.</span>
          </span>` : ""}
        </div>
      </div>
    `;
    root
      .querySelector<HTMLButtonElement>(".lobby-start")
      ?.addEventListener("click", () => handlers.onStart());
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".lobby-bot")) {
      btn.addEventListener("click", () => {
        handlers.onAddBot(btn.dataset.diff ?? "medium");
      });
    }
    wireInvite(ctx);

    // Lobby expiry countdown: ticks down the visible text every rAF, stops
    // when the deadline passes or the lobby DOM is replaced by a new render.
    if (phase.deadline !== undefined) {
      const valueEl = root.querySelector<HTMLElement>("#lobbyTimerValue");
      const timerEl = root.querySelector<HTMLElement>(".lobby-timer");
      const deadline = phase.deadline;
      function tickLobby(): void {
        if (!valueEl || !document.contains(valueEl)) return;
        const ms = Math.max(0, deadline - performance.now());
        const secs = Math.ceil(ms / 1000);
        const mm = Math.floor(secs / 60);
        const ss = String(secs % 60).padStart(2, "0");
        valueEl.textContent = `${mm}:${ss}`;
        if (timerEl) timerEl.classList.toggle("lobby-timer--low", secs <= 15);
        if (ms > 0) requestAnimationFrame(tickLobby);
      }
      requestAnimationFrame(tickLobby);
    }
  }

  // Music-only toggle chip, pinned to the overlay card's top-right corner.
  function musicChip(ctx: RenderContext): string {
    const on = ctx.musicOn;
    const icon = on ? "ph-fill ph-music-notes" : "ph ph-music-notes";
    return `<button type="button" class="overlay-music${on ? " overlay-music--on" : ""}"
      aria-pressed="${on}" aria-label="${on ? "Turn music off" : "Turn music on"}"
      title="${on ? "Music on" : "Music off"}">
      <i class="${icon}" aria-hidden="true"></i>
    </button>`;
  }

  function wireMusicChip(ctx: RenderContext): void {
    root
      .querySelector<HTMLButtonElement>(".overlay-music")
      ?.addEventListener("click", () => ctx.onToggleMusic());
  }

  function wireInvite(ctx: RenderContext): void {
    for (const btn of root.querySelectorAll<HTMLButtonElement>(
      ".invite-primary, .invite-secondary",
    )) {
      btn.addEventListener("click", () => {
        ctx.onCopyInvite();
        const original = btn.textContent;
        btn.textContent = "Copied!";
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 1500);
      });
    }
  }

  function renderChoosing(
    phase: Extract<GamePhase, { kind: "ChoosingWord" }>,
    ctx: RenderContext,
  ): void {
    const you = ctx.you;
    const nameOf = ctx.nameOf;
    visible();
    if (phase.drawer === you && phase.myOptions) {
      const cards = phase.myOptions
        .map(
          (w, i) => `
            <button type="button" class="word-pick-card" data-index="${i}">
              <span class="word-pick-num">${String(i + 1).padStart(2, "0")}</span>
              <span class="word-pick-word">${escapeHtml(w)}</span>
            </button>`,
        )
        .join("");
      root.innerHTML = `
        <div class="overlay-card overlay-card--wide">
          ${musicChip(ctx)}
          <div class="word-pick-head">
            <span class="word-pick-eyebrow">Round ${phase.roundIndex + 1} of ${phase.totalRounds} -- your turn to draw!</span>
            <h2>What do you want to draw?</h2>
          </div>
          <div class="word-pick-grid">${cards}</div>
          <p class="overlay-hint">Take too long and we'll pick for you.</p>
          <button type="button" class="invite-secondary">Share invite link</button>
        </div>
      `;
      for (const btn of root.querySelectorAll<HTMLButtonElement>(".word-pick-card")) {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.index);
          handlers.onPickWord(idx);
        });
      }
    } else {
      root.innerHTML = `
        <div class="overlay-card">
          ${musicChip(ctx)}
          <div class="word-pick-head">
            <span class="word-pick-eyebrow">Round ${phase.roundIndex + 1} of ${phase.totalRounds}</span>
            <h2>${escapeHtml(nameOf(phase.drawer))} is choosing what to draw</h2>
          </div>
          <p class="overlay-hint">Get your guessing hat on.</p>
          <button type="button" class="invite-secondary">Share invite link</button>
        </div>
      `;
    }
    wireInvite(ctx);
  }

  function renderRoundEnd(
    phase: Extract<GamePhase, { kind: "RoundEnd" }>,
    ctx: RenderContext,
  ): void {
    visible();
    const rows = phase.scores
      .map(([id, score], i) => {
        const delta = phase.deltas?.get(id) ?? 0;
        const deltaTag =
          delta > 0 ? `<span class="score-delta">+${delta}</span>` : "";
        return `<li style="--row-i: ${i};">
             <span class="score-avatar">${ctx.avatarOf(id)}</span>
             <span class="score-name">${escapeHtml(ctx.nameOf(id))}</span>
             ${deltaTag}
             <span class="score-points">${score}</span>
           </li>`;
      })
      .join("");
    root.innerHTML = `
      <div class="overlay-card">
        ${musicChip(ctx)}
        <h2>It was <em>${escapeHtml(phase.word)}</em>!</h2>
        <ul class="score-list">${rows}</ul>
      </div>
    `;
  }

  function renderGameOver(
    phase: Extract<GamePhase, { kind: "GameOver" }>,
    ctx: RenderContext,
  ): void {
    visible();
    const all = phase.finalScores;
    const maxScore = Math.max(1, ...all.map(([, s]) => s));
    const abandoned = ctx.playerCount < 2;
    const heading = abandoned ? "Looks like everyone left" : "That's a wrap!";
    const subtext = abandoned
      ? '<p class="gameover-sub">No worries. You can start a fresh room anytime.</p>'
      : "";

    const RANK_COLORS = ["#f5c6d0", "#d5c6e0", "#fce4b8", "#e0e0e0"];

    const rows = all
      .map(([id, score], i) => {
        const pct = Math.max(12, (score / maxScore) * 100);
        const bg = RANK_COLORS[Math.min(i, RANK_COLORS.length - 1)];
        const isChamp = i === 0 && !abandoned;
        const rankInner = isChamp
          ? '<i class="ph-fill ph-crown" aria-hidden="true"></i>'
          : `${i + 1}`;
        return `<li class="go-row${isChamp ? " go-row--champion" : ""}" style="--row-i: ${i};">
          <span class="go-rank" style="background: ${bg};">${rankInner}</span>
          <span class="go-avatar">${ctx.avatarOf(id)}</span>
          <span class="go-name">${escapeHtml(ctx.nameOf(id))}</span>
          <span class="go-bar-wrap">
            <span class="go-bar" style="--bar-pct: ${pct}%; background: ${bg};"></span>
          </span>
          <span class="go-score">${score}</span>
        </li>`;
      })
      .join("");

    root.innerHTML = `
      <div class="overlay-card overlay-card--gameover">
        ${musicChip(ctx)}
        <h2>${heading}</h2>
        ${subtext}
        <ol class="go-board">${rows}</ol>
        <button type="button" class="rematch-btn">One more round?</button>
      </div>
    `;
    root
      .querySelector<HTMLButtonElement>(".rematch-btn")
      ?.addEventListener("click", handlers.onRematch);
  }

  function render(phase: GamePhase, ctx: RenderContext): void {
    switch (phase.kind) {
      case "Lobby":
        renderLobby(phase, ctx);
        break;
      case "ChoosingWord":
        renderChoosing(phase, ctx);
        break;
      case "RoundEnd":
        renderRoundEnd(phase, ctx);
        break;
      case "GameOver":
        renderGameOver(phase, ctx);
        break;
      case "Drawing":
        clear();
        break;
    }
    if (phase.kind !== "Drawing") wireMusicChip(ctx);
  }

  function bannerText(phase: GamePhase): string | null {
    switch (phase.kind) {
      case "Drawing":
        return phase.myWord ?? phase.mask;
      case "ChoosingWord":
        return null;
      default:
        return null;
    }
  }

  return { render, bannerText };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
