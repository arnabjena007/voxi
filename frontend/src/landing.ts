// Landing screen shown when the URL has no ?room param. Lets the host pick
// a mode before generating a room code, or join an existing room by code.
// Name + avatar are collected by the picker once the user lands in a room.

import { renderAvatar } from "./avatar";
import {
  hasStoredIdentity,
  loadStoredIdentity,
  pickNameAndAvatar,
} from "./avatarPicker";
import { MODE_OPTIONS } from "./game";
import {
  enableBg,
  isBgEnabled,
  isBgPlaying,
  loadBgPreference,
  onBgPlaying,
  setBgScene,
  toggleBg,
} from "./music";
import { parseRoomCode, type GameMode } from "./proto";

const STORAGE_MODE = "pastel.mode";

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function showLanding(): void {
  void setBgScene("landing");

  const storedMode =
    (window.localStorage.getItem(STORAGE_MODE) as GameMode | null) ?? "Standard";

  const MODE_ACCENTS = ["#f2a4b0", "#8ecac4", "#e8c96e"];
  const MODE_SHADOWS = ["#e08a96", "#6bb0aa", "#d0b254"];

  document.body.innerHTML = `
    <main class="landing">
      <button id="landingMute" class="landing-mute" type="button"
              aria-label="Toggle background music" title="Mute music">
        <span class="landing-mute-bars" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </span>
        <i class="ph ph-speaker-slash landing-mute-off-icon" aria-hidden="true"></i>
      </button>

      <!-- hand-drawn "rough" filter, reused by page border / swash / arrow / ring -->
      <svg width="0" height="0" class="landing-defs" aria-hidden="true">
        <filter id="pastelRough">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="7" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </svg>

      <!-- drifting margin doodles -->
      <div class="landing-doodle landing-doodle--cat" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 12l4 7M34 12l-4 7"/><path d="M12 26a12 10 0 0 0 24 0c0-7-5-12-12-12s-12 5-12 12z"/><circle cx="19" cy="25" r="1.4" fill="currentColor" stroke="none"/><circle cx="29" cy="25" r="1.4" fill="currentColor" stroke="none"/><path d="M24 29l-2 2M24 29l2 2M16 27l-6 1M16 30l-6 3M32 27l6 1M32 30l6 3"/></svg></div>
      <div class="landing-doodle landing-doodle--star" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l3.6 8.4L28 12.6l-6 5.6 1.6 8.6L16 22.6 8.4 26.8 10 18.2l-6-5.6 8.4-1.2z"/></svg></div>
      <div class="landing-doodle landing-doodle--bulb" aria-hidden="true"><svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c-7 0-12 5-12 11 0 4 2 6 4 8 1.5 1.5 2 3 2 5h12c0-2 .5-3.5 2-5 2-2 4-4 4-8 0-6-5-11-12-11z"/><path d="M17 34h10M18 38h8"/><path d="M6 12l-2-1M40 11l2-1"/></svg></div>
      <div class="landing-doodle landing-doodle--squig" aria-hidden="true"><svg viewBox="0 0 70 30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 18c6-14 12 8 18-2s12 12 18 0 12 6 26-4"/></svg></div>
      <div class="landing-doodle landing-doodle--heart" aria-hidden="true"><svg viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 26C6 20 3 14 5 9c1.5-3.6 6.5-4 10-1 3.5-3 8.5-2.6 10 1 2 5-1 11-10 17z"/></svg></div>

      <div class="landing-page">
        <span class="landing-tape landing-tape--l" aria-hidden="true"></span>
        <span class="landing-tape landing-tape--r" aria-hidden="true"></span>

        <header class="landing-head">
          <h1 class="logo"><span class="logo-text landing-logo">pastel</span></h1>
          <svg class="landing-swash" viewBox="0 0 190 20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" aria-hidden="true"><path d="M6 13c40-9 100-9 178-4"/></svg>
          <p class="landing-tag">draw. <b>guess.</b> laugh.</p>
        </header>

        <details class="landing-how">
          <summary class="landing-how-summary">
            <i class="ph ph-pencil-simple" aria-hidden="true"></i>
            <span>how to play</span>
            <i class="ph ph-caret-down landing-how-caret" aria-hidden="true"></i>
          </summary>
          <ol class="landing-how-steps">
            <li><span class="landing-how-num">1</span> One player gets a secret word and draws it.</li>
            <li><span class="landing-how-num">2</span> Everyone else races to guess it in chat.</li>
            <li><span class="landing-how-num">3</span> Faster guesses score more. Take turns; top score wins.</li>
          </ol>
        </details>

        <button type="button" class="landing-identity" id="landingIdentity"
                aria-label="Change name and avatar">
          <span class="landing-identity-slot" id="landingIdentitySlot"></span>
        </button>

        <form class="landing-form" id="landingForm">
          <div class="mode-grid-landing">
            ${MODE_OPTIONS.map(
              (m, i) => `
              <label class="mode-tile ${m.id === storedMode ? "mode-tile--on" : ""}"
                     style="--tile-accent: ${MODE_ACCENTS[i]}; --tile-shadow: ${MODE_SHADOWS[i]};">
                <input type="radio" name="mode" value="${m.id}"
                       ${m.id === storedMode ? "checked" : ""} />
                <span class="mode-tile-dab" aria-hidden="true"></span>
                <span class="mode-tile-label">${m.label}</span>
                <span class="mode-tile-desc">${m.desc}</span>
                <span class="mode-tile-meta">${m.rounds} rounds</span>
                <svg class="mode-tile-ring" viewBox="0 0 120 90" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M60 6C24 6 6 26 6 45s22 40 55 39 53-22 52-41S96 6 60 6z"/></svg>
              </label>`,
            ).join("")}
          </div>

          <label class="voice-opt" tabindex="0">
            <input type="checkbox" id="landingVoice" />
            <span class="voice-opt-card">
              <span class="voice-opt-icon"><i class="ph-fill ph-microphone"></i></span>
              <span class="voice-opt-body">
                <span class="voice-opt-title">Voice chat</span>
                <span class="voice-opt-sub">talk to your room while you draw</span>
              </span>
              <span class="voice-opt-switch"><span class="voice-opt-knob"></span></span>
            </span>
          </label>

          <div class="landing-cta-wrap">
            <span class="landing-arrow-note">let's go!</span>
            <svg class="landing-arrow" viewBox="0 0 92 62" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6c26 4 44 16 52 40"/><path d="M50 34l10 14 12-8"/></svg>
            <button type="submit" class="landing-cta">Start a room</button>
          </div>
        </form>

        <div class="landing-divider"><span>or join a friend</span></div>

        <form class="landing-join" id="landingJoin">
          <div class="landing-join-row">
            <input id="landingCode" type="text" maxlength="6" minlength="6"
                   required pattern="[A-Za-z0-9]{6}" autocomplete="off"
                   placeholder="room code" class="landing-code-input"
                   style="text-transform: uppercase" />
            <button type="submit" class="landing-join-btn">Jump in</button>
          </div>
        </form>

        <footer class="landing-credits">
          <span>made with</span>
          <a href="https://github.com/btahir/open-lofi" target="_blank" rel="noopener">open-lofi</a>
          <span class="landing-credits-dot">·</span>
          <a href="https://www.dicebear.com/styles/big-smile" target="_blank" rel="noopener">dicebear</a>
          <span class="landing-credits-dot">·</span>
          <a href="https://livekit.io" target="_blank" rel="noopener">livekit</a>
        </footer>
        <div class="landing-support">
          <span>liking pastel?</span>
          <a href="https://github.com/sponsors/pixperk" target="_blank" rel="noopener"
             class="landing-support-link" title="Sponsor on GitHub">
            <i class="ph ph-heart" aria-hidden="true"></i>
            <span>sponsor</span>
          </a>
          <a href="https://buymeacoffee.com/pixperk" target="_blank" rel="noopener"
             class="landing-support-link" title="Buy me a coffee">
            <i class="ph ph-coffee" aria-hidden="true"></i>
            <span>buy me a coffee</span>
          </a>
        </div>
        <div class="landing-support landing-bug">
          <span>found a bug?</span>
          <a href="https://github.com/pixperk/pastel/issues/new?template=bug_report.yml"
             target="_blank" rel="noopener"
             class="landing-support-link landing-bug-link" title="Report a bug on GitHub">
            <i class="ph ph-bug" aria-hidden="true"></i>
            <span>report a bug</span>
          </a>
          <a href="https://github.com/pixperk/pastel/issues/new?template=idea.yml"
             target="_blank" rel="noopener"
             class="landing-support-link landing-idea-link" title="Share an idea on GitHub">
            <i class="ph ph-lightbulb" aria-hidden="true"></i>
            <span>share an idea</span>
          </a>
        </div>
        <a href="https://github.com/pixperk/pastel" target="_blank" rel="noopener"
           class="landing-star" title="Star pastel on GitHub">
          <i class="ph-fill ph-star" aria-hidden="true"></i>
          <span>drop a star on github</span>
        </a>
      </div>
    </main>
  `;

  const codeInput = document.getElementById("landingCode") as HTMLInputElement;
  const createForm = document.getElementById("landingForm") as HTMLFormElement;
  const joinForm = document.getElementById("landingJoin") as HTMLFormElement;
  const muteBtn = document.getElementById("landingMute") as HTMLButtonElement | null;

  function refreshMuteBtn(): void {
    if (!muteBtn) return;
    const on = isBgEnabled();
    const playing = isBgPlaying();
    muteBtn.classList.toggle("landing-mute--off", !on);
    muteBtn.classList.toggle("landing-mute--playing", playing);
    muteBtn.title = on
      ? (playing ? "Mute music" : "Tap anywhere to play")
      : "Unmute music";
  }

  onBgPlaying(() => refreshMuteBtn());

  // Arm bg on the first user click anywhere on the landing page (browser
  // autoplay policy requires a gesture before AudioContext can start). The
  // user's saved preference defaults to ON unless they've turned it off.
  if (loadBgPreference()) {
    const arm = async () => { await enableBg(); refreshMuteBtn(); };
    document.addEventListener("click", arm, { once: true });
  }

  muteBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await toggleBg();
    refreshMuteBtn();
  });

  refreshMuteBtn();

  // Identity chip: small "playing as [avatar] name" pill; tap to open the
  // picker. Renders an "pick your look" state for first-time visitors.
  const identityBtn = document.getElementById("landingIdentity") as HTMLButtonElement | null;
  const identitySlot = document.getElementById("landingIdentitySlot");

  function escapeText(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }
  function refreshIdentityChip(): void {
    if (!identityBtn || !identitySlot) return;
    if (hasStoredIdentity()) {
      const { name, avatar } = loadStoredIdentity();
      identityBtn.classList.remove("landing-identity--empty");
      identityBtn.title = `Change name and avatar (currently ${name})`;
      identitySlot.innerHTML = `
        <span class="landing-identity-avatar">${renderAvatar(avatar)}</span>
        <span class="landing-identity-text">playing as <strong>${escapeText(name)}</strong></span>
        <i class="ph ph-pencil-simple landing-identity-edit" aria-hidden="true"></i>
      `;
    } else {
      identityBtn.classList.add("landing-identity--empty");
      identityBtn.title = "Pick a name and avatar";
      identitySlot.innerHTML = `
        <i class="ph ph-user-circle-plus" aria-hidden="true"></i>
        <span>pick your look</span>
      `;
    }
  }

  identityBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await pickNameAndAvatar();
    } catch {
      return;
    }
    refreshIdentityChip();
  });

  refreshIdentityChip();

  for (const tile of document.querySelectorAll<HTMLLabelElement>(".mode-tile")) {
    tile.addEventListener("click", () => {
      for (const t of document.querySelectorAll<HTMLLabelElement>(".mode-tile")) {
        t.classList.remove("mode-tile--on");
      }
      tile.classList.add("mode-tile--on");
    });
  }

  // The room boot (main.ts) shows a "you're joining as X -- keep or change?"
  // card on the first entry to a room this session, so the landing no longer
  // needs to flag new-game entries here.

  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const mode =
      (new FormData(createForm).get("mode") as GameMode | null) ?? "Standard";
    window.localStorage.setItem(STORAGE_MODE, mode);
    const voiceOn = (document.getElementById("landingVoice") as HTMLInputElement | null)?.checked;
    const code = randomCode();
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    url.searchParams.set("mode", mode);
    url.searchParams.set("host", "1");
    if (voiceOn) url.searchParams.set("voice", "1");
    window.location.href = url.toString();
  });

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = codeInput.value.trim();
    let code: string;
    try {
      code = parseRoomCode(raw);
    } catch (err) {
      codeInput.setCustomValidity(`invalid room code: ${String(err)}`);
      codeInput.reportValidity();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.location.href = url.toString();
  });
}
