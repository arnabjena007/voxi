//! LiveKit access-token minting.
//!
//! The frontend hits GET /voice/token?room=ABC123&name=Alice and gets a JWT
//! signed with the project API secret. The token grants joinRoom + publish +
//! subscribe scoped to a single LiveKit room (1:1 with the voxi room code).

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_TTL_SECS: u64 = 60 * 60 * 6;

#[derive(Deserialize)]
pub struct TokenQuery {
    pub room: String,
    pub name: String,
}

#[derive(Serialize)]
struct VideoGrant {
    room: String,
    #[serde(rename = "roomJoin")]
    room_join: bool,
    #[serde(rename = "canPublish")]
    can_publish: bool,
    #[serde(rename = "canSubscribe")]
    can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    can_publish_data: bool,
}

#[derive(Serialize)]
struct Claims {
    iss: String,
    sub: String,
    name: String,
    nbf: u64,
    exp: u64,
    video: VideoGrant,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub token: String,
    pub url: String,
}

pub async fn token(
    Query(q): Query<TokenQuery>,
) -> Result<Json<TokenResponse>, (StatusCode, String)> {
    let api_key = std::env::var("LIVEKIT_API_KEY").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "voice not configured".into(),
        )
    })?;
    let api_secret = std::env::var("LIVEKIT_API_SECRET").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "voice not configured".into(),
        )
    })?;
    let url = std::env::var("LIVEKIT_URL").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "voice not configured".into(),
        )
    })?;

    if q.room.is_empty() || q.name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "room and name required".into()));
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let identity = format!("{}-{}", q.name, rand_id());

    let claims = Claims {
        iss: api_key,
        sub: identity,
        name: q.name,
        nbf: now,
        exp: now + TOKEN_TTL_SECS,
        video: VideoGrant {
            room: q.room,
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TokenResponse { token, url }))
}

fn rand_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let n = rng.gen_range(0..36);
            if n < 10 {
                (b'0' + n) as char
            } else {
                (b'a' + n - 10) as char
            }
        })
        .collect()
}
