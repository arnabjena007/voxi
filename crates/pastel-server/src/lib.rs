//! pastel-server library: HTTP + WebSocket entrypoint and room registry.
//!
//! The binary in `src/main.rs` is a thin wrapper that builds the router and
//! serves it on a TCP listener. Integration tests use the same `build_router`
//! against a port-zero listener.

pub mod bot;
pub mod rooms;
pub mod tracker;
pub mod voice;
pub mod words;
pub mod ws;

use axum::extract::State;
use axum::routing::{get, post};
use axum::Router;
use pastel_room::WordLists;
use std::sync::Arc;
use tracker::Tracker;

#[derive(Clone)]
pub struct AppState {
    pub rooms: rooms::Rooms,
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
        Self {
            rooms: rooms::Rooms::new(words),
            tracker,
        }
    }

    pub fn with_test_words() -> Self {
        Self {
            rooms: rooms::Rooms::new(Arc::new(WordLists::test_fixture())),
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
        .route("/voice/token", get(voice::token))
        .with_state(state);

    // In production, serve the frontend dist/ folder as a static fallback.
    // In dev, Vite serves the frontend and proxies API calls to us.
    let dist_dir = std::env::var("PASTEL_DIST_DIR").unwrap_or_else(|_| "frontend/dist".into());
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

async fn metrics(State(state): State<AppState>) -> String {
    let mut out = format!(
        "# HELP pastel_rooms_active Active rooms hosted on this node.\n\
         # TYPE pastel_rooms_active gauge\n\
         pastel_rooms_active {}\n",
        state.rooms.count(),
    );
    if let Some(s) = state.tracker.stats().await {
        out.push_str(&format!(
            "# HELP pastel_plays_total Total room joins recorded.\n\
             # TYPE pastel_plays_total counter\n\
             pastel_plays_total {}\n\
             # HELP pastel_unique_players_total Distinct players by browser token.\n\
             # TYPE pastel_unique_players_total counter\n\
             pastel_unique_players_total {}\n",
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
