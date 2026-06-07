// TypeScript mirror of pastel-proto. Each type's variant order MUST match
// the Rust enum declaration order in `pastel-proto/src/msg.rs` and
// `pastel-proto/src/types.rs`. Variant indices are taken from declaration
// position (0-based).

import { Reader, Writer } from "./postcard";

// --------- limits (kept in sync with pastel-proto/src/limits.rs) ----------

export const ROOM_CODE_LEN = 6;
export const MAX_NAME_LEN = 32;
export const MAX_CHAT_LEN = 256;
export const MAX_GUESS_LEN = 64;
export const MAX_POINTS_PER_BATCH = 64;
export const MAX_FRAME_BYTES = 64 * 1024;

// --------- types ---------------------------------------------------------

export type RoomCode = string; // canonical uppercase 6-char string

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function parseRoomCode(s: string): RoomCode {
  if (s.length !== ROOM_CODE_LEN) {
    throw new Error(`room code must be ${ROOM_CODE_LEN} chars, got ${s.length}`);
  }
  let out = "";
  for (const ch of s.toUpperCase()) {
    let c = ch;
    if (c === "I" || c === "L") c = "1";
    else if (c === "O") c = "0";
    else if (c === "U") c = "V";
    if (!ALPHABET.includes(c)) {
      throw new Error(`invalid room-code char: '${ch}'`);
    }
    out += c;
  }
  return out;
}

function writeRoomCode(w: Writer, code: RoomCode): void {
  const bytes = new TextEncoder().encode(code);
  if (bytes.length !== ROOM_CODE_LEN) {
    throw new Error(`room code wrong length: ${bytes.length}`);
  }
  w.fixedBytes(bytes);
}

function readRoomCode(r: Reader): RoomCode {
  const bytes = r.fixedBytes(ROOM_CODE_LEN);
  return new TextDecoder().decode(bytes);
}

export interface Point {
  dx: number; // i8
  dy: number; // i8
  dt: number; // u8
  pressure: number; // u8
}

function writePoint(w: Writer, p: Point): void {
  w.i8(p.dx).i8(p.dy).u8(p.dt).u8(p.pressure);
}

function readPoint(r: Reader): Point {
  return { dx: r.i8(), dy: r.i8(), dt: r.u8(), pressure: r.u8() };
}

export interface Avatar {
  skin: number;
  hat: number;
  hair: number;
  eyes: number;
  mouth: number;
  specs: number;
  earrings: number;
}

export const DEFAULT_AVATAR: Avatar = {
  skin: 0,
  hat: 0,
  hair: 0,
  eyes: 0,
  mouth: 0,
  specs: 0,
  earrings: 0,
};

function writeAvatar(w: Writer, a: Avatar): void {
  w.u8(a.skin)
    .u8(a.hat)
    .u8(a.hair)
    .u8(a.eyes)
    .u8(a.mouth)
    .u8(a.specs)
    .u8(a.earrings);
}

function readAvatar(r: Reader): Avatar {
  return {
    skin: r.u8(),
    hat: r.u8(),
    hair: r.u8(),
    eyes: r.u8(),
    mouth: r.u8(),
    specs: r.u8(),
    earrings: r.u8(),
  };
}

export interface Player {
  id: number; // u32
  name: string;
  avatar: Avatar;
  is_bot: boolean;
}

function writePlayer(w: Writer, p: Player): void {
  w.varint(p.id).str(p.name);
  writeAvatar(w, p.avatar);
  w.bool(p.is_bot);
}

function readPlayer(r: Reader): Player {
  return {
    id: r.varint(),
    name: r.str(),
    avatar: readAvatar(r),
    is_bot: r.bool(),
  };
}

export interface CompletedStroke {
  player: number;
  stroke_id: number;
  origin: [number, number];
  color: number;
  width: number;
  points: Point[];
}

function writeCompletedStroke(w: Writer, s: CompletedStroke): void {
  w.varint(s.player).varint(s.stroke_id);
  w.varint(s.origin[0]).varint(s.origin[1]);
  w.varint(s.color).u8(s.width);
  w.vec(s.points, writePoint);
}

function readCompletedStroke(r: Reader): CompletedStroke {
  return {
    player: r.varint(),
    stroke_id: r.varint(),
    origin: [r.varint(), r.varint()],
    color: r.varint(),
    width: r.u8(),
    points: r.vec(readPoint),
  };
}

export interface ChatLine {
  seq: number;
  player: number;
  text: string;
}

function writeChatLine(w: Writer, c: ChatLine): void {
  w.varint(c.seq).varint(c.player).str(c.text);
}

function readChatLine(r: Reader): ChatLine {
  return { seq: r.varint(), player: r.varint(), text: r.str() };
}

export type GamePhaseSnapshot =
  | { kind: "Lobby"; deadline_ms: number | null }
  | {
      kind: "ChoosingWord";
      drawer: number;
      deadline_ms: number;
      round_index: number;
      total_rounds: number;
    }
  | {
      kind: "Drawing";
      drawer: number;
      mask: string;
      deadline_ms: number;
      round_index: number;
      total_rounds: number;
    }
  | { kind: "RoundEnd"; word: string; deadline_ms: number }
  | { kind: "GameOver" };

function writeGamePhaseSnapshot(w: Writer, p: GamePhaseSnapshot): void {
  switch (p.kind) {
    case "Lobby":
      w.variant(0);
      if (p.deadline_ms === null) {
        w.variant(0); // Option::None
      } else {
        w.variant(1).varint(p.deadline_ms); // Option::Some
      }
      return;
    case "ChoosingWord":
      w.variant(1)
        .varint(p.drawer)
        .varint(p.deadline_ms)
        .u8(p.round_index)
        .u8(p.total_rounds);
      return;
    case "Drawing":
      w.variant(2)
        .varint(p.drawer)
        .str(p.mask)
        .varint(p.deadline_ms)
        .u8(p.round_index)
        .u8(p.total_rounds);
      return;
    case "RoundEnd":
      w.variant(3).str(p.word).varint(p.deadline_ms);
      return;
    case "GameOver":
      return void w.variant(4);
  }
}

function readGamePhaseSnapshot(r: Reader): GamePhaseSnapshot {
  const v = r.variant();
  switch (v) {
    case 0: {
      const opt = r.variant();
      const deadline_ms = opt === 0 ? null : r.varint();
      return { kind: "Lobby", deadline_ms };
    }
    case 1:
      return {
        kind: "ChoosingWord",
        drawer: r.varint(),
        deadline_ms: r.varint(),
        round_index: r.u8(),
        total_rounds: r.u8(),
      };
    case 2:
      return {
        kind: "Drawing",
        drawer: r.varint(),
        mask: r.str(),
        deadline_ms: r.varint(),
        round_index: r.u8(),
        total_rounds: r.u8(),
      };
    case 3:
      return { kind: "RoundEnd", word: r.str(), deadline_ms: r.varint() };
    case 4:
      return { kind: "GameOver" };
    default:
      throw new Error(`unknown GamePhaseSnapshot variant: ${v}`);
  }
}

export interface GameSnapshot {
  mode: GameMode;
  host: number | null;
  scores: [number, number][];
  phase: GamePhaseSnapshot;
}

function writeGameSnapshot(w: Writer, s: GameSnapshot): void {
  writeGameMode(w, s.mode);
  w.option(s.host, (ww, v) => ww.varint(v));
  writeScores(w, s.scores);
  writeGamePhaseSnapshot(w, s.phase);
}

function readGameSnapshot(r: Reader): GameSnapshot {
  return {
    mode: readGameMode(r),
    host: r.option((rr) => rr.varint()),
    scores: readScores(r),
    phase: readGamePhaseSnapshot(r),
  };
}

export function emptyGameSnapshot(): GameSnapshot {
  return {
    mode: "Standard",
    host: null,
    scores: [],
    phase: { kind: "Lobby", deadline_ms: null },
  };
}

export interface RoomSnapshot {
  players: Player[];
  completed: CompletedStroke[];
  seq: number;
  chat: ChatLine[];
  game: GameSnapshot;
}

function writeSnapshot(w: Writer, s: RoomSnapshot): void {
  w.vec(s.players, writePlayer);
  w.vec(s.completed, writeCompletedStroke);
  w.varint(s.seq);
  w.vec(s.chat, writeChatLine);
  writeGameSnapshot(w, s.game);
}

function readSnapshot(r: Reader): RoomSnapshot {
  return {
    players: r.vec(readPlayer),
    completed: r.vec(readCompletedStroke),
    seq: r.varint(),
    chat: r.vec(readChatLine),
    game: readGameSnapshot(r),
  };
}

// --------- enums ---------------------------------------------------------

export type GameMode = "Sprint" | "Standard" | "Marathon";

const GAME_MODE_ORDER: GameMode[] = ["Sprint", "Standard", "Marathon"];

function writeGameMode(w: Writer, m: GameMode): void {
  const idx = GAME_MODE_ORDER.indexOf(m);
  if (idx < 0) throw new Error(`unknown GameMode: ${m}`);
  w.variant(idx);
}

function readGameMode(r: Reader): GameMode {
  const v = r.variant();
  if (v < 0 || v >= GAME_MODE_ORDER.length) {
    throw new Error(`unknown GameMode variant: ${v}`);
  }
  return GAME_MODE_ORDER[v];
}

export function modeRounds(m: GameMode): number {
  switch (m) {
    case "Sprint":
      return 3;
    case "Standard":
      return 5;
    case "Marathon":
      return 7;
  }
}

export function modeWordOptions(m: GameMode): number {
  switch (m) {
    case "Sprint":
      return 7;
    case "Standard":
      return 5;
    case "Marathon":
      return 3;
  }
}

export type GameAction =
  | { kind: "Start"; mode: GameMode }
  | { kind: "PickWord"; index: number }
  | { kind: "Kick"; player: number }
  | { kind: "Clear" }
  | { kind: "ApproveJoin"; candidate: number }
  | { kind: "RejectJoin"; candidate: number };

function writeGameAction(w: Writer, a: GameAction): void {
  switch (a.kind) {
    case "Start":
      w.variant(0);
      writeGameMode(w, a.mode);
      return;
    case "PickWord":
      w.variant(1).u8(a.index);
      return;
    case "Kick":
      w.variant(2).varint(a.player);
      return;
    case "Clear":
      return void w.variant(3);
    case "ApproveJoin":
      w.variant(4).varint(a.candidate);
      return;
    case "RejectJoin":
      w.variant(5).varint(a.candidate);
      return;
  }
}

function readGameAction(r: Reader): GameAction {
  const v = r.variant();
  switch (v) {
    case 0:
      return { kind: "Start", mode: readGameMode(r) };
    case 1:
      return { kind: "PickWord", index: r.u8() };
    case 2:
      return { kind: "Kick", player: r.varint() };
    case 3:
      return { kind: "Clear" };
    case 4:
      return { kind: "ApproveJoin", candidate: r.varint() };
    case 5:
      return { kind: "RejectJoin", candidate: r.varint() };
    default:
      throw new Error(`unknown GameAction variant: ${v}`);
  }
}

export type GameEvent =
  | {
      kind: "RoundStart";
      drawer: number;
      word_mask: string;
      duration_ms: number;
      round_index: number;
      total_rounds: number;
    }
  | { kind: "RoundEnd"; word: string; scores: [number, number][]; turn: number }
  | { kind: "GameOver"; final_scores: [number, number][] }
  | { kind: "Cleared"; by: number }
  | {
      kind: "WordPickStarted";
      drawer: number;
      deadline_ms: number;
      round_index: number;
      total_rounds: number;
    }
  | { kind: "HintReveal"; mask: string }
  | { kind: "JoinRequest"; candidate: number; name: string }
  | { kind: "JoinCanceled"; candidate: number }
  | { kind: "HostChanged"; new_host: number }
  | { kind: "Reaction"; player: number; mood: DrawingMood }
  | { kind: "StrokeRemoved"; player: number; stroke_id: number }
  | { kind: "VotingOpen"; deadline_ms: number }
  | { kind: "VoteResult"; tally: [number, number][]; winner: VoteWinner | null };

export interface VoteWinner {
  turn: number;
  drawer: number;
  word: string;
  votes: number;
}

function writeScores(w: Writer, scores: [number, number][]): void {
  w.varint(scores.length);
  for (const [id, s] of scores) w.varint(id).varint(s);
}

function readScores(r: Reader): [number, number][] {
  const n = r.varint();
  const out: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [r.varint(), r.varint()];
  return out;
}

function writeGameEvent(w: Writer, e: GameEvent): void {
  switch (e.kind) {
    case "RoundStart":
      w.variant(0)
        .varint(e.drawer)
        .str(e.word_mask)
        .varint(e.duration_ms)
        .u8(e.round_index)
        .u8(e.total_rounds);
      return;
    case "RoundEnd":
      w.variant(1).str(e.word);
      writeScores(w, e.scores);
      w.varint(e.turn);
      return;
    case "GameOver":
      w.variant(2);
      writeScores(w, e.final_scores);
      return;
    case "Cleared":
      w.variant(3).varint(e.by);
      return;
    case "WordPickStarted":
      w.variant(4)
        .varint(e.drawer)
        .varint(e.deadline_ms)
        .u8(e.round_index)
        .u8(e.total_rounds);
      return;
    case "HintReveal":
      w.variant(5).str(e.mask);
      return;
    case "JoinRequest":
      w.variant(6).varint(e.candidate).str(e.name);
      return;
    case "JoinCanceled":
      w.variant(7).varint(e.candidate);
      return;
    case "HostChanged":
      w.variant(8).varint(e.new_host);
      return;
    case "Reaction":
      w.variant(9).varint(e.player);
      writeDrawingMood(w, e.mood);
      return;
    case "StrokeRemoved":
      w.variant(10).varint(e.player).varint(e.stroke_id);
      return;
    case "VotingOpen":
      w.variant(11).varint(e.deadline_ms);
      return;
    case "VoteResult":
      w.variant(12);
      w.varint(e.tally.length);
      for (const [turn, count] of e.tally) w.varint(turn).varint(count);
      w.option(e.winner, (ww, win) =>
        ww.varint(win.turn).varint(win.drawer).str(win.word).varint(win.votes),
      );
      return;
  }
}

function readGameEvent(r: Reader): GameEvent {
  const v = r.variant();
  switch (v) {
    case 0:
      return {
        kind: "RoundStart",
        drawer: r.varint(),
        word_mask: r.str(),
        duration_ms: r.varint(),
        round_index: r.u8(),
        total_rounds: r.u8(),
      };
    case 1:
      return {
        kind: "RoundEnd",
        word: r.str(),
        scores: readScores(r),
        turn: r.varint(),
      };
    case 2:
      return { kind: "GameOver", final_scores: readScores(r) };
    case 3:
      return { kind: "Cleared", by: r.varint() };
    case 4:
      return {
        kind: "WordPickStarted",
        drawer: r.varint(),
        deadline_ms: r.varint(),
        round_index: r.u8(),
        total_rounds: r.u8(),
      };
    case 5:
      return { kind: "HintReveal", mask: r.str() };
    case 6:
      return { kind: "JoinRequest", candidate: r.varint(), name: r.str() };
    case 7:
      return { kind: "JoinCanceled", candidate: r.varint() };
    case 8:
      return { kind: "HostChanged", new_host: r.varint() };
    case 9:
      return { kind: "Reaction", player: r.varint(), mood: readDrawingMood(r) };
    case 10:
      return { kind: "StrokeRemoved", player: r.varint(), stroke_id: r.varint() };
    case 11:
      return { kind: "VotingOpen", deadline_ms: r.varint() };
    case 12: {
      const n = r.varint();
      const tally: [number, number][] = new Array(n);
      for (let i = 0; i < n; i++) tally[i] = [r.varint(), r.varint()];
      const winner = r.option<VoteWinner>((rr) => ({
        turn: rr.varint(),
        drawer: rr.varint(),
        word: rr.str(),
        votes: rr.varint(),
      }));
      return { kind: "VoteResult", tally, winner };
    }
    default:
      throw new Error(`unknown GameEvent variant: ${v}`);
  }
}

export type GuessKind = "Correct" | "Close" | "Spoiler";

export type DrawingMood = "Loved" | "Confused";

function writeDrawingMood(w: Writer, m: DrawingMood): void {
  w.variant(m === "Loved" ? 0 : 1);
}

function readDrawingMood(r: Reader): DrawingMood {
  const v = r.variant();
  if (v === 0) return "Loved";
  if (v === 1) return "Confused";
  throw new Error(`unknown DrawingMood: ${v}`);
}

function writeGuessKind(w: Writer, k: GuessKind): void {
  w.variant(k === "Correct" ? 0 : k === "Close" ? 1 : 2);
}

function readGuessKind(r: Reader): GuessKind {
  const v = r.variant();
  if (v === 0) return "Correct";
  if (v === 1) return "Close";
  if (v === 2) return "Spoiler";
  throw new Error(`unknown GuessKind: ${v}`);
}

export type ByeReason =
  | "Reconnect"
  | "Kicked"
  | "RoomClosed"
  | "RoomFull"
  | "BadFrame";

const BYE_ORDER: ByeReason[] = [
  "Reconnect",
  "Kicked",
  "RoomClosed",
  "RoomFull",
  "BadFrame",
];

function writeByeReason(w: Writer, r: ByeReason): void {
  const idx = BYE_ORDER.indexOf(r);
  if (idx < 0) throw new Error(`unknown ByeReason: ${r}`);
  w.variant(idx);
}

function readByeReason(r: Reader): ByeReason {
  const v = r.variant();
  if (v < 0 || v >= BYE_ORDER.length) {
    throw new Error(`unknown ByeReason variant: ${v}`);
  }
  return BYE_ORDER[v];
}

// --------- Hello ---------------------------------------------------------

export interface Hello {
  room: RoomCode;
  name: string;
  resume_from: number | null;
  client_token: string | null;
  avatar: Avatar;
}

function writeHello(w: Writer, h: Hello): void {
  writeRoomCode(w, h.room);
  w.str(h.name);
  w.option(h.resume_from, (ww, n) => ww.varint(n));
  w.option(h.client_token, (ww, s) => ww.str(s));
  writeAvatar(w, h.avatar);
}

function readHello(r: Reader): Hello {
  return {
    room: readRoomCode(r),
    name: r.str(),
    resume_from: r.option((rr) => rr.varint()),
    client_token: r.option((rr) => rr.str()),
    avatar: readAvatar(r),
  };
}

// --------- ClientMsg -----------------------------------------------------

export type ClientMsg =
  | { kind: "Hello"; hello: Hello }
  | {
      kind: "Stroke";
      stroke_id: number;
      origin: [number, number];
      color: number;
      width: number;
      points: Point[];
      finished: boolean;
    }
  | { kind: "Chat"; text: string }
  | { kind: "Guess"; text: string }
  | { kind: "Game"; action: GameAction }
  | { kind: "Pong"; nonce: number }
  | { kind: "React"; mood: DrawingMood }
  | { kind: "Undo" }
  | { kind: "Emote"; idx: number }
  | { kind: "Vote"; turn: number };

export function encodeClientMsg(msg: ClientMsg): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  switch (msg.kind) {
    case "Hello":
      w.variant(0);
      writeHello(w, msg.hello);
      break;
    case "Stroke":
      w.variant(1)
        .varint(msg.stroke_id)
        .varint(msg.origin[0])
        .varint(msg.origin[1])
        .varint(msg.color)
        .u8(msg.width)
        .vec(msg.points, writePoint)
        .bool(msg.finished);
      break;
    case "Chat":
      w.variant(2).str(msg.text);
      break;
    case "Guess":
      w.variant(3).str(msg.text);
      break;
    case "Game":
      w.variant(4);
      writeGameAction(w, msg.action);
      break;
    case "Pong":
      w.variant(5).varint(msg.nonce);
      break;
    case "React":
      w.variant(6);
      writeDrawingMood(w, msg.mood);
      break;
    case "Undo":
      w.variant(7);
      break;
    case "Emote":
      w.variant(8).u8(msg.idx);
      break;
    case "Vote":
      w.variant(9).varint(msg.turn);
      break;
  }
  return w.bytes();
}

export function decodeClientMsg(bytes: Uint8Array): ClientMsg {
  const r = new Reader(bytes);
  const v = r.variant();
  switch (v) {
    case 0:
      return { kind: "Hello", hello: readHello(r) };
    case 1:
      return {
        kind: "Stroke",
        stroke_id: r.varint(),
        origin: [r.varint(), r.varint()],
        color: r.varint(),
        width: r.u8(),
        points: r.vec(readPoint),
        finished: r.bool(),
      };
    case 2:
      return { kind: "Chat", text: r.str() };
    case 3:
      return { kind: "Guess", text: r.str() };
    case 4:
      return { kind: "Game", action: readGameAction(r) };
    case 5:
      return { kind: "Pong", nonce: r.varint() };
    case 6:
      return { kind: "React", mood: readDrawingMood(r) };
    case 7:
      return { kind: "Undo" };
    case 8:
      return { kind: "Emote", idx: r.u8() };
    case 9:
      return { kind: "Vote", turn: r.varint() };
    default:
      throw new Error(`unknown ClientMsg variant: ${v}`);
  }
}

// --------- ServerMsg -----------------------------------------------------

export type ServerMsg =
  | {
      kind: "Welcome";
      you: number;
      snapshot: RoomSnapshot;
      seq: number;
      lk_token: string;
    }
  | { kind: "Resume"; events: ServerMsg[] }
  | {
      kind: "Stroke";
      seq: number;
      player: number;
      stroke_id: number;
      origin: [number, number];
      color: number;
      width: number;
      points: Point[];
      finished: boolean;
    }
  | { kind: "Chat"; seq: number; player: number; text: string }
  | { kind: "Guess"; seq: number; player: number; guess: GuessKind }
  | { kind: "Presence"; seq: number; joined: Player[]; left: number[] }
  | { kind: "Game"; seq: number; event: GameEvent }
  | { kind: "Ping"; nonce: number }
  | { kind: "Bye"; reason: ByeReason }
  | { kind: "WordOptions"; words: string[]; deadline_ms: number }
  | { kind: "DrawerWord"; word: string; duration_ms: number }
  | { kind: "JoinPending" }
  | { kind: "DrawingFeedback"; mood: DrawingMood }
  | { kind: "Emote"; player: number; idx: number };

export function encodeServerMsg(msg: ServerMsg): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  writeServerMsg(w, msg);
  return w.bytes();
}

function writeServerMsg(w: Writer, msg: ServerMsg): void {
  switch (msg.kind) {
    case "Welcome":
      w.variant(0).varint(msg.you);
      writeSnapshot(w, msg.snapshot);
      w.varint(msg.seq).str(msg.lk_token);
      return;
    case "Resume":
      w.variant(1).vec(msg.events, (ww, e) => writeServerMsg(ww, e));
      return;
    case "Stroke":
      w.variant(2)
        .varint(msg.seq)
        .varint(msg.player)
        .varint(msg.stroke_id)
        .varint(msg.origin[0])
        .varint(msg.origin[1])
        .varint(msg.color)
        .u8(msg.width)
        .vec(msg.points, writePoint)
        .bool(msg.finished);
      return;
    case "Chat":
      w.variant(3).varint(msg.seq).varint(msg.player).str(msg.text);
      return;
    case "Guess":
      w.variant(4).varint(msg.seq).varint(msg.player);
      writeGuessKind(w, msg.guess);
      return;
    case "Presence":
      w.variant(5)
        .varint(msg.seq)
        .vec(msg.joined, writePlayer)
        .vec(msg.left, (ww, n) => ww.varint(n));
      return;
    case "Game":
      w.variant(6).varint(msg.seq);
      writeGameEvent(w, msg.event);
      return;
    case "Ping":
      w.variant(7).varint(msg.nonce);
      return;
    case "Bye":
      w.variant(8);
      writeByeReason(w, msg.reason);
      return;
    case "WordOptions":
      w.variant(9)
        .vec(msg.words, (ww, s) => ww.str(s))
        .varint(msg.deadline_ms);
      return;
    case "DrawerWord":
      w.variant(10).str(msg.word).varint(msg.duration_ms);
      return;
    case "JoinPending":
      w.variant(11);
      return;
    case "DrawingFeedback":
      w.variant(12);
      writeDrawingMood(w, msg.mood);
      return;
    case "Emote":
      w.variant(13).varint(msg.player).u8(msg.idx);
      return;
  }
}

export function decodeServerMsg(bytes: Uint8Array): ServerMsg {
  const r = new Reader(bytes);
  return readServerMsg(r);
}

// The server only ever sends a flat Resume (no Resume inside a Resume), so cap
// recursion here: a nested-Resume frame can't stack-overflow the decoder.
const MAX_RESUME_DEPTH = 1;

function readServerMsg(r: Reader, depth = 0): ServerMsg {
  const v = r.variant();
  switch (v) {
    case 0:
      return {
        kind: "Welcome",
        you: r.varint(),
        snapshot: readSnapshot(r),
        seq: r.varint(),
        lk_token: r.str(),
      };
    case 1:
      if (depth >= MAX_RESUME_DEPTH) {
        throw new Error("postcard: Resume nested too deep");
      }
      return { kind: "Resume", events: r.vec((rr) => readServerMsg(rr, depth + 1)) };
    case 2:
      return {
        kind: "Stroke",
        seq: r.varint(),
        player: r.varint(),
        stroke_id: r.varint(),
        origin: [r.varint(), r.varint()],
        color: r.varint(),
        width: r.u8(),
        points: r.vec(readPoint),
        finished: r.bool(),
      };
    case 3:
      return { kind: "Chat", seq: r.varint(), player: r.varint(), text: r.str() };
    case 4:
      return {
        kind: "Guess",
        seq: r.varint(),
        player: r.varint(),
        guess: readGuessKind(r),
      };
    case 5:
      return {
        kind: "Presence",
        seq: r.varint(),
        joined: r.vec(readPlayer),
        left: r.vec((rr) => rr.varint()),
      };
    case 6:
      return { kind: "Game", seq: r.varint(), event: readGameEvent(r) };
    case 7:
      return { kind: "Ping", nonce: r.varint() };
    case 8:
      return { kind: "Bye", reason: readByeReason(r) };
    case 9:
      return {
        kind: "WordOptions",
        words: r.vec((rr) => rr.str()),
        deadline_ms: r.varint(),
      };
    case 10:
      return {
        kind: "DrawerWord",
        word: r.str(),
        duration_ms: r.varint(),
      };
    case 11:
      return { kind: "JoinPending" };
    case 12:
      return { kind: "DrawingFeedback", mood: readDrawingMood(r) };
    case 13:
      return { kind: "Emote", player: r.varint(), idx: r.u8() };
    default:
      throw new Error(`unknown ServerMsg variant: ${v}`);
  }
}
