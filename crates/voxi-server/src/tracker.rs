//! Lightweight play tracking backed by Turso (libSQL).
//!
//! Every successful human join (one WebSocket handshake that makes it into a
//! room) is recorded as a row in the `plays` table on a remote Turso database.
//! Bots never reach this path — they're added through `/bot/:code` — so the
//! counts only reflect real users. Tracking degrades to a no-op if the database
//! can't be reached, so a bad token or network blip never takes the server
//! down.

use libsql::{Builder, Connection, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct Tracker {
    conn: Option<Connection>,
}

pub struct Stats {
    /// Total join events recorded (a returning player counts each time).
    pub total_plays: i64,
    /// Distinct players by browser `client_token`; tokenless joins each count
    /// as one.
    pub unique_players: i64,
}

impl Tracker {
    /// Connect to a remote Turso database and ensure the schema exists. On
    /// failure, logs a warning and returns a disabled tracker rather than
    /// erroring.
    pub async fn connect(url: &str, token: &str) -> Self {
        match Self::try_connect(url, token).await {
            Ok(conn) => {
                tracing::info!("play tracking enabled (turso/libsql)");
                Tracker { conn: Some(conn) }
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not connect to turso; play tracking disabled");
                Tracker { conn: None }
            }
        }
    }

    /// A tracker that records nothing — used in tests and when Turso isn't
    /// configured.
    pub fn disabled() -> Self {
        Tracker { conn: None }
    }

    async fn try_connect(url: &str, token: &str) -> libsql::Result<Connection> {
        let db = Builder::new_remote(url.to_string(), token.to_string())
            .build()
            .await?;
        let conn = db.connect()?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS plays (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                client_token TEXT,
                name         TEXT    NOT NULL,
                room         TEXT    NOT NULL,
                joined_at    INTEGER NOT NULL
            )",
            (),
        )
        .await?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_plays_token ON plays(client_token)",
            (),
        )
        .await?;
        Ok(conn)
    }

    /// Record one successful join. Best-effort: errors are logged, never
    /// propagated. Callers should `tokio::spawn` this so the network write
    /// never sits in the join hot path.
    pub async fn record_join(&self, client_token: Option<&str>, name: &str, room: &str) {
        let Some(conn) = &self.conn else { return };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let params = vec![
            client_token
                .map(|t| Value::from(t.to_string()))
                .unwrap_or(Value::Null),
            Value::from(name.to_string()),
            Value::from(room.to_string()),
            Value::from(now),
        ];
        if let Err(e) = conn
            .execute(
                "INSERT INTO plays (client_token, name, room, joined_at) VALUES (?1, ?2, ?3, ?4)",
                params,
            )
            .await
        {
            tracing::warn!(error = %e, "failed to record play");
        }
    }

    /// Snapshot of totals, or `None` when tracking is disabled.
    pub async fn stats(&self) -> Option<Stats> {
        let conn = self.conn.as_ref()?;
        let total_plays = count(conn, "SELECT COUNT(*) FROM plays").await;
        let unique_players = count(
            conn,
            "SELECT (SELECT COUNT(DISTINCT client_token) FROM plays WHERE client_token IS NOT NULL)
                  + (SELECT COUNT(*) FROM plays WHERE client_token IS NULL)",
        )
        .await;
        Some(Stats {
            total_plays,
            unique_players,
        })
    }
}

/// Run a single-scalar `COUNT` query, returning 0 on any error.
async fn count(conn: &Connection, sql: &str) -> i64 {
    match conn.query(sql, ()).await {
        Ok(mut rows) => match rows.next().await {
            Ok(Some(row)) => row.get::<i64>(0).unwrap_or(0),
            _ => 0,
        },
        Err(e) => {
            tracing::warn!(error = %e, "stats query failed");
            0
        }
    }
}
