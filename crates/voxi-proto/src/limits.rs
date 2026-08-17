//! Wire-level size caps. Enforced by `decode_validated` and by senders.

pub const ROOM_CODE_LEN: usize = 6;
pub const MAX_PLAYERS_PER_ROOM: usize = 10;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_CHAT_LEN: usize = 256;
pub const MAX_CLIENT_TOKEN_LEN: usize = 64;
pub const MAX_GUESS_LEN: usize = 64;
pub const MAX_WORD_LEN: usize = 64;

pub const MAX_POINTS_PER_BATCH: usize = 64;
pub const MAX_STROKES_PER_SNAPSHOT: usize = 1024;
pub const MAX_CHAT_HISTORY: usize = 64;
pub const MAX_WORD_OPTIONS: usize = 8;
pub const MAX_RESUME_EVENTS: usize = 1024;
pub const MAX_LK_TOKEN_LEN: usize = 1024;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// Per-field upper bounds on `Avatar` part IDs. These match the part counts in
/// the frontend's parts table; the codec rejects out-of-range bytes so a
/// hostile client can't crash the renderer with an unknown index.
pub const AVATAR_MAX_SKIN: u8 = 6;
pub const AVATAR_MAX_HAT: u8 = 5;
pub const AVATAR_MAX_HAIR: u8 = 7;
pub const AVATAR_MAX_EYES: u8 = 7;
pub const AVATAR_MAX_MOUTH: u8 = 6;
pub const AVATAR_MAX_SPECS: u8 = 4;
pub const AVATAR_MAX_EARRINGS: u8 = 4;
