// Lightweight DOM confetti burst. Used for personal "you guessed it" moments
// and the game-over winner spotlight. Pure CSS animation per particle; the host
// element is removed once the burst finishes. Respects prefers-reduced-motion.

const COLORS = ["#f5c6d0", "#d5c6e0", "#fce4b8", "#8ecac4", "#f2a4b0", "#a8d8ea"];

export interface ConfettiOpts {
  count?: number;
  /** Burst origin in viewport px; defaults to upper-middle of the screen. */
  originX?: number;
  originY?: number;
}

export function confettiBurst(opts: ConfettiOpts = {}): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const count = opts.count ?? 90;
  const ox = opts.originX ?? window.innerWidth / 2;
  const oy = opts.originY ?? window.innerHeight / 3;

  const host = document.createElement("div");
  host.className = "confetti-host";
  document.body.appendChild(host);

  for (let i = 0; i < count; i++) {
    const bit = document.createElement("span");
    bit.className = "confetti-bit";
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 240;
    const dx = Math.cos(angle) * dist;
    // Bias the initial pop upward; gravity in the keyframe pulls it back down.
    const dy = Math.sin(angle) * dist - (80 + Math.random() * 140);
    bit.style.left = `${ox}px`;
    bit.style.top = `${oy}px`;
    bit.style.background = COLORS[i % COLORS.length];
    bit.style.setProperty("--dx", `${dx.toFixed(1)}px`);
    bit.style.setProperty("--dy", `${dy.toFixed(1)}px`);
    bit.style.setProperty("--rot", `${(Math.random() * 720 - 360).toFixed(0)}deg`);
    bit.style.setProperty("--delay", `${(Math.random() * 80).toFixed(0)}ms`);
    bit.style.setProperty("--dur", `${(900 + Math.random() * 700).toFixed(0)}ms`);
    host.appendChild(bit);
  }

  setTimeout(() => host.remove(), 1900);
}
