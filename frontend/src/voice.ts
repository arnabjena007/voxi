// LiveKit voice integration. Lazy-connects on first mic tap, mutes by default,
// and exposes hooks for "who is speaking" so the UI can pulse avatars/meters.

import {
  createLocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteParticipant,
  type Participant,
  type LocalAudioTrack,
} from "livekit-client";

let room: Room | null = null;
let connecting: Promise<void> | null = null;
let micPublished = false;
let muted = true;
let localIdentity: string | null = null;

type SpeakingHandler = (ids: Set<string>) => void;
const speakingHandlers = new Set<SpeakingHandler>();

// Per-remote-speaker local mute. Lives only on this client; doesn't tell the
// server or other peers anything. Volume 0 silences the audio element but the
// participant still appears in active-speakers (their mic is still hot), so
// the muting client just chooses not to listen.
//
// Tracked by display NAME (not LiveKit identity) so the user can mute someone
// before that remote has published a track; intent is then re-applied in
// TrackSubscribed when the audio actually arrives.
const mutedNames = new Set<string>();
const remoteAudioByIdentity = new Map<string, RemoteAudioTrack[]>();

type MicStateHandler = (state: MicState) => void;
const micStateHandlers = new Set<MicStateHandler>();

export type MicState = "off" | "connecting" | "muted" | "live";
let micState: MicState = "off";

function setMicState(s: MicState): void {
  if (micState === s) return;
  micState = s;
  for (const h of micStateHandlers) h(micState);
}

export function getMicState(): MicState {
  return micState;
}

export function getLocalIdentity(): string | null {
  return localIdentity;
}

// Subscribe to speaking-set changes. Set contains LiveKit participant identities.
export function onActiveSpeakers(h: SpeakingHandler): () => void {
  speakingHandlers.add(h);
  return () => speakingHandlers.delete(h);
}

export function onMicState(h: MicStateHandler): () => void {
  micStateHandlers.add(h);
  h(micState);
  return () => micStateHandlers.delete(h);
}

async function fetchToken(roomCode: string, name: string): Promise<{ token: string; url: string }> {
  const params = new URLSearchParams({ room: roomCode, name });
  const res = await fetch(`/voice/token?${params.toString()}`);
  if (!res.ok) throw new Error(`voice token fetch failed: ${res.status}`);
  return res.json();
}

// Explicit pre-warm. Connects to the LiveKit room without publishing a mic
// track so the first toggleMic click only has to ask for mic permission +
// publish (skip token fetch + WS handshake).
export async function connectVoice(roomCode: string, name: string): Promise<void> {
  await connect(roomCode, name);
  setMicState("muted");
}

async function connect(roomCode: string, name: string): Promise<void> {
  if (room) return;
  if (connecting) return connecting;

  setMicState("connecting");
  connecting = (async () => {
    const { token, url } = await fetchToken(roomCode, name);
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        const el = track.attach() as HTMLAudioElement;
        el.style.display = "none";
        el.autoplay = true;
        document.body.appendChild(el);
        const id = participant.identity;
        const list = remoteAudioByIdentity.get(id) ?? [];
        list.push(track);
        remoteAudioByIdentity.set(id, list);
        if (mutedNames.has(identityToName(id))) track.setVolume(0);
      }
    });

    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        for (const el of track.detach()) el.remove();
        const id = participant.identity;
        const list = remoteAudioByIdentity.get(id);
        if (list) {
          const next = list.filter((t) => t !== track);
          if (next.length === 0) remoteAudioByIdentity.delete(id);
          else remoteAudioByIdentity.set(id, next);
        }
      }
    });

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const ids = new Set(speakers.map((p) => p.identity));
      for (const h of speakingHandlers) h(ids);
    });

    r.on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => {
      for (const h of speakingHandlers) h(new Set());
    });

    await r.connect(url, token);
    room = r;
    localIdentity = r.localParticipant.identity;
  })();

  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

async function publishMic(): Promise<void> {
  if (!room) return;
  if (micPublished) return;
  const track: LocalAudioTrack = await createLocalAudioTrack({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  await room.localParticipant.publishTrack(track);
  micPublished = true;
}

// Toggle mic. First call lazily connects + publishes. Subsequent toggles flip
// the mute flag without renegotiating.
export async function toggleMic(roomCode: string, name: string): Promise<MicState> {
  try {
    if (!room) {
      await connect(roomCode, name);
      await publishMic();
      muted = false;
      await setLocalMuted(false);
      setMicState("live");
      return micState;
    }
    if (!micPublished) {
      await publishMic();
    }
    muted = !muted;
    await setLocalMuted(muted);
    setMicState(muted ? "muted" : "live");
    return micState;
  } catch (e) {
    console.warn("[voice] toggle failed", e);
    setMicState("off");
    return micState;
  }
}

async function setLocalMuted(m: boolean): Promise<void> {
  if (!room) return;
  for (const pub of room.localParticipant.audioTrackPublications.values()) {
    if (pub.track) {
      if (m) await pub.mute();
      else await pub.unmute();
    }
  }
}

export async function disconnect(): Promise<void> {
  if (room) {
    await room.disconnect();
    room = null;
  }
  micPublished = false;
  muted = true;
  localIdentity = null;
  mutedNames.clear();
  remoteAudioByIdentity.clear();
  setMicState("off");
}

export function isMuted(): boolean {
  return muted;
}

// Map LiveKit identity (name-XXXXXX) back to display name so the UI can match
// active speakers to player rows. The server mints identity as `${name}-${rand}`.
export function identityToName(identity: string): string {
  const dash = identity.lastIndexOf("-");
  return dash > 0 ? identity.slice(0, dash) : identity;
}

// Iterate every currently-subscribed audio track that belongs to the given
// display name. There can be more than one identity sharing a display name
// across reconnects; we apply intent to all of them.
function tracksForName(name: string): RemoteAudioTrack[] {
  const out: RemoteAudioTrack[] = [];
  for (const [id, tracks] of remoteAudioByIdentity) {
    if (identityToName(id) === name) out.push(...tracks);
  }
  return out;
}

// Toggle local-only mute for a remote player by display name. Tracked by name
// so it works even before the remote publishes a track; intent is reapplied
// on TrackSubscribed. Affects nothing on the server or other clients.
export function toggleRemoteMute(name: string): boolean {
  const nowMuted = !mutedNames.has(name);
  if (nowMuted) mutedNames.add(name);
  else mutedNames.delete(name);
  for (const t of tracksForName(name)) t.setVolume(nowMuted ? 0 : 1);
  return nowMuted;
}

export function isRemoteMutedByName(name: string): boolean {
  return mutedNames.has(name);
}
