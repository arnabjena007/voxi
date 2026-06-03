// Floating emoji reactions. A small bar (shown to guessers while someone is
// drawing) lets them tap an emoji that drifts up over the canvas for everyone.
// The index set MUST match EMOTE_COUNT on the server (pastel-room).

export const EMOTES = ["😂", "🔥", "😮", "❤️", "👏", "😭", "🐐", "💀", "🎨"];

let floatHost: HTMLElement | null = null;

function ensureFloatHost(anchor: HTMLElement): HTMLElement {
  if (floatHost && anchor.contains(floatHost)) return floatHost;
  floatHost = document.createElement("div");
  floatHost.className = "emote-float-host";
  anchor.appendChild(floatHost);
  return floatHost;
}

// Spawn one emoji that floats up over `anchor` and fades out.
export function floatEmote(idx: number, anchor: HTMLElement): void {
  const emoji = EMOTES[idx];
  if (!emoji) return;
  const host = ensureFloatHost(anchor);
  const el = document.createElement("span");
  el.className = "emote-float";
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 80}%`;
  el.style.setProperty("--drift", `${Math.round(Math.random() * 50 - 25)}px`);
  el.style.setProperty("--rot", `${Math.round(Math.random() * 36 - 18)}deg`);
  el.style.setProperty("--dur", `${(2200 + Math.random() * 600).toFixed(0)}ms`);
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 2900);
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
