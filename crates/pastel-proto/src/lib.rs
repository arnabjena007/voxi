//! pastel wire protocol. Stable across versions until v1.0.
//!
//! Binary-encoded with `postcard`. One enum per direction (`ClientMsg`,
//! `ServerMsg`) multiplexes every message type on a single WebSocket.

pub mod codec;
pub mod limits;
pub mod msg;
pub mod types;

pub use codec::{
    decode, decode_client_validated, decode_server_validated, encode, validate_client,
    validate_server, CodecError,
};
pub use limits::*;
pub use msg::{
    ByeReason, ClientMsg, DrawingMood, GameAction, GameEvent, GuessKind, Hello, ServerMsg,
    VoteWinner,
};
pub use types::{
    Avatar, ChatLine, CompletedStroke, GameMode, GamePhaseSnapshot, GameSnapshot, Player, PlayerId,
    Point, RoomCode, RoomCodeError, RoomSnapshot, Seq,
};
