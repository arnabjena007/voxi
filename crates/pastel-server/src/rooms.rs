use dashmap::DashMap;
use pastel_proto::RoomCode;
use pastel_room::{spawn_room_with_evictor, RoomHandle, WordLists};
use rand::Rng;
use std::sync::Arc;

// The canonical room-code alphabet (Crockford-ish, no I/L/O/U). Matches
// RoomCode::parse so a generated code round-trips unchanged.
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Clone)]
pub struct Rooms {
    inner: Arc<DashMap<RoomCode, RoomHandle>>,
    words: Arc<WordLists>,
}

impl Rooms {
    pub fn new(words: Arc<WordLists>) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            words,
        }
    }

    pub fn get_or_create(&self, code: RoomCode) -> RoomHandle {
        let words = self.words.clone();
        let map = self.inner.clone();
        self.inner
            .entry(code)
            .or_insert_with(|| {
                spawn_room_with_evictor(code, words, move || {
                    // Room signalled shutdown (lobby timeout or last human
                    // left). Drop the entry so the code is free for reuse.
                    map.remove(&code);
                })
            })
            .clone()
    }

    /// Mint a fresh, unused room code and spawn its room. Matchmaking needs
    /// this because (unlike the invite flow) there's no client-supplied code.
    pub fn create_unique(&self) -> (RoomCode, RoomHandle) {
        loop {
            let s: String = {
                let mut rng = rand::thread_rng();
                (0..6)
                    .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
                    .collect()
            };
            let Ok(code) = RoomCode::parse(&s) else {
                continue;
            };
            // 32^6 codes vs a handful of live rooms: collisions are vanishing.
            if self.inner.contains_key(&code) {
                continue;
            }
            let handle = self.get_or_create(code);
            return (code, handle);
        }
    }

    pub fn count(&self) -> usize {
        self.inner.len()
    }
}
