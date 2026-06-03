use pastel_proto::*;
use proptest::collection::{vec, SizeRange};
use proptest::prelude::*;

fn arb_room_code() -> impl Strategy<Value = RoomCode> {
    "[0-9A-HJKMNP-TV-Z]{6}".prop_map(|s| RoomCode::parse(&s).unwrap())
}

fn arb_name() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9_]{0,32}".prop_map(String::from)
}

fn arb_text(max: usize) -> impl Strategy<Value = String> {
    proptest::string::string_regex(&format!(".{{0,{max}}}"))
        .unwrap()
        .prop_map(move |s| {
            let mut s = s;
            while s.len() > max {
                s.pop();
            }
            s
        })
}

fn arb_point() -> impl Strategy<Value = Point> {
    (any::<i8>(), any::<i8>(), any::<u8>(), any::<u8>()).prop_map(|(dx, dy, dt, pressure)| Point {
        dx,
        dy,
        dt,
        pressure,
    })
}

fn arb_points(max: usize) -> impl Strategy<Value = Vec<Point>> {
    vec(arb_point(), SizeRange::from(0..=max))
}

fn arb_avatar() -> impl Strategy<Value = Avatar> {
    (
        0u8..=AVATAR_MAX_SKIN,
        0u8..=AVATAR_MAX_HAT,
        0u8..=AVATAR_MAX_HAIR,
        0u8..=AVATAR_MAX_EYES,
        0u8..=AVATAR_MAX_MOUTH,
        0u8..=AVATAR_MAX_SPECS,
        0u8..=AVATAR_MAX_EARRINGS,
    )
        .prop_map(|(skin, hat, hair, eyes, mouth, specs, earrings)| Avatar {
            skin,
            hat,
            hair,
            eyes,
            mouth,
            specs,
            earrings,
        })
}

fn arb_player() -> impl Strategy<Value = Player> {
    (any::<u32>(), arb_name(), arb_avatar(), any::<bool>()).prop_map(
        |(id, name, avatar, is_bot)| Player {
            id,
            name,
            avatar,
            is_bot,
        },
    )
}

// Realistic, not pathological. These bounds keep every generated message
// inside MAX_FRAME_BYTES even when nested inside a Resume.
const PROPTEST_POINTS_PER_COMPLETED_STROKE: usize = 64;
const PROPTEST_STROKES_PER_SNAPSHOT: usize = 8;
const PROPTEST_LK_TOKEN_LEN: usize = 128;
const PROPTEST_RESUME_EVENTS: usize = 4;

fn arb_completed_stroke() -> impl Strategy<Value = CompletedStroke> {
    (
        any::<u32>(),
        any::<u32>(),
        (any::<u16>(), any::<u16>()),
        0u32..=0xffffff,
        any::<u8>(),
        arb_points(PROPTEST_POINTS_PER_COMPLETED_STROKE),
    )
        .prop_map(
            |(player, stroke_id, origin, color, width, points)| CompletedStroke {
                player,
                stroke_id,
                origin,
                color,
                width,
                points,
            },
        )
}

fn arb_chat_line() -> impl Strategy<Value = ChatLine> {
    (any::<u64>(), any::<u32>(), arb_text(MAX_CHAT_LEN)).prop_map(|(seq, player, text)| ChatLine {
        seq,
        player,
        text,
    })
}

fn arb_game_phase_snapshot() -> impl Strategy<Value = GamePhaseSnapshot> {
    prop_oneof![
        proptest::option::of(any::<u32>())
            .prop_map(|deadline_ms| GamePhaseSnapshot::Lobby { deadline_ms }),
        (any::<u32>(), any::<u32>(), any::<u8>(), any::<u8>()).prop_map(
            |(drawer, deadline_ms, round_index, total_rounds)| {
                GamePhaseSnapshot::ChoosingWord {
                    drawer,
                    deadline_ms,
                    round_index,
                    total_rounds,
                }
            },
        ),
        (
            any::<u32>(),
            arb_text(MAX_WORD_LEN),
            any::<u32>(),
            any::<u8>(),
            any::<u8>(),
        )
            .prop_map(|(drawer, mask, deadline_ms, round_index, total_rounds)| {
                GamePhaseSnapshot::Drawing {
                    drawer,
                    mask,
                    deadline_ms,
                    round_index,
                    total_rounds,
                }
            },),
        (arb_text(MAX_WORD_LEN), any::<u32>())
            .prop_map(|(word, deadline_ms)| { GamePhaseSnapshot::RoundEnd { word, deadline_ms } }),
        Just(GamePhaseSnapshot::GameOver),
    ]
}

fn arb_game_snapshot() -> impl Strategy<Value = GameSnapshot> {
    (
        arb_game_mode(),
        proptest::option::of(any::<u32>()),
        vec((any::<u32>(), any::<u32>()), 0..=MAX_PLAYERS_PER_ROOM),
        arb_game_phase_snapshot(),
    )
        .prop_map(|(mode, host, scores, phase)| GameSnapshot {
            mode,
            host,
            scores,
            phase,
        })
}

fn arb_snapshot() -> impl Strategy<Value = RoomSnapshot> {
    (
        vec(arb_player(), 0..=MAX_PLAYERS_PER_ROOM),
        vec(arb_completed_stroke(), 0..=PROPTEST_STROKES_PER_SNAPSHOT),
        any::<u64>(),
        vec(arb_chat_line(), 0..=8),
        arb_game_snapshot(),
    )
        .prop_map(|(players, completed, seq, chat, game)| RoomSnapshot {
            players,
            completed,
            seq,
            chat,
            game,
        })
}

fn arb_hello() -> impl Strategy<Value = Hello> {
    (
        arb_room_code(),
        arb_name(),
        proptest::option::of(any::<u64>()),
        proptest::option::of(arb_text(MAX_CLIENT_TOKEN_LEN)),
        arb_avatar(),
    )
        .prop_map(|(room, name, resume_from, client_token, avatar)| Hello {
            room,
            name,
            resume_from,
            client_token,
            avatar,
        })
}

fn arb_game_mode() -> impl Strategy<Value = GameMode> {
    prop_oneof![
        Just(GameMode::Sprint),
        Just(GameMode::Standard),
        Just(GameMode::Marathon),
    ]
}

fn arb_game_action() -> impl Strategy<Value = GameAction> {
    prop_oneof![
        arb_game_mode().prop_map(|mode| GameAction::Start { mode }),
        any::<u8>().prop_map(GameAction::PickWord),
        any::<u32>().prop_map(GameAction::Kick),
        Just(GameAction::Clear),
        any::<u32>().prop_map(GameAction::ApproveJoin),
        any::<u32>().prop_map(GameAction::RejectJoin),
    ]
}

fn arb_game_event() -> impl Strategy<Value = GameEvent> {
    prop_oneof![
        (
            any::<u32>(),
            arb_text(MAX_WORD_LEN),
            any::<u32>(),
            any::<u8>(),
            any::<u8>()
        )
            .prop_map(
                |(drawer, word_mask, duration_ms, round_index, total_rounds)| {
                    GameEvent::RoundStart {
                        drawer,
                        word_mask,
                        duration_ms,
                        round_index,
                        total_rounds,
                    }
                }
            ),
        (
            arb_text(MAX_WORD_LEN),
            vec((any::<u32>(), any::<u32>()), 0..=MAX_PLAYERS_PER_ROOM),
            any::<u16>(),
        )
            .prop_map(|(word, scores, turn)| GameEvent::RoundEnd { word, scores, turn }),
        vec((any::<u32>(), any::<u32>()), 0..=MAX_PLAYERS_PER_ROOM)
            .prop_map(|final_scores| GameEvent::GameOver { final_scores }),
        any::<u32>().prop_map(|by| GameEvent::Cleared { by }),
        (any::<u32>(), any::<u32>(), any::<u8>(), any::<u8>()).prop_map(
            |(drawer, deadline_ms, round_index, total_rounds)| GameEvent::WordPickStarted {
                drawer,
                deadline_ms,
                round_index,
                total_rounds,
            },
        ),
        arb_text(MAX_WORD_LEN).prop_map(|mask| GameEvent::HintReveal { mask }),
        (any::<u32>(), arb_name())
            .prop_map(|(candidate, name)| GameEvent::JoinRequest { candidate, name }),
        any::<u32>().prop_map(|candidate| GameEvent::JoinCanceled { candidate }),
        any::<u32>().prop_map(|new_host| GameEvent::HostChanged { new_host }),
    ]
}

fn arb_guess_kind() -> impl Strategy<Value = GuessKind> {
    prop_oneof![Just(GuessKind::Correct), Just(GuessKind::Close)]
}

fn arb_bye_reason() -> impl Strategy<Value = ByeReason> {
    prop_oneof![
        Just(ByeReason::Reconnect),
        Just(ByeReason::Kicked),
        Just(ByeReason::RoomClosed),
        Just(ByeReason::RoomFull),
        Just(ByeReason::BadFrame),
    ]
}

fn arb_client_msg() -> impl Strategy<Value = ClientMsg> {
    prop_oneof![
        arb_hello().prop_map(ClientMsg::Hello),
        (
            any::<u32>(),
            (any::<u16>(), any::<u16>()),
            0u32..=0xffffff,
            any::<u8>(),
            arb_points(MAX_POINTS_PER_BATCH),
            any::<bool>(),
        )
            .prop_map(|(stroke_id, origin, color, width, points, finished)| {
                ClientMsg::Stroke {
                    stroke_id,
                    origin,
                    color,
                    width,
                    points,
                    finished,
                }
            }),
        arb_text(MAX_CHAT_LEN).prop_map(|text| ClientMsg::Chat { text }),
        arb_text(MAX_GUESS_LEN).prop_map(|text| ClientMsg::Guess { text }),
        arb_game_action().prop_map(ClientMsg::Game),
        any::<u32>().prop_map(|nonce| ClientMsg::Pong { nonce }),
    ]
}

fn arb_server_leaf_msg() -> impl Strategy<Value = ServerMsg> {
    prop_oneof![
        (
            any::<u32>(),
            arb_snapshot(),
            any::<u64>(),
            arb_text(PROPTEST_LK_TOKEN_LEN)
        )
            .prop_map(|(you, snapshot, seq, lk_token)| ServerMsg::Welcome {
                you,
                snapshot,
                seq,
                lk_token,
            }),
        (
            any::<u64>(),
            any::<u32>(),
            any::<u32>(),
            (any::<u16>(), any::<u16>()),
            0u32..=0xffffff,
            any::<u8>(),
            arb_points(MAX_POINTS_PER_BATCH),
            any::<bool>(),
        )
            .prop_map(
                |(seq, player, stroke_id, origin, color, width, points, finished)| {
                    ServerMsg::Stroke {
                        seq,
                        player,
                        stroke_id,
                        origin,
                        color,
                        width,
                        points,
                        finished,
                    }
                },
            ),
        (any::<u64>(), any::<u32>(), arb_text(MAX_CHAT_LEN))
            .prop_map(|(seq, player, text)| ServerMsg::Chat { seq, player, text }),
        (any::<u64>(), any::<u32>(), arb_guess_kind())
            .prop_map(|(seq, player, kind)| ServerMsg::Guess { seq, player, kind }),
        (
            any::<u64>(),
            vec(arb_player(), 0..=MAX_PLAYERS_PER_ROOM),
            vec(any::<u32>(), 0..=MAX_PLAYERS_PER_ROOM),
        )
            .prop_map(|(seq, joined, left)| ServerMsg::Presence { seq, joined, left }),
        (any::<u64>(), arb_game_event()).prop_map(|(seq, event)| ServerMsg::Game { seq, event }),
        any::<u32>().prop_map(|nonce| ServerMsg::Ping { nonce }),
        arb_bye_reason().prop_map(|reason| ServerMsg::Bye { reason }),
        (
            vec(arb_text(MAX_WORD_LEN), 0..=MAX_WORD_OPTIONS),
            any::<u32>()
        )
            .prop_map(|(words, deadline_ms)| ServerMsg::WordOptions { words, deadline_ms },),
        (arb_text(MAX_WORD_LEN), any::<u32>())
            .prop_map(|(word, duration_ms)| ServerMsg::DrawerWord { word, duration_ms }),
        Just(ServerMsg::JoinPending),
    ]
}

fn arb_server_msg() -> impl Strategy<Value = ServerMsg> {
    prop_oneof![
        arb_server_leaf_msg(),
        vec(arb_server_leaf_msg(), 0..=PROPTEST_RESUME_EVENTS)
            .prop_map(|events| ServerMsg::Resume { events }),
    ]
}

proptest! {
    #[test]
    fn round_trip_client_msg(msg in arb_client_msg()) {
        let bytes = encode(&msg).unwrap();
        let back: ClientMsg = decode(&bytes).unwrap();
        prop_assert_eq!(msg, back);
    }

    #[test]
    fn round_trip_server_msg(msg in arb_server_msg()) {
        let bytes = encode(&msg).unwrap();
        let back: ServerMsg = decode(&bytes).unwrap();
        prop_assert_eq!(msg, back);
    }

    #[test]
    fn validated_decode_accepts_well_formed_client(msg in arb_client_msg()) {
        let bytes = encode(&msg).unwrap();
        let back = decode_client_validated(&bytes).unwrap();
        prop_assert_eq!(msg, back);
    }

    #[test]
    fn validated_decode_accepts_well_formed_server(msg in arb_server_msg()) {
        let bytes = encode(&msg).unwrap();
        let back = decode_server_validated(&bytes).unwrap();
        prop_assert_eq!(msg, back);
    }

    #[test]
    fn room_code_round_trip(code in arb_room_code()) {
        let s = code.to_string();
        let back = RoomCode::parse(&s).unwrap();
        prop_assert_eq!(code, back);
    }
}

#[test]
fn validation_rejects_oversize_chat() {
    let too_long = "a".repeat(MAX_CHAT_LEN + 1);
    let msg = ClientMsg::Chat { text: too_long };
    let bytes = encode(&msg).unwrap();
    let err = decode_client_validated(&bytes).unwrap_err();
    assert!(matches!(err, CodecError::FieldTooLong { field, .. } if field == "chat.text"));
}

#[test]
fn validation_rejects_oversize_stroke_batch() {
    let msg = ClientMsg::Stroke {
        stroke_id: 1,
        origin: (0, 0),
        color: 0,
        width: 4,
        points: vec![
            Point {
                dx: 0,
                dy: 0,
                dt: 0,
                pressure: 0
            };
            MAX_POINTS_PER_BATCH + 1
        ],
        finished: false,
    };
    let bytes = encode(&msg).unwrap();
    let err = decode_client_validated(&bytes).unwrap_err();
    assert!(matches!(err, CodecError::FieldTooLong { field, .. } if field == "stroke.points"));
}

#[test]
fn validation_rejects_oversize_name() {
    let msg = ClientMsg::Hello(Hello {
        room: RoomCode::parse("ABC234").unwrap(),
        name: "a".repeat(MAX_NAME_LEN + 1),
        resume_from: None,
        client_token: None,
        avatar: Avatar::default(),
    });
    let bytes = encode(&msg).unwrap();
    let err = decode_client_validated(&bytes).unwrap_err();
    assert!(matches!(err, CodecError::FieldTooLong { field, .. } if field == "hello.name"));
}

#[test]
fn validation_rejects_avatar_out_of_range() {
    let msg = ClientMsg::Hello(Hello {
        room: RoomCode::parse("ABC234").unwrap(),
        name: "alice".into(),
        resume_from: None,
        client_token: None,
        avatar: Avatar {
            skin: AVATAR_MAX_SKIN + 1,
            ..Avatar::default()
        },
    });
    let bytes = encode(&msg).unwrap();
    let err = decode_client_validated(&bytes).unwrap_err();
    assert!(matches!(
        err,
        CodecError::AvatarPartOutOfRange { field: "skin", .. }
    ));
}

#[test]
fn validation_rejects_oversize_frame() {
    let huge = vec![0u8; MAX_FRAME_BYTES + 1];
    let err = decode::<ClientMsg>(&huge).unwrap_err();
    assert!(matches!(err, CodecError::FrameTooLarge(_)));
}

#[test]
fn validation_rejects_nested_resume() {
    let inner = ServerMsg::Resume {
        events: vec![ServerMsg::Ping { nonce: 1 }],
    };
    let outer = ServerMsg::Resume {
        events: vec![inner],
    };
    let bytes = encode(&outer).unwrap();
    let err = decode_server_validated(&bytes).unwrap_err();
    assert!(matches!(err, CodecError::ResumeTooDeep));
}

#[test]
fn stroke_batch_size_budget() {
    let msg = ClientMsg::Stroke {
        stroke_id: 7,
        origin: (320, 240),
        color: 0xd62828,
        width: 4,
        points: vec![
            Point {
                dx: 1,
                dy: -2,
                dt: 16,
                pressure: 200
            };
            30
        ],
        finished: false,
    };
    let bytes = encode(&msg).unwrap();
    assert!(
        bytes.len() < 150,
        "30-point batch was {} bytes",
        bytes.len()
    );
}

#[test]
fn stroke_batch_worst_case_size_budget() {
    let msg = ClientMsg::Stroke {
        stroke_id: u32::MAX,
        origin: (u16::MAX, u16::MAX),
        color: 0xffffff,
        width: 255,
        points: vec![
            Point {
                dx: 127,
                dy: -128,
                dt: 255,
                pressure: 255
            };
            MAX_POINTS_PER_BATCH
        ],
        finished: true,
    };
    let bytes = encode(&msg).unwrap();
    assert!(
        bytes.len() < 320,
        "{}-point worst-case batch was {} bytes",
        MAX_POINTS_PER_BATCH,
        bytes.len()
    );
}

#[test]
fn chat_minimum_size_budget() {
    let msg = ClientMsg::Chat { text: "hi".into() };
    let bytes = encode(&msg).unwrap();
    assert!(bytes.len() < 8, "chat 'hi' was {} bytes", bytes.len());
}
