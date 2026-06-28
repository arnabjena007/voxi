//! Game-loop integration tests. Each driver creates a room with a small
//! known word list, joins two players, starts a game, walks through the
//! state machine, and asserts the wire-level effects.
//!
//! We pause tokio time at the start of every test so the long pick/draw
//! windows pass instantly via `advance`.

use pastel_proto::*;
use pastel_room::{spawn_room, JoinOutcome, JoinResult, RoomHandle, WordLists};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver as BroadcastRx;
use tokio::sync::mpsc::Receiver as UnicastRx;

const RECV_TIMEOUT: Duration = Duration::from_millis(200);

fn code() -> RoomCode {
    RoomCode::parse("ABC234").unwrap()
}

/// A one-word-per-tier pool so the test knows what word the drawer was
/// offered without inspecting the WordOptions message.
fn fixed_words() -> WordLists {
    WordLists::new(
        vec!["cat".into()],
        vec!["banana".into()],
        vec!["satellite".into()],
    )
}

fn spawn_with(words: WordLists) -> RoomHandle {
    spawn_room(code(), Arc::new(words))
}

fn hello(name: &str) -> Hello {
    Hello {
        room: code(),
        name: name.into(),
        resume_from: None,
        client_token: None,
        avatar: Avatar::default(),
    }
}

async fn join(h: &RoomHandle, name: &str) -> JoinResult {
    match h.join(hello(name)).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending join in test helper"),
    }
}

async fn join_token(h: &RoomHandle, name: &str, token: &str) -> JoinResult {
    let hello = Hello {
        room: code(),
        name: name.into(),
        resume_from: None,
        client_token: Some(token.into()),
        avatar: Avatar::default(),
    };
    match h.join(hello).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending join in test helper"),
    }
}

async fn join_bot(h: &RoomHandle, name: &str) -> JoinResult {
    match h.join_as_bot(hello(name)).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending bot join in test helper"),
    }
}

async fn next_broadcast(
    rx: &mut BroadcastRx<std::sync::Arc<ServerMsg>>,
) -> std::sync::Arc<ServerMsg> {
    tokio::time::timeout(RECV_TIMEOUT, rx.recv())
        .await
        .expect("broadcast recv timed out")
        .expect("broadcast channel closed")
}

async fn next_unicast(rx: &mut UnicastRx<std::sync::Arc<ServerMsg>>) -> std::sync::Arc<ServerMsg> {
    tokio::time::timeout(RECV_TIMEOUT, rx.recv())
        .await
        .expect("unicast recv timed out")
        .expect("unicast channel closed")
}

/// Drain Presence / Welcome / Cleared events until we see the predicate match.
async fn wait_broadcast_for<F>(
    rx: &mut BroadcastRx<std::sync::Arc<ServerMsg>>,
    mut pred: F,
) -> std::sync::Arc<ServerMsg>
where
    F: FnMut(&ServerMsg) -> bool,
{
    loop {
        let msg = next_broadcast(rx).await;
        if pred(&msg) {
            return msg;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn full_sprint_game_plays_to_game_over() {
    let h = spawn_with(fixed_words());

    let mut alice = join(&h, "alice").await;
    let mut bob = join(&h, "bob").await;

    // Drain welcomes.
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;

    // Drain presence broadcasts so the channels are empty before Start.
    let _ = next_broadcast(&mut alice.broadcast_rx).await; // alice joined
    let _ = next_broadcast(&mut alice.broadcast_rx).await; // bob joined
    let _ = next_broadcast(&mut bob.broadcast_rx).await; // bob joined (own)

    // Start a Sprint game (3 rounds).
    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    // Sprint = 3 rounds; with 2 players each round has 2 turns, so 6 total.
    let total_turns = 3 * 2;
    let mut last_drawer = None;
    for turn in 0..total_turns {
        let expected_round = (turn / 2) as u8;
        let _ = expected_round; // kept for future stricter asserts
                                // WordPickStarted broadcast.
        let pick_msg = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;
        let (drawer, round_index, total_rounds) = match pick_msg.as_ref() {
            ServerMsg::Game {
                event:
                    GameEvent::WordPickStarted {
                        drawer,
                        round_index,
                        total_rounds,
                        ..
                    },
                ..
            } => (*drawer, *round_index, *total_rounds),
            other => panic!("expected WordPickStarted, got {other:?}"),
        };
        assert_eq!(round_index, expected_round, "turn {turn} round mismatch");
        assert_eq!(total_rounds, 3);
        last_drawer = Some(drawer);

        // Also let bob see the WordPickStarted so his queue doesn't lag.
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;

        // Drawer receives WordOptions unicast.
        let drawer_uc = if drawer == alice.you {
            &mut alice.unicast_rx
        } else {
            &mut bob.unicast_rx
        };
        match next_unicast(drawer_uc).await.as_ref() {
            ServerMsg::WordOptions { words, .. } => {
                assert!(!words.is_empty());
            }
            other => panic!("expected WordOptions, got {other:?}"),
        }

        // Drawer picks index 0.
        h.send(drawer, ClientMsg::Game(GameAction::PickWord(0)))
            .await;

        // Cleared broadcast (canvas reset at round start), then RoundStart.
        wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;

        // Drawer receives DrawerWord unicast with the real word.
        let drawer_uc = if drawer == alice.you {
            &mut alice.unicast_rx
        } else {
            &mut bob.unicast_rx
        };
        let secret_word = match next_unicast(drawer_uc).await.as_ref() {
            ServerMsg::DrawerWord { word, .. } => word.clone(),
            other => panic!("expected DrawerWord, got {other:?}"),
        };

        // The OTHER player guesses correctly.
        let guesser = if drawer == alice.you {
            (bob.you, &mut bob.broadcast_rx)
        } else {
            (alice.you, &mut alice.broadcast_rx)
        };
        h.send(
            guesser.0,
            ClientMsg::Guess {
                text: secret_word.clone(),
            },
        )
        .await;

        // Expect Guess { Correct } on both sides, then RoundEnd.
        wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Guess {
                    kind: GuessKind::Correct,
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Guess {
                    kind: GuessKind::Correct,
                    ..
                }
            )
        })
        .await;

        let round_end_a = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        let _ = wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        match round_end_a.as_ref() {
            ServerMsg::Game {
                event: GameEvent::RoundEnd { word, .. },
                ..
            } => assert_eq!(word, &secret_word),
            other => panic!("expected RoundEnd, got {other:?}"),
        }

        // Tick past the 5s reveal so we move to the next round (or GameOver).
        tokio::time::advance(Duration::from_secs(6)).await;
    }

    // After the third round end, the server should broadcast GameOver.
    let over = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::GameOver { .. },
                ..
            }
        )
    })
    .await;
    match over.as_ref() {
        ServerMsg::Game {
            event: GameEvent::GameOver { final_scores },
            ..
        } => {
            assert!(!final_scores.is_empty());
            let total: u32 = final_scores.iter().map(|(_, s)| *s).sum();
            assert!(total > 0, "someone should have scored points");
        }
        other => panic!("expected GameOver, got {other:?}"),
    }
    assert!(last_drawer.is_some());
}

#[tokio::test(start_paused = true)]
async fn best_drawing_vote_picks_a_winner() {
    let h = spawn_with(fixed_words());
    let mut alice = join(&h, "alice").await;
    let mut bob = join(&h, "bob").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;
    let _ = next_broadcast(&mut alice.broadcast_rx).await;
    let _ = next_broadcast(&mut alice.broadcast_rx).await;
    let _ = next_broadcast(&mut bob.broadcast_rx).await;

    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    // Play all 6 turns, capturing each drawing's (turn id, drawer).
    let mut turns: Vec<(u16, u32)> = Vec::new();
    for _ in 0..(3 * 2) {
        let pick = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;
        let drawer = match pick.as_ref() {
            ServerMsg::Game {
                event: GameEvent::WordPickStarted { drawer, .. },
                ..
            } => *drawer,
            o => panic!("expected WordPickStarted, got {o:?}"),
        };
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;

        let drawer_uc = if drawer == alice.you {
            &mut alice.unicast_rx
        } else {
            &mut bob.unicast_rx
        };
        let _ = next_unicast(drawer_uc).await; // WordOptions
        h.send(drawer, ClientMsg::Game(GameAction::PickWord(0)))
            .await;

        wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;

        let drawer_uc = if drawer == alice.you {
            &mut alice.unicast_rx
        } else {
            &mut bob.unicast_rx
        };
        let secret = match next_unicast(drawer_uc).await.as_ref() {
            ServerMsg::DrawerWord { word, .. } => word.clone(),
            o => panic!("expected DrawerWord, got {o:?}"),
        };
        let guesser = if drawer == alice.you {
            bob.you
        } else {
            alice.you
        };
        h.send(guesser, ClientMsg::Guess { text: secret }).await;

        wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Guess {
                    kind: GuessKind::Correct,
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Guess {
                    kind: GuessKind::Correct,
                    ..
                }
            )
        })
        .await;

        let re = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        let turn = match re.as_ref() {
            ServerMsg::Game {
                event: GameEvent::RoundEnd { turn, .. },
                ..
            } => *turn,
            o => panic!("expected RoundEnd, got {o:?}"),
        };
        turns.push((turn, drawer));

        tokio::time::advance(Duration::from_secs(6)).await;
    }

    // GameOver, then the voting window opens.
    for rx in [&mut alice.broadcast_rx, &mut bob.broadcast_rx] {
        wait_broadcast_for(rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::GameOver { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::VotingOpen { .. },
                    ..
                }
            )
        })
        .await;
    }

    let bob_turns: Vec<u16> = turns
        .iter()
        .filter(|(_, d)| *d == bob.you)
        .map(|(t, _)| *t)
        .collect();
    let alice_turns: Vec<u16> = turns
        .iter()
        .filter(|(_, d)| *d == alice.you)
        .map(|(t, _)| *t)
        .collect();
    assert!(bob_turns.len() >= 2 && !alice_turns.is_empty());

    // alice rates: a self-vote (rejected), 3 hearts on one of bob's drawings,
    // and 1 -> 2 hearts on another (a changed rating, counted once).
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: alice_turns[0],
            hearts: 3,
        },
    )
    .await; // self-vote -> ignored
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bob_turns[0],
            hearts: 2,
        },
    )
    .await;
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bob_turns[0],
            hearts: 3,
        },
    )
    .await; // change 2 -> 3
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bob_turns[1],
            hearts: 1,
        },
    )
    .await;
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bob_turns[1],
            hearts: 2,
        },
    )
    .await; // change 1 -> 2
            // bob hearts one of alice's drawings.
    h.send(
        bob.you,
        ClientMsg::Vote {
            turn: alice_turns[0],
            hearts: 1,
        },
    )
    .await;
    // The window closes on its timer.
    tokio::time::advance(Duration::from_secs(41)).await;

    let res = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::VoteResult { .. },
                ..
            }
        )
    })
    .await;
    match res.as_ref() {
        ServerMsg::Game {
            event:
                GameEvent::VoteResult {
                    tally,
                    top_drawing,
                    artist,
                },
            ..
        } => {
            let map: std::collections::HashMap<u16, u32> = tally.iter().copied().collect();
            assert_eq!(
                map.get(&bob_turns[0]),
                Some(&3),
                "alice's hearts, self-vote ignored"
            );
            assert_eq!(
                map.get(&bob_turns[1]),
                Some(&2),
                "changed rating counts once"
            );
            assert_eq!(map.get(&alice_turns[0]), Some(&1), "bob's heart on alice");
            // Top drawing: bob's most-hearted piece.
            let top = top_drawing.as_ref().expect("a top drawing");
            assert_eq!(top.turn, bob_turns[0]);
            assert_eq!(top.drawer, bob.you);
            assert_eq!(top.hearts, 3);
            // Best artist: bob (3 + 2 = 5 hearts) beats alice (1).
            let a = artist.as_ref().expect("a best artist");
            assert_eq!(a.player, bob.you);
            assert_eq!(a.hearts, 5);
        }
        o => panic!("expected VoteResult, got {o:?}"),
    }
}

// A lone human plus a bot: the bot rates every drawing it didn't make (by
// clarity), and its own drawings can win Best Artist when the human loves them.
#[tokio::test(start_paused = true)]
async fn bot_votes_by_clarity_and_can_win() {
    let h = spawn_with(fixed_words());
    let mut alice = join(&h, "alice").await;
    let mut bot = join_bot(&h, "robo").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bot.unicast_rx).await;
    let _ = next_broadcast(&mut alice.broadcast_rx).await;
    let _ = next_broadcast(&mut alice.broadcast_rx).await;
    let _ = next_broadcast(&mut bot.broadcast_rx).await;

    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    // Play all 6 turns. Nobody ever guesses (the bot has no driver here), so
    // every round ends on the draw timer and every drawing has clarity 1.
    let mut turns: Vec<(u16, u32)> = Vec::new();
    for _ in 0..(3 * 2) {
        let pick = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;
        let drawer = match pick.as_ref() {
            ServerMsg::Game {
                event: GameEvent::WordPickStarted { drawer, .. },
                ..
            } => *drawer,
            o => panic!("expected WordPickStarted, got {o:?}"),
        };
        wait_broadcast_for(&mut bot.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;

        if drawer == alice.you {
            let _ = next_unicast(&mut alice.unicast_rx).await; // WordOptions
            h.send(alice.you, ClientMsg::Game(GameAction::PickWord(0)))
                .await;
        } else {
            // Bot drawer: drain its options, then let the pick window elapse so
            // the server auto-picks for it.
            let _ = next_unicast(&mut bot.unicast_rx).await; // WordOptions
            tokio::time::advance(Duration::from_secs(16)).await;
        }

        wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bot.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundStart { .. },
                    ..
                }
            )
        })
        .await;

        // Drain the drawer's secret, then let the draw window time out.
        if drawer == alice.you {
            let _ = next_unicast(&mut alice.unicast_rx).await; // DrawerWord
        } else {
            let _ = next_unicast(&mut bot.unicast_rx).await; // DrawerWord
        }
        tokio::time::advance(Duration::from_secs(81)).await;

        let re = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut bot.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::RoundEnd { .. },
                    ..
                }
            )
        })
        .await;
        let turn = match re.as_ref() {
            ServerMsg::Game {
                event: GameEvent::RoundEnd { turn, .. },
                ..
            } => *turn,
            o => panic!("expected RoundEnd, got {o:?}"),
        };
        turns.push((turn, drawer));
        tokio::time::advance(Duration::from_secs(6)).await;
    }

    for rx in [&mut alice.broadcast_rx, &mut bot.broadcast_rx] {
        wait_broadcast_for(rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::GameOver { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::VotingOpen { .. },
                    ..
                }
            )
        })
        .await;
    }

    let alice_turns: Vec<u16> = turns
        .iter()
        .filter(|(_, d)| *d == alice.you)
        .map(|(t, _)| *t)
        .collect();
    let bot_turns: Vec<u16> = turns
        .iter()
        .filter(|(_, d)| *d == bot.you)
        .map(|(t, _)| *t)
        .collect();
    assert_eq!(alice_turns.len(), 3);
    assert_eq!(bot_turns.len(), 3);

    // Alice loves two of the bot's drawings. The bot has already auto-voted
    // (clarity 1) on each of alice's.
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bot_turns[0],
            hearts: 3,
        },
    )
    .await;
    h.send(
        alice.you,
        ClientMsg::Vote {
            turn: bot_turns[1],
            hearts: 2,
        },
    )
    .await;
    tokio::time::advance(Duration::from_secs(41)).await;

    let res = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::VoteResult { .. },
                ..
            }
        )
    })
    .await;
    match res.as_ref() {
        ServerMsg::Game {
            event:
                GameEvent::VoteResult {
                    tally,
                    top_drawing,
                    artist,
                },
            ..
        } => {
            let map: std::collections::HashMap<u16, u32> = tally.iter().copied().collect();
            // The bot voted: each of alice's drawings got its clarity heart,
            // even though no human rated them.
            for t in &alice_turns {
                assert_eq!(map.get(t), Some(&1), "bot clarity-voted alice's drawing");
            }
            // Bot can win: alice's 3 + 2 hearts make its art the Best Artist.
            let a = artist.as_ref().expect("a best artist");
            assert_eq!(
                a.player, bot.you,
                "the bot's drawings earned the most hearts"
            );
            assert_eq!(a.hearts, 5);
            let top = top_drawing.as_ref().expect("a top drawing");
            assert_eq!(top.turn, bot_turns[0]);
            assert_eq!(top.hearts, 3);
        }
        o => panic!("expected VoteResult, got {o:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn pick_window_auto_picks_on_timeout() {
    let h = spawn_with(fixed_words());

    let mut alice = join(&h, "alice").await;
    let mut bob = join(&h, "bob").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;

    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    // Wait for WordPickStarted.
    wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::WordPickStarted { .. },
                ..
            }
        )
    })
    .await;

    // Don't pick. Advance past the pick window.
    tokio::time::advance(Duration::from_secs(20)).await;

    // Server should auto-pick option 0 and broadcast RoundStart.
    wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::RoundStart { .. },
                ..
            }
        )
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn draw_window_timeout_advances_to_round_end() {
    let h = spawn_with(fixed_words());

    let mut alice = join(&h, "alice").await;
    let mut bob = join(&h, "bob").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;

    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    let pick = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::WordPickStarted { .. },
                ..
            }
        )
    })
    .await;
    let drawer = match pick.as_ref() {
        ServerMsg::Game {
            event: GameEvent::WordPickStarted { drawer, .. },
            ..
        } => *drawer,
        _ => unreachable!(),
    };
    h.send(drawer, ClientMsg::Game(GameAction::PickWord(0)))
        .await;

    // Drain channels up to RoundStart so the test only watches forward.
    wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::RoundStart { .. },
                ..
            }
        )
    })
    .await;

    // No one guesses. Advance past the draw window.
    tokio::time::advance(Duration::from_secs(90)).await;

    wait_broadcast_for(&mut alice.broadcast_rx, |m| {
        matches!(
            m,
            ServerMsg::Game {
                event: GameEvent::RoundEnd { .. },
                ..
            }
        )
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn same_token_rejoin_mid_game_does_not_duplicate_rotation() {
    // Regression: handle_leave keeps a player in `rotation` (dead slots collapse
    // via the alive-check), so a same-token rejoin mid-game used to push them
    // again and they drew twice every round. With 3 players, round 0 must have
    // exactly 3 turns by 3 distinct drawers even after one disconnects + rejoins.
    let h = spawn_with(fixed_words());
    let mut alice = join_token(&h, "alice", "tok-a").await;
    let mut bob = join_token(&h, "bob", "tok-b").await;
    let mut carol = join_token(&h, "carol", "tok-c").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;
    let _ = next_unicast(&mut carol.unicast_rx).await;

    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    let mut round0_drawers: Vec<u32> = Vec::new();
    let mut reconnected = false;
    loop {
        let pick = wait_broadcast_for(&mut alice.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. } | GameEvent::GameOver { .. },
                    ..
                }
            )
        })
        .await;
        let (drawer, round_index) = match pick.as_ref() {
            ServerMsg::Game {
                event: GameEvent::GameOver { .. },
                ..
            } => break,
            ServerMsg::Game {
                event:
                    GameEvent::WordPickStarted {
                        drawer,
                        round_index,
                        ..
                    },
                ..
            } => (*drawer, *round_index),
            o => panic!("expected WordPickStarted/GameOver, got {o:?}"),
        };
        if round_index >= 1 {
            break; // round 0 fully accounted for
        }
        round0_drawers.push(drawer);

        // Keep the other queues moving.
        wait_broadcast_for(&mut bob.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;
        wait_broadcast_for(&mut carol.broadcast_rx, |m| {
            matches!(
                m,
                ServerMsg::Game {
                    event: GameEvent::WordPickStarted { .. },
                    ..
                }
            )
        })
        .await;

        // Drawer picks word 0 (drain its WordOptions unicast first).
        if drawer == alice.you {
            let _ = next_unicast(&mut alice.unicast_rx).await;
        } else if drawer == bob.you {
            let _ = next_unicast(&mut bob.unicast_rx).await;
        } else {
            let _ = next_unicast(&mut carol.unicast_rx).await;
        }
        h.send(drawer, ClientMsg::Game(GameAction::PickWord(0)))
            .await;

        for rx in [
            &mut alice.broadcast_rx,
            &mut bob.broadcast_rx,
            &mut carol.broadcast_rx,
        ] {
            wait_broadcast_for(rx, |m| {
                matches!(
                    m,
                    ServerMsg::Game {
                        event: GameEvent::RoundStart { .. },
                        ..
                    }
                )
            })
            .await;
        }
        // Drain the drawer's DrawerWord unicast so a later turn isn't blocked behind it.
        if drawer == alice.you {
            let _ = next_unicast(&mut alice.unicast_rx).await;
        } else if drawer == bob.you {
            let _ = next_unicast(&mut bob.unicast_rx).await;
        } else {
            let _ = next_unicast(&mut carol.unicast_rx).await;
        }

        // Let the draw window time out -> RoundEnd.
        tokio::time::advance(Duration::from_secs(90)).await;
        for rx in [
            &mut alice.broadcast_rx,
            &mut bob.broadcast_rx,
            &mut carol.broadcast_rx,
        ] {
            wait_broadcast_for(rx, |m| {
                matches!(
                    m,
                    ServerMsg::Game {
                        event: GameEvent::RoundEnd { .. },
                        ..
                    }
                )
            })
            .await;
        }

        // After the first turn (nobody currently drawing), bob disconnects and
        // reconnects with the same token. The rotation must not grow.
        if !reconnected {
            reconnected = true;
            h.leave(bob.you).await;
            bob = join_token(&h, "bob", "tok-b").await;
            let _ = next_unicast(&mut bob.unicast_rx).await; // Welcome
        }

        tokio::time::advance(Duration::from_secs(6)).await; // reveal -> next turn
    }

    assert!(reconnected, "test never reconnected bob");
    assert_eq!(
        round0_drawers.len(),
        3,
        "round 0 should have exactly 3 turns, got {round0_drawers:?}"
    );
    let mut unique = round0_drawers.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        3,
        "round 0 had a duplicate drawer (rotation grew on rejoin): {round0_drawers:?}"
    );
}
