use futures_util::{SinkExt, StreamExt};
use voxi_proto::*;
use voxi_server::{build_router, AppState};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as TungMsg;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const RECV_TIMEOUT: Duration = Duration::from_millis(500);

async fn spawn_server() -> SocketAddr {
    let app = build_router(AppState::with_test_words());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

async fn connect(addr: SocketAddr, code: &str) -> Client {
    let url = format!("ws://{addr}/ws/{code}");
    let (ws, _resp) = connect_async(&url).await.expect("ws connect");
    ws
}

async fn send_client(ws: &mut Client, msg: ClientMsg) {
    let bytes = encode(&msg).expect("encode");
    ws.send(TungMsg::Binary(bytes)).await.expect("ws send");
}

async fn recv_server(ws: &mut Client) -> ServerMsg {
    let frame = tokio::time::timeout(RECV_TIMEOUT, ws.next())
        .await
        .expect("recv timeout")
        .expect("stream ended")
        .expect("ws error");
    match frame {
        TungMsg::Binary(bytes) => decode::<ServerMsg>(&bytes).expect("decode"),
        other => panic!("unexpected ws frame: {other:?}"),
    }
}

async fn try_recv_server(ws: &mut Client) -> Option<ServerMsg> {
    let frame = tokio::time::timeout(Duration::from_millis(50), ws.next())
        .await
        .ok()?;
    let frame = frame?.ok()?;
    if let TungMsg::Binary(bytes) = frame {
        decode::<ServerMsg>(&bytes).ok()
    } else {
        None
    }
}

fn hello(name: &str) -> ClientMsg {
    ClientMsg::Hello(Hello {
        room: RoomCode::parse("ABC234").unwrap(),
        name: name.into(),
        resume_from: None,
        client_token: None,
        avatar: Avatar::default(),
    })
}

async fn drain_until_presence_for(ws: &mut Client, expected_name: &str) {
    loop {
        match recv_server(ws).await {
            ServerMsg::Welcome { .. } => continue,
            ServerMsg::Presence { joined, .. }
                if joined.iter().any(|p| p.name == expected_name) =>
            {
                return
            }
            ServerMsg::Presence { .. } => continue,
            other => panic!("unexpected msg while waiting for presence: {other:?}"),
        }
    }
}

#[tokio::test]
async fn healthz_returns_ok() {
    let addr = spawn_server().await;
    let body = reqwest_get(&format!("http://{addr}/healthz")).await;
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn metrics_exposes_room_count() {
    let addr = spawn_server().await;
    // Touch a room first via WS connect+hello.
    let mut a = connect(addr, "ABC234").await;
    send_client(&mut a, hello("alice")).await;
    let _ = recv_server(&mut a).await; // Welcome

    let body = reqwest_get(&format!("http://{addr}/metrics")).await;
    assert!(
        body.contains("voxi_rooms_active 1"),
        "metrics did not report 1 active room:\n{body}"
    );
}

#[tokio::test]
async fn rejects_invalid_room_code() {
    let addr = spawn_server().await;
    let result = connect_async(format!("ws://{addr}/ws/!!!")).await;
    assert!(result.is_err(), "expected ws upgrade to fail");
}

#[tokio::test]
async fn welcome_contains_assigned_player_id() {
    let addr = spawn_server().await;
    let mut a = connect(addr, "ABC234").await;
    send_client(&mut a, hello("alice")).await;
    match recv_server(&mut a).await {
        ServerMsg::Welcome { you, snapshot, .. } => {
            assert_ne!(you, 0);
            assert!(snapshot.players.is_empty());
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

#[tokio::test]
async fn two_clients_exchange_strokes() {
    let addr = spawn_server().await;

    let mut a = connect(addr, "ABC234").await;
    send_client(&mut a, hello("alice")).await;
    let alice_id = match recv_server(&mut a).await {
        ServerMsg::Welcome { you, .. } => you,
        other => panic!("alice welcome: {other:?}"),
    };

    let mut b = connect(addr, "ABC234").await;
    send_client(&mut b, hello("bob")).await;
    match recv_server(&mut b).await {
        ServerMsg::Welcome { snapshot, .. } => {
            assert_eq!(snapshot.players.len(), 1);
            assert_eq!(snapshot.players[0].name, "alice");
        }
        other => panic!("bob welcome: {other:?}"),
    }

    // Both clients drain presence until bob's join is visible on alice.
    drain_until_presence_for(&mut a, "bob").await;
    drain_until_presence_for(&mut b, "bob").await;

    // Alice draws.
    send_client(
        &mut a,
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

    // Both see the stroke broadcast (drawer included by design).
    for ws in [&mut a, &mut b] {
        match recv_server(ws).await {
            ServerMsg::Stroke {
                player,
                stroke_id,
                color,
                width,
                points,
                ..
            } => {
                assert_eq!(player, alice_id);
                assert_eq!(stroke_id, 1);
                assert_eq!(color, 0xd62828);
                assert_eq!(width, 4);
                assert_eq!(points.len(), 1);
            }
            other => panic!("expected Stroke, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn bad_frame_is_rejected_with_bye() {
    let addr = spawn_server().await;
    let mut a = connect(addr, "ABC234").await;
    // Send junk before Hello.
    a.send(TungMsg::Binary(vec![0xff; 8])).await.unwrap();

    match recv_server(&mut a).await {
        ServerMsg::Bye { reason } => assert_eq!(reason, ByeReason::BadFrame),
        other => panic!("expected Bye(BadFrame), got {other:?}"),
    }
}

/// Tiny `reqwest`-style GET without adding the dependency.
async fn reqwest_get(url: &str) -> String {
    let url = url.strip_prefix("http://").expect("http url");
    let (host_port, path) = url
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap();
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let body_start = text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
    text[body_start..].to_string()
}

#[allow(dead_code)]
async fn drain_one(ws: &mut Client) -> Option<ServerMsg> {
    try_recv_server(ws).await
}

/// Tiny raw-TCP JSON POST (no reqwest dep).
async fn http_post(url: &str, body: &str) -> String {
    let url = url.strip_prefix("http://").expect("http url");
    let (host_port, path) = url
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap();
    let mut stream = tokio::net::TcpStream::connect(host_port).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host_port}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let body_start = text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
    text[body_start..].to_string()
}

#[tokio::test]
async fn matchmake_returns_a_valid_joinable_code() {
    let addr = spawn_server().await;
    // size 4, 3 bots -> 1 human seat, so the table forms + a room is minted.
    let body = http_post(
        &format!("http://{addr}/matchmake"),
        r#"{"size":4,"bots":3}"#,
    )
    .await;
    // Body is {"code":"XXXXXX"}; pull the code out without a json dep.
    let code = body
        .split_once("\"code\":\"")
        .and_then(|(_, rest)| rest.split('"').next())
        .expect("code field")
        .to_string();
    assert_eq!(code.len(), 6, "6-char room code, got {code:?}");
    assert!(RoomCode::parse(&code).is_ok(), "code parses: {code}");

    // The minted room is real: /metrics should show at least one active room.
    let metrics = reqwest_get(&format!("http://{addr}/metrics")).await;
    assert!(
        metrics.contains("voxi_rooms_active 1") || metrics.contains("voxi_rooms_active 2"),
        "a room was created: {metrics}"
    );

    // And it's joinable over the normal WS path.
    let _ws = connect(addr, &code).await;
}

#[tokio::test]
async fn matchmake_rejects_bad_size() {
    let addr = spawn_server().await;
    let body = http_post(
        &format!("http://{addr}/matchmake"),
        r#"{"size":3,"bots":0}"#,
    )
    .await;
    assert!(
        body.to_lowercase().contains("size must be"),
        "bad size rejected: {body}"
    );
}
