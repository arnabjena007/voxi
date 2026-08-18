use crate::limits::ROOM_CODE_LEN;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type Seq = u64;
pub type PlayerId = u32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameMode {
    Sprint,
    Standard,
    Marathon,
}

impl GameMode {
    pub fn rounds(self) -> u8 {
        match self {
            GameMode::Sprint => 3,
            GameMode::Standard => 5,
            GameMode::Marathon => 7,
        }
    }

    pub fn word_options(self) -> u8 {
        match self {
            GameMode::Sprint => 7,
            GameMode::Standard => 5,
            GameMode::Marathon => 3,
        }
    }
}

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RoomCodeError {
    #[error("expected {ROOM_CODE_LEN} characters, got {0}")]
    WrongLength(usize),
    #[error("character '{0}' is not in the room-code alphabet")]
    InvalidChar(char),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoomCode([u8; ROOM_CODE_LEN]);

impl RoomCode {
    pub fn from_bytes(b: [u8; ROOM_CODE_LEN]) -> Result<Self, RoomCodeError> {
        for &c in &b {
            if !ALPHABET.contains(&c) {
                return Err(RoomCodeError::InvalidChar(c as char));
            }
        }
        Ok(Self(b))
    }

    pub fn parse(s: &str) -> Result<Self, RoomCodeError> {
        let bytes = s.as_bytes();
        if bytes.len() != ROOM_CODE_LEN {
            return Err(RoomCodeError::WrongLength(bytes.len()));
        }
        let mut out = [0u8; ROOM_CODE_LEN];
        for (i, &c) in bytes.iter().enumerate() {
            let upper = c.to_ascii_uppercase();
            let canonical = match upper {
                b'I' | b'L' => b'1',
                b'O' => b'0',
                b'U' => b'V',
                other => other,
            };
            if !ALPHABET.contains(&canonical) {
                return Err(RoomCodeError::InvalidChar(c as char));
            }
            out[i] = canonical;
        }
        Ok(Self(out))
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("room code bytes are always ASCII alphabet")
    }

    pub fn as_bytes(&self) -> &[u8; ROOM_CODE_LEN] {
        &self.0
    }
}

impl fmt::Debug for RoomCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RoomCode({})", self.as_str())
    }
}

impl fmt::Display for RoomCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Point {
    pub dx: i8,
    pub dy: i8,
    pub dt: u8,
    pub pressure: u8,
}

/// Compact per-player avatar. Each field is an index into a client-side parts
/// table; the server treats them as opaque bytes. Ranges are validated in
/// `codec::validate_*` so a malicious client can't pin a renderer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Avatar {
    pub skin: u8,
    pub hat: u8,
    pub hair: u8,
    pub eyes: u8,
    pub mouth: u8,
    pub specs: u8,
    pub earrings: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Player {
    pub id: PlayerId,
    pub name: String,
    pub avatar: Avatar,
    /// True if this player is a server-side bot. Surfaced to clients so the
    /// UI can mark them and so we never assign one as host.
    #[serde(default)]
    pub is_bot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompletedStroke {
    pub player: PlayerId,
    pub stroke_id: u32,
    pub origin: (u16, u16),
    pub color: u32,
    pub width: u8,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoxelBlock {
    pub x: i8,
    pub y: u8,
    pub z: i8,
    pub color: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatLine {
    pub seq: Seq,
    pub player: PlayerId,
    pub text: String,
}

/// Phase-aware game snapshot, included in `RoomSnapshot` so a fresh `Welcome`
/// can rehydrate a client mid-game. Deadlines are relative milliseconds from
/// "now" on the server, so the client adds them to its local clock without
/// needing wall-clock sync.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GamePhaseSnapshot {
    Lobby {
        /// Milliseconds remaining before the room expires if no game is
        /// started. `None` means no expiry (e.g. after the host clicks Start
        /// in time, the lobby loses its timer; or in post-game rematch
        /// lobbies which aren't time-bound).
        #[serde(default)]
        deadline_ms: Option<u32>,
    },
    ChoosingWord {
        drawer: PlayerId,
        deadline_ms: u32,
        round_index: u8,
        total_rounds: u8,
    },
    Drawing {
        drawer: PlayerId,
        mask: String,
        deadline_ms: u32,
        round_index: u8,
        total_rounds: u8,
    },
    RoundEnd {
        word: String,
        deadline_ms: u32,
    },
    GameOver,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameSnapshot {
    pub mode: GameMode,
    pub host: Option<PlayerId>,
    pub scores: Vec<(PlayerId, u32)>,
    pub phase: GamePhaseSnapshot,
}

impl Default for GameSnapshot {
    fn default() -> Self {
        Self {
            mode: GameMode::Standard,
            host: None,
            scores: Vec::new(),
            phase: GamePhaseSnapshot::Lobby { deadline_ms: None },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoomSnapshot {
    pub players: Vec<Player>,
    pub completed: Vec<CompletedStroke>,
    #[serde(default)]
    pub voxels: Vec<VoxelBlock>,
    pub seq: Seq,
    pub chat: Vec<ChatLine>,
    pub game: GameSnapshot,
    #[serde(default = "default_grid_size")]
    pub grid_size: u8,
}

fn default_grid_size() -> u8 {
    20
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_code_parse_canonical() {
        let c = RoomCode::parse("abc234").unwrap();
        assert_eq!(c.as_str(), "ABC234");
    }

    #[test]
    fn room_code_substitutes_ambiguous() {
        assert_eq!(RoomCode::parse("ILOABC").unwrap().as_str(), "110ABC");
    }

    #[test]
    fn room_code_rejects_bad_chars() {
        assert!(matches!(
            RoomCode::parse("ABCDE!"),
            Err(RoomCodeError::InvalidChar(_))
        ));
    }

    #[test]
    fn room_code_rejects_bad_length() {
        assert!(matches!(
            RoomCode::parse("ABC"),
            Err(RoomCodeError::WrongLength(3))
        ));
    }
}
