use crate::types::{Avatar, GameMode, Player, PlayerId, Point, RoomCode, RoomSnapshot, Seq};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub room: RoomCode,
    pub name: String,
    pub resume_from: Option<Seq>,
    /// Persistent per-browser token. Used to recognise a previously-kicked
    /// player coming back, so the server can gate them behind host approval
    /// instead of admitting them silently. Optional for backwards-compat.
    pub client_token: Option<String>,
    pub avatar: Avatar,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameAction {
    Start {
        mode: GameMode,
    },
    PickWord(u8),
    Kick(PlayerId),
    Clear,
    /// Host approves a pending join request.
    ApproveJoin(PlayerId),
    /// Host rejects a pending join request.
    RejectJoin(PlayerId),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameEvent {
    RoundStart {
        drawer: PlayerId,
        word_mask: String,
        duration_ms: u32,
        round_index: u8,
        total_rounds: u8,
    },
    RoundEnd {
        word: String,
        scores: Vec<(PlayerId, u32)>,
    },
    GameOver {
        final_scores: Vec<(PlayerId, u32)>,
    },
    Cleared {
        by: PlayerId,
    },
    WordPickStarted {
        drawer: PlayerId,
        deadline_ms: u32,
        round_index: u8,
        total_rounds: u8,
    },
    HintReveal {
        mask: String,
    },
    /// A previously-kicked player wants back in. Only the host can approve.
    JoinRequest {
        candidate: PlayerId,
        name: String,
    },
    /// A pending candidate gave up (closed the tab) before the host responded.
    JoinCanceled {
        candidate: PlayerId,
    },
    /// The previous host left; this player is now the host. Receivers should
    /// update local `game.host` and re-render host-only affordances.
    HostChanged {
        new_host: PlayerId,
    },
    /// A guesser registered (or changed) their reaction to the drawing.
    /// Broadcast so every client can roll a soft system line into chat.
    /// Only emitted when the player's mood actually changes.
    Reaction {
        player: PlayerId,
        mood: DrawingMood,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GuessKind {
    Correct,
    Close,
    /// Unicast to a player whose chat tried to leak the secret word (drawer
    /// or a player who already guessed correctly). The original message is
    /// dropped; the sender sees a "don't spoil it" nudge instead.
    Spoiler,
}

/// What a guesser thinks of the drawing in progress. Aggregated server-side
/// and surfaced back to the drawer when one mood crosses a threshold.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DrawingMood {
    /// "Looking good" — guesser is enjoying / getting the drawing.
    Loved,
    /// "I'm lost" — guesser can't figure out what's being drawn.
    Confused,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ByeReason {
    Reconnect,
    Kicked,
    RoomClosed,
    RoomFull,
    BadFrame,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ClientMsg {
    Hello(Hello),
    Stroke {
        stroke_id: u32,
        origin: (u16, u16),
        color: u32,
        width: u8,
        points: Vec<Point>,
        finished: bool,
    },
    Chat {
        text: String,
    },
    Guess {
        text: String,
    },
    Game(GameAction),
    Pong {
        nonce: u32,
    },
    /// Guesser reacting to the in-progress drawing. Server aggregates these
    /// per round and unicasts a `DrawingFeedback` to the drawer once one
    /// reaction type crosses the threshold.
    React {
        mood: DrawingMood,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ServerMsg {
    Welcome {
        you: PlayerId,
        snapshot: RoomSnapshot,
        seq: Seq,
        lk_token: String,
    },
    Resume {
        events: Vec<ServerMsg>,
    },
    Stroke {
        seq: Seq,
        player: PlayerId,
        stroke_id: u32,
        origin: (u16, u16),
        color: u32,
        width: u8,
        points: Vec<Point>,
        finished: bool,
    },
    Chat {
        seq: Seq,
        player: PlayerId,
        text: String,
    },
    Guess {
        seq: Seq,
        player: PlayerId,
        kind: GuessKind,
    },
    Presence {
        seq: Seq,
        joined: Vec<Player>,
        left: Vec<PlayerId>,
    },
    Game {
        seq: Seq,
        event: GameEvent,
    },
    Ping {
        nonce: u32,
    },
    Bye {
        reason: ByeReason,
    },
    /// Unicast to the drawer at round-pick time with the words to choose from.
    WordOptions {
        words: Vec<String>,
        deadline_ms: u32,
    },
    /// Unicast to the drawer once a word has been picked, so their UI can
    /// show the full word while everyone else only sees the mask.
    DrawerWord {
        word: String,
        duration_ms: u32,
    },
    /// Unicast to a candidate whose join is waiting on host approval.
    JoinPending,
    /// Unicast to the drawer mid-round when guesser reactions cross a
    /// threshold. The drawer's UI shows a soft "they love it" or "they're
    /// lost" banner. Re-sent only when the dominant mood changes.
    DrawingFeedback {
        mood: DrawingMood,
    },
}
