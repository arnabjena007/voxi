import { renderAvatar } from "./avatar";
import { hasStoredIdentity, loadStoredIdentity, pickNameAndAvatar } from "./avatarPicker";
import { CHAT_BUCKET_CAPACITY, CHAT_BUCKET_REFILL_PER_SEC, TokenBucket } from "./bucket";
import { DrawingSurface } from "./canvas";
import { showCanvasEvent } from "./canvasEvent";
import { confettiBurst } from "./celebrate";
import { makeSettingsDraggable } from "./dragSettings";
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
import { isPhoneViewport, loadInitialColor, loadInitialTool, mountToolbar } from "./toolbar";
import { mountMobileTools } from "./mobileTools";
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
// Mask-reveal state. Module-level (NOT inside updateBanner) because the boot
// path calls renderGameUI() before any function below would have a chance to
// initialise a `let` in its body. Declared up here next to the other game
// state so it lands in the TDZ-safe zone before line 472.
let lastSubmittedGuess: string | null = null;
let lastRevealedWord: string | null = null;
// Previous mask string, so a hint that unlocks a new letter can animate just
// that character in (rather than popping in silently).
let lastMask: string | null = null;
// Set true for one banner render when a guess lands while you're the drawer,
// so the guess-count pill pulses once instead of on every re-render.
let drawerGuessPulse = false;

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
      <button class="invite-pill" type="button" title="Copy the invite link">
        <span class="invite-pill-main">
          <span class="invite-pill-label">room</span>
          <span class="invite-pill-code">${room}</span>
        </span>
        <span class="invite-pill-cta">
          <i class="ph ph-link invite-pill-icon" aria-hidden="true"></i>
          <span class="invite-pill-text">invite</span>
        </span>
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
  const invitePill = playersEl.querySelector<HTMLButtonElement>(".invite-pill");
  invitePill?.addEventListener("click", () => {
    void copyInviteLink();
    const cta = invitePill.querySelector<HTMLElement>(".invite-pill-cta");
    if (cta && !invitePill.classList.contains("invite-pill--copied")) {
      const prev = cta.innerHTML;
      invitePill.classList.add("invite-pill--copied");
      cta.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>copied!</span>';
      window.setTimeout(() => {
        cta.innerHTML = prev;
        invitePill.classList.remove("invite-pill--copied");
      }, 1500);
    }
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
    // During Drawing, only still-guessing players send as Guess. Once you've
    // guessed correctly (or you're the drawer) your input is chat -- still
    // visible to the room, but the server intercepts any attempt to leak
    // the word and replies with a Spoiler nudge instead of broadcasting.
    const phase = gameState.phase;
    const inDrawing = phase.kind === "Drawing";
    const isDrawer = inDrawing && phase.drawer === youId;
    const youAlreadyGuessed =
      youId !== null && correctGuessers.has(youId);
    if (inDrawing && !isDrawer && !youAlreadyGuessed) {
      lastSubmittedGuess = text;
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

// Drawing-phase semantics: the shared canvas belongs to the drawer. Their
// Clear wipes everyone via server broadcast. Non-drawers may have scribbled
// locally (server rejected their strokes); their Clear wipes only their own
// local doodles via surface.clearLocal(), leaving the drawer's work alone.
// In Lobby/RoundEnd/GameOver the canvas is freely shared, so any Clear
// broadcasts to everyone like before.
async function clearCanvas(): Promise<void> {
  const phase = gameState.phase;
  const inDrawing = phase.kind === "Drawing";
  const isDrawer = inDrawing && phase.drawer === youId;

  if (inDrawing && !isDrawer) {
    const ok = await showConfirm({
      title: "Clear your doodles?",
      message:
        "Only your own scribbles vanish. The drawer's canvas stays.",
      confirmLabel: "Clear mine",
      destructive: true,
    });
    if (ok) surface.clearLocal();
    return;
  }

  const ok = await showConfirm({
    title: "Clear the canvas?",
    message: "Everyone in the room will lose what's been drawn.",
    confirmLabel: "Clear it",
    destructive: true,
  });
  if (ok) conn.send({ kind: "Game", action: { kind: "Clear" } });
}

// Undo / redo. Local-only for non-drawer doodles during Drawing; server
// round-trips for the shared canvas (drawer in Drawing, anyone in Lobby).
// Buttons + Ctrl+Z keyboard call performUndo / performRedo; toolbar UI
// reads canUndo() / canRedo() to enable / disable themselves on render.
function strokeIsShared(): boolean {
  const phase = gameState.phase;
  if (phase.kind === "Lobby") return true;
  if (phase.kind === "Drawing" && phase.drawer === youId) return true;
  return false;
}

function performUndo(): void {
  if (!surface.canUndo()) return;
  if (strokeIsShared()) {
    // Move the record from undo to redo stack locally so we keep its data
    // for a potential redo. The actual removal from completedStrokes
    // happens when the server's StrokeRemoved broadcast lands.
    const popped = surface.undoLocal();
    if (popped !== null) {
      conn.send({ kind: "Undo" });
    }
  } else {
    surface.undoLocal();
  }
  refreshUndoButtons();
}

function performRedo(): void {
  if (!surface.canRedo()) return;
  const record = surface.popRedo();
  if (record === null) return;
  if (strokeIsShared()) {
    // Fresh stroke id so the server treats it as a new stroke rather than
    // a replay of the one we just undid. Same color, width, points.
    const newStrokeId = surface.allocateStrokeId();
    conn.send({
      kind: "Stroke",
      stroke_id: newStrokeId,
      origin: record.origin,
      color: record.color,
      width: record.width,
      points: record.points,
      finished: true,
    });
    surface.redoLocalApply(record, newStrokeId);
  } else {
    surface.redoLocalApply(record, record.strokeId);
  }
  refreshUndoButtons();
}

// Lets the desktop toolbar + mobile panel react to undo state changes
// without having to poll. Both implementations register here.
type UndoStateListener = (canUndo: boolean, canRedo: boolean) => void;
const undoStateListeners = new Set<UndoStateListener>();
function refreshUndoButtons(): void {
  const u = surface.canUndo();
  const r = surface.canRedo();
  for (const fn of undoStateListeners) fn(u, r);
}
function onUndoState(fn: UndoStateListener): void {
  undoStateListeners.add(fn);
  fn(surface.canUndo(), surface.canRedo());
}

mountToolbar(toolbarEl, {
  onColor: (rgb) => surface.setColor(rgb),
  onTool: (tool) => surface.setWidth(tool.width),
  onClear: () => {
    void clearCanvas();
  },
  onUndo: () => performUndo(),
  onRedo: () => performRedo(),
  onHistoryChange: (cb) => onUndoState(cb),
});

if (isPhoneViewport()) {
  mountMobileTools({
    onColor: (rgb) => surface.setColor(rgb),
    onTool: (tool) => surface.setWidth(tool.width),
    onClear: () => {
      void clearCanvas();
    },
    onUndo: () => performUndo(),
    onRedo: () => performRedo(),
    onHistoryChange: (cb) => onUndoState(cb),
  });
}

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

// Let the user drag the control cluster out of the way of their drawing.
const settingsEl = document.getElementById("canvasSettings");
const settingsGrip = document.getElementById("canvasSettingsGrip");
if (settingsEl && settingsGrip) makeSettingsDraggable(settingsEl, settingsGrip);

// Voice chat (LiveKit). Mic starts off; first click connects + publishes muted,
// second click goes live. Active speakers drive a pulse on player avatars.
const micBtn = document.getElementById("micToggle") as HTMLButtonElement | null;

function refreshMicBtn(state: MicState): void {
  if (!micBtn) return;
  micBtn.classList.toggle("canvas-setting--on", state === "live");
  micBtn.classList.toggle("canvas-setting--busy", state === "connecting");
  micBtn.classList.toggle("canvas-setting--muted", state === "muted");
  const icon = micBtn.querySelector("i");
  if (icon) {
    if (state === "live") icon.className = "ph-fill ph-microphone";
    else if (state === "muted") icon.className = "ph-fill ph-microphone-slash";
    else if (state === "connecting") icon.className = "ph ph-circle-notch";
    else icon.className = "ph ph-microphone-slash";
  }
  if (state === "live") micBtn.title = "You're live - tap to mute";
  else if (state === "muted") micBtn.title = "You're muted - tap to unmute";
  else if (state === "connecting") micBtn.title = "Connecting...";
  else micBtn.title = "Join voice chat";
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
  // Voice is icon-only, so first-timers don't know it exists. Nudge once.
  if (window.localStorage.getItem("pastel.voicehint.seen") !== "1") {
    window.setTimeout(() => {
      showToast("Tap the mic to talk with your room 🎙️", {
        kind: "info",
        durationMs: 4500,
      });
      window.localStorage.setItem("pastel.voicehint.seen", "1");
    }, 3000);
  }
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
    musicOn: isBgEnabled(),
    onToggleMusic: () => {
      void (async () => {
        await toggleBg();
        refreshAudioBtns();
        renderGameUI();
      })();
    },
  });
  updateBanner();
  // "Guessing" UI (badge + placeholder) only while you still need to guess.
  // Once you've gotten the word right, your input goes through the chat
  // path; flip the badge off so the placeholder reverts to "Say something".
  const youAlreadyGuessed = youId !== null && correctGuessers.has(youId);
  const isGuessing =
    gameState.phase.kind === "Drawing" &&
    gameState.phase.drawer !== youId &&
    !youAlreadyGuessed;
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

// Render the mask as per-character spans so each underscore can flip to its
// real letter independently. Called only from updateBanner; declared above
// it so hoisting order is irrelevant.
function buildMaskHtml(
  mask: string,
  revealed: string | null,
  animate: boolean,
  newlyHinted?: Set<number>,
): string {
  const maskChars = mask.split("");
  const wordChars = revealed ? revealed.split("") : null;
  return maskChars
    .map((m, i) => {
      if (m !== "_") {
        // Spaces, hyphens, digits etc. stay as-is and don't animate. A letter
        // freshly unlocked by a hint pops in via the --hint variant.
        const safe = m === " " ? "&nbsp;" : escapeHtml(m);
        const hintCls = newlyHinted?.has(i) ? " banner-mask-char--hint" : "";
        return `<span class="banner-mask-char banner-mask-char--literal${hintCls}">${safe}</span>`;
      }
      const w = wordChars?.[i];
      if (w === undefined) {
        return `<span class="banner-mask-char">_</span>`;
      }
      const cls = animate
        ? "banner-mask-char banner-mask-char--reveal"
        : "banner-mask-char banner-mask-char--known";
      const style = animate ? ` style="animation-delay:${i * 55}ms"` : "";
      return `<span class="${cls}"${style}>${escapeHtml(w)}</span>`;
    })
    .join("");
}

function updateBanner(): void {
  const phase = gameState.phase;
  if (phase.kind !== "Drawing" && phase.kind !== "ChoosingWord") {
    bannerEl.classList.add("banner--hidden");
    // Reset reveal memory so the next round's first reveal animates fresh
    // instead of skipping straight to the static "known" state.
    lastRevealedWord = null;
    lastMask = null;
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
  // Drawer-only live guess tally, so the person drawing actually sees that
  // people are getting it. Pulses once when a new guess lands.
  let countPill = "";
  if (isDrawer) {
    const guessed = correctGuessers.size;
    const totalGuessers = Math.max(0, players.size - 1);
    if (guessed > 0) {
      const pulse = drawerGuessPulse ? " banner-guesscount--pulse" : "";
      countPill = `<div class="banner-guesscount${pulse}">
        <i class="ph-fill ph-check-circle" aria-hidden="true"></i>
        <span>${guessed} of ${totalGuessers} guessed</span>
      </div>`;
    }
  }
  drawerGuessPulse = false;
  // Mask + reveal: if the local player knows the word (drawer always, or
  // a non-drawer who just guessed correctly), animate the underscore → letter
  // swap on the first render only. lastRevealedWord stays sticky so any
  // re-renders from reactions / mood updates don't replay the stagger.
  let maskHtml: string;
  if (phase.kind === "Drawing") {
    const revealed = phase.myWord ?? null;
    const justRevealed = revealed !== null && revealed !== lastRevealedWord;
    if (revealed !== lastRevealedWord) lastRevealedWord = revealed;
    // When we don't know the full word yet, diff the mask so a hint that
    // unlocks a letter animates just that character.
    const newlyHinted = new Set<number>();
    if (revealed === null && lastMask !== null) {
      for (let i = 0; i < phase.mask.length; i++) {
        const wasHidden = i >= lastMask.length || lastMask[i] === "_";
        if (wasHidden && phase.mask[i] !== "_") newlyHinted.add(i);
      }
    }
    lastMask = phase.mask;
    maskHtml = buildMaskHtml(phase.mask, revealed, justRevealed, newlyHinted);
  } else {
    maskHtml = escapeHtml(text);
  }
  bannerEl.innerHTML = `
    <div class="banner-main">
      <div class="banner-drawer" title="${escapeHtml(nameOf(phase.drawer))}">
        ${avatarOf(phase.drawer)}
      </div>
      <div class="banner-round">${escapeHtml(round)}</div>
      <div class="banner-mask">${maskHtml}</div>
      ${countPill}
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
        const guessedByMe = msg.player === youId;
        const iAmDrawer =
          gameState.phase.kind === "Drawing" && gameState.phase.drawer === youId;
        // For the local player only: stash the secret onto the Drawing phase
        // so the banner mask reveals into the real word. We reuse the text
        // they just typed (server match is case/whitespace-insensitive, so
        // it's functionally the word) and lowercase it to line up with the
        // mask's letter casing.
        if (
          guessedByMe &&
          gameState.phase.kind === "Drawing" &&
          gameState.phase.myWord == null &&
          lastSubmittedGuess !== null
        ) {
          gameState.phase = {
            ...gameState.phase,
            myWord: lastSubmittedGuess.trim().toLowerCase(),
          };
        }
        // Pulse the drawer's guess-count pill once on this render.
        if (iAmDrawer) drawerGuessPulse = true;
        renderPlayers();
        renderGameUI();
        playCorrect();
        chat.appendCorrectGuess(
          nameOf(msg.player),
          colorOf(msg.player),
          avatarOf(msg.player),
        );
        if (guessedByMe) {
          // Personal moment: confetti + a celebratory card just for you.
          confettiBurst();
          showCanvasEvent({
            avatarHtml: avatarOf(msg.player),
            message: "You got it! 🎉",
            kind: "celebrate",
          });
        } else {
          showCanvasEvent({
            avatarHtml: avatarOf(msg.player),
            message: `${nameOf(msg.player)} got it!`,
            kind: "celebrate",
          });
        }
      } else if (msg.guess === "Close" && msg.player === youId) {
        // Server unicasts Close only to the guesser, but we still gate
        // here for safety.
        chat.appendCloseGuess();
      } else if (msg.guess === "Spoiler" && msg.player === youId) {
        // Server unicasts Spoiler when our chat would have leaked the word.
        chat.appendSpoilerWarning();
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
      refreshUndoButtons();
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
      // A clear personal cue at the round boundary -- you're on deck.
      if (event.drawer === youId) {
        showToast("Your turn to draw! Pick a word.", { kind: "success" });
      } else {
        showToast(`${nameOf(event.drawer)} is drawing -- get ready to guess!`);
      }
      renderGameUI();
      return;
    }
    case "RoundStart": {
      void setBgScene("game");
      playRoundStart();
      myReaction = null;
      drawerFeedback = null;
      // Each round starts with empty history -- you can't undo strokes
      // from a previous round (the canvas got reset anyway).
      surface.resetHistory();
      refreshUndoButtons();
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
    case "RoundEnd": {
      // Points earned this round = new cumulative total minus the prior total.
      // Compute BEFORE applyScores overwrites gameState.scores.
      const deltas = new Map<number, number>();
      for (const [id, total] of event.scores) {
        deltas.set(id, total - (gameState.scores.get(id) ?? 0));
      }
      correctGuessers.clear();
      applyScores(gameState, event.scores);
      gameState.phase = {
        kind: "RoundEnd",
        word: event.word,
        scores: event.scores,
        deltas,
      };
      chat.appendSystem(`the word was "${event.word}"`);
      playRoundEnd();
      // Reveal phase: no more strokes accepted, undo history irrelevant.
      surface.resetHistory();
      refreshUndoButtons();
      renderPlayers();
      renderGameUI();
      return;
    }
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
      // Celebrate the finish unless the game fizzled out (everyone left).
      if (players.size >= 2) confettiBurst({ count: 130, originY: window.innerHeight / 4 });
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
    case "StrokeRemoved":
      // Server broadcast of someone's undo. Drop the matching stroke from
      // our canvas. For the player who issued the undo this is the actual
      // removal -- their undoLocal earlier only moved the record to the
      // redo stack so the data survives for a potential redo.
      surface.applyStrokeRemoved(event.player, event.stroke_id);
      refreshUndoButtons();
      return;
  }
}

// A prominent reconnect banner (the status-bar text alone is easy to miss
// mid-game). Created lazily, slides in from the top while reconnecting.
function setReconnectBar(show: boolean, attempt = 0): void {
  let bar = document.getElementById("reconnectBar");
  if (show) {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "reconnectBar";
      bar.className = "reconnect-bar";
      bar.innerHTML = `
        <span class="reconnect-spinner" aria-hidden="true"></span>
        <span class="reconnect-text"></span>
      `;
      document.body.appendChild(bar);
      void bar.offsetWidth;
    }
    bar.classList.add("reconnect-bar--in");
    const t = bar.querySelector(".reconnect-text");
    if (t) {
      t.textContent =
        attempt > 1 ? `Reconnecting… (attempt ${attempt})` : "Reconnecting…";
    }
  } else if (bar) {
    bar.classList.remove("reconnect-bar--in");
  }
}

function handleState(s: ConnState): void {
  switch (s.kind) {
    case "connecting":
      statusEl.textContent = "finding the room...";
      return;
    case "open":
      statusEl.textContent = `room ${room} -- playing as ${name}`;
      setReconnectBar(false);
      void setBgScene("lobby");
      return;
    case "reconnecting":
      statusEl.textContent = `reconnecting... (try ${s.attempt})`;
      setReconnectBar(true, s.attempt);
      return;
    case "closed":
      statusEl.textContent = `lost connection: ${s.reason}`;
      setReconnectBar(false);
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
surface.setHistoryListener(() => refreshUndoButtons());

// Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) = redo. Skip
// when the user is typing in the chat or any other input/textarea so we
// don't fight with native text undo.
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
      return;
    }
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === "z" || e.key === "Z") {
    e.preventDefault();
    if (e.shiftKey) performRedo();
    else performUndo();
  } else if (e.key === "y" || e.key === "Y") {
    e.preventDefault();
    performRedo();
  }
});

  // Avoid an unused-import lint when game.ts re-exports types we only use as
  // types at call sites.
  void (null as unknown as GamePhase);
}
