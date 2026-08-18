//! voxi-bot: a single AI player that joins a room and plays the game.
//! It draws using Quick Draw stroke data and guesses with a human-like
//! delay strategy. Run alongside a real player for testing.
//!
//! Usage: cargo run -p voxi-loadtest --bin voxi-bot -- --room ABCDEF

use anyhow::Result;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::Message;
use voxi_proto::*;

#[derive(Parser)]
#[command(about = "A bot player for voxi rooms.")]
struct Args {
    #[arg(long, default_value = "ws://127.0.0.1:7070")]
    addr: String,
    #[arg(long)]
    room: String,
    #[arg(long, default_value = "VoxiBot")]
    name: String,
}

struct Drawing {
    strokes: Vec<Vec<(u8, u8)>>,
}

fn load_drawings() -> HashMap<String, Drawing> {
    let data = include_bytes!("../data/drawings.bin");
    let mut pos = 0usize;
    let count = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    let mut map = HashMap::new();
    for _ in 0..count {
        let wlen = data[pos] as usize;
        pos += 1;
        let word = String::from_utf8_lossy(&data[pos..pos + wlen]).to_string();
        pos += wlen;
        let stroke_count = data[pos] as usize;
        pos += 1;
        let mut strokes = Vec::with_capacity(stroke_count);
        for _ in 0..stroke_count {
            let pt_count = u16::from_le_bytes(data[pos..pos + 2].try_into().unwrap()) as usize;
            pos += 2;
            let mut pts = Vec::with_capacity(pt_count);
            for _ in 0..pt_count {
                pts.push((data[pos], data[pos + 1]));
                pos += 2;
            }
            strokes.push(pts);
        }
        map.insert(word, Drawing { strokes });
    }
    map
}

#[derive(Clone, Copy)]
enum GuessProfile {
    Sharp,
    Average,
    Slow,
    Clueless,
}

fn pick_profile() -> GuessProfile {
    let r: f32 = rand::thread_rng().gen();
    if r < 0.30 {
        GuessProfile::Sharp
    } else if r < 0.70 {
        GuessProfile::Average
    } else if r < 0.90 {
        GuessProfile::Slow
    } else {
        GuessProfile::Clueless
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let drawings = load_drawings();
    println!(
        "loaded {} drawings, connecting to room {}",
        drawings.len(),
        args.room
    );

    let url = format!("{}/ws/{}", args.addr, args.room);
    let (ws, _) = tokio_tungstenite::connect_async(&url).await?;
    let (mut sink, mut stream) = ws.split();

    let hello = ClientMsg::Hello(Hello {
        room: RoomCode::parse(&args.room)?,
        name: args.name.clone(),
        resume_from: None,
        client_token: None,
        avatar: Avatar::default(),
    });
    sink.send(Message::Binary(encode(&hello)?)).await?;

    let mut my_id: PlayerId = 0;
    let mut current_word: Option<String> = None;
    let mut is_drawer = false;
    let mut round_deadline: Option<Instant> = None;
    let mut guess_sent = false;
    let mut bot_words: Vec<String> = drawings.keys().cloned().collect();
    bot_words.sort();

    println!("connected as {}", args.name);

    loop {
        tokio::select! {
            biased;

            // Check if it's time to guess
            _ = async {
                if !is_drawer && !guess_sent {
                    if let (Some(word), Some(deadline)) = (&current_word, round_deadline) {
                        let total = deadline.duration_since(Instant::now() - Duration::from_secs(80));
                        let profile = pick_profile();
                        let wait_frac = match profile {
                            GuessProfile::Sharp => rand::thread_rng().gen_range(0.25..0.40),
                            GuessProfile::Average => rand::thread_rng().gen_range(0.50..0.70),
                            GuessProfile::Slow => rand::thread_rng().gen_range(0.75..0.90),
                            GuessProfile::Clueless => 2.0, // will never fire before deadline
                        };
                        let wait = Duration::from_secs_f64(total.as_secs_f64() * wait_frac);
                        sleep(wait).await;
                        return Some((word.clone(), profile));
                    }
                }
                std::future::pending::<Option<(String, GuessProfile)>>().await
            } => {
                // This arm is unreachable due to pending(), guessing is handled in message processing below
            },

            msg = stream.next() => {
                let Some(Ok(Message::Binary(bytes))) = msg else {
                    if msg.is_none() {
                        println!("connection closed");
                        break;
                    }
                    continue;
                };
                let Ok(server_msg) = decode::<ServerMsg>(&bytes) else {
                    continue;
                };
                match server_msg {
                    ServerMsg::Welcome { you, .. } => {
                        my_id = you;
                        println!("joined as player {my_id}");
                    }
                    ServerMsg::WordOptions { words, .. } => {
                        // Pick a word we have a drawing for
                        let pick = words.iter().position(|w| {
                            drawings.contains_key(&w.to_lowercase())
                        }).unwrap_or(0);
                        let chosen = &words[pick.min(words.len() - 1)];
                        println!("picking word: {chosen}");
                        let msg = ClientMsg::Game(GameAction::PickWord(pick as u8));
                        let _ = sink.send(Message::Binary(encode(&msg)?)).await;
                    }
                    ServerMsg::DrawerWord { word, duration_ms } => {
                        println!("drawing: {word} ({duration_ms}ms)");
                        is_drawer = true;
                        current_word = Some(word.clone());
                        round_deadline = Some(Instant::now() + Duration::from_millis(duration_ms as u64));

                        // Replay the Quick Draw strokes
                        let word_lower = word.to_lowercase();
                        if let Some(drawing) = drawings.get(&word_lower) {
                            let _ = replay_drawing(&mut sink, &drawing.strokes).await;
                        }
                    }
                    ServerMsg::Game { event: GameEvent::RoundStart { drawer, duration_ms, .. }, .. } => {
                        is_drawer = drawer == my_id;
                        guess_sent = false;
                        if !is_drawer {
                            round_deadline = Some(Instant::now() + Duration::from_millis(duration_ms as u64));
                        }
                    }
                    ServerMsg::Game { event: GameEvent::WordPickStarted { drawer, .. }, .. } => {
                        is_drawer = drawer == my_id;
                        current_word = None;
                        guess_sent = false;
                    }
                    ServerMsg::Game { event: GameEvent::RoundEnd { word, .. }, .. } => {
                        println!("round ended, word was: {word}");
                        is_drawer = false;
                        current_word = None;
                        round_deadline = None;
                        guess_sent = false;
                    }
                    ServerMsg::Ping { nonce } => {
                        let _ = sink.send(Message::Binary(encode(&ClientMsg::Pong { nonce })?)).await;
                    }
                    ServerMsg::Bye { reason } => {
                        println!("bye: {reason:?}");
                        break;
                    }
                    _ => {}
                }
            }
        }

        // Guessing logic (non-drawer, has a word to guess)
        if !is_drawer && !guess_sent {
            if let Some(deadline) = round_deadline {
                if let Some(word) = &current_word {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let elapsed_frac = 1.0 - (remaining.as_secs_f64() / 80.0).clamp(0.0, 1.0);
                    let profile = pick_profile();
                    let trigger_frac = match profile {
                        GuessProfile::Sharp => 0.30,
                        GuessProfile::Average => 0.55,
                        GuessProfile::Slow => 0.75,
                        GuessProfile::Clueless => 1.1,
                    };
                    if elapsed_frac >= trigger_frac {
                        // Send 0-2 wrong guesses first
                        let wrong_count = match profile {
                            GuessProfile::Sharp => 0,
                            GuessProfile::Average => rand::thread_rng().gen_range(1..=2),
                            GuessProfile::Slow => rand::thread_rng().gen_range(2..=3),
                            GuessProfile::Clueless => rand::thread_rng().gen_range(1..=3),
                        };
                        for _ in 0..wrong_count {
                            let wrong =
                                &bot_words[rand::thread_rng().gen_range(0..bot_words.len())];
                            if wrong != word {
                                let msg = ClientMsg::Guess {
                                    text: wrong.clone(),
                                };
                                let _ = sink.send(Message::Binary(encode(&msg)?)).await;
                                sleep(Duration::from_millis(
                                    rand::thread_rng().gen_range(800..2500),
                                ))
                                .await;
                            }
                        }
                        // Correct guess (unless clueless)
                        if !matches!(profile, GuessProfile::Clueless) {
                            let msg = ClientMsg::Guess { text: word.clone() };
                            let _ = sink.send(Message::Binary(encode(&msg)?)).await;
                            println!("guessed: {word}");
                        }
                        guess_sent = true;
                    }
                }
            }
        }
    }

    Ok(())
}

async fn replay_drawing(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    strokes: &[Vec<(u8, u8)>],
) -> Result<()> {
    let scale_x = 960.0 / 256.0;
    let scale_y = 600.0 / 256.0;

    for (sid, stroke) in strokes.iter().enumerate() {
        if stroke.is_empty() {
            continue;
        }
        let origin_x = (stroke[0].0 as f32 * scale_x) as u16;
        let origin_y = (stroke[0].1 as f32 * scale_y) as u16;

        // Send in batches of up to 64 points (MAX_POINTS_PER_BATCH)
        let mut points: Vec<Point> = Vec::new();
        let mut prev = stroke[0];
        for &(x, y) in &stroke[1..] {
            let dx = (x as i16 - prev.0 as i16).clamp(-128, 127) as i8;
            let dy = (y as i16 - prev.1 as i16).clamp(-128, 127) as i8;
            points.push(Point {
                dx,
                dy,
                dt: 16,
                pressure: 200,
            });
            prev = (x, y);

            if points.len() >= 60 {
                let msg = ClientMsg::Stroke {
                    stroke_id: sid as u32,
                    origin: (origin_x, origin_y),
                    color: 0x2a2a2e,
                    width: 4,
                    points: std::mem::take(&mut points),
                    finished: false,
                };
                sink.send(Message::Binary(encode(&msg)?)).await?;
                sleep(Duration::from_millis(30)).await;
            }
        }

        let msg = ClientMsg::Stroke {
            stroke_id: sid as u32,
            origin: (origin_x, origin_y),
            color: 0x2a2a2e,
            width: 4,
            points,
            finished: true,
        };
        sink.send(Message::Binary(encode(&msg)?)).await?;
        sleep(Duration::from_millis(
            rand::thread_rng().gen_range(100..300),
        ))
        .await;
    }
    Ok(())
}
