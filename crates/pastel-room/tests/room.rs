use pastel_proto::*;
use pastel_room::{
    spawn_room, JoinError, JoinOutcome, JoinResult, RoomHandle, WordLists, MAX_PLAYERS_PER_ROOM,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver as BroadcastRx;
use tokio::sync::mpsc::Receiver as UnicastRx;

const ROOM: &str = "ABC234";
const RECV_TIMEOUT: Duration = Duration::from_millis(200);

fn code() -> RoomCode {
    RoomCode::parse(ROOM).unwrap()
}

fn spawn() -> RoomHandle {
    spawn_room(code(), Arc::new(WordLists::test_fixture()))
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

async fn join(handle: &RoomHandle, name: &str) -> JoinResult {
    match handle.join(hello(name)).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending join in test helper"),
    }
}

async fn next(rx: &mut BroadcastRx<Arc<ServerMsg>>) -> Arc<ServerMsg> {
    tokio::time::timeout(RECV_TIMEOUT, rx.recv())
        .await
        .expect("broadcast recv timed out")
        .expect("broadcast channel closed unexpectedly")
}

async fn next_unicast(rx: &mut UnicastRx<Arc<ServerMsg>>) -> Arc<ServerMsg> {
    tokio::time::timeout(RECV_TIMEOUT, rx.recv())
        .await
        .expect("unicast recv timed out")
        .expect("unicast channel closed unexpectedly")
}

async fn expect_no_message(rx: &mut BroadcastRx<Arc<ServerMsg>>) {
    let result = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await;
    assert!(result.is_err(), "expected no message but got one");
}

#[tokio::test]
async fn join_returns_welcome_with_empty_snapshot() {
    let h = spawn();
    let mut joined = join(&h, "alice").await;

    let welcome = next_unicast(&mut joined.unicast_rx).await;
    match welcome.as_ref() {
        ServerMsg::Welcome { you, snapshot, .. } => {
            assert_eq!(*you, joined.you);
            assert!(
                snapshot.players.is_empty(),
                "first joiner sees empty player list"
            );
            assert!(snapshot.completed.is_empty());
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[tokio::test]
async fn second_joiner_sees_presence_for_first() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let _welcome_a = next_unicast(&mut a.unicast_rx).await;

    // alice should see her own join broadcast.
    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { joined, left, .. } => {
            assert_eq!(joined.len(), 1);
            assert_eq!(joined[0].name, "alice");
            assert!(left.is_empty());
        }
        other => panic!("expected Presence, got {other:?}"),
    }

    let _b = join(&h, "bob").await;

    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { joined, left, .. } => {
            assert_eq!(joined.len(), 1);
            assert_eq!(joined[0].name, "bob");
            assert!(left.is_empty());
        }
        other => panic!("expected Presence for bob, got {other:?}"),
    }
}

#[tokio::test]
async fn stroke_broadcasts_with_monotonic_seq() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    let _ = next(&mut a.broadcast_rx).await; // presence

    h.send(
        a.you,
        ClientMsg::Stroke {
            stroke_id: 1,
            origin: (10, 20),
            color: 0xd62828,
            width: 4,
            points: vec![Point {
                dx: 1,
                dy: 1,
                dt: 16,
                pressure: 200,
            }],
            finished: false,
        },
    )
    .await;

    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Stroke {
            seq,
            player,
            stroke_id,
            color,
            width,
            points,
            finished,
            ..
        } => {
            assert_eq!(*player, a.you);
            assert_eq!(*stroke_id, 1);
            assert_eq!(*color, 0xd62828);
            assert_eq!(*width, 4);
            assert_eq!(points.len(), 1);
            assert!(!finished);
            assert!(*seq >= 2, "seq should advance after presence");
        }
        other => panic!("expected Stroke, got {other:?}"),
    }
}

#[tokio::test]
async fn chat_is_broadcast_to_all() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let mut b = join(&h, "bob").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    let _ = next_unicast(&mut b.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 2).await;
    drain_presence(&mut b.broadcast_rx, 1).await;

    h.send(a.you, ClientMsg::Chat { text: "hi".into() }).await;

    for rx in [&mut a.broadcast_rx, &mut b.broadcast_rx] {
        match next(rx).await.as_ref() {
            ServerMsg::Chat { player, text, .. } => {
                assert_eq!(*player, a.you);
                assert_eq!(text, "hi");
            }
            other => panic!("expected Chat, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn correct_guess_broadcasts_guess_event() {
    let h = spawn();
    let mut a = join(&h, "alice").await; // drawer
    let mut b = join(&h, "bob").await; // guesser
    let _ = next_unicast(&mut a.unicast_rx).await;
    let _ = next_unicast(&mut b.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 2).await;
    drain_presence(&mut b.broadcast_rx, 1).await;

    h.set_secret(a.you, "apple").await;

    h.send(
        b.you,
        ClientMsg::Guess {
            text: "Apple".into(),
        },
    )
    .await;

    for rx in [&mut a.broadcast_rx, &mut b.broadcast_rx] {
        match next(rx).await.as_ref() {
            ServerMsg::Guess { player, kind, .. } => {
                assert_eq!(*player, b.you);
                assert_eq!(*kind, GuessKind::Correct);
            }
            other => panic!("expected Guess, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn wrong_guess_falls_through_to_chat() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let mut b = join(&h, "bob").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    let _ = next_unicast(&mut b.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 2).await;
    drain_presence(&mut b.broadcast_rx, 1).await;

    h.set_secret(a.you, "apple").await;
    h.send(
        b.you,
        ClientMsg::Guess {
            text: "banana".into(),
        },
    )
    .await;

    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Chat { player, text, .. } => {
            assert_eq!(*player, b.you);
            assert_eq!(text, "banana");
        }
        other => panic!("expected Chat for wrong guess, got {other:?}"),
    }
}

#[tokio::test]
async fn correct_guesser_chatting_the_word_is_blocked_as_spoiler() {
    let h = spawn();
    let a = join(&h, "alice").await; // drawer
    let mut b = join(&h, "bob").await; // will guess correctly -> "knows" the word
    let mut c = join(&h, "carol").await; // still guessing -> round stays open
    let _ = next_unicast(&mut b.unicast_rx).await; // Welcome
    let _ = next_unicast(&mut c.unicast_rx).await; // Welcome
    drain_presence(&mut b.broadcast_rx, 2).await; // bob + carol
    drain_presence(&mut c.broadcast_rx, 1).await; // carol

    h.set_secret(a.you, "apple").await;

    // bob guesses correctly. carol hasn't, so the round stays in Drawing and
    // bob is now a "knower".
    h.send(b.you, ClientMsg::Guess { text: "apple".into() }).await;
    match next(&mut c.broadcast_rx).await.as_ref() {
        ServerMsg::Guess { kind, .. } => assert_eq!(*kind, GuessKind::Correct),
        other => panic!("expected Correct guess, got {other:?}"),
    }

    // bob tries to drop the word in chat.
    h.send(
        b.you,
        ClientMsg::Chat {
            text: "it's apple lol".into(),
        },
    )
    .await;

    // bob gets a private Spoiler nudge instead of it being broadcast...
    match next_unicast(&mut b.unicast_rx).await.as_ref() {
        ServerMsg::Guess { player, kind, .. } => {
            assert_eq!(*player, b.you);
            assert_eq!(*kind, GuessKind::Spoiler);
        }
        other => panic!("expected Spoiler, got {other:?}"),
    }
    // ...and carol, still guessing, never sees the leaked word.
    expect_no_message(&mut c.broadcast_rx).await;
}

#[tokio::test]
async fn correct_guesser_can_chat_without_the_word() {
    let h = spawn();
    let a = join(&h, "alice").await; // drawer
    let mut b = join(&h, "bob").await; // knower after guessing
    let mut c = join(&h, "carol").await; // still guessing
    let _ = next_unicast(&mut b.unicast_rx).await;
    let _ = next_unicast(&mut c.unicast_rx).await;
    drain_presence(&mut b.broadcast_rx, 2).await;
    drain_presence(&mut c.broadcast_rx, 1).await;

    h.set_secret(a.you, "apple").await;
    h.send(b.you, ClientMsg::Guess { text: "apple".into() }).await;
    match next(&mut c.broadcast_rx).await.as_ref() {
        ServerMsg::Guess { kind, .. } => assert_eq!(*kind, GuessKind::Correct),
        other => panic!("expected Correct guess, got {other:?}"),
    }

    // A normal message from a knower (no word) reaches everyone, including the
    // still-guessing carol -- post-guess chat works.
    h.send(
        b.you,
        ClientMsg::Chat {
            text: "nice work!".into(),
        },
    )
    .await;
    match next(&mut c.broadcast_rx).await.as_ref() {
        ServerMsg::Chat { player, text, .. } => {
            assert_eq!(*player, b.you);
            assert_eq!(text, "nice work!");
        }
        other => panic!("expected Chat broadcast, got {other:?}"),
    }
}

#[tokio::test]
async fn drawer_guess_is_ignored() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 1).await;

    h.set_secret(a.you, "apple").await;
    h.send(
        a.you,
        ClientMsg::Guess {
            text: "apple".into(),
        },
    )
    .await;

    expect_no_message(&mut a.broadcast_rx).await;
}

#[tokio::test]
async fn eleventh_join_is_rejected() {
    let h = spawn();
    let mut held = Vec::new();
    for i in 0..MAX_PLAYERS_PER_ROOM {
        held.push(join(&h, &format!("p{i}")).await);
    }
    match h.join(hello("overflow")).await {
        Err(JoinError::RoomFull) => {}
        Err(other) => panic!("expected RoomFull, got {other:?}"),
        Ok(_) => panic!("expected RoomFull, got Ok"),
    }
    drop(held);
}

#[tokio::test]
async fn leave_emits_presence() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let b = join(&h, "bob").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 2).await;

    h.leave(b.you).await;

    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { joined, left, .. } => {
            assert!(joined.is_empty());
            assert_eq!(left, &vec![b.you]);
        }
        other => panic!("expected Presence(left), got {other:?}"),
    }
}

#[tokio::test]
async fn ten_players_thousand_strokes_arrive_ordered() {
    let h = spawn();
    let mut players = Vec::with_capacity(10);
    for i in 0..10 {
        let mut j = join(&h, &format!("p{i}")).await;
        let _ = next_unicast(&mut j.unicast_rx).await;
        players.push(j);
    }
    // Each player subscribes during their own join, so they see one presence
    // for themselves plus one for every player that joins after them.
    let total = players.len();
    for (i, p) in players.iter_mut().enumerate() {
        drain_presence(&mut p.broadcast_rx, total - i).await;
    }

    // Each player sends 100 strokes for a total of 1000.
    for p in &players {
        for s in 0..100u32 {
            h.send(
                p.you,
                ClientMsg::Stroke {
                    stroke_id: s,
                    origin: (0, 0),
                    color: 0,
                    width: 4,
                    points: vec![Point {
                        dx: 0,
                        dy: 0,
                        dt: 0,
                        pressure: 0,
                    }],
                    finished: false,
                },
            )
            .await;
        }
    }

    for p in &mut players {
        let mut last_seq: Seq = 0;
        let mut received = 0;
        while received < 1000 {
            match next(&mut p.broadcast_rx).await.as_ref() {
                ServerMsg::Stroke { seq, .. } => {
                    assert!(*seq > last_seq, "seq went backwards: {last_seq} -> {seq}");
                    last_seq = *seq;
                    received += 1;
                }
                other => panic!("unexpected msg in stroke phase: {other:?}"),
            }
        }
    }
}

async fn drain_presence(rx: &mut BroadcastRx<Arc<ServerMsg>>, count: usize) {
    for _ in 0..count {
        match next(rx).await.as_ref() {
            ServerMsg::Presence { .. } => {}
            other => panic!("expected Presence, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn host_leaving_promotes_next_player_and_broadcasts_host_changed() {
    let h = spawn();
    // alice joins first, becomes host. bob and carol follow.
    let a = join(&h, "alice").await;
    let mut b = join(&h, "bob").await;
    let _c = join(&h, "carol").await;
    let _ = next_unicast(&mut b.unicast_rx).await; // Welcome
                                                   // bob subscribed after alice's join broadcast, so he only sees his own
                                                   // join Presence + carol's: 2 frames.
    drain_presence(&mut b.broadcast_rx, 2).await;

    // alice (host) leaves.
    h.leave(a.you).await;

    // Presence.left for alice.
    match next(&mut b.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { left, .. } => assert_eq!(left, &vec![a.you]),
        other => panic!("expected Presence(left), got {other:?}"),
    }
    // Followed by HostChanged naming bob (lowest remaining PlayerId).
    match next(&mut b.broadcast_rx).await.as_ref() {
        ServerMsg::Game {
            event: GameEvent::HostChanged { new_host },
            ..
        } => assert_eq!(*new_host, b.you),
        other => panic!("expected Game(HostChanged), got {other:?}"),
    }
}

#[tokio::test]
async fn non_host_leaving_does_not_broadcast_host_changed() {
    let h = spawn();
    let mut a = join(&h, "alice").await;
    let b = join(&h, "bob").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 2).await;

    h.leave(b.you).await;

    // Just the Presence.left, no HostChanged.
    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { left, .. } => assert_eq!(left, &vec![b.you]),
        other => panic!("expected Presence(left), got {other:?}"),
    }
    // Confirm nothing else lands in a tight window.
    let result = tokio::time::timeout(Duration::from_millis(50), a.broadcast_rx.recv()).await;
    assert!(
        result.is_err(),
        "non-host leaving should not produce a HostChanged"
    );
}

// ---- scoreboard filter + same-browser rejoin ----------------------------

fn hello_with_token(name: &str, token: &str) -> Hello {
    Hello {
        room: code(),
        name: name.into(),
        resume_from: None,
        client_token: Some(token.into()),
        avatar: Avatar::default(),
    }
}

async fn join_with_token(h: &RoomHandle, name: &str, token: &str) -> JoinResult {
    match h.join(hello_with_token(name, token)).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending join"),
    }
}

/// Scoreboard filter: a player who scored and then left should not appear in
/// the next RoundEnd broadcast even though their score is still tracked
/// internally (so they can resume it if they reconnect with the same token).
#[tokio::test]
async fn round_end_excludes_departed_players() {
    let h = spawn();
    let mut a = join(&h, "alice").await; // drawer
    let mut b = join(&h, "bob").await;
    let mut c = join(&h, "carol").await;
    let _ = next_unicast(&mut a.unicast_rx).await;
    let _ = next_unicast(&mut b.unicast_rx).await;
    let _ = next_unicast(&mut c.unicast_rx).await;
    drain_presence(&mut a.broadcast_rx, 3).await;
    drain_presence(&mut b.broadcast_rx, 2).await;
    drain_presence(&mut c.broadcast_rx, 1).await;

    h.set_secret(a.you, "apple").await;

    // Carol guesses correctly first, scoring herself + giving the drawer bonus.
    h.send(
        c.you,
        ClientMsg::Guess {
            text: "apple".into(),
        },
    )
    .await;
    for rx in [
        &mut a.broadcast_rx,
        &mut b.broadcast_rx,
        &mut c.broadcast_rx,
    ] {
        match next(rx).await.as_ref() {
            ServerMsg::Guess {
                kind: GuessKind::Correct,
                ..
            } => {}
            other => panic!("expected Correct, got {other:?}"),
        }
    }

    // Carol disconnects mid-round. Her score row is stashed in the room but
    // she is no longer in `self.players`.
    h.leave(c.you).await;
    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Presence { left, .. } => assert_eq!(left, &vec![c.you]),
        other => panic!("expected Presence, got {other:?}"),
    }
    let _ = next(&mut b.broadcast_rx).await; // bob also sees the presence

    // Bob now guesses, closing out the round (no remaining guessers).
    h.send(
        b.you,
        ClientMsg::Guess {
            text: "apple".into(),
        },
    )
    .await;
    for rx in [&mut a.broadcast_rx, &mut b.broadcast_rx] {
        match next(rx).await.as_ref() {
            ServerMsg::Guess {
                kind: GuessKind::Correct,
                ..
            } => {}
            other => panic!("expected Correct, got {other:?}"),
        }
    }

    // RoundEnd should show only alice + bob; carol must be filtered out.
    match next(&mut a.broadcast_rx).await.as_ref() {
        ServerMsg::Game {
            event: GameEvent::RoundEnd { scores, .. },
            ..
        } => {
            let ids: Vec<PlayerId> = scores.iter().map(|(p, _)| *p).collect();
            assert!(ids.contains(&a.you), "alice missing from RoundEnd scores");
            assert!(ids.contains(&b.you), "bob missing from RoundEnd scores");
            assert!(
                !ids.contains(&c.you),
                "carol (departed) should not appear in RoundEnd scores; got {scores:?}"
            );
        }
        other => panic!("expected RoundEnd, got {other:?}"),
    }
}

/// Same-browser rejoin: leaving and reconnecting with the same client_token
/// should hand back the same PlayerId so cumulative scores stay attached and
/// the scoreboard doesn't show a duplicate row.
#[tokio::test]
async fn rejoin_with_same_client_token_restores_player_id() {
    let h = spawn();
    // Keep a second human in the room so it doesn't shut down the moment
    // alice leaves -- the bots-only-kill rule would otherwise wipe the
    // departed map alice's rejoin needs to consult.
    let mut keepalive = join_with_token(&h, "keepalive", "tok-keep").await;
    let mut alice = join_with_token(&h, "alice", "tok-alice").await;
    let original_id = alice.you;
    let _ = next_unicast(&mut keepalive.unicast_rx).await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    drain_presence(&mut keepalive.broadcast_rx, 2).await;
    drain_presence(&mut alice.broadcast_rx, 1).await;

    // Disconnect.
    h.leave(alice.you).await;

    // Reconnect with the same token. Should resolve back to the same PlayerId.
    let alice2 = join_with_token(&h, "alice", "tok-alice").await;
    assert_eq!(
        alice2.you, original_id,
        "expected same PlayerId on rejoin; got fresh id {} vs original {}",
        alice2.you, original_id,
    );
}

async fn join_as_bot(h: &RoomHandle, name: &str) -> JoinResult {
    match h.join_as_bot(hello(name)).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending bot join"),
    }
}

/// Bots must never become host. If a bot joins first, host stays unassigned
/// (visible in the Welcome snapshot). The next human joiner takes the host
/// badge; the bot stays headless even though it has a lower PlayerId.
#[tokio::test]
async fn bot_joining_first_does_not_become_host() {
    let h = spawn();
    let mut bot = join_as_bot(&h, "BotBob").await;
    // The bot's own Welcome snapshot must show host = None.
    match next_unicast(&mut bot.unicast_rx).await.as_ref() {
        ServerMsg::Welcome { snapshot, .. } => {
            assert_eq!(
                snapshot.game.host, None,
                "bot solo in room must not be host"
            );
        }
        other => panic!("expected Welcome, got {other:?}"),
    }

    // Alice joins next. Her Welcome should show her as the host (she's the
    // first human; bot is skipped).
    let mut alice = join(&h, "alice").await;
    match next_unicast(&mut alice.unicast_rx).await.as_ref() {
        ServerMsg::Welcome { snapshot, you, .. } => {
            assert_eq!(
                snapshot.game.host,
                Some(*you),
                "first human joiner must be host"
            );
            assert_ne!(
                snapshot.game.host,
                Some(bot.you),
                "host must not be the bot"
            );
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

/// When the human host leaves and only a bot remains, host transfers to None,
/// NOT to the bot. The next human who joins takes the host badge.
#[tokio::test]
async fn host_leaving_skips_bots_for_transfer() {
    let h = spawn();
    let mut alice = join(&h, "alice").await; // host
    let mut bot = join_as_bot(&h, "BotBob").await;
    let mut carol = join(&h, "carol").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bot.unicast_rx).await;
    let _ = next_unicast(&mut carol.unicast_rx).await;
    drain_presence(&mut alice.broadcast_rx, 3).await;
    drain_presence(&mut bot.broadcast_rx, 2).await;
    drain_presence(&mut carol.broadcast_rx, 1).await;

    // Alice (host) leaves. Transfer must pick carol (a human), skipping the
    // bot even though the bot's PlayerId is lower than carol's.
    h.leave(alice.you).await;
    // Drain the Presence broadcast for alice leaving.
    let _ = next(&mut carol.broadcast_rx).await;
    // Then expect HostChanged with carol as the new host.
    match next(&mut carol.broadcast_rx).await.as_ref() {
        ServerMsg::Game {
            event: GameEvent::HostChanged { new_host },
            ..
        } => {
            assert_eq!(
                *new_host, carol.you,
                "host transfer must pick carol (human), not the bot"
            );
            assert_ne!(*new_host, bot.you);
        }
        other => panic!("expected HostChanged, got {other:?}"),
    }
}

/// Different client_token => fresh PlayerId (control case for the test above).
#[tokio::test]
async fn rejoin_without_token_gets_fresh_player_id() {
    let h = spawn();
    // Keep a stayer in the room so it survives alice's leave.
    let mut keepalive = join_with_token(&h, "keepalive", "tok-keep").await;
    let mut alice = join_with_token(&h, "alice", "tok-alice").await;
    let original_id = alice.you;
    let _ = next_unicast(&mut keepalive.unicast_rx).await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    drain_presence(&mut keepalive.broadcast_rx, 2).await;
    drain_presence(&mut alice.broadcast_rx, 1).await;

    h.leave(alice.you).await;

    let bob = join_with_token(&h, "bob", "tok-bob").await;
    assert_ne!(
        bob.you, original_id,
        "different token should get a different PlayerId"
    );
}

// ---- room lifecycle: lobby timeout + bots-only kill ---------------------

/// Once the last human leaves, the room shuts itself down: every remaining
/// bot gets a Bye(RoomClosed) on its unicast and the room actor exits.
#[tokio::test(start_paused = true)]
async fn room_closes_when_last_human_leaves() {
    let h = spawn();
    let mut alice = join(&h, "alice").await;
    let mut bot = match h.join_as_bot(hello("BotBob")).await.unwrap() {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending { .. } => panic!("unexpected pending"),
    };
    let _ = next_unicast(&mut alice.unicast_rx).await; // welcome
    let _ = next_unicast(&mut bot.unicast_rx).await; // welcome
    drain_presence(&mut alice.broadcast_rx, 2).await;
    drain_presence(&mut bot.broadcast_rx, 1).await;

    // Alice leaves. Only the bot remains, so the room should close and the
    // bot's unicast should receive Bye(RoomClosed) shortly after.
    h.leave(alice.you).await;

    let bye = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            match bot.unicast_rx.recv().await {
                Some(m) => match m.as_ref() {
                    ServerMsg::Bye { reason } => return Some(*reason),
                    _ => continue,
                },
                None => return None,
            }
        }
    })
    .await
    .unwrap_or(None);
    assert_eq!(
        bye,
        Some(ByeReason::RoomClosed),
        "bot should receive Bye(RoomClosed) after the last human leaves"
    );
}

/// If nobody starts the game within the 120s lobby window, the room
/// shuts down and the host's unicast receives Bye(RoomClosed).
#[tokio::test(start_paused = true)]
async fn lobby_times_out_after_120s_with_no_start() {
    let h = spawn();
    let mut alice = join(&h, "alice").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    drain_presence(&mut alice.broadcast_rx, 1).await;

    // Advance well past the 120s lobby window without sending Start.
    tokio::time::advance(Duration::from_secs(125)).await;

    let bye = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            match alice.unicast_rx.recv().await {
                Some(m) => match m.as_ref() {
                    ServerMsg::Bye { reason } => return Some(*reason),
                    _ => continue,
                },
                None => return None,
            }
        }
    })
    .await
    .unwrap_or(None);
    assert_eq!(
        bye,
        Some(ByeReason::RoomClosed),
        "lobby past 120s without Start should expire and send Bye"
    );
}

/// Sending Start before the deadline should cancel the lobby expiry; the
/// room must NOT close just because 120s passed afterwards (because by then
/// we're in the middle of a game).
#[tokio::test(start_paused = true)]
async fn start_within_lobby_window_cancels_expiry() {
    let h = spawn();
    let mut alice = join(&h, "alice").await;
    let mut bob = join(&h, "bob").await;
    let _ = next_unicast(&mut alice.unicast_rx).await;
    let _ = next_unicast(&mut bob.unicast_rx).await;
    drain_presence(&mut alice.broadcast_rx, 2).await;
    drain_presence(&mut bob.broadcast_rx, 1).await;

    // 30s into the lobby window, host hits Start.
    tokio::time::advance(Duration::from_secs(30)).await;
    h.send(
        alice.you,
        ClientMsg::Game(GameAction::Start {
            mode: GameMode::Sprint,
        }),
    )
    .await;

    // Drain whatever the start emits so we don't trip a full mpsc buffer.
    // Then advance past what would have been the lobby deadline; the room
    // is in a game now, so no Bye should arrive on alice's unicast.
    let _ = tokio::time::timeout(Duration::from_millis(50), alice.unicast_rx.recv()).await;
    tokio::time::advance(Duration::from_secs(120)).await;

    // Drain non-Bye unicasts inside a short window; assert none of them is
    // a Bye(RoomClosed). The full game keeps producing word options etc.
    let saw_bye = tokio::time::timeout(Duration::from_millis(150), async {
        loop {
            match alice.unicast_rx.recv().await {
                Some(m) => {
                    if matches!(m.as_ref(), ServerMsg::Bye { .. }) {
                        return true;
                    }
                }
                None => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        !saw_bye,
        "starting the game must cancel the lobby expiry; got an unexpected Bye"
    );
}
