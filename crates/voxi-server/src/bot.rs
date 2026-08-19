use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use rand::Rng;
use serde::Deserialize;
use std::time::Duration;
use voxi_proto::*;
use voxi_room::{JoinOutcome, RoomHandle};

#[derive(Debug, Clone, Copy)]
pub enum BotDifficulty {
    Easy,
    Medium,
    Hard,
}

impl BotDifficulty {
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "easy" => Self::Easy,
            "hard" => Self::Hard,
            _ => Self::Medium,
        }
    }
    /// Initial wait before the FIRST guess of a round. Slow on purpose so
    /// the bot lets some letters reveal before throwing darts.
    fn initial_wait_secs(&self) -> (f64, f64) {
        match self {
            Self::Easy => (35.0, 55.0),
            Self::Medium => (25.0, 40.0),
            Self::Hard => (15.0, 25.0),
        }
    }

    /// Pause between guesses before any hint has fired. Slow.
    fn pre_hint_pause_ms(&self) -> (u64, u64) {
        match self {
            Self::Easy => (8000, 14000),
            Self::Medium => (5000, 9000),
            Self::Hard => (3000, 6000),
        }
    }

    /// Pause between guesses AFTER at least one hint has fired. Fast,
    /// because the candidate pool shrinks dramatically.
    fn post_hint_pause_ms(&self) -> (u64, u64) {
        match self {
            Self::Easy => (3000, 5000),
            Self::Medium => (1500, 3000),
            Self::Hard => (600, 1500),
        }
    }
    fn label(&self) -> &'static str {
        match self {
            Self::Easy => "chill",
            Self::Medium => "normal",
            Self::Hard => "sweaty",
        }
    }
}

#[derive(Deserialize)]
pub struct BotQuery {
    #[serde(default)]
    difficulty: Option<String>,
}

static BOT_NAMES: &[&str] = &[
    "lil crayon",
    "soft pencil",
    "chalky",
    "lil voxi",
    "smudge",
    "doodlebug",
    "inkbean",
    "brushie",
    "sketchy",
    "pigment",
    "blotch",
    "scribbles",
    "tintsy",
    "hue",
    "palette",
    "swatch",
    "noodle",
    "stipple",
    "gouache",
    "speckle",
    "mochi",
    "pebble",
    "canvas",
    "fuzzy",
    "ribbon",
    "linty",
    "pip",
    "bristly",
];

static GREETINGS: &[&str] = &[
    "hey everyone!",
    "hiiii",
    "ready to play!",
    "lets gooo",
    "hello hello",
    "sup",
    "yo",
    "hey what's up",
    "ready when you are",
    "ohhh new game",
];

static REACT_CORRECT: &[&str] = &[
    "nice one!",
    "gg",
    "wow fast",
    "how??",
    "big brain",
    "too easy",
    "okayyy",
    "i was just about to guess that",
    "lucky",
    "show off",
    "noted",
];

static REACT_ROUND_END: &[&str] = &[
    "ohhh",
    "i see it now",
    "that was tough",
    "should have got that",
    "lol",
    "interesting",
    "i was thinking the same",
    "nooo i had it",
    "good one",
    "haha",
    "wait what",
];

static REACT_MY_TURN: &[&str] = &[
    "my turn!",
    "ok here goes",
    "watch this",
    "i got this",
    "easy one",
    "hmm let me think",
    "this is fine",
    "do not laugh",
    "art incoming",
    "give me a sec",
];

// First hint just dropped and we're still guessing. Quick "ohh" beat.
static REACT_HINT: &[&str] = &[
    "ohh",
    "ahh",
    "wait...",
    "now i see",
    "oh okay",
    "yeah maybe",
    "interesting",
    "hmm",
];

// Bot itself just guessed correctly. Self-congratulatory.
static SELF_CORRECT: &[&str] = &[
    "yesss",
    "got it",
    "haha",
    "called it",
    "knew it",
    "easy",
    "finally",
];

// Bot got a close guess. The server unicasts Close to the guesser only.
static SELF_CLOSE: &[&str] = &[
    "so close",
    "off by one ugh",
    "almost!",
    "darn",
    "i'm right there",
];

// Mid-round banter while still trying to guess. Used at most once per round.
static GUESSING_BANTER: &[&str] = &[
    "hmm",
    "is that a...",
    "wait wait",
    "no clue tbh",
    "lemme think",
    "i swear i know this",
    "could be anything",
    "uhhh",
];

// Drawer talking mid-round while bot is drawing. Used at most once per round.
static DRAWING_BANTER: &[&str] = &[
    "this is harder than it looks",
    "okay almost there",
    "bear with me",
    "trust the process",
    "art is hard",
    "guess faster",
];

fn random_from(list: &[&str]) -> String {
    list[rand::thread_rng().gen_range(0..list.len())].to_string()
}

async fn bot_chat(room: &RoomHandle, my_id: PlayerId, text: String) {
    let delay = rand::thread_rng().gen_range(300..1200);
    tokio::time::sleep(Duration::from_millis(delay)).await;
    room.send(my_id, ClientMsg::Chat { text }).await;
}

/// Spawn one bot into an existing room. Returns the bot's display name. Shared
/// by the lobby "+ bot" endpoint and by matchmaking's seat backfill.
pub fn spawn_bot(handle: RoomHandle, code: RoomCode, diff: BotDifficulty) -> String {
    let name = BOT_NAMES[rand::thread_rng().gen_range(0..BOT_NAMES.len())].to_string();
    let spawn_name = name.clone();
    tokio::spawn(async move {
        if let Err(e) = run_bot(handle, code, spawn_name, diff).await {
            tracing::debug!("bot exited: {e}");
        }
    });
    name
}

pub async fn add_bot(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<BotQuery>,
) -> impl IntoResponse {
    let room_code = match RoomCode::parse(&code) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("bad room code: {e}"));
        }
    };
    let diff = BotDifficulty::from_str(query.difficulty.as_deref().unwrap_or("medium"));
    let handle = state.rooms.get_or_create(room_code);
    let name = spawn_bot(handle, room_code, diff);
    (StatusCode::OK, format!("{name} joined ({})", diff.label()))
}

fn load_all_game_words() -> Vec<String> {
    let easy = include_str!("../data/words-easy.txt");
    let medium = include_str!("../data/words-medium.txt");
    let hard = include_str!("../data/words-hard.txt");
    let bot = include_str!("../data/words-bot.txt");
    let mut words: Vec<String> = easy
        .lines()
        .chain(medium.lines())
        .chain(hard.lines())
        .chain(bot.lines())
        .filter(|l| !l.is_empty())
        .map(|l| l.trim().to_string())
        .collect();
    words.sort();
    words.dedup();
    words
}

async fn run_bot(
    room: RoomHandle,
    code: RoomCode,
    name: String,
    diff: BotDifficulty,
) -> anyhow::Result<()> {
    let all_words = load_all_game_words();

    let hello = Hello {
        room: code,
        name,
        resume_from: None,
        client_token: None,
        avatar: Avatar {
            skin: rand::thread_rng().gen_range(0..=6),
            hat: 0,
            hair: rand::thread_rng().gen_range(0..=7),
            eyes: rand::thread_rng().gen_range(0..=7),
            mouth: rand::thread_rng().gen_range(0..=6),
            specs: 0,
            earrings: 0,
        },
    };

    let outcome = room.join_as_bot(hello).await?;
    let join = match outcome {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => anyhow::bail!("bot got pending"),
    };

    let my_id = join.you;
    let mut broadcast_rx = join.broadcast_rx;
    let mut unicast_rx = join.unicast_rx;

    let mut is_drawer = false;
    let mut guess_candidates: Vec<String> = Vec::new();
    let mut guess_index: usize = 0;
    let mut guess_sent = false;
    let mut next_guess_at: Option<tokio::time::Instant> = None;
    let mut hints_revealed: u32 = 0;
    // At most one mid-round banter line per round to keep chat from spamming
    // when several bots are in the same room.
    let mut banter_used = false;
    // Drop a guessing banter once we've tried `banter_after` attempts.
    let banter_after: usize = rand::thread_rng().gen_range(4..9);

    // Drain welcome, then greet
    let _ = unicast_rx.recv().await;
    bot_chat(&room, my_id, random_from(GREETINGS)).await;

    loop {
        tokio::select! {
            biased;

            uc = unicast_rx.recv() => {
                let Some(msg) = uc else { break };
                match msg.as_ref() {
                    ServerMsg::WordOptions { .. } => {
                        room.send(my_id, ClientMsg::Game(GameAction::PickWord(0))).await;
                    }
                    ServerMsg::DrawerWord { word, .. } => {
                        is_drawer = true;

                        bot_chat(&room, my_id, random_from(REACT_MY_TURN)).await;
                        // Schedule one banter line a few seconds into the
                        // drawing so the bot feels chatty while sketching.
                        // Cloned RoomHandle is cheap (mpsc Sender clone).
                        if !banter_used && rand::thread_rng().gen_bool(0.55) {
                            banter_used = true;
                            let room_c = room.clone();
                            let line = random_from(DRAWING_BANTER);
                            // ThreadRng is !Send: pre-roll the delay here
                            // and move the Duration into the spawned task.
                            let delay_ms = rand::thread_rng().gen_range(4000..10_000);
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                room_c.send(my_id, ClientMsg::Chat { text: line }).await;
                            });
                        }
                        let strokes = built_in_sketch(word);
                        replay_drawing(&room, my_id, &strokes).await;
                    }
                    ServerMsg::Guess { player, kind: GuessKind::Close, .. }
                        if *player == my_id && rand::thread_rng().gen_bool(0.7) =>
                    {
                        bot_chat(&room, my_id, random_from(SELF_CLOSE)).await;
                    }
                    ServerMsg::Bye { .. } => break,
                    _ => {}
                }
            }

            bc = broadcast_rx.recv() => {
                let Ok(msg) = bc else { break };
                match msg.as_ref() {
                    ServerMsg::Game { event: GameEvent::RoundStart { drawer, word_mask, .. }, .. } => {
                        is_drawer = *drawer == my_id;
                        guess_sent = false;
                        guess_index = 0;
                        guess_candidates.clear();
                        next_guess_at = None;
                        hints_revealed = 0;
                        // Fresh round, fresh banter budget.
                        banter_used = false;
                        if !is_drawer {
                            let mask_len = word_mask.chars().filter(|c| *c != ' ').count();
                            let mut candidates: Vec<String> = all_words.iter()
                                .filter(|w| w.len() == mask_len || w.chars().count() == mask_len)
                                .cloned()
                                .collect();
                            use rand::seq::SliceRandom;
                            candidates.shuffle(&mut rand::thread_rng());
                            guess_candidates = candidates;
                            let (lo, hi) = diff.initial_wait_secs();
                            let first_wait = rand::thread_rng().gen_range(lo..hi);
                            next_guess_at = Some(tokio::time::Instant::now() + Duration::from_secs_f64(first_wait));
                        }
                    }
                    ServerMsg::Guess { player, kind: GuessKind::Correct, .. } if *player == my_id => {
                        guess_sent = true;
                        next_guess_at = None;
                        if rand::thread_rng().gen_bool(0.7) {
                            bot_chat(&room, my_id, random_from(SELF_CORRECT)).await;
                        }
                    }
                    ServerMsg::Game { event: GameEvent::HintReveal { mask }, .. } => {
                        // Brief "ohh" before the candidate-pool filter runs.
                        if !is_drawer && !guess_sent && rand::thread_rng().gen_bool(0.45) {
                            bot_chat(&room, my_id, random_from(REACT_HINT)).await;
                        }
                        if !is_drawer && !guess_sent {
                            let mask_chars: Vec<char> = mask.chars().collect();
                            guess_candidates.retain(|w| {
                                let wc: Vec<char> = w.chars().collect();
                                if wc.len() != mask_chars.len() { return false; }
                                for (mc, wch) in mask_chars.iter().zip(wc.iter()) {
                                    if *mc != '_' && *mc != ' ' && mc.to_lowercase().next() != wch.to_lowercase().next() {
                                        return false;
                                    }
                                }
                                true
                            });
                            // Reset index since the pool just shrank.
                            guess_index = 0;
                            hints_revealed += 1;
                            // Speed up: schedule a fresh guess soon.
                            let (lo, hi) = diff.post_hint_pause_ms();
                            let delay = rand::thread_rng().gen_range(lo..hi);
                            next_guess_at = Some(tokio::time::Instant::now() + Duration::from_millis(delay));
                        }
                    }
                    ServerMsg::Game { event: GameEvent::WordPickStarted { drawer, .. }, .. } => {
                        is_drawer = *drawer == my_id;
                        guess_candidates.clear();
                        guess_index = 0;
                        guess_sent = false;
                        next_guess_at = None;
                    }
                    ServerMsg::Game { event: GameEvent::RoundEnd { .. }, .. } => {
                        is_drawer = false;
                        guess_candidates.clear();
                        guess_index = 0;
                        guess_sent = false;
                        next_guess_at = None;
                        if rand::thread_rng().gen_bool(0.5) {
                            bot_chat(&room, my_id, random_from(REACT_ROUND_END)).await;
                        }
                    }
                    ServerMsg::Guess { player, kind: GuessKind::Correct, .. }
                        if *player != my_id && rand::thread_rng().gen_bool(0.4) =>
                    {
                        bot_chat(&room, my_id, random_from(REACT_CORRECT)).await;
                    }
                    ServerMsg::Game { event: GameEvent::GameOver { .. }, .. } => {
                        // Stay in the room for rematch
                    }
                    _ => {}
                }
            }

            // Guessing: one candidate per tick, wait for result before next
            _ = async {
                match next_guess_at {
                    Some(t) if !is_drawer && !guess_sent && guess_index < guess_candidates.len() => {
                        tokio::time::sleep_until(t).await;
                    }
                    _ => std::future::pending::<()>().await,
                }
            } => {
                if guess_index < guess_candidates.len() {
                    let guess = guess_candidates[guess_index].clone();
                    guess_index += 1;
                    room.send(my_id, ClientMsg::Guess { text: guess }).await;
                    // After a handful of failed attempts, drop one mid-round
                    // banter line so the bot reads as "thinking", not silent.
                    if !banter_used && guess_index >= banter_after {
                        banter_used = true;
                        let room_c = room.clone();
                        let line = random_from(GUESSING_BANTER);
                        // ThreadRng is !Send, so roll the delay here and move
                        // only the resulting Duration into the spawned task.
                        let delay_ms = rand::thread_rng().gen_range(300..900);
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            room_c.send(my_id, ClientMsg::Chat { text: line }).await;
                        });
                    }
                    // Slow when no hints have fired, fast after hints arrive
                    // (candidate pool is much smaller post-hint).
                    let (lo, hi) = if hints_revealed == 0 {
                        diff.pre_hint_pause_ms()
                    } else {
                        diff.post_hint_pause_ms()
                    };
                    let delay = rand::thread_rng().gen_range(lo..hi);
                    next_guess_at = Some(
                        tokio::time::Instant::now() + Duration::from_millis(delay),
                    );
                } else {
                    // Exhausted all candidates, stop
                    guess_sent = true;
                    next_guess_at = None;
                }
            }
        }
    }

    room.leave(my_id).await;
    Ok(())
}

fn built_in_sketch(word: &str) -> Vec<Vec<(u8, u8)>> {
    let seed = word.bytes().fold(0u8, |acc, byte| acc.wrapping_add(byte));
    match seed % 4 {
        0 => vec![
            vec![(70, 170), (128, 90), (186, 170), (70, 170)],
            vec![(92, 170), (92, 210), (164, 210), (164, 170)],
            vec![(120, 210), (120, 185), (140, 185), (140, 210)],
        ],
        1 => vec![
            vec![(128, 60), (128, 190)],
            vec![(128, 92), (86, 132), (128, 124), (170, 132), (128, 92)],
            vec![(128, 136), (76, 178), (128, 166), (180, 178), (128, 136)],
            vec![(128, 188), (98, 220), (158, 220), (128, 188)],
        ],
        2 => vec![
            vec![(70, 150), (92, 110), (130, 92), (170, 108), (192, 150)],
            vec![(74, 150), (192, 150), (178, 195), (88, 195), (74, 150)],
            vec![(96, 155), (112, 170), (130, 155), (148, 170), (166, 155)],
        ],
        _ => vec![
            vec![
                (88, 86),
                (168, 86),
                (188, 166),
                (128, 218),
                (68, 166),
                (88, 86),
            ],
            vec![(92, 128), (164, 128)],
            vec![(104, 166), (152, 166)],
        ],
    }
}

async fn replay_drawing(room: &RoomHandle, my_id: PlayerId, strokes: &[Vec<(u8, u8)>]) {
    let pad_x = 80.0_f32;
    let pad_y = 50.0_f32;
    let usable_w = 960.0 - pad_x * 2.0;
    let usable_h = 600.0 - pad_y * 2.0;

    let scale = |rx: u8, ry: u8| -> (i32, i32) {
        (
            (pad_x + (rx as f32 / 255.0) * usable_w).round() as i32,
            (pad_y + (ry as f32 / 255.0) * usable_h).round() as i32,
        )
    };

    for (sid, stroke) in strokes.iter().enumerate() {
        if stroke.is_empty() {
            continue;
        }

        let (ox, oy) = scale(stroke[0].0, stroke[0].1);
        let origin_x = ox.clamp(0, 960) as u16;
        let origin_y = oy.clamp(0, 600) as u16;

        let mut points: Vec<Point> = Vec::new();
        let mut cur_x = ox;
        let mut cur_y = oy;

        for &(rx, ry) in &stroke[1..] {
            let (tx, ty) = scale(rx, ry);
            let mut rem_x = tx - cur_x;
            let mut rem_y = ty - cur_y;

            while rem_x != 0 || rem_y != 0 {
                let dx = rem_x.clamp(-120, 120) as i8;
                let dy = rem_y.clamp(-120, 120) as i8;
                points.push(Point {
                    dx,
                    dy,
                    dt: 16,
                    pressure: 200,
                });
                cur_x += dx as i32;
                cur_y += dy as i32;
                rem_x = tx - cur_x;
                rem_y = ty - cur_y;
            }

            if points.len() >= 50 {
                let msg = ClientMsg::Stroke {
                    stroke_id: sid as u32,
                    origin: (origin_x, origin_y),
                    color: 0x2a2a2e,
                    width: 3,
                    points: std::mem::take(&mut points),
                    finished: false,
                };
                room.send(my_id, msg).await;
                let batch_pause = rand::thread_rng().gen_range(60..150);
                tokio::time::sleep(Duration::from_millis(batch_pause)).await;
            }
        }

        let msg = ClientMsg::Stroke {
            stroke_id: sid as u32,
            origin: (origin_x, origin_y),
            color: 0x2a2a2e,
            width: 3,
            points,
            finished: true,
        };
        room.send(my_id, msg).await;
        let stroke_pause = rand::thread_rng().gen_range(300..700);
        tokio::time::sleep(Duration::from_millis(stroke_pause)).await;
    }
}
