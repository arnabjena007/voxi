// Emoji reactions. A small bar (shown to guessers while someone is drawing)
// lets them tap an emoji; the server rebroadcasts it. On receipt every client
// pops a badge on the reactor's avatar AND bubbles the emoji up from that same
// avatar -- attribution plus energy, and it never covers the canvas.
// The index set MUST match EMOTE_COUNT on the server (pastel-room).

export const EMOTES = ["😂", "🔥", "😮", "❤️", "👏", "😭", "🐐", "💀", "🎨"];

let floatHost: HTMLElement | null = null;

function ensureFloatHost(): HTMLElement {
  if (floatHost && document.body.contains(floatHost)) return floatHost;
  floatHost = document.createElement("div");
  floatHost.className = "emote-float-host";
  document.body.appendChild(floatHost);
  return floatHost;
}

// Bubble one emoji up from a viewport point (the reactor's avatar) and fade it.
// Skipped for reduced-motion users (the avatar badge still shows).
export function floatEmote(idx: number, origin: { x: number; y: number }): void {
  const emoji = EMOTES[idx];
  if (!emoji) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const host = ensureFloatHost();
  const el = document.createElement("span");
  el.className = "emote-float";
  el.textContent = emoji;
  el.style.left = `${origin.x}px`;
  el.style.top = `${origin.y}px`;
  el.style.setProperty("--drift", `${Math.round(Math.random() * 40 - 20)}px`);
  el.style.setProperty("--rot", `${Math.round(Math.random() * 36 - 18)}deg`);
  el.style.setProperty("--dur", `${(1600 + Math.random() * 500).toFixed(0)}ms`);
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 2300);
}

// Build the emoji bar. Returns the element so the caller can show/hide it.
export function mountEmoteBar(
  container: HTMLElement,
  onEmote: (idx: number) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "emote-bar";
  EMOTES.forEach((emoji, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emote-btn";
    btn.textContent = emoji;
    btn.setAttribute("aria-label", `React ${emoji}`);
    btn.addEventListener("click", () => onEmote(i));
    bar.appendChild(btn);
  });
  container.appendChild(bar);
  return bar;
}

