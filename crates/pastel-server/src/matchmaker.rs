//! Quick-match matchmaking.
//!
//! Players pick a table `size` (2/4/6) and how many of those seats should be
//! `bots`; the rest are human seats. Requests for the same `(size, bots)` combo
//! pool into one "forming" room so real humans play together, and the room is
//! armed to auto-start (no host click) once it actually holds `size` players.
//!
//! Crucially, empty human seats are NEVER filled with bots on a timer: a table
//! that wants humans just waits in the lobby until they arrive. If nobody else
//! is online the player simply sees the lobby ("waiting for players"), where
//! they can start early, add a bot, or hang on. A solo-vs-bots pick (all seats
//! but one are bots) is full the moment the player connects, so it starts right
//! away.

use crate::bot::{spawn_bot, BotDifficulty};
use crate::rooms::Rooms;
use pastel_proto::{GameMode, RoomCode};
use rand::Rng;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// All quick matches run Standard.
const QUICK_MATCH_MODE: GameMode = GameMode::Standard;
/// How long a partially-filled table keeps accepting new humans into the same
/// room before the next request opens a fresh one.
const TABLE_TTL: Duration = Duration::from_secs(90);

struct Forming {
    code: RoomCode,
    /// Humans wanted before the table is full (= size - bots).
    human_seats: u8,
    /// Humans who have claimed a seat so far.
    humans_joined: u8,
    /// After this, the table stops taking new humans (stale / likely gone).
    expires: Instant,
}

#[derive(Clone)]
pub struct Matchmaker {
    rooms: Rooms,
    /// Open tables keyed by (size, bots). At most one forming table per combo.
    forming: Arc<Mutex<HashMap<(u8, u8), Forming>>>,
}

impl Matchmaker {
    pub fn new(rooms: Rooms) -> Self {
        Self {
            rooms,
            forming: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Seat a human into a matched room and return its code. `size` is assumed
    /// valid (2/4/6) and `bots` in 0..size; the caller validates.
    pub fn match_request(&self, size: u8, bots: u8) -> RoomCode {
        let key = (size, bots);
        let human_seats = size.saturating_sub(bots).max(1);
        let now = Instant::now();

        let mut map = self.forming.lock().unwrap();

        // Join an existing, still-fresh table for this exact combo.
        if let Some(f) = map.get_mut(&key) {
            if f.expires > now && f.humans_joined < f.human_seats {
                f.humans_joined += 1;
                let code = f.code;
                if f.humans_joined >= f.human_seats {
                    map.remove(&key); // table's human seats are all claimed
                }
                return code;
            }
            // Stale or full: fall through and open a fresh table.
        }

        // Open a new table: mint a room, drop the chosen bots in, and arm it to
        // start once it holds `size` players. Bots are the only ones added up
        // front; human seats stay open, waiting for people.
        let (code, handle) = self.rooms.create_unique();
        for _ in 0..bots {
            spawn_bot(handle.clone(), code, random_difficulty());
        }
        let size_usize = size as usize;
        tokio::spawn(async move {
            handle.arm_auto_start(QUICK_MATCH_MODE, size_usize).await;
        });

        if human_seats <= 1 {
            // This lone human fills every human seat -> no pooling needed.
            map.remove(&key);
            return code;
        }
        map.insert(
            key,
            Forming {
                code,
                human_seats,
                humans_joined: 1,
                expires: now + TABLE_TTL,
            },
        );
        code
    }
}

fn random_difficulty() -> BotDifficulty {
    match rand::thread_rng().gen_range(0..3) {
        0 => BotDifficulty::Easy,
        1 => BotDifficulty::Hard,
        _ => BotDifficulty::Medium,
    }
}
