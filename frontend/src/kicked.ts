// Full-screen takeover when the server closes the connection terminally
// (kicked, room closed, room full). The connection is already gone by the
// time this renders; we just inform the user.

import type { ByeReason } from "./proto";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function showFatalScreen(reason: ByeReason): void {
  const { heading, body } = copyFor(reason);
  document.body.innerHTML = `
    <main class="kicked">
      <section class="kicked-card">
        <h1>${escapeHtml(heading)}</h1>
        <p class="kicked-body">${escapeHtml(body)}</p>
        <div class="kicked-actions">
          <button type="button" class="kicked-primary" id="kickedHome">
            Back home
          </button>
          <button type="button" class="kicked-secondary" id="kickedRejoin">
            Try rejoining
          </button>
        </div>
      </section>
    </main>
  `;
  document.getElementById("kickedHome")?.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("host");
    url.searchParams.delete("mode");
    window.location.href = url.toString();
  });
  document.getElementById("kickedRejoin")?.addEventListener("click", () => {
    window.location.reload();
  });
}

const PENDING_OVERLAY_ID = "joinPendingOverlay";

/// Show a fixed-position waiting overlay while the host decides whether to
/// readmit a previously-kicked player. Idempotent. Call [`hideJoinPendingScreen`]
/// after the candidate is approved so the underlying UI is revealed again.
export function showJoinPendingScreen(): void {
  if (document.getElementById(PENDING_OVERLAY_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = PENDING_OVERLAY_ID;
  overlay.className = "kicked";
  overlay.innerHTML = `
    <section class="kicked-card">
      <span class="kicked-spinner" aria-hidden="true"></span>
      <h1>Asking the host…</h1>
      <p class="kicked-body">
        Your request to rejoin has been sent. You were removed earlier, so the
        host has to approve you before you can hop back in. You'll join
        automatically the moment they do.
      </p>
      <div class="kicked-actions">
        <button type="button" class="kicked-secondary" id="pendingHome">
          Never mind, leave
        </button>
      </div>
    </section>
  `;
  document.body.appendChild(overlay);
  document.getElementById("pendingHome")?.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("host");
    url.searchParams.delete("mode");
    window.location.href = url.toString();
  });
}

export function hideJoinPendingScreen(): void {
  document.getElementById(PENDING_OVERLAY_ID)?.remove();
}

function copyFor(reason: ByeReason): { heading: string; body: string } {
  switch (reason) {
    case "Kicked":
      return {
        heading: "You've been removed",
        body: "The host removed you from the room. You can ask to rejoin -- they'll need to approve you before you're back in.",
      };
    case "RoomFull":
      return {
        heading: "Room's full!",
        body: "This room already has 10 players. Try starting your own, or check back in a bit.",
      };
    case "RoomClosed":
      return {
        heading: "This room is gone",
        body: "The host closed the room. Time to start a new one?",
      };
    case "BadFrame":
      return {
        heading: "Something went wrong",
        body: "We couldn't connect properly. A quick reload usually fixes this.",
      };
    case "Reconnect":
      return {
        heading: "You got disconnected",
        body: "Lost the connection. Reload to hop back in.",
      };
  }
}
