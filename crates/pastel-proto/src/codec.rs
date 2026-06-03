use crate::limits::*;
use crate::msg::{ClientMsg, ServerMsg};
use crate::types::Avatar;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("postcard: {0}")]
    Postcard(#[from] postcard::Error),
    #[error("frame is {0} bytes, exceeds limit {MAX_FRAME_BYTES}")]
    FrameTooLarge(usize),
    #[error("{field} length {len} exceeds limit {max}")]
    FieldTooLong {
        field: &'static str,
        len: usize,
        max: usize,
    },
    #[error("avatar.{field}={value} exceeds limit {max}")]
    AvatarPartOutOfRange {
        field: &'static str,
        value: u8,
        max: u8,
    },
    #[error("resume events nested too deep")]
    ResumeTooDeep,
}

pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, CodecError> {
    Ok(postcard::to_allocvec(msg)?)
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, CodecError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(CodecError::FrameTooLarge(bytes.len()));
    }
    Ok(postcard::from_bytes(bytes)?)
}

pub fn decode_client_validated(bytes: &[u8]) -> Result<ClientMsg, CodecError> {
    let msg: ClientMsg = decode(bytes)?;
    validate_client(&msg)?;
    Ok(msg)
}

pub fn decode_server_validated(bytes: &[u8]) -> Result<ServerMsg, CodecError> {
    let msg: ServerMsg = decode(bytes)?;
    validate_server(&msg, 0)?;
    Ok(msg)
}

pub fn validate_client(msg: &ClientMsg) -> Result<(), CodecError> {
    match msg {
        ClientMsg::Hello(h) => {
            check_len("hello.name", h.name.len(), MAX_NAME_LEN)?;
            if let Some(t) = &h.client_token {
                check_len("hello.client_token", t.len(), MAX_CLIENT_TOKEN_LEN)?;
            }
            validate_avatar(&h.avatar)?;
        }
        ClientMsg::Stroke { points, .. } => {
            check_len("stroke.points", points.len(), MAX_POINTS_PER_BATCH)?;
        }
        ClientMsg::Chat { text } => {
            check_len("chat.text", text.len(), MAX_CHAT_LEN)?;
        }
        ClientMsg::Guess { text } => {
            check_len("guess.text", text.len(), MAX_GUESS_LEN)?;
        }
        ClientMsg::Game(_)
        | ClientMsg::Pong { .. }
        | ClientMsg::React { .. }
        | ClientMsg::Undo
        | ClientMsg::Emote { .. }
        | ClientMsg::Vote { .. } => {}
    }
    Ok(())
}

const MAX_RESUME_NESTING: u8 = 1;

pub fn validate_server(msg: &ServerMsg, depth: u8) -> Result<(), CodecError> {
    match msg {
        ServerMsg::Welcome {
            snapshot, lk_token, ..
        } => {
            check_len(
                "welcome.snapshot.completed",
                snapshot.completed.len(),
                MAX_STROKES_PER_SNAPSHOT,
            )?;
            check_len(
                "welcome.snapshot.players",
                snapshot.players.len(),
                MAX_PLAYERS_PER_ROOM,
            )?;
            check_len("welcome.lk_token", lk_token.len(), MAX_LK_TOKEN_LEN)?;
            for p in &snapshot.players {
                validate_avatar(&p.avatar)?;
            }
            for s in &snapshot.completed {
                check_len(
                    "completed_stroke.points",
                    s.points.len(),
                    MAX_POINTS_PER_BATCH * 16,
                )?;
            }
            check_len(
                "welcome.snapshot.chat",
                snapshot.chat.len(),
                MAX_CHAT_HISTORY,
            )?;
            for line in &snapshot.chat {
                check_len("chat_line.text", line.text.len(), MAX_CHAT_LEN)?;
            }
        }
        ServerMsg::Resume { events } => {
            if depth >= MAX_RESUME_NESTING {
                return Err(CodecError::ResumeTooDeep);
            }
            check_len("resume.events", events.len(), MAX_RESUME_EVENTS)?;
            for e in events {
                validate_server(e, depth + 1)?;
            }
        }
        ServerMsg::Stroke { points, .. } => {
            check_len("stroke.points", points.len(), MAX_POINTS_PER_BATCH)?;
        }
        ServerMsg::Chat { text, .. } => {
            check_len("chat.text", text.len(), MAX_CHAT_LEN)?;
        }
        ServerMsg::Presence { joined, left, .. } => {
            check_len("presence.joined", joined.len(), MAX_PLAYERS_PER_ROOM)?;
            check_len("presence.left", left.len(), MAX_PLAYERS_PER_ROOM)?;
            for p in joined {
                validate_avatar(&p.avatar)?;
            }
        }
        ServerMsg::Game { event, .. } => match event {
            crate::msg::GameEvent::RoundStart { word_mask, .. } => {
                check_len("round_start.word_mask", word_mask.len(), MAX_WORD_LEN)?;
            }
            crate::msg::GameEvent::RoundEnd { word, scores, .. } => {
                check_len("round_end.word", word.len(), MAX_WORD_LEN)?;
                check_len("round_end.scores", scores.len(), MAX_PLAYERS_PER_ROOM)?;
            }
            crate::msg::GameEvent::GameOver { final_scores } => {
                check_len(
                    "game_over.final_scores",
                    final_scores.len(),
                    MAX_PLAYERS_PER_ROOM,
                )?;
            }
            crate::msg::GameEvent::Cleared { .. } => {}
            crate::msg::GameEvent::WordPickStarted { .. } => {}
            crate::msg::GameEvent::HintReveal { mask } => {
                check_len("hint_reveal.mask", mask.len(), MAX_WORD_LEN)?;
            }
            crate::msg::GameEvent::JoinRequest { name, .. } => {
                check_len("join_request.name", name.len(), MAX_NAME_LEN)?;
            }
            crate::msg::GameEvent::JoinCanceled { .. } => {}
            crate::msg::GameEvent::HostChanged { .. } => {}
            crate::msg::GameEvent::Reaction { .. } => {}
            crate::msg::GameEvent::StrokeRemoved { .. } => {}
            crate::msg::GameEvent::VotingOpen { .. } => {}
            crate::msg::GameEvent::VoteResult { tally, winner } => {
                check_len("vote_result.tally", tally.len(), MAX_PLAYERS_PER_ROOM * 8)?;
                if let Some(w) = winner {
                    check_len("vote_result.winner.word", w.word.len(), MAX_WORD_LEN)?;
                }
            }
        },
        ServerMsg::WordOptions { words, .. } => {
            check_len("word_options.words", words.len(), MAX_WORD_OPTIONS)?;
            for w in words {
                check_len("word_options.words[i]", w.len(), MAX_WORD_LEN)?;
            }
        }
        ServerMsg::DrawerWord { word, .. } => {
            check_len("drawer_word.word", word.len(), MAX_WORD_LEN)?;
        }
        ServerMsg::JoinPending
        | ServerMsg::Guess { .. }
        | ServerMsg::Ping { .. }
        | ServerMsg::Bye { .. }
        | ServerMsg::DrawingFeedback { .. }
        | ServerMsg::Emote { .. } => {}
    }
    Ok(())
}

fn check_len(field: &'static str, len: usize, max: usize) -> Result<(), CodecError> {
    if len > max {
        Err(CodecError::FieldTooLong { field, len, max })
    } else {
        Ok(())
    }
}

fn check_part(field: &'static str, value: u8, max: u8) -> Result<(), CodecError> {
    if value > max {
        Err(CodecError::AvatarPartOutOfRange { field, value, max })
    } else {
        Ok(())
    }
}

pub fn validate_avatar(a: &Avatar) -> Result<(), CodecError> {
    check_part("skin", a.skin, AVATAR_MAX_SKIN)?;
    check_part("hat", a.hat, AVATAR_MAX_HAT)?;
    check_part("hair", a.hair, AVATAR_MAX_HAIR)?;
    check_part("eyes", a.eyes, AVATAR_MAX_EYES)?;
    check_part("mouth", a.mouth, AVATAR_MAX_MOUTH)?;
    check_part("specs", a.specs, AVATAR_MAX_SPECS)?;
    check_part("earrings", a.earrings, AVATAR_MAX_EARRINGS)?;
    Ok(())
}
