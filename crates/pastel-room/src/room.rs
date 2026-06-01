use crate::bucket::TokenBucket;
use crate::game::{
    build_mask, drawer_bonus, guess_score, is_close_guess, max_hints, message_leaks_word,
    pick_hint_index, ranked_scores, reveal_at, DRAW_WINDOW, HINT_REMAINING_SECS, PICK_WINDOW,
    ROUND_REVEAL,
};
use crate::words::{Difficulty, SharedWords};
use crate::{
    BROADCAST_CAPACITY, CHAT_RING, COMMAND_INBOX_CAPACITY, COMPLETED_STROKES_RING, UNICAST_CAPACITY,
};
use ahash::AHashMap;
use pastel_proto::*;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::Instant;

const CHAT_BUCKET_CAPACITY: f32 = 5.0;
const CHAT_REFILL_PER_SEC: f32 = 5.0 / 3.0;
const GUESS_BUCKET_CAPACITY: f32 = 10.0;
const GUESS_REFILL_PER_SEC: f32 = 10.0 / 3.0;

/// How long a freshly-created room sits in Lobby before being torn down
/// if nobody hits Start. Releases the room code so someone else can claim
/// it instead of letting it squat indefinitely.
const LOBBY_TIMEOUT: Duration = Duration::from_secs(120);

pub enum RoomCmd {
    Join {
        hello: Hello,
        reply: oneshot::Sender<Result<JoinOutcome, JoinError>>,
    },
    JoinBot {
        hello: Hello,
        reply: oneshot::Sender<Result<JoinOutcome, JoinError>>,
    },
    Leave {
        player: PlayerId,
    },
    CancelPending {
        candidate: PlayerId,
    },
    FromClient {
        player: PlayerId,
        msg: ClientMsg,
    },
    /// Test-only: inject a Drawing phase with the given drawer + word so guess
    /// tests can run without driving a full game start.
    SetSecret {
        drawer: PlayerId,
        word: String,
    },
}

pub struct JoinResult {
    pub you: PlayerId,
    pub unicast_rx: mpsc::Receiver<Arc<ServerMsg>>,
    pub broadcast_rx: broadcast::Receiver<Arc<ServerMsg>>,
}

/// Either an immediate join, or a pending request that needs host approval.
/// Pending is only used when a previously-kicked client_token tries to rejoin.
pub enum JoinOutcome {
    Joined(JoinResult),
    Pending {
        candidate: PlayerId,
        approval_rx: oneshot::Receiver<ApprovalResult>,
    },
}

pub enum ApprovalResult {
    Approved(JoinResult),
    Rejected,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JoinError {
    #[error("room is full")]
    RoomFull,
    #[error("room is closed")]
    RoomClosed,
}

#[derive(Clone)]
pub struct RoomHandle {
    cmd_tx: mpsc::Sender<RoomCmd>,
}

impl RoomHandle {
    pub async fn join(&self, hello: Hello) -> Result<JoinOutcome, JoinError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(RoomCmd::Join { hello, reply: tx })
            .await
            .map_err(|_| JoinError::RoomClosed)?;
        rx.await.map_err(|_| JoinError::RoomClosed)?
    }

    pub async fn send(&self, player: PlayerId, msg: ClientMsg) {
        let _ = self.cmd_tx.send(RoomCmd::FromClient { player, msg }).await;
    }

    pub async fn leave(&self, player: PlayerId) {
        let _ = self.cmd_tx.send(RoomCmd::Leave { player }).await;
    }

    pub async fn join_as_bot(&self, hello: Hello) -> Result<JoinOutcome, JoinError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(RoomCmd::JoinBot { hello, reply: tx })
            .await
            .map_err(|_| JoinError::RoomClosed)?;
        rx.await.map_err(|_| JoinError::RoomClosed)?
    }

    pub async fn cancel_pending(&self, candidate: PlayerId) {
        let _ = self.cmd_tx.send(RoomCmd::CancelPending { candidate }).await;
    }

    pub async fn set_secret(&self, drawer: PlayerId, word: impl Into<String>) {
        let _ = self
            .cmd_tx
            .send(RoomCmd::SetSecret {
                drawer,
                word: word.into(),
            })
            .await;
    }
}

pub fn spawn_room(code: RoomCode, words: SharedWords) -> RoomHandle {
    spawn_room_inner(code, words, None)
}

/// Spawn a room with a registry-eviction callback. The callback fires once
/// when the room shuts down (lobby timeout or last-human leaves), letting
/// the caller drop the entry so the code becomes reusable.
pub fn spawn_room_with_evictor<F: FnOnce() + Send + 'static>(
    code: RoomCode,
    words: SharedWords,
    on_close: F,
) -> RoomHandle {
    spawn_room_inner(code, words, Some(Box::new(on_close)))
}

fn spawn_room_inner(
    code: RoomCode,
    words: SharedWords,
    on_close: Option<Box<dyn FnOnce() + Send>>,
) -> RoomHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_INBOX_CAPACITY);
    let (bc_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let mut room = Room::new(code, bc_tx, words);
    room.on_close = on_close;
    // First-human deadline ticks from spawn; if nobody starts within
    // LOBBY_TIMEOUT the room shuts itself down.
    room.game.lobby_deadline = Some(Instant::now() + LOBBY_TIMEOUT);
    tokio::spawn(room.run(cmd_rx));
    RoomHandle { cmd_tx }
}

struct PlayerSlot {
    name: String,
    unicast_tx: mpsc::Sender<Arc<ServerMsg>>,
    chat_bucket: TokenBucket,
    guess_bucket: TokenBucket,
    client_token: Option<String>,
    avatar: Avatar,
    is_bot: bool,
}

struct PendingJoiner {
    name: String,
    client_token: String,
    avatar: Avatar,
    reply_tx: oneshot::Sender<ApprovalResult>,
}

#[derive(Default)]
struct InProgressStroke {
    origin: (u16, u16),
    color: u32,
    width: u8,
    points: Vec<Point>,
}

#[allow(clippy::large_enum_variant)]
enum GamePhase {
    Lobby,
    ChoosingWord {
        drawer: PlayerId,
        options: Vec<String>,
        deadline: Instant,
        round_index: u8,
    },
    Drawing {
        drawer: PlayerId,
        word: String,
        mask: String,
        deadline: Instant,
        started_at: Instant,
        round_index: u8,
        revealed_indices: HashSet<usize>,
        scores_this_round: AHashMap<PlayerId, u32>,
        correct_guessers: Vec<PlayerId>,
        hint_schedule: Vec<Instant>,
        /// Latest mood per guesser this round. Latest reaction wins if a
        /// player toggles. Reset on round start.
        reactions: AHashMap<PlayerId, DrawingMood>,
        /// Mood we last surfaced to the drawer, so re-sending the same mood
        /// is suppressed and only mood changes show a fresh banner.
        last_feedback: Option<DrawingMood>,
    },
    RoundEnd {
        #[allow(dead_code)]
        word: String,
        deadline: Instant,
        round_index: u8,
    },
    GameOver,
}

struct GameState {
    mode: GameMode,
    rounds: u8,
    rotation: Vec<PlayerId>,
    scores: AHashMap<PlayerId, u32>,
    phase: GamePhase,
    /// Position within the current round's rotation, 0..rotation.len().
    /// A "round" advances when every alive player has drawn once.
    turn_in_round: u8,
    host: Option<PlayerId>,
    /// Wall-clock deadline by which the host must hit Start. If we're still
    /// in `Lobby` when this elapses, the room expires and frees its code.
    /// Cleared once a game actually starts (no expiry mid-game).
    lobby_deadline: Option<Instant>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            mode: GameMode::Standard,
            rounds: GameMode::Standard.rounds(),
            rotation: Vec::new(),
            scores: AHashMap::new(),
            phase: GamePhase::Lobby,
            turn_in_round: 0,
            host: None,
            lobby_deadline: None,
        }
    }
}

enum DeadlineAction {
    None,
    AutoPickWord,
    RevealHint,
    EndRoundTimedOut,
    NextRoundOrFinish,
}

struct Room {
    #[allow(dead_code)]
    code: RoomCode,
    seq: Seq,
    next_player_id: PlayerId,
    players: AHashMap<PlayerId, PlayerSlot>,
    completed: VecDeque<CompletedStroke>,
    in_progress: AHashMap<(PlayerId, u32), InProgressStroke>,
    chat: VecDeque<(Seq, PlayerId, String)>,
    game: GameState,
    words: SharedWords,
    broadcast_tx: broadcast::Sender<Arc<ServerMsg>>,
    /// Tokens that have been kicked from this room. A reconnect carrying one
    /// of these is routed through host approval before being admitted.
    kicked_tokens: HashSet<String>,
    /// Candidates currently waiting for the host to approve their rejoin.
    pending: AHashMap<PlayerId, PendingJoiner>,
    /// Players who left voluntarily, indexed by their `client_token`. When a
    /// Hello arrives with a matching token, we reuse the original `PlayerId`
    /// so accumulated scores, rotation slot, and scoreboard row carry over
    /// from before the disconnect.
    departed: AHashMap<String, PlayerId>,
    /// Called once when the room shuts down (lobby timeout or last human
    /// leaves). The `Rooms` registry uses this to evict the entry so the
    /// room code becomes available again.
    on_close: Option<Box<dyn FnOnce() + Send>>,
    /// Set during command/deadline handling when the room has decided to
    /// shut down. The run loop checks this after each step and finalizes
    /// (sends Bye to all, calls on_close, breaks).
    closing: bool,
}

impl Room {
    fn new(
        code: RoomCode,
        broadcast_tx: broadcast::Sender<Arc<ServerMsg>>,
        words: SharedWords,
    ) -> Self {
        Self {
            code,
            seq: 0,
            next_player_id: 1,
            players: AHashMap::new(),
            completed: VecDeque::with_capacity(COMPLETED_STROKES_RING),
            in_progress: AHashMap::new(),
            chat: VecDeque::with_capacity(CHAT_RING),
            game: GameState::default(),
            words,
            broadcast_tx,
            kicked_tokens: HashSet::new(),
            pending: AHashMap::new(),
            departed: AHashMap::new(),
            on_close: None,
            closing: false,
        }
    }

    async fn run(mut self, mut inbox: mpsc::Receiver<RoomCmd>) {
        loop {
            if self.closing {
                self.finalize_close();
                break;
            }
            let next = self.next_deadline();
            tokio::select! {
                biased;
                cmd = inbox.recv() => match cmd {
                    Some(cmd) => self.handle_cmd(cmd),
                    None => break,
                },
                _ = sleep_until_or_pending(next) => {
                    self.handle_deadline();
                }
            }
        }
    }

    /// Send Bye to every connected slot (humans break their WS, bots break
    /// their in-process tasks), then run the eviction callback. Idempotent.
    fn finalize_close(&mut self) {
        let bye = Arc::new(ServerMsg::Bye {
            reason: ByeReason::RoomClosed,
        });
        for slot in self.players.values() {
            let _ = slot.unicast_tx.try_send(bye.clone());
        }
        if let Some(cb) = self.on_close.take() {
            cb();
        }
    }

    fn handle_cmd(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join { hello, reply } => self.handle_join(hello, reply, false),
            RoomCmd::JoinBot { hello, reply } => self.handle_join(hello, reply, true),
            RoomCmd::Leave { player } => self.handle_leave(player),
            RoomCmd::CancelPending { candidate } => self.handle_cancel_pending(candidate),
            RoomCmd::FromClient { player, msg } => self.handle_client_msg(player, msg),
            RoomCmd::SetSecret { drawer, word } => self.handle_set_secret(drawer, word),
        }
    }

    fn next_seq(&mut self) -> Seq {
        self.seq += 1;
        self.seq
    }

    fn broadcast(&self, msg: ServerMsg) {
        let _ = self.broadcast_tx.send(Arc::new(msg));
    }

    fn unicast(&self, player: PlayerId, msg: ServerMsg) {
        if let Some(slot) = self.players.get(&player) {
            let _ = slot.unicast_tx.try_send(Arc::new(msg));
        }
    }

    fn snapshot(&self) -> RoomSnapshot {
        RoomSnapshot {
            players: self
                .players
                .iter()
                .map(|(id, slot)| Player {
                    id: *id,
                    name: slot.name.clone(),
                    avatar: slot.avatar,
                    is_bot: slot.is_bot,
                })
                .collect(),
            completed: self.completed.iter().cloned().collect(),
            seq: self.seq,
            chat: self
                .chat
                .iter()
                .map(|(seq, player, text)| ChatLine {
                    seq: *seq,
                    player: *player,
                    text: text.clone(),
                })
                .collect(),
            game: self.game_snapshot(),
        }
    }

    fn game_snapshot(&self) -> GameSnapshot {
        let now = Instant::now();
        let remaining_ms = |deadline: Instant| {
            deadline
                .checked_duration_since(now)
                .unwrap_or_default()
                .as_millis() as u32
        };
        let phase = match &self.game.phase {
            GamePhase::Lobby => GamePhaseSnapshot::Lobby {
                deadline_ms: self.game.lobby_deadline.map(&remaining_ms),
            },
            GamePhase::ChoosingWord {
                drawer,
                deadline,
                round_index,
                ..
            } => GamePhaseSnapshot::ChoosingWord {
                drawer: *drawer,
                deadline_ms: remaining_ms(*deadline),
                round_index: *round_index,
                total_rounds: self.game.rounds,
            },
            GamePhase::Drawing {
                drawer,
                mask,
                deadline,
                round_index,
                ..
            } => GamePhaseSnapshot::Drawing {
                drawer: *drawer,
                mask: mask.clone(),
                deadline_ms: remaining_ms(*deadline),
                round_index: *round_index,
                total_rounds: self.game.rounds,
            },
            GamePhase::RoundEnd { word, deadline, .. } => GamePhaseSnapshot::RoundEnd {
                word: word.clone(),
                deadline_ms: remaining_ms(*deadline),
            },
            GamePhase::GameOver => GamePhaseSnapshot::GameOver,
        };
        GameSnapshot {
            mode: self.game.mode,
            host: self.game.host,
            scores: ranked_scores(&self.game.scores),
            phase,
        }
    }

    // ---- join / leave / presence -----------------------------------------

    fn handle_join(
        &mut self,
        hello: Hello,
        reply: oneshot::Sender<Result<JoinOutcome, JoinError>>,
        is_bot: bool,
    ) {
        if self.players.len() >= MAX_PLAYERS_PER_ROOM {
            let _ = reply.send(Err(JoinError::RoomFull));
            return;
        }

        // Same-browser rejoin (reload, brief disconnect): if this client_token
        // matches a previously-departed slot in this room, hand back the same
        // PlayerId so cumulative scores and scoreboard rows survive.
        if let Some(token) = hello.client_token.as_ref() {
            if let Some(prev_id) = self.departed.remove(token) {
                let join = self.admit_player(
                    prev_id,
                    hello.name,
                    hello.client_token,
                    hello.avatar,
                    is_bot,
                );
                let _ = reply.send(Ok(JoinOutcome::Joined(join)));
                return;
            }
        }

        let id = self.next_player_id;
        self.next_player_id = self.next_player_id.wrapping_add(1);

        // A previously-kicked client_token must be approved by the host before
        // being readmitted. Stash a pending entry and broadcast a JoinRequest;
        // the candidate gets back an `approval_rx` to await on.
        if let Some(token) = hello.client_token.as_ref() {
            if self.kicked_tokens.contains(token) {
                let (approval_tx, approval_rx) = oneshot::channel();
                self.pending.insert(
                    id,
                    PendingJoiner {
                        name: hello.name.clone(),
                        client_token: token.clone(),
                        avatar: hello.avatar,
                        reply_tx: approval_tx,
                    },
                );
                let seq = self.next_seq();
                self.broadcast(ServerMsg::Game {
                    seq,
                    event: GameEvent::JoinRequest {
                        candidate: id,
                        name: hello.name,
                    },
                });
                let _ = reply.send(Ok(JoinOutcome::Pending {
                    candidate: id,
                    approval_rx,
                }));
                return;
            }
        }

        let join = self.admit_player(id, hello.name, hello.client_token, hello.avatar, is_bot);
        let _ = reply.send(Ok(JoinOutcome::Joined(join)));
    }

    /// Allocate the slot, send Welcome, broadcast Presence, and return the
    /// per-connection channels. Shared by the direct-join and approved-pending
    /// paths.
    fn admit_player(
        &mut self,
        id: PlayerId,
        name: String,
        client_token: Option<String>,
        avatar: Avatar,
        is_bot: bool,
    ) -> JoinResult {
        // First human joiner becomes host. Bots never get the host badge —
        // even if a bot is the only player in the room for a moment, host
        // stays unassigned until a human shows up.
        if self.game.host.is_none() && !is_bot {
            self.game.host = Some(id);
        }

        let (uc_tx, uc_rx) = mpsc::channel(UNICAST_CAPACITY);
        let bc_rx = self.broadcast_tx.subscribe();

        let welcome = ServerMsg::Welcome {
            you: id,
            snapshot: self.snapshot(),
            seq: self.seq,
            lk_token: String::new(),
        };
        let _ = uc_tx.try_send(Arc::new(welcome));

        self.players.insert(
            id,
            PlayerSlot {
                name: name.clone(),
                unicast_tx: uc_tx,
                chat_bucket: TokenBucket::new(CHAT_BUCKET_CAPACITY, CHAT_REFILL_PER_SEC),
                guess_bucket: TokenBucket::new(GUESS_BUCKET_CAPACITY, GUESS_REFILL_PER_SEC),
                client_token,
                avatar,
                is_bot,
            },
        );

        // Late joiners during an active game are appended to the rotation
        // so they get a turn at the end of each remaining round.
        if !matches!(self.game.phase, GamePhase::Lobby | GamePhase::GameOver) {
            self.game.rotation.push(id);
            self.game.scores.entry(id).or_insert(0);
        }

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Presence {
            seq,
            joined: vec![Player {
                id,
                name,
                avatar,
                is_bot,
            }],
            left: vec![],
        });

        JoinResult {
            you: id,
            unicast_rx: uc_rx,
            broadcast_rx: bc_rx,
        }
    }

    fn handle_cancel_pending(&mut self, candidate: PlayerId) {
        if self.pending.remove(&candidate).is_none() {
            return;
        }
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::JoinCanceled { candidate },
        });
    }

    fn handle_approve_join(&mut self, sender: PlayerId, candidate: PlayerId) {
        if self.game.host != Some(sender) {
            return;
        }
        let Some(pj) = self.pending.remove(&candidate) else {
            return;
        };
        // They're back in good standing; clear their kick mark.
        self.kicked_tokens.remove(&pj.client_token);
        let join = self.admit_player(candidate, pj.name, Some(pj.client_token), pj.avatar, false);
        let _ = pj.reply_tx.send(ApprovalResult::Approved(join));
    }

    fn handle_reject_join(&mut self, sender: PlayerId, candidate: PlayerId) {
        if self.game.host != Some(sender) {
            return;
        }
        let Some(pj) = self.pending.remove(&candidate) else {
            return;
        };
        let _ = pj.reply_tx.send(ApprovalResult::Rejected);
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::JoinCanceled { candidate },
        });
    }

    fn handle_leave(&mut self, player: PlayerId) {
        let Some(slot) = self.players.remove(&player) else {
            return;
        };
        // Stash the (client_token -> PlayerId) so a reconnect from the same
        // browser comes back as the same player rather than a duplicate row
        // on the scoreboard. Kicked players already have their own approval
        // flow, so skip the stash for those.
        if let Some(tok) = slot.client_token.clone() {
            if !self.kicked_tokens.contains(&tok) {
                self.departed.insert(tok, player);
            }
        }
        self.in_progress.retain(|(p, _), _| *p != player);

        // If the leaver was the current drawer, end the round early.
        let was_current_drawer = match &self.game.phase {
            GamePhase::ChoosingWord { drawer, .. } | GamePhase::Drawing { drawer, .. } => {
                *drawer == player
            }
            _ => false,
        };

        // Host transfer: if the host leaves, pass to the oldest remaining
        // human (lowest PlayerId among non-bots). Bots never hold host so
        // they can't decide round flow, kick, etc. If only bots remain,
        // host stays None until a human joins.
        let mut new_host = None;
        if self.game.host == Some(player) {
            self.game.host = self
                .players
                .iter()
                .filter(|(_, slot)| !slot.is_bot)
                .map(|(id, _)| *id)
                .min();
            new_host = self.game.host;
        }

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Presence {
            seq,
            joined: vec![],
            left: vec![player],
        });

        if let Some(nh) = new_host {
            let seq = self.next_seq();
            self.broadcast(ServerMsg::Game {
                seq,
                event: GameEvent::HostChanged { new_host: nh },
            });
        }

        // If a game is in flight and we're down to fewer than 2 players,
        // just end the game now and reveal accumulated scores. No point
        // walking the round end ceremony when nobody's left to play.
        let game_active = matches!(
            self.game.phase,
            GamePhase::ChoosingWord { .. } | GamePhase::Drawing { .. } | GamePhase::RoundEnd { .. }
        );
        if game_active && self.players.len() < 2 {
            self.end_game();
        } else if was_current_drawer {
            self.end_round_abort();
        }

        // If the only players left are bots, there's nothing to host. Shut
        // the room down so the bots disconnect cleanly and the code can be
        // reused by someone else.
        let humans_left = self.players.values().filter(|s| !s.is_bot).count();
        if humans_left == 0 {
            tracing::info!(room = %self.code, "no humans left; closing room");
            self.closing = true;
        }
    }

    // ---- client messages -------------------------------------------------

    fn handle_client_msg(&mut self, player: PlayerId, msg: ClientMsg) {
        if !self.players.contains_key(&player) {
            return;
        }
        match msg {
            ClientMsg::Stroke {
                stroke_id,
                origin,
                color,
                width,
                points,
                finished,
            } => self.handle_stroke(player, stroke_id, origin, color, width, points, finished),
            ClientMsg::Chat { text } => self.handle_chat(player, text),
            ClientMsg::Guess { text } => self.handle_guess(player, text),
            ClientMsg::Game(GameAction::Start { mode }) => self.handle_start_game(player, mode),
            ClientMsg::Game(GameAction::PickWord(idx)) => self.handle_pick_word(player, idx),
            ClientMsg::Game(GameAction::Clear) => self.handle_clear(player),
            ClientMsg::Game(GameAction::Kick(target)) => self.handle_kick(player, target),
            ClientMsg::Game(GameAction::ApproveJoin(candidate)) => {
                self.handle_approve_join(player, candidate)
            }
            ClientMsg::Game(GameAction::RejectJoin(candidate)) => {
                self.handle_reject_join(player, candidate)
            }
            ClientMsg::React { mood } => self.handle_react(player, mood),
            ClientMsg::Hello(_) | ClientMsg::Pong { .. } => {
                // Hello is connection setup.
            }
        }
    }

    fn handle_kick(&mut self, sender: PlayerId, target: PlayerId) {
        // Only the host can kick. Can't kick yourself. Target must exist.
        if self.game.host != Some(sender) {
            return;
        }
        if sender == target {
            return;
        }
        let Some(slot) = self.players.get(&target) else {
            return;
        };
        // Remember the kicked token so that a reconnect from the same browser
        // is routed through host approval instead of being admitted silently.
        if let Some(tok) = slot.client_token.clone() {
            self.kicked_tokens.insert(tok);
        }
        // Send Bye to the target before removing them. The unicast channel
        // is buffered, so the message lands before unicast_tx is dropped
        // (which happens inside handle_leave when the player slot is dropped).
        let _ = slot.unicast_tx.try_send(Arc::new(ServerMsg::Bye {
            reason: ByeReason::Kicked,
        }));
        self.handle_leave(target);
    }

    fn handle_react(&mut self, player: PlayerId, mood: DrawingMood) {
        // Collect everything inside one borrow of self.game.phase, then drop
        // the borrow before calling self.next_seq / self.broadcast / self.unicast.
        let (mood_changed, feedback_to_send, drawer_id) = {
            let GamePhase::Drawing {
                drawer,
                reactions,
                last_feedback,
                ..
            } = &mut self.game.phase
            else {
                return;
            };
            if player == *drawer {
                return;
            }
            // Latest reaction from each guesser wins.
            let previous = reactions.insert(player, mood);
            let mood_changed = previous != Some(mood);

            // Threshold = half the current guesser pool (everyone except drawer).
            // Counting against the pool, not just those who reacted, so a single
            // early reaction doesn't trip the banner.
            let guesser_count = self.players.len().saturating_sub(1);
            let feedback_to_send = if guesser_count == 0 {
                None
            } else {
                let needed = guesser_count.div_ceil(2);
                let loved = reactions
                    .values()
                    .filter(|m| matches!(m, DrawingMood::Loved))
                    .count();
                let confused = reactions
                    .values()
                    .filter(|m| matches!(m, DrawingMood::Confused))
                    .count();
                let dominant = if loved >= needed {
                    Some(DrawingMood::Loved)
                } else if confused >= needed {
                    Some(DrawingMood::Confused)
                } else {
                    None
                };
                match dominant {
                    Some(d) if *last_feedback != Some(d) => {
                        *last_feedback = Some(d);
                        Some(d)
                    }
                    _ => None,
                }
            };
            (mood_changed, feedback_to_send, *drawer)
        };

        if mood_changed {
            let seq = self.next_seq();
            self.broadcast(ServerMsg::Game {
                seq,
                event: GameEvent::Reaction { player, mood },
            });
        }
        if let Some(d) = feedback_to_send {
            self.unicast(drawer_id, ServerMsg::DrawingFeedback { mood: d });
        }
    }

    fn handle_clear(&mut self, player: PlayerId) {
        // During an active Drawing phase the shared canvas belongs to the
        // drawer; other players doodle locally and the server never accepted
        // their strokes in the first place. Their Clear is a local-only
        // intent (handled client-side) and must not wipe the drawer's work.
        if let GamePhase::Drawing { drawer, .. } = self.game.phase {
            if drawer != player {
                return;
            }
        }
        self.completed.clear();
        self.in_progress.clear();
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::Cleared { by: player },
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_stroke(
        &mut self,
        player: PlayerId,
        stroke_id: u32,
        origin: (u16, u16),
        color: u32,
        width: u8,
        points: Vec<Point>,
        finished: bool,
    ) {
        // While a game is in progress, only the drawer's strokes are accepted.
        if matches!(self.game.phase, GamePhase::Drawing { drawer, .. } if drawer != player) {
            return;
        }
        if matches!(
            self.game.phase,
            GamePhase::ChoosingWord { .. } | GamePhase::RoundEnd { .. }
        ) {
            return;
        }

        let key = (player, stroke_id);
        let entry = self
            .in_progress
            .entry(key)
            .or_insert_with(|| InProgressStroke {
                origin,
                color,
                width,
                points: Vec::new(),
            });
        entry.points.extend_from_slice(&points);

        if finished {
            if let Some(done) = self.in_progress.remove(&key) {
                self.completed.push_back(CompletedStroke {
                    player,
                    stroke_id,
                    origin: done.origin,
                    color: done.color,
                    width: done.width,
                    points: done.points,
                });
                while self.completed.len() > COMPLETED_STROKES_RING {
                    self.completed.pop_front();
                }
            }
        }

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Stroke {
            seq,
            player,
            stroke_id,
            origin,
            color,
            width,
            points,
            finished,
        });
    }

    fn handle_chat(&mut self, player: PlayerId, text: String) {
        let Some(slot) = self.players.get_mut(&player) else {
            return;
        };
        if !slot.chat_bucket.try_take() {
            return;
        }
        // During Drawing, players who already know the word (drawer or
        // anyone who's guessed correctly) can chat freely, except any
        // attempt to drop the word in plaintext is intercepted and nudged
        // back to the sender so still-guessing players don't see it.
        if let GamePhase::Drawing {
            drawer,
            word,
            correct_guessers,
            ..
        } = &self.game.phase
        {
            let knows_word = *drawer == player || correct_guessers.contains(&player);
            if knows_word && message_leaks_word(&text, word) {
                let seq = self.next_seq();
                self.unicast(
                    player,
                    ServerMsg::Guess {
                        seq,
                        player,
                        kind: GuessKind::Spoiler,
                    },
                );
                return;
            }
        }
        let seq = self.next_seq();
        self.chat.push_back((seq, player, text.clone()));
        while self.chat.len() > CHAT_RING {
            self.chat.pop_front();
        }
        self.broadcast(ServerMsg::Chat { seq, player, text });
    }

    fn handle_guess(&mut self, player: PlayerId, text: String) {
        let Some(slot) = self.players.get_mut(&player) else {
            return;
        };
        if !slot.guess_bucket.try_take() {
            return;
        }

        match self.evaluate_guess(player, &text) {
            GuessOutcome::Correct { everyone_guessed } => {
                let seq = self.next_seq();
                self.broadcast(ServerMsg::Guess {
                    seq,
                    player,
                    kind: GuessKind::Correct,
                });
                if everyone_guessed {
                    self.end_round_completed();
                }
            }
            GuessOutcome::Close => {
                // Everyone sees the guess as chat (so they don't repeat it),
                // but only the guesser gets the "close" hint pill.
                let seq = self.next_seq();
                self.broadcast(ServerMsg::Chat {
                    seq,
                    player,
                    text: text.clone(),
                });
                let seq2 = self.next_seq();
                self.unicast(
                    player,
                    ServerMsg::Guess {
                        seq: seq2,
                        player,
                        kind: GuessKind::Close,
                    },
                );
            }
            GuessOutcome::Wrong | GuessOutcome::NotInGame => {
                let seq = self.next_seq();
                self.broadcast(ServerMsg::Chat { seq, player, text });
            }
            GuessOutcome::DrawerSelfGuess | GuessOutcome::AlreadyCorrect => {
                // Silently dropped; drawer can't spoil and re-guessers can't spam.
            }
        }
    }

    fn evaluate_guess(&mut self, player: PlayerId, text: &str) -> GuessOutcome {
        match &mut self.game.phase {
            GamePhase::Drawing {
                drawer,
                word,
                deadline,
                started_at,
                scores_this_round,
                correct_guessers,
                ..
            } => {
                if *drawer == player {
                    return GuessOutcome::DrawerSelfGuess;
                }
                if correct_guessers.contains(&player) {
                    return GuessOutcome::AlreadyCorrect;
                }
                if !text.trim().eq_ignore_ascii_case(word.trim()) {
                    return if is_close_guess(text, word) {
                        GuessOutcome::Close
                    } else {
                        GuessOutcome::Wrong
                    };
                }

                let now = Instant::now();
                let remaining_ms = deadline
                    .checked_duration_since(now)
                    .unwrap_or_default()
                    .as_millis() as u32;
                let window_ms = deadline
                    .checked_duration_since(*started_at)
                    .unwrap_or(DRAW_WINDOW)
                    .as_millis() as u32;
                let rank = correct_guessers.len();
                let score = guess_score(remaining_ms, window_ms, rank);

                scores_this_round.insert(player, score);
                correct_guessers.push(player);

                let guessers_remaining = self
                    .players
                    .keys()
                    .filter(|p| **p != *drawer)
                    .filter(|p| !correct_guessers.contains(p))
                    .count();

                GuessOutcome::Correct {
                    everyone_guessed: guessers_remaining == 0,
                }
            }
            _ => GuessOutcome::NotInGame,
        }
    }

    fn handle_set_secret(&mut self, drawer: PlayerId, word: String) {
        // Test-only fast path: jump into a Drawing phase with the given word.
        // No timers, no hint schedule; deadline is far in the future.
        let mask = build_mask(&word);
        let started_at = Instant::now();
        let deadline = started_at + Duration::from_secs(60 * 60);
        self.game.phase = GamePhase::Drawing {
            drawer,
            word,
            mask,
            deadline,
            started_at,
            round_index: 0,
            revealed_indices: HashSet::new(),
            scores_this_round: AHashMap::new(),
            correct_guessers: Vec::new(),
            hint_schedule: Vec::new(),
            reactions: AHashMap::new(),
            last_feedback: None,
        };
    }

    // ---- game state machine ---------------------------------------------

    fn handle_start_game(&mut self, sender: PlayerId, mode: GameMode) {
        if !matches!(self.game.phase, GamePhase::Lobby | GamePhase::GameOver) {
            return;
        }
        if self.players.len() < 2 {
            tracing::debug!("ignoring Start: at least 2 players required");
            return;
        }
        if let Some(host) = self.game.host {
            if host != sender {
                tracing::debug!("ignoring Start: only host can start");
                return;
            }
        }
        if self.words.is_empty() {
            tracing::warn!("ignoring Start: word lists are empty");
            return;
        }
        let mut rotation: Vec<PlayerId> = self.players.keys().copied().collect();
        rotation.sort();
        // Preserve host across game restarts.
        let host = self.game.host;
        self.game = GameState {
            mode,
            rounds: mode.rounds(),
            rotation,
            scores: AHashMap::from_iter(self.players.keys().copied().map(|p| (p, 0u32))),
            phase: GamePhase::Lobby, // will be overwritten by start_choosing_round
            turn_in_round: 0,
            host,
            // Game is starting; the lobby-expire timer no longer applies.
            lobby_deadline: None,
        };
        self.start_choosing_round(0);
    }

    fn start_choosing_round(&mut self, round_index: u8) {
        // Pick the next alive drawer starting from turn_in_round, skipping
        // dead slots. The found index becomes the new turn_in_round, so
        // disconnects collapse without leaving holes in the schedule.
        let total = self.game.rotation.len();
        if total == 0 {
            self.end_game();
            return;
        }
        let start = self.game.turn_in_round as usize;
        let mut drawer = None;
        for offset in 0..total {
            let idx = (start + offset) % total;
            let candidate = self.game.rotation[idx];
            if self.players.contains_key(&candidate) {
                drawer = Some(candidate);
                self.game.turn_in_round = idx as u8;
                break;
            }
        }
        let Some(drawer) = drawer else {
            self.end_game();
            return;
        };

        let diff = Difficulty::for_round(round_index);
        let count = self.game.mode.word_options() as usize;
        let drawer_is_bot = self.players.get(&drawer).is_some_and(|s| s.is_bot);
        let options = if drawer_is_bot {
            self.words.sample_bot(diff, count)
        } else {
            self.words.sample(diff, count)
        };
        if options.is_empty() {
            tracing::warn!("no words available for difficulty {diff:?}; ending game");
            self.end_game();
            return;
        }

        let deadline = Instant::now() + PICK_WINDOW;
        self.game.phase = GamePhase::ChoosingWord {
            drawer,
            options: options.clone(),
            deadline,
            round_index,
        };

        let total_rounds = self.game.rounds;
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::WordPickStarted {
                drawer,
                deadline_ms: PICK_WINDOW.as_millis() as u32,
                round_index,
                total_rounds,
            },
        });
        self.unicast(
            drawer,
            ServerMsg::WordOptions {
                words: options,
                deadline_ms: PICK_WINDOW.as_millis() as u32,
            },
        );
    }

    fn handle_pick_word(&mut self, player: PlayerId, idx: u8) {
        let (chosen_word, round_index) = match &self.game.phase {
            GamePhase::ChoosingWord {
                drawer,
                options,
                round_index,
                ..
            } if *drawer == player => {
                let i = (idx as usize).min(options.len().saturating_sub(1));
                if options.is_empty() {
                    return;
                }
                (options[i].clone(), *round_index)
            }
            _ => return,
        };
        self.start_drawing(player, chosen_word, round_index);
    }

    fn auto_pick_word(&mut self) {
        let (drawer, chosen_word, round_index) = match &self.game.phase {
            GamePhase::ChoosingWord {
                drawer,
                options,
                round_index,
                ..
            } if !options.is_empty() => (*drawer, options[0].clone(), *round_index),
            _ => return,
        };
        self.start_drawing(drawer, chosen_word, round_index);
    }

    fn start_drawing(&mut self, drawer: PlayerId, word: String, round_index: u8) {
        // Fresh canvas per round.
        self.completed.clear();
        self.in_progress.clear();
        let clear_seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq: clear_seq,
            event: GameEvent::Cleared { by: drawer },
        });

        let mask = build_mask(&word);
        let started_at = Instant::now();
        let deadline = started_at + DRAW_WINDOW;

        // Pre-reveal non-alpha positions (spaces, hyphens, digits).
        let mut revealed_indices = HashSet::new();
        for (i, c) in word.chars().enumerate() {
            if !c.is_alphabetic() {
                revealed_indices.insert(i);
            }
        }

        let hint_count = max_hints(&word);
        let hint_schedule: Vec<Instant> = HINT_REMAINING_SECS
            .iter()
            .take(hint_count)
            .map(|secs| deadline - Duration::from_secs(*secs))
            .collect();

        let total_rounds = self.game.rounds;
        self.game.phase = GamePhase::Drawing {
            drawer,
            word: word.clone(),
            mask: mask.clone(),
            deadline,
            started_at,
            round_index,
            revealed_indices,
            scores_this_round: AHashMap::new(),
            correct_guessers: Vec::new(),
            hint_schedule,
            reactions: AHashMap::new(),
            last_feedback: None,
        };

        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::RoundStart {
                drawer,
                word_mask: mask,
                duration_ms: DRAW_WINDOW.as_millis() as u32,
                round_index,
                total_rounds,
            },
        });
        self.unicast(
            drawer,
            ServerMsg::DrawerWord {
                word,
                duration_ms: DRAW_WINDOW.as_millis() as u32,
            },
        );
    }

    fn reveal_one_hint(&mut self) {
        let GamePhase::Drawing {
            word,
            mask,
            revealed_indices,
            hint_schedule,
            ..
        } = &mut self.game.phase
        else {
            return;
        };
        if !hint_schedule.is_empty() {
            hint_schedule.remove(0);
        }
        let Some(idx) = pick_hint_index(word, revealed_indices) else {
            return;
        };
        if !reveal_at(mask, word, idx) {
            return;
        }
        revealed_indices.insert(idx);
        let mask_clone = mask.clone();
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::HintReveal { mask: mask_clone },
        });
    }

    fn end_round_completed(&mut self) {
        self.end_round(EndRoundReason::AllGuessed);
    }

    fn end_round_timed_out(&mut self) {
        self.end_round(EndRoundReason::TimedOut);
    }

    fn end_round_abort(&mut self) {
        self.end_round(EndRoundReason::Aborted);
    }

    fn end_round(&mut self, reason: EndRoundReason) {
        let (word, drawer, scores_this_round, correct_guessers, round_index) =
            match std::mem::replace(&mut self.game.phase, GamePhase::Lobby) {
                GamePhase::Drawing {
                    word,
                    drawer,
                    scores_this_round,
                    correct_guessers,
                    round_index,
                    ..
                } => (
                    word,
                    drawer,
                    scores_this_round,
                    correct_guessers,
                    round_index,
                ),
                other => {
                    // Wasn't Drawing; restore and move on.
                    self.game.phase = other;
                    return;
                }
            };

        // Award drawer bonus only if the round wasn't aborted.
        let mut total = 0u32;
        for v in scores_this_round.values() {
            total = total.saturating_add(*v);
        }
        let bonus = if matches!(reason, EndRoundReason::Aborted) {
            0
        } else {
            drawer_bonus(total)
        };

        for (pid, delta) in &scores_this_round {
            let entry = self.game.scores.entry(*pid).or_insert(0);
            *entry = entry.saturating_add(*delta);
        }
        if bonus > 0 {
            let entry = self.game.scores.entry(drawer).or_insert(0);
            *entry = entry.saturating_add(bonus);
        }

        let _ = correct_guessers; // already tracked in scores_this_round
        let cumulative = self.ranked_scores_current();
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::RoundEnd {
                word: word.clone(),
                scores: cumulative,
            },
        });

        let deadline = Instant::now() + ROUND_REVEAL;
        self.game.phase = GamePhase::RoundEnd {
            word,
            deadline,
            round_index,
        };
    }

    fn advance_round(&mut self) {
        let GamePhase::RoundEnd { round_index, .. } = self.game.phase else {
            return;
        };
        let rotation_len = self.game.rotation.len();
        if rotation_len == 0 {
            self.end_game();
            return;
        }
        // Next turn within the current round, or roll over to the next round.
        let next_turn = self.game.turn_in_round as usize + 1;
        if next_turn < rotation_len {
            self.game.turn_in_round = next_turn as u8;
            self.start_choosing_round(round_index);
        } else if (round_index as u16 + 1) < self.game.rounds as u16 {
            self.game.turn_in_round = 0;
            self.start_choosing_round(round_index + 1);
        } else {
            self.end_game();
        }
    }

    fn end_game(&mut self) {
        let final_scores = self.ranked_scores_current();
        let seq = self.next_seq();
        self.broadcast(ServerMsg::Game {
            seq,
            event: GameEvent::GameOver { final_scores },
        });
        self.game.phase = GamePhase::GameOver;
    }

    /// Ranked scoreboard restricted to players currently in the room.
    /// Players who left mid-game keep their scores in `self.game.scores`
    /// (so totals stay correct if they rejoin), but we don't surface them
    /// to UIs that should only show people who are actually here now.
    fn ranked_scores_current(&self) -> Vec<(PlayerId, u32)> {
        let mut filtered: AHashMap<PlayerId, u32> = AHashMap::with_capacity(self.players.len());
        for pid in self.players.keys() {
            let s = self.game.scores.get(pid).copied().unwrap_or(0);
            filtered.insert(*pid, s);
        }
        ranked_scores(&filtered)
    }

    // ---- deadlines -------------------------------------------------------

    fn next_deadline(&self) -> Option<Instant> {
        match &self.game.phase {
            GamePhase::ChoosingWord { deadline, .. } => Some(*deadline),
            GamePhase::RoundEnd { deadline, .. } => Some(*deadline),
            GamePhase::Drawing {
                deadline,
                hint_schedule,
                ..
            } => {
                let next_hint = hint_schedule.first().copied();
                match next_hint {
                    Some(h) if h < *deadline => Some(h),
                    _ => Some(*deadline),
                }
            }
            GamePhase::Lobby => self.game.lobby_deadline,
            GamePhase::GameOver => None,
        }
    }

    fn handle_deadline(&mut self) {
        let now = Instant::now();
        // Lobby timeout: nobody hit Start in time, expire the room so the
        // code can be reused. Returns before other phase matches so we
        // don't accidentally also try to auto-pick a word, etc.
        if matches!(self.game.phase, GamePhase::Lobby) {
            if let Some(d) = self.game.lobby_deadline {
                if now >= d {
                    tracing::info!(room = %self.code, "lobby timeout; closing room");
                    self.closing = true;
                    return;
                }
            }
        }
        let action = match &self.game.phase {
            GamePhase::ChoosingWord { deadline, .. } if now >= *deadline => {
                DeadlineAction::AutoPickWord
            }
            GamePhase::Drawing {
                deadline,
                hint_schedule,
                ..
            } => {
                if hint_schedule.first().is_some_and(|h| *h <= now) {
                    DeadlineAction::RevealHint
                } else if now >= *deadline {
                    DeadlineAction::EndRoundTimedOut
                } else {
                    DeadlineAction::None
                }
            }
            GamePhase::RoundEnd { deadline, .. } if now >= *deadline => {
                DeadlineAction::NextRoundOrFinish
            }
            _ => DeadlineAction::None,
        };
        match action {
            DeadlineAction::None => {}
            DeadlineAction::AutoPickWord => self.auto_pick_word(),
            DeadlineAction::RevealHint => self.reveal_one_hint(),
            DeadlineAction::EndRoundTimedOut => self.end_round_timed_out(),
            DeadlineAction::NextRoundOrFinish => self.advance_round(),
        }
    }
}

enum GuessOutcome {
    Correct { everyone_guessed: bool },
    Close,
    Wrong,
    NotInGame,
    DrawerSelfGuess,
    AlreadyCorrect,
}

enum EndRoundReason {
    AllGuessed,
    TimedOut,
    Aborted,
}

async fn sleep_until_or_pending(when: Option<Instant>) {
    match when {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending::<()>().await,
    }
}
