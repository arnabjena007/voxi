use pastel_room::WordLists;
use pastel_server::{build_router, words, AppState};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::from_path("crates/pastel-server/.env");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,pastel=debug".into()),
        )
        .init();

    let data_dir: PathBuf = std::env::var_os("PASTEL_WORDS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("crates/pastel-server/data"));

    let wordlists = match words::load_from_dir(&data_dir) {
        Ok(w) => {
            tracing::info!(path = %data_dir.display(), "loaded word lists");
            Arc::new(w)
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "could not load word lists from {}, falling back to embedded test fixture",
                data_dir.display(),
            );
            Arc::new(WordLists::test_fixture())
        }
    };

    let app = build_router(AppState::new(wordlists).await);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7070);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(%addr, "pastel-server listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
