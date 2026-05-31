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
      <div class="landing-inner">
        <h1 class="logo"><span class="logo-text landing-logo">pastel</span></h1>
        <p class="landing-tag">draw. guess. laugh.</p>

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
                <span class="mode-tile-label">${m.label}</span>
                <span class="mode-tile-desc">${m.desc}</span>
                <span class="mode-tile-meta">${m.rounds} rounds</span>
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

          <button type="submit" class="landing-cta">Start a room</button>
        </form>

        <div class="landing-divider"><span>or join a friend</span></div>

        <form class="landing-join" id="landingJoin">
          <div class="landing-join-row">
            <input id="landingCode" type="text" maxlength="6" minlength="6"
                   required pattern="[A-Za-z0-9]{6}" autocomplete="off"
                   placeholder="Room code" class="landing-code-input"
                   style="text-transform: uppercase" />
            <button type="submit" class="landing-join-btn">Jump in</button>
          </div>
        </form>

        <footer class="landing-credits">
          <span>made with</span>
          <a href="https://github.com/btahir/open-lofi" target="_blank" rel="noopener">open-lofi</a>
          <span class="landing-credits-dot">.</span>
          <a href="https://www.dicebear.com/styles/big-smile" target="_blank" rel="noopener">dicebear</a>
          <span class="landing-credits-dot">.</span>
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

  // Set a session flag the room boot reads to decide whether to show the
  // "playing as X -- change anything?" confirm. Set on real new-game
  // entries (Start a room / Jump in) but not on URL reloads. SessionStorage
  // dies when the tab closes so it won't linger across sessions.
  const SESSION_PROMPT_FLAG = "pastel.confirm-identity-next-join";

  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const mode =
      (new FormData(createForm).get("mode") as GameMode | null) ?? "Standard";
    window.localStorage.setItem(STORAGE_MODE, mode);
    const voiceOn = (document.getElementById("landingVoice") as HTMLInputElement | null)?.checked;
    const code = randomCode();
    window.sessionStorage.setItem(SESSION_PROMPT_FLAG, "1");
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
    window.sessionStorage.setItem(SESSION_PROMPT_FLAG, "1");
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.location.href = url.toString();
  });
}
