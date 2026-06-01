use crate::tracker::Tracker;
use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use pastel_proto::{
    decode_client_validated, encode, ByeReason, ClientMsg, Hello, RoomCode, ServerMsg,
};
use pastel_room::{ApprovalResult, JoinError, JoinOutcome, JoinResult, RoomHandle};
use tokio::sync::broadcast::error::RecvError as BroadcastRecvError;

pub async fn ws_handler(
    State(state): State<AppState>,
    Path(code): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let room_code = match RoomCode::parse(&code) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("invalid room code: {e}")).into_response();
        }
    };
    let handle = state.rooms.get_or_create(room_code);
    let tracker = state.tracker.clone();
    let code_str = code;
    ws.on_upgrade(move |socket| connection_task(socket, handle, tracker, code_str))
}

async fn connection_task(mut socket: WebSocket, room: RoomHandle, tracker: Tracker, code: String) {
    let hello = match recv_hello(&mut socket).await {
        Ok(h) => h,
        Err(err) => {
            tracing::debug!(%err, "hello handshake failed");
            let _ = send_bye(&mut socket, ByeReason::BadFrame).await;
            return;
        }
    };

    // Capture identifying fields before `hello` is consumed by `join`.
    let client_token = hello.client_token.clone();
    let player_name = hello.name.clone();

    let outcome = match room.join(hello).await {
        Ok(j) => j,
        Err(JoinError::RoomFull) => {
            let _ = send_bye(&mut socket, ByeReason::RoomFull).await;
            return;
        }
        Err(JoinError::RoomClosed) => {
            let _ = send_bye(&mut socket, ByeReason::RoomClosed).await;
            return;
        }
    };

    let join = match outcome {
        JoinOutcome::Joined(j) => j,
        JoinOutcome::Pending {
            candidate,
            approval_rx,
        } => match await_approval(&mut socket, &room, candidate, approval_rx).await {
            Some(j) => j,
            None => return,
        },
    };

    let JoinResult {
        you,
        mut unicast_rx,
        mut broadcast_rx,
    } = join;

    // Player is now admitted to the room — record the play off the hot path
    // so the remote Turso write never delays gameplay.
    tokio::spawn(async move {
        tracker
            .record_join(client_token.as_deref(), &player_name, &code)
            .await;
    });

    loop {
        tokio::select! {
            biased;

            uc = unicast_rx.recv() => match uc {
                Some(msg) => {
                    if let Err(err) = send_msg(&mut socket, &msg).await {
                        tracing::debug!(%err, "unicast send failed");
                        break;
                    }
                }
                None => break,
            },

            bc = broadcast_rx.recv() => match bc {
                Ok(msg) => {
                    if let Err(err) = send_msg(&mut socket, &msg).await {
                        tracing::debug!(%err, "broadcast send failed");
                        break;
                    }
                }
                Err(BroadcastRecvError::Lagged(n)) => {
                    tracing::debug!(skipped = n, "client lagged broadcast, closing");
                    let _ = send_bye(&mut socket, ByeReason::Reconnect).await;
                    break;
                }
                Err(BroadcastRecvError::Closed) => break,
            },

            ws_msg = socket.recv() => match ws_msg {
                Some(Ok(Message::Binary(bytes))) => match decode_client_validated(&bytes) {
                    Ok(msg) => room.send(you, msg).await,
                    Err(err) => {
                        tracing::debug!(%err, "client frame rejected");
                        let _ = send_bye(&mut socket, ByeReason::BadFrame).await;
                        break;
                    }
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(err)) => {
                    tracing::debug!(%err, "ws recv error");
                    break;
                }
                Some(Ok(_)) => {
                    // ignore text / ping / pong — axum auto-pongs.
                }
            },
        }
    }

    room.leave(you).await;
}

async fn await_approval(
    socket: &mut WebSocket,
    room: &RoomHandle,
    candidate: pastel_proto::PlayerId,
    mut approval_rx: tokio::sync::oneshot::Receiver<ApprovalResult>,
) -> Option<JoinResult> {
    if send_msg(socket, &ServerMsg::JoinPending).await.is_err() {
        room.cancel_pending(candidate).await;
        return None;
    }
    loop {
        tokio::select! {
            biased;
            res = &mut approval_rx => match res {
                Ok(ApprovalResult::Approved(j)) => return Some(j),
                Ok(ApprovalResult::Rejected) => {
                    let _ = send_bye(socket, ByeReason::Kicked).await;
                    return None;
                }
                Err(_) => {
                    // Room dropped before deciding.
                    let _ = send_bye(socket, ByeReason::RoomClosed).await;
                    return None;
                }
            },
            ws_msg = socket.recv() => match ws_msg {
                Some(Ok(Message::Close(_))) | None => {
                    room.cancel_pending(candidate).await;
                    return None;
                }
                Some(Err(_)) => {
                    room.cancel_pending(candidate).await;
                    return None;
                }
                Some(Ok(_)) => {
                    // While pending we accept no client frames; ignore.
                }
            },
        }
    }
}

async fn recv_hello(socket: &mut WebSocket) -> anyhow::Result<Hello> {
    let frame = match socket.recv().await {
        Some(Ok(m)) => m,
        Some(Err(e)) => anyhow::bail!("ws error before hello: {e}"),
        None => anyhow::bail!("socket closed before hello"),
    };
    let bytes = match frame {
        Message::Binary(b) => b,
        other => anyhow::bail!("expected binary hello, got {other:?}"),
    };
    match decode_client_validated(&bytes)? {
        ClientMsg::Hello(h) => Ok(h),
        other => anyhow::bail!("expected Hello, got {other:?}"),
    }
}

async fn send_msg(socket: &mut WebSocket, msg: &ServerMsg) -> anyhow::Result<()> {
    let bytes = encode(msg)?;
    socket.send(Message::Binary(bytes)).await?;
    Ok(())
}

async fn send_bye(socket: &mut WebSocket, reason: ByeReason) -> anyhow::Result<()> {
    send_msg(socket, &ServerMsg::Bye { reason }).await
}
