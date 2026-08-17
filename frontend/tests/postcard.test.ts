import { describe, expect, it } from "vitest";
import { Reader, Writer } from "../src/postcard";
import {
  decodeClientMsg,
  decodeServerMsg,
  DEFAULT_AVATAR,
  encodeClientMsg,
  encodeServerMsg,
  parseRoomCode,
  type ClientMsg,
  type ServerMsg,
} from "../src/proto";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

describe("postcard primitives", () => {
  it("round-trips u8", () => {
    const w = new Writer();
    w.u8(0).u8(127).u8(255);
    const r = new Reader(w.bytes());
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(127);
    expect(r.u8()).toBe(255);
  });

  it("round-trips small varints in one byte", () => {
    for (const v of [0, 1, 63, 127]) {
      const w = new Writer();
      w.varint(v);
      expect(w.bytes().length).toBe(1);
      expect(new Reader(w.bytes()).varint()).toBe(v);
    }
  });

  it("varint 128 encodes to 2 bytes", () => {
    const w = new Writer();
    w.varint(128);
    expect(hex(w.bytes())).toBe("8001");
  });

  it("zig-zag signed varint round-trip", () => {
    for (const v of [-128, -2, -1, 0, 1, 2, 127]) {
      const w = new Writer();
      w.ivarint(v);
      expect(new Reader(w.bytes()).ivarint()).toBe(v);
    }
  });

  it("i8 round-trip is one raw byte (two's complement)", () => {
    const w = new Writer();
    w.i8(-2);
    expect(hex(w.bytes())).toBe("fe");
    expect(new Reader(w.bytes()).i8()).toBe(-2);

    const wPos = new Writer();
    wPos.i8(1);
    expect(hex(wPos.bytes())).toBe("01");
  });

  it("string round-trip with multibyte chars", () => {
    const w = new Writer();
    w.str("héllo \u{1F600}");
    const r = new Reader(w.bytes());
    expect(r.str()).toBe("héllo \u{1F600}");
  });

  it("vec round-trip", () => {
    const w = new Writer();
    w.vec([1, 2, 3, 1000], (ww, v) => ww.varint(v));
    const r = new Reader(w.bytes());
    expect(r.vec((rr) => rr.varint())).toEqual([1, 2, 3, 1000]);
  });

  it("option round-trip", () => {
    const wSome = new Writer();
    wSome.option(42, (w, v) => w.varint(v));
    expect(new Reader(wSome.bytes()).option((r) => r.varint())).toBe(42);

    const wNone = new Writer();
    wNone.option<number>(null, (w, v) => w.varint(v));
    expect(new Reader(wNone.bytes()).option((r) => r.varint())).toBeNull();
  });

  it("rejects out-of-range u8", () => {
    expect(() => new Writer().u8(256)).toThrow();
    expect(() => new Writer().u8(-1)).toThrow();
  });

  it("rejects reads past end", () => {
    expect(() => new Reader(new Uint8Array()).u8()).toThrow();
  });
});

describe("room code", () => {
  it("substitutes ambiguous chars", () => {
    expect(parseRoomCode("iloabc")).toBe("110ABC");
  });
  it("rejects invalid chars", () => {
    expect(() => parseRoomCode("ABC!23")).toThrow();
  });
  it("rejects wrong length", () => {
    expect(() => parseRoomCode("ABC")).toThrow();
  });
});

// These hex strings are the cross-codec contract. The Rust side asserts the
// same bytes in `crates/voxi-proto/tests/fixtures.rs`. If you change
// either, change both.
describe("wire fixtures (must match Rust)", () => {
  it("ClientMsg::Pong { nonce: 7 }", () => {
    const msg: ClientMsg = { kind: "Pong", nonce: 7 };
    expect(hex(encodeClientMsg(msg))).toBe("0507");
    expect(decodeClientMsg(bytes(0x05, 0x07))).toEqual(msg);
  });

  it("ClientMsg::Chat { text: 'hi' }", () => {
    const msg: ClientMsg = { kind: "Chat", text: "hi" };
    expect(hex(encodeClientMsg(msg))).toBe("02026869");
    expect(decodeClientMsg(bytes(0x02, 0x02, 0x68, 0x69))).toEqual(msg);
  });

  it("ClientMsg::Stroke single-point", () => {
    const msg: ClientMsg = {
      kind: "Stroke",
      stroke_id: 7,
      origin: [0, 0],
      color: 0,
      width: 4,
      points: [{ dx: 1, dy: -2, dt: 16, pressure: 200 }],
      finished: false,
    };
    // variant 1, stroke_id 7, origin 0 0, color 0, width 4, len 1,
    // point [01 fe 10 c8], finished 0.
    expect(hex(encodeClientMsg(msg))).toBe("0107000000040101fe10c800");
    const round = decodeClientMsg(encodeClientMsg(msg));
    expect(round).toEqual(msg);
  });

  it("ServerMsg::Bye { reason: Reconnect }", () => {
    const msg: ServerMsg = { kind: "Bye", reason: "Reconnect" };
    expect(hex(encodeServerMsg(msg))).toBe("0800");
    expect(decodeServerMsg(bytes(0x08, 0x00))).toEqual(msg);
  });

  it("ServerMsg::Welcome with empty snapshot", () => {
    const msg: ServerMsg = {
      kind: "Welcome",
      you: 1,
      snapshot: {
        players: [],
        completed: [],
        voxels: [],
        seq: 0,
        chat: [],
        game: {
          mode: "Standard",
          host: null,
          scores: [],
          phase: { kind: "Lobby", deadline_ms: null },
        },
        grid_size: 20,
      },
      seq: 0,
      lk_token: "",
    };
    // variant 0, you 1, players 0, completed 0, snap.seq 0, chat 0,
    // game.mode Standard=1, game.host None=0, game.scores 0,
    // game.phase Lobby=0 + deadline_ms Option::None=0, grid_size 20, outer seq 0, lk_token 0
    expect(hex(encodeServerMsg(msg))).toBe("000100000000000100000000140000");
    expect(decodeServerMsg(encodeServerMsg(msg))).toEqual(msg);
  });
});

describe("client/server round-trips", () => {
  const fixtures: ClientMsg[] = [
    {
      kind: "Hello",
      hello: {
        room: parseRoomCode("ABC234"),
        name: "alice",
        resume_from: null,
        client_token: null,
        avatar: DEFAULT_AVATAR,
      },
    },
    {
      kind: "Hello",
      hello: {
        room: parseRoomCode("ABC234"),
        name: "bob",
        resume_from: 42,
        client_token: "tok-bob",
        avatar: {
          skin: 3,
          hat: 2,
          hair: 5,
          eyes: 3,
          mouth: 1,
          specs: 4,
          earrings: 2,
        },
      },
    },
    {
      kind: "Stroke",
      stroke_id: 99,
      origin: [320, 240],
      color: 0xd62828,
      width: 4,
      points: Array.from({ length: 30 }, (_, i) => ({
        dx: ((i * 3) % 11) - 5,
        dy: ((i * 7) % 13) - 6,
        dt: 16,
        pressure: 200,
      })),
      finished: false,
    },
    { kind: "Chat", text: "hello world" },
    { kind: "Guess", text: "apple" },
    { kind: "Game", action: { kind: "Start", mode: "Standard" } },
    { kind: "Game", action: { kind: "PickWord", index: 2 } },
    { kind: "Game", action: { kind: "Kick", player: 7 } },
    { kind: "Pong", nonce: 0xdeadbeef },
  ];

  for (const m of fixtures) {
    it(`ClientMsg ${m.kind} round-trip`, () => {
      const bytes = encodeClientMsg(m);
      expect(decodeClientMsg(bytes)).toEqual(m);
    });
  }

  const serverFixtures: ServerMsg[] = [
    {
      kind: "Welcome",
      you: 5,
      snapshot: {
        players: [{ id: 1, name: "alice", avatar: DEFAULT_AVATAR, is_bot: false }],
        completed: [
          {
            player: 1,
            stroke_id: 1,
            origin: [10, 20],
            color: 0xd62828,
            width: 4,
            points: [{ dx: 1, dy: 1, dt: 16, pressure: 200 }],
          },
        ],
        voxels: [],
        seq: 3,
        chat: [{ seq: 2, player: 1, text: "hi" }],
        game: {
          mode: "Sprint",
          host: 1,
          scores: [[1, 100]],
          phase: {
            kind: "Drawing",
            drawer: 1,
            mask: "_____",
            deadline_ms: 60000,
            round_index: 0,
            total_rounds: 3,
          },
        },
        grid_size: 20,
      },
      seq: 3,
      lk_token: "fake.jwt.token",
    },
    {
      kind: "Stroke",
      seq: 4,
      player: 2,
      stroke_id: 1,
      origin: [50, 60],
      color: 0x2b6cb0,
      width: 8,
      points: [{ dx: -1, dy: 2, dt: 16, pressure: 180 }],
      finished: true,
    },
    { kind: "Chat", seq: 5, player: 2, text: "hello" },
    { kind: "Guess", seq: 6, player: 3, guess: "Correct" },
    {
      kind: "Presence",
      seq: 7,
      joined: [{ id: 4, name: "carol", avatar: DEFAULT_AVATAR, is_bot: false }],
      left: [2],
    },
    {
      kind: "Game",
      seq: 8,
      event: {
        kind: "RoundStart",
        drawer: 1,
        word_mask: "_____",
        duration_ms: 60000,
        round_index: 0,
        total_rounds: 5,
      },
    },
    { kind: "Ping", nonce: 1 },
    { kind: "Bye", reason: "RoomFull" },
    {
      kind: "WordOptions",
      words: ["cat", "dog", "tree"],
      deadline_ms: 15000,
    },
    { kind: "DrawerWord", word: "apple", duration_ms: 80000 },
    {
      kind: "Game",
      seq: 9,
      event: {
        kind: "WordPickStarted",
        drawer: 1,
        deadline_ms: 15000,
        round_index: 0,
        total_rounds: 5,
      },
    },
    {
      kind: "Game",
      seq: 10,
      event: { kind: "HintReveal", mask: "_a___" },
    },
    {
      kind: "Resume",
      events: [
        { kind: "Ping", nonce: 1 },
        { kind: "Chat", seq: 10, player: 1, text: "yo" },
      ],
    },
  ];

  for (const m of serverFixtures) {
    it(`ServerMsg ${m.kind} round-trip`, () => {
      const bytes = encodeServerMsg(m);
      expect(decodeServerMsg(bytes)).toEqual(m);
    });
  }
});
