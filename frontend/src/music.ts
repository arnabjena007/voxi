// Background music: streams real audio files from /music/ (cheap, no DSP).
// Event SFX stay procedural via Tone.js (short, lightweight, no glitching).
//
// Three tracks switch by scene: landing / lobby / game. Track changes
// crossfade so transitions don't feel abrupt.

import * as Tone from "tone";

const BG_KEY = "voxi.bg";
const SFX_KEY = "voxi.sfx";

export type BgScene = "landing" | "lobby" | "game";

const TRACKS: Record<BgScene, string> = {
  landing: "/music/landing.mp3",
  lobby: "/music/lobby.mp3",
  game: "/music/game.mp3",
};

const BG_VOLUME = 0.35;
const FADE_MS = 600;
const DUCK_VOLUME = 0.05;

let bgEnabled = false;
let sfxEnabled = false;
let toneStarted = false;
let duckedForVoice = false;
let currentScene: BgScene | null = null;
let currentAudio: HTMLAudioElement | null = null;
let fadeTimers = new Set<number>();

type BgPlayingHandler = (playing: boolean) => void;
const bgPlayingHandlers = new Set<BgPlayingHandler>();

export function isBgPlaying(): boolean {
  return currentAudio !== null && !currentAudio.paused;
}

export function onBgPlaying(h: BgPlayingHandler): () => void {
  bgPlayingHandlers.add(h);
  h(isBgPlaying());
  return () => {
    bgPlayingHandlers.delete(h);
  };
}

function emitBgPlaying(): void {
  const p = isBgPlaying();
  for (const h of bgPlayingHandlers) h(p);
}

function targetVolume(): number {
  return duckedForVoice ? DUCK_VOLUME : BG_VOLUME;
}

function clearFades(): void {
  for (const t of fadeTimers) window.clearInterval(t);
  fadeTimers.clear();
}

function fade(el: HTMLAudioElement, from: number, to: number, durMs: number, onDone?: () => void): void {
  const steps = 20;
  const stepMs = durMs / steps;
  let i = 0;
  el.volume = Math.max(0, Math.min(1, from));
  const timer = window.setInterval(() => {
    i++;
    const t = i / steps;
    el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (i >= steps) {
      window.clearInterval(timer);
      fadeTimers.delete(timer);
      onDone?.();
    }
  }, stepMs);
  fadeTimers.add(timer);
}

function makeTrack(src: string): HTMLAudioElement {
  const a = new Audio(src);
  a.loop = true;
  a.preload = "auto";
  a.volume = 0;
  return a;
}

async function startScene(scene: BgScene): Promise<void> {
  if (!bgEnabled) return;
  const src = TRACKS[scene];

  // Same scene already playing.
  if (currentAudio && currentAudio.src.endsWith(src) && !currentAudio.paused) {
    return;
  }

  clearFades();
  const next = makeTrack(src);
  try {
    await next.play();
  } catch (e) {
    // Browser blocked autoplay; will resume on next user gesture via enableBg().
    console.warn("[music] autoplay blocked", e);
    return;
  }

  const out = currentAudio;
  currentAudio = next;
  fade(next, 0, targetVolume(), FADE_MS);
  if (out) {
    fade(out, out.volume, 0, FADE_MS, () => {
      out.pause();
      out.src = "";
    });
  }
  emitBgPlaying();
}

function stopBg(): void {
  clearFades();
  if (currentAudio) {
    const out = currentAudio;
    fade(out, out.volume, 0, FADE_MS, () => {
      out.pause();
      out.src = "";
    });
    currentAudio = null;
  }
  emitBgPlaying();
}

async function ensureToneStarted(): Promise<void> {
  if (toneStarted) return;
  await Tone.start();
  toneStarted = true;
}

// Public scene-change API. Safe to call before bg is enabled; it just stores
// the desired scene and starts on first enable.
export async function setBgScene(scene: BgScene): Promise<void> {
  currentScene = scene;
  if (bgEnabled) await startScene(scene);
}

// Voice ducking: when the user's mic is live, drop the bg volume way down so
// other players don't hear the music leaking through the mic.
export function setVoiceDucking(active: boolean): void {
  if (duckedForVoice === active) return;
  duckedForVoice = active;
  if (currentAudio) {
    fade(currentAudio, currentAudio.volume, targetVolume(), 400);
  }
}

export function isBgEnabled(): boolean {
  return bgEnabled;
}

export function isSfxEnabled(): boolean {
  return sfxEnabled;
}

export async function enableBg(): Promise<void> {
  bgEnabled = true;
  window.localStorage.setItem(BG_KEY, "1");
  if (currentScene) await startScene(currentScene);
}

export function disableBg(): void {
  bgEnabled = false;
  window.localStorage.setItem(BG_KEY, "0");
  stopBg();
}

export async function toggleBg(): Promise<boolean> {
  if (bgEnabled) disableBg();
  else await enableBg();
  return bgEnabled;
}

export async function enableSfx(): Promise<void> {
  await ensureToneStarted();
  sfxEnabled = true;
  window.localStorage.setItem(SFX_KEY, "1");
}

export function disableSfx(): void {
  sfxEnabled = false;
  window.localStorage.setItem(SFX_KEY, "0");
}

export async function toggleSfx(): Promise<boolean> {
  if (sfxEnabled) disableSfx();
  else await enableSfx();
  return sfxEnabled;
}

export function loadBgPreference(): boolean {
  return window.localStorage.getItem(BG_KEY) !== "0";
}

export function loadSfxPreference(): boolean {
  return window.localStorage.getItem(SFX_KEY) !== "0";
}

// Short event sounds. Still procedural via Tone.js since they're brief, fire
// once, and the previous DSP glitching was only the long bg loop.

function playMelody(notes: { note: string; time: number; dur: string }[]): void {
  if (!sfxEnabled) return;
  void ensureToneStarted();
  const reverb = new Tone.Reverb({ decay: 2, wet: 0.3 }).toDestination();
  const synth = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.6 },
    volume: -22,
  }).connect(reverb);
  const now = Tone.now();
  for (const { note, time, dur } of notes) {
    synth.triggerAttackRelease(note, dur, now + time);
  }
  const totalDur = notes.reduce((acc, n) => Math.max(acc, n.time + 1.0), 0);
  window.setTimeout(() => {
    synth.dispose();
    reverb.dispose();
  }, (totalDur + 1) * 1000);
}

export function playCorrect(): void {
  playMelody([
    { note: "C5", time: 0, dur: "16n" },
    { note: "E5", time: 0.1, dur: "16n" },
    { note: "G5", time: 0.2, dur: "8n" },
  ]);
}

export function playRoundStart(): void {
  playMelody([
    { note: "G4", time: 0, dur: "16n" },
    { note: "C5", time: 0.12, dur: "8n" },
  ]);
}

export function playRoundEnd(): void {
  playMelody([
    { note: "E5", time: 0, dur: "16n" },
    { note: "C5", time: 0.1, dur: "16n" },
    { note: "G4", time: 0.2, dur: "4n" },
  ]);
}

export function playJoin(): void {
  playMelody([
    { note: "E4", time: 0, dur: "16n" },
    { note: "A4", time: 0.08, dur: "16n" },
  ]);
}

export function playGameOver(): void {
  playMelody([
    { note: "C5", time: 0, dur: "16n" },
    { note: "E5", time: 0.1, dur: "16n" },
    { note: "G5", time: 0.2, dur: "16n" },
    { note: "C6", time: 0.3, dur: "4n" },
  ]);
}
