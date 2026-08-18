//! voxi-server library: HTTP + WebSocket entrypoint and room registry.
//!
//! The binary in `src/main.rs` is a thin wrapper that builds the router and
//! serves it on a TCP listener. Integration tests use the same `build_router`
//! against a port-zero listener.

pub mod bot;
pub mod matchmaker;
pub mod rooms;
pub mod tracker;
pub mod voice;
pub mod words;
pub mod ws;

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use matchmaker::Matchmaker;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracker::Tracker;
use voxi_room::WordLists;

#[derive(Clone)]
pub struct AppState {
    pub rooms: rooms::Rooms,
    pub matchmaker: Matchmaker,
    pub tracker: Tracker,
}

impl AppState {
    pub async fn new(words: Arc<WordLists>) -> Self {
        let tracker = match (
            std::env::var("TURSO_DATABASE_URL"),
            std::env::var("TURSO_AUTH_TOKEN"),
        ) {
            (Ok(url), Ok(token)) if !url.is_empty() => Tracker::connect(&url, &token).await,
            _ => {
                tracing::warn!(
                    "TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set; play tracking disabled"
                );
                Tracker::disabled()
            }
        };
        let rooms = rooms::Rooms::new(words);
        Self {
            matchmaker: Matchmaker::new(rooms.clone()),
            rooms,
            tracker,
        }
    }

    pub fn with_test_words() -> Self {
        let rooms = rooms::Rooms::new(Arc::new(WordLists::test_fixture()));
        Self {
            matchmaker: Matchmaker::new(rooms.clone()),
            rooms,
            tracker: Tracker::disabled(),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/stats", get(stats))
        .route("/ws/:code", get(ws::ws_handler))
        .route("/bot/:code", post(bot::add_bot))
        .route("/matchmake", post(matchmake))
        .route("/voice/token", get(voice::token))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(Any),
        )
        .with_state(state);

    // In production, serve the frontend dist/ folder as a static fallback.
    // In dev, Vite serves the frontend and proxies API calls to us.
    let dist_dir = std::env::var("VOXI_DIST_DIR").unwrap_or_else(|_| "frontend/dist".into());
    let dist_path = std::path::PathBuf::from(&dist_dir);
    if dist_path.join("index.html").exists() {
        tracing::info!(path = %dist_dir, "serving static frontend");
        api.fallback_service(tower_http::services::ServeDir::new(&dist_dir).fallback(
            tower_http::services::ServeFile::new(dist_path.join("index.html")),
        ))
    } else {
        api
    }
}

async fn healthz() -> &'static str {
    "ok"
}

#[derive(serde::Deserialize)]
struct MatchmakeReq {
    size: u8,
    bots: u8,
}

/// Quick match: place the caller into a matched table for the given size + bot
/// count and hand back its room code to join via `/ws/:code`.
async fn matchmake(
    State(state): State<AppState>,
    Json(req): Json<MatchmakeReq>,
) -> impl IntoResponse {
    if !matches!(req.size, 2 | 4 | 6) {
        return (StatusCode::BAD_REQUEST, "size must be 2, 4, or 6").into_response();
    }
    // At least one human seat: bots can't exceed size - 1.
    let bots = req.bots.min(req.size - 1);
    let code = state.matchmaker.match_request(req.size, bots);
    Json(serde_json::json!({ "code": code.as_str() })).into_response()
}

async fn metrics(State(state): State<AppState>) -> String {
    let mut out = format!(
        "# HELP voxi_rooms_active Active rooms hosted on this node.\n\
         # TYPE voxi_rooms_active gauge\n\
         voxi_rooms_active {}\n",
        state.rooms.count(),
    );
    if let Some(s) = state.tracker.stats().await {
        out.push_str(&format!(
            "# HELP voxi_plays_total Total room joins recorded.\n\
             # TYPE voxi_plays_total counter\n\
             voxi_plays_total {}\n\
             # HELP voxi_unique_players_total Distinct players by browser token.\n\
             # TYPE voxi_unique_players_total counter\n\
             voxi_unique_players_total {}\n",
            s.total_plays, s.unique_players,
        ));
    }
    out
}

/// Human-friendly JSON snapshot — `curl host/stats`.
async fn stats(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    let (total_plays, unique_players) = state
        .tracker
        .stats()
        .await
        .map(|s| (s.total_plays, s.unique_players))
        .unwrap_or((0, 0));
    axum::Json(serde_json::json!({
        "rooms_active": state.rooms.count(),
        "total_plays": total_plays,
        "unique_players": unique_players,
    }))
}
