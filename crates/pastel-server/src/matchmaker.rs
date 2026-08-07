//! Quick-match matchmaking.
//!
//! Players pick a table `size` (2/4/6) and how many of those seats should be
//! `bots`; the rest are human seats. Requests for the same `(size, bots)` combo
//! pool into one "forming" room for a short window so real humans play
//! together, and any human seats left unclaimed when the window closes are
//! filled with bots. The matched room auto-starts (no host click) once its
//! table is ready. At low traffic this means: you almost always play instantly
//! against your chosen bots; as traffic grows, humans slot into the same combos.

use crate::bot::{spawn_bot, BotDifficulty};
use crate::rooms::Rooms;
use pastel_proto::{GameMode, RoomCode};
use pastel_room::RoomHandle;
use rand::Rng;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// All quick matches run Standard.
const QUICK_MATCH_MODE: GameMode = GameMode::Standard;
/// How long a table stays open to gather more humans before it fills with bots
/// and starts.
const FILL_WINDOW: Duration = Duration::from_secs(6);
/// A shorter grace for tables whose human seats are already all claimed, just
/// enough for those players to finish connecting before the game starts.
const CONNECT_GRACE: Duration = Duration::from_secs(3);

struct Forming {
    code: RoomCode,
    handle: RoomHandle,
    /// Humans wanted before the table is considered full (= size - bots).
    human_seats: u8,
    /// Humans who have claimed a seat in this table so far.
    humans_joined: u8,
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

        let mut map = self.forming.lock().unwrap();

        // Join an already-open table for this exact combo.
        if map.contains_key(&key) {
            let (code, full, handle) = {
                let f = map.get_mut(&key).unwrap();
                f.humans_joined += 1;
                let full = f.humans_joined >= f.human_seats;
                (
                    f.code,
                    full,
                    if full { Some(f.handle.clone()) } else { None },
                )
            };
            if full {
                map.remove(&key);
            }
            drop(map);
            if let Some(h) = handle {
                start_after(h, CONNECT_GRACE);
            }
            return code;
        }

        // No open table: mint one, drop the chosen bots in.
        let (code, handle) = self.rooms.create_unique();
        for _ in 0..bots {
            spawn_bot(handle.clone(), code, random_difficulty());
        }

        if human_seats <= 1 {
            // This lone human fills every human seat -> just needs to connect.
            drop(map);
            start_after(handle, CONNECT_GRACE);
            return code;
        }

        map.insert(
            key,
            Forming {
                code,
                handle: handle.clone(),
                human_seats,
                humans_joined: 1,
            },
        );
        drop(map);
        self.arm_fill_timer(key, code, handle);
        code
    }

    /// After the fill window, if this table is still open, backfill its unclaimed
    /// human seats with bots and start it.
    fn arm_fill_timer(&self, key: (u8, u8), code: RoomCode, handle: RoomHandle) {
        let forming = self.forming.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FILL_WINDOW).await;
            let backfill = {
                let mut map = forming.lock().unwrap();
                match map.get(&key) {
                    // Still the same open table -> claim it and fill it.
                    Some(f) if f.code == code => {
                        let n = f.human_seats.saturating_sub(f.humans_joined);
                        map.remove(&key);
                        n
                    }
                    // Filled early (started already) or replaced by a newer
                    // table for this combo -> nothing to do.
                    _ => return,
                }
            };
            for _ in 0..backfill {
                spawn_bot(handle.clone(), code, random_difficulty());
            }
            handle.auto_start(QUICK_MATCH_MODE).await;
        });
    }
}

/// Kick the room off after a short delay (so joiners finish connecting).
fn start_after(handle: RoomHandle, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        handle.auto_start(QUICK_MATCH_MODE).await;
    });
}

fn random_difficulty() -> BotDifficulty {
    match rand::thread_rng().gen_range(0..3) {
        0 => BotDifficulty::Easy,
        1 => BotDifficulty::Hard,
        _ => BotDifficulty::Medium,
    }
}
