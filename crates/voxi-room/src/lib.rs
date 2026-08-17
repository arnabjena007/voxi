//! Per-room actor task.
//!
//! One [`Room`] owns its state and is the only writer to it. Connection tasks
//! talk to it via [`RoomCmd`] over an `mpsc` inbox and receive [`ServerMsg`]s
//! via a `broadcast` channel (room-wide) plus a per-player `mpsc` (unicast,
//! e.g. for Welcome and Resume).

mod bucket;
pub mod game;
mod room;
pub mod words;

pub use room::{
    spawn_room, spawn_room_with_evictor, ApprovalResult, JoinError, JoinOutcome, JoinResult,
    RoomCmd, RoomHandle,
};
pub use words::{Difficulty, SharedWords, WordLists};

pub const BROADCAST_CAPACITY: usize = 1024;
pub const UNICAST_CAPACITY: usize = 64;
pub const COMMAND_INBOX_CAPACITY: usize = 256;
pub const COMPLETED_STROKES_RING: usize = 256;
pub const CHAT_RING: usize = 50;
pub use voxi_proto::MAX_PLAYERS_PER_ROOM;
