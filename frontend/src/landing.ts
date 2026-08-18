// Landing screen shown when the URL has no ?room param.

import {
  setBgScene,
} from "./music";
import { serverHttpUrl } from "./server";

export function showLanding(): void {
  void setBgScene("landing");

  document.body.innerHTML = `
    <button class="landing-theme-toggle" id="landingThemeToggle" type="button" aria-label="Switch to dark mode" title="Switch theme"><i class="ph ph-moon"></i><span>Dark</span></button>
    <main class="landing">
      <div class="landing-page landing-page--minimal">
        <div class="landing-head">
          <div class="landing-brand">
            <div class="voxi-wordmark">VOXI</div>
            <div class="voxi-wordmark-sub">VOXEL ROOM</div>
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
            <span class="landing-brand-sub">choose a room and build together</span>
          </div>
          <section class="landing-mode-box" aria-labelledby="modeTitle">
            <h1 id="modeTitle">Choose a mode</h1>
            <p>Start with a clear canvas.</p>
            <div class="mode-grid-landing">
              <button type="button" class="mode-tile" id="singleModeBtn">
                <span class="mode-tile-dab"></span>
                <span class="mode-tile-label">Single Player</span>
                <span class="mode-tile-meta">Build alone</span>
              </button>
              <button type="button" class="mode-tile mode-tile--on" id="multiModeBtn">
                <span class="mode-tile-dab"></span>
                <span class="mode-tile-label">Multiplayer</span>
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
      </div>
    </main>
  `;

  const singleModeBtn = document.getElementById("singleModeBtn") as HTMLButtonElement | null;
  const multiModeBtn = document.getElementById("multiModeBtn") as HTMLButtonElement | null;
  const landingStatus = document.getElementById("landingStatus");
  const joinRoomForm = document.getElementById("joinRoomForm") as HTMLFormElement | null;
  const joinStatus = document.getElementById("joinStatus");
  const themeToggle = document.getElementById("landingThemeToggle") as HTMLButtonElement | null;
  const landingPage = document.querySelector<HTMLElement>(".landing-page");
  const savedTheme = window.localStorage.getItem("voxi.landing-theme");
  if (savedTheme === "dark") {
    landingPage?.classList.add("landing-page--dark");
    document.body.classList.add("voxi-theme-dark");
  }
  const syncThemeButton = (): void => {
    const dark = landingPage?.classList.contains("landing-page--dark") ?? false;
    if (themeToggle) {
      themeToggle.innerHTML = `<i class="ph ${dark ? "ph-sun" : "ph-moon"}"></i><span>${dark ? "Light" : "Dark"}</span>`;
      themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    }
  };
  syncThemeButton();
  themeToggle?.addEventListener("click", () => {
    const dark = landingPage?.classList.toggle("landing-page--dark") ?? false;
    document.body.classList.toggle("voxi-theme-dark", dark);
    window.localStorage.setItem("voxi.landing-theme", dark ? "dark" : "light");
    syncThemeButton();
  });

  const startMode = async (button: HTMLButtonElement, multiplayer: boolean): Promise<void> => {
      if (!multiplayer) {
        const url = new URL(window.location.href);
        url.searchParams.set("room", "SOLO01");
        url.searchParams.set("mode", "voxel");
        url.searchParams.set("solo", "1");
        url.searchParams.delete("voice");
        window.location.href = url.toString();
        return;
      }
      button.disabled = true;
      button.classList.add("is-loading");
      if (landingStatus) landingStatus.textContent = "Opening room...";
      try {
        const res = await fetch(serverHttpUrl("/matchmake"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Voxel rooms are collaborative canvas rooms: humans join by code.
          // Do not seed them with drawing-game bots or automated chat.
          body: JSON.stringify(multiplayer ? { size: 4, bots: 0 } : { size: 2, bots: 0 }),
        });
        if (!res.ok) throw new Error(`matchmake failed: ${res.status}`);
        const { code } = (await res.json()) as { code: string };
        const url = new URL(window.location.href);
        url.searchParams.set("room", code);
        url.searchParams.set("qm", multiplayer ? "4" : "2");
        url.searchParams.set("mode", "voxel");
        if (!multiplayer) url.searchParams.set("solo", "1");
        url.searchParams.set("voice", "1");
        window.location.href = url.toString();
      } catch (err) {
        console.warn("[start mode]", err);
        button.disabled = false;
        button.classList.remove("is-loading");
        if (landingStatus) landingStatus.textContent = "Room could not open. Check that the server is running.";
      }
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
