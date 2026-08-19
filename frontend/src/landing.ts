// Landing screen shown when the URL has no ?room param.

import {
  setBgScene,
} from "./music";
import { mountLandingFooter } from "./landingFooter";

export function showLanding(): void {
  void setBgScene("landing");
  window.localStorage.removeItem("voxi.landing-theme");
  document.body.classList.remove("game-room-body", "voxel-room-body", "voxi-theme-dark");

  document.body.innerHTML = `
    <main class="landing">
      <div class="landing-page landing-page--minimal">
        <div class="landing-head">
          <div class="landing-brand">
            <div class="voxi-wordmark">VOXI</div>
            <svg class="voxel-logo" viewBox="0 0 920 260" role="img" aria-label="voxi voxel logo">
              <g fill="none" stroke="none">
                <g transform="translate(20,18)">
                  <path class="voxel-letter voxel-letter--v" d="M0 0h62v184H0z"/>
                  <path class="voxel-letter voxel-letter--v" d="M124 0h62v184h-62z"/>
                  <rect class="voxel-dot" x="16" y="16" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="16" y="64" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="16" y="112" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="16" y="160" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="140" y="16" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="140" y="64" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="140" y="112" width="30" height="30" rx="8"/>
                  <rect class="voxel-dot" x="140" y="160" width="30" height="30" rx="8"/>
                </g>
                <g transform="translate(232,18)">
                  <path class="voxel-letter voxel-letter--o" d="M0 0h154v184H0z"/>
                  <path class="voxel-hole" d="M48 46h58v92H48z"/>
                  <rect class="voxel-dot" x="16" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="60" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="104" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="16" y="140" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="60" y="140" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="104" y="140" width="28" height="28" rx="7"/>
                </g>
                <g transform="translate(446,18)">
                  <path class="voxel-letter voxel-letter--x" d="M0 0h154v184H0z"/>
                  <path class="voxel-cross" d="M44 44h66v28H44zM60 76h34v44H60z"/>
                  <rect class="voxel-dot" x="16" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="60" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="104" y="16" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="16" y="140" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="60" y="140" width="28" height="28" rx="7"/>
                  <rect class="voxel-dot" x="104" y="140" width="28" height="28" rx="7"/>
                </g>
                <g transform="translate(660,18)">
                  <path class="voxel-letter voxel-letter--i" d="M0 0h114v184H0z"/>
                  <rect class="voxel-dot" x="16" y="16" width="26" height="26" rx="7"/>
                  <rect class="voxel-dot" x="16" y="64" width="26" height="26" rx="7"/>
                  <rect class="voxel-dot" x="16" y="112" width="26" height="26" rx="7"/>
                  <rect class="voxel-dot" x="16" y="160" width="26" height="26" rx="7"/>
                </g>
              </g>
            </svg>
          </div>
          <section class="landing-mode-box" aria-labelledby="modeTitle">
            <h1 id="modeTitle">Start with a clear canvas.</h1>
            <div class="mode-grid-landing">
              <button type="button" class="mode-tile" id="singleModeBtn">
                <span class="mode-tile-dab"></span>
                <span class="mode-tile-label">Single Player</span>
                <span class="mode-tile-meta">Build alone</span>
              </button>
              <button type="button" class="mode-tile mode-tile--on" id="multiModeBtn">
                <span class="mode-tile-dab"></span>
                <span class="mode-tile-label">Multi Player</span>
                <span class="mode-tile-meta">Build together</span>
              </button>
            </div>
            <p class="landing-status" id="landingStatus" role="status" aria-live="polite"></p>
          </section>
          <form class="landing-join-box" id="joinRoomForm">
            <label for="joinRoomCode">Join with room code</label>
            <div class="landing-join-fields">
              <input id="joinRoomCode" name="room" maxlength="6" autocomplete="off" placeholder="ROOM CODE" required />
              <input id="joinPlayerName" name="name" maxlength="24" autocomplete="name" placeholder="YOUR NAME" required />
              <button type="submit">JOIN ROOM</button>
            </div>
            <p class="landing-status" id="joinStatus" role="status" aria-live="polite"></p>
          </form>
        </div>
        <footer class="voxi-cube-footer" aria-label="Interactive rainbow voxel footer">
          <canvas id="landingFooterCanvas" aria-label="Rainbow voxel pattern. Hover over a cube to lift it."></canvas>
        </footer>
      </div>
    </main>
  `;

  const footerCanvas = document.getElementById("landingFooterCanvas") as HTMLCanvasElement | null;
  if (footerCanvas) mountLandingFooter(footerCanvas);

  const singleModeBtn = document.getElementById("singleModeBtn") as HTMLButtonElement | null;
  const multiModeBtn = document.getElementById("multiModeBtn") as HTMLButtonElement | null;
  const landingStatus = document.getElementById("landingStatus");
  const joinRoomForm = document.getElementById("joinRoomForm") as HTMLFormElement | null;
  const joinStatus = document.getElementById("joinStatus");
  const waitForPressAnimation = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 130));

  const startMode = async (button: HTMLButtonElement, multiplayer: boolean): Promise<void> => {
    button.disabled = true;
    button.classList.add("is-loading");
    if (landingStatus) landingStatus.textContent = "Opening room...";
    if (!multiplayer) {
      const url = new URL(window.location.href);
      url.searchParams.set("room", "SOLO01");
      url.searchParams.set("mode", "voxel");
      url.searchParams.set("solo", "1");
      url.searchParams.delete("voice");
      await waitForPressAnimation();
      window.location.href = url.toString();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", randomRoomCode());
    url.searchParams.set("mode", "voxel");
    url.searchParams.delete("solo");
    url.searchParams.delete("qm");
    url.searchParams.set("voice", "1");
    await waitForPressAnimation();
    window.location.href = url.toString();
  };

  singleModeBtn?.addEventListener("click", () => void startMode(singleModeBtn, false));
  multiModeBtn?.addEventListener("click", () => void startMode(multiModeBtn, true));
  joinRoomForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(joinRoomForm);
    const code = String(form.get("room") ?? "").trim().toUpperCase();
    const name = String(form.get("name") ?? "").trim();
    if (!/^[0-9A-Z]{6}$/.test(code)) {
      if (joinStatus) joinStatus.textContent = "Enter the 6-character room code.";
      return;
    }
    if (!name) {
      if (joinStatus) joinStatus.textContent = "Enter your name to join.";
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    url.searchParams.set("mode", "voxel");
    url.searchParams.set("name", name);
    url.searchParams.set("voice", "1");
    window.location.href = url.toString();
  });
}

function randomRoomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return [...values].map((value) => alphabet[value % alphabet.length]).join("");
}
