import { renderAvatar } from "./avatar";
import { hasStoredIdentity, loadStoredIdentity, pickNameAndAvatar } from "./avatarPicker";
import { CHAT_BUCKET_CAPACITY, CHAT_BUCKET_REFILL_PER_SEC, TokenBucket } from "./bucket";
import { DrawingSurface } from "./canvas";
import { showCanvasEvent } from "./canvasEvent";
import {
  enableBg,
  enableSfx,
  isBgEnabled,
  isSfxEnabled,
  loadBgPreference,
  loadSfxPreference,
  playCorrect,
  playGameOver,
  playJoin,
  playRoundEnd,
  playRoundStart,
  setBgScene,
  setVoiceDucking,
  toggleBg,
  toggleSfx,
} from "./music";
import { showRoundIntro } from "./roundIntro";
import type { MicState } from "./voice";
import { mountChat, type ChatPanel } from "./chat";
import { showConfirm } from "./dialog";
import { showToast } from "./toast";
import { applyScores, emptyState, MODE_OPTIONS, type GamePhase, type GameState } from "./game";
import { mountGameUI } from "./gameUI";
import {
  hideJoinPendingScreen,
  showFatalScreen,
  showJoinPendingScreen,
} from "./kicked";
import { showLanding } from "./landing";
import {
  parseRoomCode,
  type Player,
  type ServerMsg,
} from "./proto";
import { loadInitialColor, loadInitialTool, mountToolbar } from "./toolbar";
import { Conn, type ConnState } from "./ws";

// Show the landing screen if no room is in the URL. The landing form
// redirects to ?room=CODE&host=1&mode=MODE on submit.
const params = new URLSearchParams(window.location.search);
if (!params.has("room")) {
  showLanding();
} else {
  void bootRoom();
}

async function bootRoom(): Promise<void> {

function pickRoomCode(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("room");
  if (fromUrl) return parseRoomCode(fromUrl);
  const generated = randomCode();
  const url = new URL(window.location.href);
  url.searchParams.set("room", generated);
  window.history.replaceState({}, "", url.toString());
  return generated;
}

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function pickClientToken(): string {
  const key = "pastel.client_token";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const tok = (window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
    .toString();
  window.localStorage.setItem(key, tok);
  return tok;
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

const canvasEl = document.getElementById("canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLElement;
const playersEl = document.getElementById("players") as HTMLElement;
const toolbarEl = document.getElementById("toolbar") as HTMLElement;
const chatEl = document.getElementById("chat") as HTMLElement;
const bannerEl = document.getElementById("banner") as HTMLElement;
const overlayEl = document.getElementById("gameOverlay") as HTMLElement;

const room = pickRoomCode();
const voiceRequested = new URLSearchParams(window.location.search).get("voice") === "1";

// Kick off the LiveKit chunk download in parallel with the avatar picker.
// By the time the user finishes picking, the 500KB SDK is cached and the
// post-picker connect only pays the WS handshake (~100-300ms).
const voicePrefetch: Promise<typeof import("./voice")> | null = voiceRequested
  ? import("./voice")
  : null;

// Skip the picker entirely if the browser already has a saved name + avatar
// from a previous session. Paired with the persistent client_token below, a
// reload (or any return visit) lands on the server as the same player, with
// the same scoreboard row, instead of a fresh duplicate.
//
// Exception: when landing.ts sets the "confirm-identity-next-join" session
// flag (real new-game entries, not reloads/rejoins), show a soft confirm
// that lets the user keep the saved identity or change it before joining.
const PROMPT_FLAG = "pastel.confirm-identity-next-join";
async function pickOrConfirmIdentity() {
  if (!hasStoredIdentity()) {
    return pickNameAndAvatar();
  }
  const wantsConfirm = window.sessionStorage.getItem(PROMPT_FLAG) === "1";
  window.sessionStorage.removeItem(PROMPT_FLAG); // one-shot
  if (!wantsConfirm) {
    return loadStoredIdentity();
  }
  const stored = loadStoredIdentity();
  const keep = await showConfirm({
    title: `playing as ${stored.name}`,
    message:
      "want to keep this name and avatar, or change them before joining?",
    confirmLabel: "Looks good!",
    cancelLabel: "Change",
  });
  if (keep) return stored;
  return pickNameAndAvatar();
}
const { name, avatar } = await pickOrConfirmIdentity();
const clientToken = pickClientToken();
document.title = `pastel -- room ${room}`;

if (voiceRequested && voicePrefetch) {
  await prewarmVoice(room, name, voicePrefetch);
}

async function prewarmVoice(
  roomCode: string,
  displayName: string,
  modulePromise: Promise<typeof import("./voice")>,
): Promise<void> {
  const overlay = document.createElement("div");
  overlay.className = "voice-prewarm";
  overlay.innerHTML = `
    <div class="voice-prewarm-card">
      <div class="voice-prewarm-spin"><i class="ph ph-microphone"></i></div>
      <div class="voice-prewarm-title">Setting up voice...</div>
      <div class="voice-prewarm-sub">grabbing the line</div>
    </div>
  `;
  document.body.appendChild(overlay);
  try {
    const v = await modulePromise;
    await v.connectVoice(roomCode, displayName);
  } catch (e) {
    console.warn("[voice] prewarm failed", e);
  } finally {
    overlay.remove();
  }
}

// Mode for the next game start. Seeded from the URL (?mode=...) which the
// landing page sets for the host. Falls back to Standard for joiners and
// reloads. Updated after each game from the snapshot so rematches keep the
// same mode.
const urlMode = new URLSearchParams(window.location.search).get("mode");
let selectedMode: import("./proto").GameMode =
  (urlMode === "Sprint" || urlMode === "Standard" || urlMode === "Marathon")
    ? urlMode
    : "Standard";

const surface = new DrawingSurface(canvasEl);

const initialColor = loadInitialColor();
const initialTool = loadInitialTool();
surface.setColor(initialColor);
surface.setWidth(initialTool.width);

const players = new Map<number, Player>();
const playerColors = new Map<number, number>();
const pendingJoiners = new Map<number, string>();
// Sticky names + avatars: once we've ever seen a PlayerId's name/avatar,
// we remember it forever this session. Old chat messages and end-of-game
// podiums for players who have since left still render with their real
// identity.
const nameHistory = new Map<number, string>();
const avatarHistory = new Map<number, import("./proto").Avatar>();
let youId: number | null = null;

function recordName(id: number, name: string): void {
  nameHistory.set(id, name);
}

function recordAvatar(id: number, av: import("./proto").Avatar): void {
  avatarHistory.set(id, av);
}

function avatarOf(id: number): string {
  const a = players.get(id)?.avatar ?? avatarHistory.get(id);
  if (a) return renderAvatar(a);
  // Player we never knew (extremely unlikely). Fall back to a tiny initial
  // chip so the row layout still looks consistent.
  const name = nameOf(id);
  const ch = (name[0] ?? "?").toUpperCase();
  return `<span class="avatar-fallback">${ch}</span>`;
}

const gameState: GameState = emptyState();

// The server's unicast (WordOptions, DrawerWord) is read by the connection
// task BEFORE the broadcast (WordPickStarted, RoundStart) thanks to the
// biased select on the server. So the drawer routinely sees the unicast
// before the broadcast. Stash whichever arrives first and merge it into the
// phase whenever the matching broadcast lands.
let pendingWordOptions: string[] | null = null;
let pendingDrawerWord: string | null = null;
const prevScores = new Map<number, number>();
const correctGuessers = new Set<number>();
const speakingNames = new Set<string>();
const mutedSpeakerNames = new Set<string>();
// Reaction state, reset each round. Guessers stash what they picked so the
// button stays selected. The drawer stashes the latest aggregated mood the
// server pushed so the banner can render their feedback.
let myReaction: import("./proto").DrawingMood | null = null;
let drawerFeedback: import("./proto").DrawingMood | null = null;

function nameOf(id: number, fallback = "anon"): string {
  return players.get(id)?.name ?? nameHistory.get(id) ?? fallback;
}

function colorOf(id: number): number {
  return playerColors.get(id) ?? 0x76767c;
}

function renderPlayers(): void {
  const youAreHost = youId !== null && youId === gameState.host;
  const sorted = Array.from(players.values()).sort((a, b) => {
    const sa = gameState.scores.get(a.id) ?? 0;
    const sb = gameState.scores.get(b.id) ?? 0;
    return sb - sa || a.id - b.id;
  });
  const items = sorted.map((p, idx) => {
    const score = gameState.scores.get(p.id);
    const prev = prevScores.get(p.id);
    const changed = score !== undefined && prev !== undefined && score !== prev;
    const hasScores = gameState.scores.size > 0;
    const rankTag = hasScores
      ? `<span class="players-rank">#${idx + 1}</span>`
      : "";
    const scoreTag =
      score !== undefined
        ? `<span class="players-score${changed ? " players-score--pop" : ""}" data-pid="${p.id}">${score}</span>`
        : "";
    const youTag = p.id === youId ? '<span class="players-you">(you)</span>' : "";
    const hostTag =
      p.id === gameState.host ? '<span class="players-host">host</span>' : "";
    const botTag = p.is_bot
      ? '<span class="players-bot" title="bot"><i class="ph ph-robot" aria-hidden="true"></i></span>'
      : "";
    const kickBtn =
      youAreHost && p.id !== youId
        ? `<button class="players-kick" data-target="${p.id}" title="Remove ${escapeHtml(
            p.name,
          )} from the room" aria-label="Remove ${escapeHtml(p.name)}">×</button>`
        : "";
    const guessedTag = correctGuessers.has(p.id)
      ? '<span class="players-guessed" title="Guessed correctly">✓</span>'
      : "";
    const muteBtn =
      voiceRequested && p.id !== youId
        ? `<button class="players-mute${mutedSpeakerNames.has(p.name) ? " players-mute--on" : ""}" data-target-name="${escapeHtml(p.name)}" title="${mutedSpeakerNames.has(p.name) ? `Unmute ${escapeHtml(p.name)}` : `Mute ${escapeHtml(p.name)}`}" aria-label="Toggle mute for ${escapeHtml(p.name)}"><i class="${mutedSpeakerNames.has(p.name) ? "ph-fill ph-speaker-slash" : "ph ph-speaker-high"}" aria-hidden="true"></i></button>`
        : "";
    const correctClass = correctGuessers.has(p.id) ? " players-li--correct" : "";
    const speakingClass = speakingNames.has(p.name) ? " players-li--speaking" : "";
    return `<li class="${correctClass}${speakingClass}" data-player-name="${escapeHtml(p.name)}">
      ${rankTag}
      <span class="players-avatar-wrap">
        <span class="players-avatar">${renderAvatar(p.avatar)}</span>
        ${kickBtn}
      </span>
      <div class="players-info">
        <span class="players-name">${escapeHtml(p.name)}${botTag}</span>
        <span class="players-meta">
          ${youTag}${hostTag}${guessedTag}${scoreTag}${muteBtn}
        </span>
      </div>
    </li>`;
  });
  const pendingItems =
    youAreHost && pendingJoiners.size > 0
      ? Array.from(pendingJoiners.entries())
          .map(
            ([id, n]) => `<li class="pending-row">
              <span class="pending-name">${escapeHtml(n)}</span>
              <span class="pending-tag">wants to rejoin</span>
              <span class="pending-actions">
                <button class="pending-approve" data-target="${id}">Approve</button>
                <button class="pending-reject" data-target="${id}">Reject</button>
              </span>
            </li>`,
          )
          .join("")
      : "";
  const pendingSection = pendingItems
    ? `<ul class="pending-list">${pendingItems}</ul>`
    : "";
  playersEl.innerHTML = `
    <div class="players-head">
      <h2>Room <span class="room-code">${room}</span></h2>
      <button class="players-invite" type="button" title="Copy invite link">
        Invite
      </button>
    </div>
    ${pendingSection}
    <ul>${items.join("")}</ul>
  `;
  for (const btn of playersEl.querySelectorAll<HTMLButtonElement>(".players-kick")) {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.target);
      if (Number.isNaN(target)) return;
      const who = nameOf(target);
      void showConfirm({
        title: `Remove ${who}?`,
        message: `${who} will be kicked from the room and will need your approval to rejoin.`,
        confirmLabel: "Remove",
        destructive: true,
      }).then((ok) => {
        if (ok) conn.send({ kind: "Game", action: { kind: "Kick", player: target } });
      });
    });
  }
  playersEl
    .querySelector<HTMLButtonElement>(".players-invite")
    ?.addEventListener("click", () => {
      void copyInviteLink();
    });
  for (const btn of playersEl.querySelectorAll<HTMLButtonElement>(".players-mute")) {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.targetName ?? "";
      if (!target) return;
      const v = await loadVoice();
      const nowMuted = v.toggleRemoteMute(target);
      if (nowMuted) mutedSpeakerNames.add(target);
      else mutedSpeakerNames.delete(target);
      renderPlayers();
    });
  }
  for (const btn of playersEl.querySelectorAll<HTMLButtonElement>(
    ".pending-approve",
  )) {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.target);
      if (Number.isNaN(target)) return;
      conn.send({
        kind: "Game",
        action: { kind: "ApproveJoin", candidate: target },
      });
    });
  }
  for (const btn of playersEl.querySelectorAll<HTMLButtonElement>(
    ".pending-reject",
  )) {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.target);
      if (Number.isNaN(target)) return;
      conn.send({
        kind: "Game",
        action: { kind: "RejectJoin", candidate: target },
      });
    });
  }
  // Snapshot scores so the next render can detect changes for the pop.
  prevScores.clear();
  for (const [id, v] of gameState.scores) prevScores.set(id, v);
}

const chatBucket = new TokenBucket(CHAT_BUCKET_CAPACITY, CHAT_BUCKET_REFILL_PER_SEC);

const chat: ChatPanel = mountChat(chatEl, {
  onSend: (text) => {
    if (!chatBucket.tryTake()) return false;
    // During Drawing phase as a non-drawer, treat input as a guess. The
    // server treats both as text; this is just routing semantic.
    if (gameState.phase.kind === "Drawing" && gameState.phase.drawer !== youId) {
      conn.send({ kind: "Guess", text });
    } else {
      conn.send({ kind: "Chat", text });
    }
    return true;
  },
});

const gameUI = mountGameUI(overlayEl, {
  onStart: () =>
    conn.send({ kind: "Game", action: { kind: "Start", mode: selectedMode } }),
  onPickWord: (index) =>
    conn.send({ kind: "Game", action: { kind: "PickWord", index } }),
  onRematch: () => {
    gameState.phase = { kind: "Lobby" };
    renderGameUI();
  },
  onAddBot: (difficulty) => {
    fetch(`/bot/${room}?difficulty=${difficulty}`, { method: "POST" })
      .then((r) => r.text())
      .then((name) => showToast(name, { kind: "success" }))
      .catch(() => showToast("Couldn't add bot", { kind: "error" }));
  },
});

mountToolbar(toolbarEl, {
  onColor: (rgb) => surface.setColor(rgb),
  onTool: (tool) => surface.setWidth(tool.width),
  onClear: () => conn.send({ kind: "Game", action: { kind: "Clear" } }),
});

renderPlayers();
renderGameUI();
startBannerTicker();

// Settings bar over the canvas: separate toggles for bg music and event sfx.
// Both persist across sessions, default off. Browsers require a user gesture
// before AudioContext.resume(), so a previously-saved "on" preference still
// waits for any click before actually starting.
const bgBtn = document.getElementById("bgToggle") as HTMLButtonElement | null;
const sfxBtn = document.getElementById("sfxToggle") as HTMLButtonElement | null;
function refreshAudioBtns(): void {
  const bgOn = isBgEnabled();
  const sfxOn = isSfxEnabled();
  bgBtn?.classList.toggle("canvas-setting--on", bgOn);
  sfxBtn?.classList.toggle("canvas-setting--on", sfxOn);
  const bgIcon = bgBtn?.querySelector("i");
  if (bgIcon) bgIcon.className = bgOn ? "ph-fill ph-music-notes" : "ph ph-music-notes";
  const sfxIcon = sfxBtn?.querySelector("i");
  if (sfxIcon) sfxIcon.className = sfxOn ? "ph-fill ph-speaker-high" : "ph ph-speaker-simple-slash";
}
bgBtn?.addEventListener("click", async () => {
  await toggleBg();
  refreshAudioBtns();
});
sfxBtn?.addEventListener("click", async () => {
  await toggleSfx();
  refreshAudioBtns();
});

if (loadBgPreference() || loadSfxPreference()) {
  const armOnFirstClick = async () => {
    if (loadBgPreference()) await enableBg();
    if (loadSfxPreference()) await enableSfx();
    refreshAudioBtns();
  };
  document.addEventListener("click", armOnFirstClick, { once: true });
}
refreshAudioBtns();

// Voice chat (LiveKit). Mic starts off; first click connects + publishes muted,
// second click goes live. Active speakers drive a pulse on player avatars.
const micBtn = document.getElementById("micToggle") as HTMLButtonElement | null;

function refreshMicBtn(state: MicState): void {
  if (!micBtn) return;
  micBtn.classList.toggle("canvas-setting--on", state === "live");
  micBtn.classList.toggle("canvas-setting--busy", state === "connecting");
  const icon = micBtn.querySelector("i");
  if (icon) {
    if (state === "live") icon.className = "ph-fill ph-microphone";
    else if (state === "muted") icon.className = "ph ph-microphone";
    else if (state === "connecting") icon.className = "ph ph-circle-notch";
    else icon.className = "ph ph-microphone-slash";
  }
}

function applySpeakingClasses(): void {
  for (const li of playersEl.querySelectorAll<HTMLLIElement>("li[data-player-name]")) {
    const n = li.dataset.playerName ?? "";
    li.classList.toggle("players-li--speaking", speakingNames.has(n));
  }
}

// LiveKit SDK is ~500KB; lazy-load on first mic tap so non-voice users don't pay.
// If the room was created with ?voice=1 it's already pre-imported and warmed.
let voiceModule: typeof import("./voice") | null = null;
async function loadVoice(): Promise<typeof import("./voice")> {
  if (voiceModule) return voiceModule;
  voiceModule = await import("./voice");
  voiceModule.onMicState((s) => {
    refreshMicBtn(s);
    setVoiceDucking(s === "live");
  });
  voiceModule.onActiveSpeakers((ids) => {
    speakingNames.clear();
    for (const id of ids) speakingNames.add(voiceModule!.identityToName(id));
    applySpeakingClasses();
  });
  return voiceModule;
}

micBtn?.addEventListener("click", async () => {
  const v = await loadVoice();
  await v.toggleMic(room, name);
});

if (voiceRequested) {
  // Module is already imported by prewarmVoice; this attaches the listeners.
  void loadVoice();
} else {
  refreshMicBtn("off");
}

const wsUrl = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/${room}`;
})();

function modeBadge(): string {
  const m = MODE_OPTIONS.find((o) => o.id === selectedMode) ?? MODE_OPTIONS[1];
  return `${m.label} · ${m.rounds} rounds`;
}

function renderGameUI(): void {
  gameUI.render(gameState.phase, {
    you: youId,
    host: gameState.host,
    playerCount: players.size,
    nameOf: (id) => nameOf(id),
    avatarOf: (id) => avatarOf(id),
    modeBadge: modeBadge(),
    playerAvatars: Array.from(players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      avatarHtml: avatarOf(p.id),
    })),
    onCopyInvite: copyInviteLink,
  });
  updateBanner();
  const isGuessing =
    gameState.phase.kind === "Drawing" && gameState.phase.drawer !== youId;
  chat.setGuessMode(isGuessing);
}

async function copyInviteLink(): Promise<void> {
  const url = window.location.href;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      // Fallback for non-secure contexts (e.g. plain http during dev).
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    showToast("Link copied!", { kind: "success" });
  } catch {
    showToast("Couldn't copy the link", { kind: "error" });
    chat.appendSystem("share this link: " + url);
  }
}

// One-shot feedback nudge after a player's very first game in this browser.
// Surfaces a soft confirm with a "share feedback" CTA that opens the GitHub
// issues page in a new tab. localStorage keys make it idempotent: once
// dismissed or actioned, it never appears again from this browser.
const FEEDBACK_SHOWN_KEY = "pastel.feedback-prompted";
const FEEDBACK_URL =
  "https://github.com/pixperk/pastel/issues/new?template=feedback.yml";
async function maybeAskForFeedback(): Promise<void> {
  if (window.localStorage.getItem(FEEDBACK_SHOWN_KEY) === "1") return;
  window.localStorage.setItem(FEEDBACK_SHOWN_KEY, "1");
  // Tiny delay so the GameOver podium animates in first and the popup
  // doesn't fight for attention with the score reveal.
  await new Promise((r) => window.setTimeout(r, 1200));
  const wantsToShare = await showConfirm({
    title: "Thanks for playing!",
    message:
      "You're one of the first to try pastel. Got 30 seconds to share what worked and what didn't? It really helps shape the launch.",
    confirmLabel: "Share feedback on GitHub",
    cancelLabel: "Maybe later",
  });
  if (wantsToShare) {
    window.open(FEEDBACK_URL, "_blank", "noopener,noreferrer");
  }
}

function updateBanner(): void {
  const phase = gameState.phase;
  if (phase.kind !== "Drawing" && phase.kind !== "ChoosingWord") {
    bannerEl.classList.add("banner--hidden");
    return;
  }
  bannerEl.classList.remove("banner--hidden");
  const text = gameUI.bannerText(phase) ?? "";
  const round = `Round ${phase.roundIndex + 1}/${phase.totalRounds}`;
  const isDrawing = phase.kind === "Drawing";
  const isDrawer = isDrawing && phase.drawer === youId;
  const hint = isDrawing && !isDrawer
    ? `<div class="banner-hint">${escapeHtml(nameOf(phase.drawer))} is drawing -- feel free to doodle, only you can see it</div>`
    : "";
  // Guessers see a reaction strip; the drawer sees a feedback pill when the
  // server reports a dominant mood from the room.
  let extra = "";
  if (isDrawing && !isDrawer) {
    const lovedOn = myReaction === "Loved" ? " reaction-btn--on" : "";
    const confusedOn = myReaction === "Confused" ? " reaction-btn--on" : "";
    extra = `<div class="banner-reactions">
      <button class="reaction-btn reaction-btn--love${lovedOn}" data-mood="Loved" type="button" title="Looking good">
        <i class="ph-fill ph-sparkle" aria-hidden="true"></i>
        <span>looking good</span>
      </button>
      <button class="reaction-btn reaction-btn--lost${confusedOn}" data-mood="Confused" type="button" title="I'm lost">
        <i class="ph ph-question" aria-hidden="true"></i>
        <span>i'm lost</span>
      </button>
    </div>`;
  } else if (isDrawing && isDrawer && drawerFeedback) {
    const fb = drawerFeedback;
    const cls = fb === "Loved" ? "feedback-pill--love" : "feedback-pill--lost";
    const text = fb === "Loved"
      ? "they're loving it -- nice work!"
      : "they're a bit lost -- bigger, clearer strokes?";
    const icon = fb === "Loved" ? "ph-fill ph-sparkle" : "ph ph-question";
    extra = `<div class="feedback-pill ${cls}">
      <i class="${icon}" aria-hidden="true"></i>
      <span>${text}</span>
    </div>`;
  }
  bannerEl.innerHTML = `
    <div class="banner-main">
      <div class="banner-drawer" title="${escapeHtml(nameOf(phase.drawer))}">
        ${avatarOf(phase.drawer)}
      </div>
      <div class="banner-round">${escapeHtml(round)}</div>
      <div class="banner-mask">${escapeHtml(text)}</div>
      <div class="banner-timer" id="bannerTimer">--</div>
    </div>
    ${hint}
    ${extra}
  `;
  for (const btn of bannerEl.querySelectorAll<HTMLButtonElement>(".reaction-btn")) {
    btn.addEventListener("click", () => {
      const mood = btn.dataset.mood as import("./proto").DrawingMood | undefined;
      if (!mood) return;
      myReaction = mood;
      conn.send({ kind: "React", mood });
      updateBanner();
    });
  }
}

function startBannerTicker(): void {
  function tick(): void {
    const timerEl = document.getElementById("bannerTimer");
    const phase = gameState.phase;
    if (timerEl) {
      const deadline =
        phase.kind === "Drawing" || phase.kind === "ChoosingWord"
          ? phase.deadline
          : null;
      if (deadline !== null) {
        const ms = Math.max(0, deadline - performance.now());
        const secs = Math.ceil(ms / 1000);
        timerEl.textContent = `${secs}s`;
        if (secs <= 10) {
          timerEl.classList.add("banner-timer--low");
        } else {
          timerEl.classList.remove("banner-timer--low");
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function applyGameSnapshot(snap: import("./proto").GameSnapshot): void {
  gameState.host = snap.host;
  // Only adopt the server's mode once an actual game has set it. The server's
  // default is Standard, so taking snap.mode at Welcome would clobber the
  // host's URL choice (?mode=Sprint, Marathon, etc.) before they can Start.
  // Once we're past Lobby the mode is real and worth restoring for rematches.
  if (snap.phase.kind !== "Lobby") {
    selectedMode = snap.mode;
  }
  gameState.scores.clear();
  for (const [id, v] of snap.scores) gameState.scores.set(id, v);
  switch (snap.phase.kind) {
    case "Lobby":
      gameState.phase = {
        kind: "Lobby",
        deadline:
          snap.phase.deadline_ms !== null
            ? performance.now() + snap.phase.deadline_ms
            : undefined,
      };
      return;
    case "ChoosingWord":
      gameState.phase = {
        kind: "ChoosingWord",
        drawer: snap.phase.drawer,
        deadline: performance.now() + snap.phase.deadline_ms,
        roundIndex: snap.phase.round_index,
        totalRounds: snap.phase.total_rounds,
      };
      return;
    case "Drawing":
      gameState.phase = {
        kind: "Drawing",
        drawer: snap.phase.drawer,
        mask: snap.phase.mask,
        deadline: performance.now() + snap.phase.deadline_ms,
        durationMs: snap.phase.deadline_ms,
        roundIndex: snap.phase.round_index,
        totalRounds: snap.phase.total_rounds,
      };
      return;
    case "RoundEnd":
      gameState.phase = {
        kind: "RoundEnd",
        word: snap.phase.word,
        scores: snap.scores,
      };
      return;
    case "GameOver":
      gameState.phase = { kind: "GameOver", finalScores: snap.scores };
      return;
  }
}

function handleMessage(msg: ServerMsg): void {
  switch (msg.kind) {
    case "Welcome": {
      // If we were waiting on host approval, the overlay can come down.
      hideJoinPendingScreen();
      surface.setYouId(msg.you);
      youId = msg.you;
      players.clear();
      playerColors.clear();
      for (const p of msg.snapshot.players) {
        players.set(p.id, p);
        recordName(p.id, p.name);
        recordAvatar(p.id, p.avatar);
      }
      players.set(msg.you, { id: msg.you, name, avatar, is_bot: false });
      recordName(msg.you, name);
      recordAvatar(msg.you, avatar);
      // Snapshot chat may reference identities of players who have since left;
      // ensure those names + avatars persist for re-render after reload.
      for (const line of msg.snapshot.chat) {
        const author = msg.snapshot.players.find((p) => p.id === line.player);
        if (author) {
          recordName(author.id, author.name);
          recordAvatar(author.id, author.avatar);
        }
      }
      for (const s of msg.snapshot.completed) playerColors.set(s.player, s.color);
      applyGameSnapshot(msg.snapshot.game);
      renderPlayers();
      surface.applySnapshot(msg);
      chat.clear();
      for (const line of msg.snapshot.chat) {
        chat.appendMessage(
          nameOf(line.player),
          line.text,
          colorOf(line.player),
          line.player === youId,
          avatarOf(line.player),
        );
      }
      chat.appendSystem(`you're in! welcome to room ${room}`);
      renderGameUI();
      return;
    }
    case "Presence": {
      for (const p of msg.joined) {
        players.set(p.id, p);
        recordName(p.id, p.name);
        recordAvatar(p.id, p.avatar);
        // Approved rejoin: drop their entry from the host's pending list.
        pendingJoiners.delete(p.id);
        if (p.id !== youId) {
          chat.appendSystem(`${p.name} hopped in`, avatarOf(p.id));
          playJoin();
        }
      }
      for (const id of msg.left) {
        const who = nameOf(id);
        const avatar = avatarOf(id); // capture before delete
        players.delete(id);
        playerColors.delete(id);
        // nameHistory keeps `who` for any future references in chat/scores.
        chat.appendSystem(`${who} left the room`, avatar);
      }
      renderPlayers();
      // Re-render the overlay too: the lobby's "you're alone" message
      // depends on player count, and a Presence change just shifted it.
      renderGameUI();
      return;
    }
    case "Stroke":
      playerColors.set(msg.player, msg.color);
      surface.handleStrokeMessage(
        msg.player,
        msg.stroke_id,
        msg.origin,
        msg.color,
        msg.width,
        msg.points,
        msg.finished,
      );
      renderPlayers();
      return;
    case "Chat":
      chat.appendMessage(
        nameOf(msg.player),
        msg.text,
        colorOf(msg.player),
        msg.player === youId,
        avatarOf(msg.player),
      );
      return;
    case "Guess":
      if (msg.guess === "Correct") {
        correctGuessers.add(msg.player);
        renderPlayers();
        playCorrect();
        chat.appendCorrectGuess(
          nameOf(msg.player),
          colorOf(msg.player),
          avatarOf(msg.player),
        );
        showCanvasEvent({
          avatarHtml: avatarOf(msg.player),
          message: `${nameOf(msg.player)} got it!`,
          kind: "celebrate",
        });
      } else if (msg.guess === "Close" && msg.player === youId) {
        // Server unicasts Close only to the guesser, but we still gate
        // here for safety.
        chat.appendCloseGuess();
      }
      return;
    case "Resume":
      for (const e of msg.events) handleMessage(e);
      return;
    case "Bye":
      // Terminal Byes get a full-screen takeover so the user actually
      // notices. "Reconnect" is transient; the WS layer will reconnect.
      if (msg.reason === "Reconnect") {
        statusEl.textContent = "reconnecting...";
        return;
      }
      showFatalScreen(msg.reason);
      return;
    case "Game":
      handleGameEvent(msg.event);
      return;
    case "WordOptions": {
      pendingWordOptions = msg.words;
      if (gameState.phase.kind === "ChoosingWord") {
        gameState.phase = { ...gameState.phase, myOptions: msg.words };
        renderGameUI();
      }
      return;
    }
    case "DrawerWord": {
      pendingDrawerWord = msg.word;
      if (gameState.phase.kind === "Drawing") {
        gameState.phase = { ...gameState.phase, myWord: msg.word };
        renderGameUI();
      }
      return;
    }
    case "Ping":
      return;
    case "JoinPending":
      showJoinPendingScreen();
      return;
    case "DrawingFeedback":
      drawerFeedback = msg.mood;
      updateBanner();
      return;
  }
}

function handleGameEvent(event: Extract<ServerMsg, { kind: "Game" }>["event"]): void {
  switch (event.kind) {
    case "Cleared":
      surface.clear();
      chat.appendSystem(`${nameOf(event.by)} wiped the canvas clean`, avatarOf(event.by));
      showCanvasEvent({
        avatarHtml: avatarOf(event.by),
        message: `${nameOf(event.by)} wiped the canvas`,
      });
      return;
    case "WordPickStarted": {
      // Detect the boundary from Lobby/GameOver into a fresh game. Don't
      // use round_index === 0 alone -- that also matches every drawer's
      // turn within round 0, which would zero out scores accumulated in
      // earlier turns of the same first round.
      const startingFreshGame =
        gameState.phase.kind === "Lobby" || gameState.phase.kind === "GameOver";
      if (startingFreshGame) {
        gameState.scores.clear();
        prevScores.clear();
      }
      const deadline = performance.now() + event.deadline_ms;
      gameState.phase = {
        kind: "ChoosingWord",
        drawer: event.drawer,
        deadline,
        roundIndex: event.round_index,
        totalRounds: event.total_rounds,
        myOptions:
          event.drawer === youId && pendingWordOptions
            ? pendingWordOptions
            : undefined,
      };
      // New round: any stashed DrawerWord from a previous round is stale.
      pendingDrawerWord = null;
      pendingWordOptions = null;
      surface.clear();
      chat.appendSystem(
        `Round ${event.round_index + 1}/${event.total_rounds} -- ${nameOf(event.drawer)} is up next`,
      );
      renderGameUI();
      return;
    }
    case "RoundStart": {
      void setBgScene("game");
      playRoundStart();
      myReaction = null;
      drawerFeedback = null;
      const deadline = performance.now() + event.duration_ms;
      gameState.phase = {
        kind: "Drawing",
        drawer: event.drawer,
        mask: event.word_mask,
        myWord:
          event.drawer === youId && pendingDrawerWord
            ? pendingDrawerWord
            : undefined,
        deadline,
        durationMs: event.duration_ms,
        roundIndex: event.round_index,
        totalRounds: event.total_rounds,
      };
      pendingDrawerWord = null;
      pendingWordOptions = null;
      // Cumulative scores so far, ranked. Players with no points get a 0
      // row so the intro feels populated on round 1.
      const ranked: { id: number; points: number }[] = [];
      for (const id of players.keys()) {
        ranked.push({ id, points: gameState.scores.get(id) ?? 0 });
      }
      ranked.sort((a, b) => b.points - a.points || a.id - b.id);
      showRoundIntro({
        roundIndex: event.round_index,
        totalRounds: event.total_rounds,
        drawerName: nameOf(event.drawer),
        drawerAvatarHtml: avatarOf(event.drawer),
        scores: ranked.map((r) => ({
          id: r.id,
          name: nameOf(r.id),
          avatarHtml: avatarOf(r.id),
          points: r.points,
        })),
      });
      renderGameUI();
      return;
    }
    case "HintReveal":
      if (gameState.phase.kind === "Drawing") {
        gameState.phase = { ...gameState.phase, mask: event.mask };
        renderGameUI();
      }
      return;
    case "RoundEnd":
      correctGuessers.clear();
      applyScores(gameState, event.scores);
      gameState.phase = {
        kind: "RoundEnd",
        word: event.word,
        scores: event.scores,
      };
      chat.appendSystem(`the word was "${event.word}"`);
      playRoundEnd();
      renderPlayers();
      renderGameUI();
      return;
    case "GameOver":
      void setBgScene("lobby");
      playGameOver();
      applyScores(gameState, event.final_scores);
      gameState.phase = {
        kind: "GameOver",
        finalScores: event.final_scores,
      };
      renderPlayers();
      renderGameUI();
      // First completed game ever in this browser: show a one-shot
      // feedback prompt that links to GitHub issues. Skipped on
      // every subsequent game-over.
      void maybeAskForFeedback();
      return;
    case "JoinRequest":
      pendingJoiners.set(event.candidate, event.name);
      recordName(event.candidate, event.name);
      renderPlayers();
      return;
    case "JoinCanceled":
      pendingJoiners.delete(event.candidate);
      renderPlayers();
      return;
    case "HostChanged":
      gameState.host = event.new_host;
      chat.appendSystem(
        `${nameOf(event.new_host)} is now the host`,
        avatarOf(event.new_host),
      );
      showCanvasEvent({
        avatarHtml: avatarOf(event.new_host),
        message: `${nameOf(event.new_host)} is now the host`,
      });
      renderPlayers();
      renderGameUI();
      return;
    case "Reaction": {
      const who = nameOf(event.player);
      const line = event.mood === "Loved"
        ? `${who} appreciated the drawing`
        : `${who} is confused`;
      chat.appendSystem(line, avatarOf(event.player));
      return;
    }
  }
}

function handleState(s: ConnState): void {
  switch (s.kind) {
    case "connecting":
      statusEl.textContent = "finding the room...";
      return;
    case "open":
      statusEl.textContent = `room ${room} -- playing as ${name}`;
      void setBgScene("lobby");
      return;
    case "reconnecting":
      statusEl.textContent = `reconnecting... (try ${s.attempt})`;
      return;
    case "closed":
      statusEl.textContent = `lost connection: ${s.reason}`;
      return;
  }
}

const conn = new Conn({
  url: wsUrl,
  hello: () => ({
    kind: "Hello",
    hello: {
      room,
      name,
      resume_from: null,
      client_token: clientToken,
      avatar,
    },
  }),
  onMessage: handleMessage,
  onState: handleState,
});

surface.attachSender((msg) => conn.send(msg));

  // Avoid an unused-import lint when game.ts re-exports types we only use as
  // types at call sites.
  void (null as unknown as GamePhase);
}
