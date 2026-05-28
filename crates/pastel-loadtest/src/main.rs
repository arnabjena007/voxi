//! pastel-loadtest: drive N simulated WebSocket clients against a running
//! pastel-server, measure RTT via self-echoed strokes, print a report.
//!
//! Each client connects, joins a room (clients are bucketed in groups of
//! `per_room`), sends `rate` strokes per second for `duration` seconds, and
//! records the time between sending a Stroke and seeing the broadcast come
//! back from the server. The histogram is HdrHistogram-backed so the
//! p50/p95/p99 numbers are real.
//!
//! No assumptions about the server beyond "it implements the pastel wire
//! protocol on /ws/:code". Start the server in another terminal first.

use anyhow::Result;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use hdrhistogram::Histogram;
use pastel_proto::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

#[derive(Parser, Debug)]
#[command(about = "Drive simulated clients against a pastel-server.")]
struct Args {
    /// Base WebSocket address, e.g. ws://127.0.0.1:7070
    #[arg(long, default_value = "ws://127.0.0.1:7070")]
    addr: String,

    /// Total number of simulated clients.
    #[arg(short, long, default_value_t = 100)]
    clients: usize,

    /// Players per room. Clients are distributed across `ceil(clients/per_room)` rooms.
    #[arg(long, default_value_t = 5)]
    per_room: usize,

    /// Duration of the steady-state phase, in seconds.
    #[arg(short = 't', long, default_value_t = 30)]
    duration: u64,

    /// Strokes per second per client.
    #[arg(long, default_value_t = 10)]
    rate: u32,

    /// Suppress the every-2-seconds progress lines.
    #[arg(long)]
    quiet: bool,

    /// Connect, send Hello, await Welcome, then disconnect immediately. No
    /// stroke loop. Useful for measuring pure connect-handshake throughput
    /// against TLS + load balancer + room creation.
    #[arg(long)]
    connect_only: bool,

    /// Skip TLS certificate verification. Use for self-signed clusters or
    /// debugging. Never use this against a production endpoint you don't
    /// own; it disables MITM detection entirely.
    #[arg(long)]
    insecure: bool,
}

#[derive(Default)]
struct Stats {
    connected: AtomicU64,
    failed_connect: AtomicU64,
    sent: AtomicU64,
    received_self: AtomicU64,
    received_other: AtomicU64,
    bad_frames: AtomicU64,
    ws_errors: AtomicU64,
}

struct Shared {
    stats: Stats,
    global_hist: Mutex<Histogram<u64>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    let rooms_count = args.clients.div_ceil(args.per_room.max(1));
    println!("pastel-loadtest");
    println!("  target:    {}", args.addr);
    println!(
        "  clients:   {} across {} rooms ({} per room)",
        args.clients, rooms_count, args.per_room
    );
    println!("  duration:  {}s", args.duration);
    println!("  rate:      {} strokes/s per client", args.rate);
    println!();

    let shared = Arc::new(Shared {
        stats: Stats::default(),
        global_hist: Mutex::new(Histogram::<u64>::new(3).expect("histogram")),
    });

    let send_interval = if args.rate == 0 {
        Duration::from_secs(3600)
    } else {
        Duration::from_micros(1_000_000 / args.rate as u64)
    };
    let test_duration = Duration::from_secs(args.duration);

    // Stagger client startup over the first second so we don't slam connect().
    let stagger = if args.clients > 0 {
        Duration::from_millis((1000 / args.clients.max(1) as u64).max(1))
    } else {
        Duration::ZERO
    };

    let progress_handle = if !args.quiet {
        Some(spawn_progress(shared.clone(), args.clients))
    } else {
        None
    };

    // Build the TLS connector once and share it across all clients. Default
    // path (rustls-webpki-roots, full verification) is in-built so we only
    // need to override when --insecure was passed.
    let connector = if args.insecure {
        eprintln!("  [insecure] TLS certificate verification disabled for this run");
        Some(tokio_tungstenite::Connector::Rustls(
            insecure_rustls_config(),
        ))
    } else {
        None
    };

    let connect_only = args.connect_only;
    if connect_only {
        println!("  mode:      connect-only (no stroke loop)");
    }
    println!();

    let mut client_handles = Vec::with_capacity(args.clients);
    let test_started = Instant::now();
    for i in 0..args.clients {
        let url = format!(
            "{}/ws/{}",
            args.addr.trim_end_matches('/'),
            room_for_index(i / args.per_room.max(1))
        );
        let name = format!("load-{i}");
        let shared = shared.clone();
        let connector_for_client = connector.clone();
        client_handles.push(tokio::spawn(async move {
            let _ = run_client(
                url,
                name,
                test_duration,
                send_interval,
                shared,
                connector_for_client,
                connect_only,
            )
            .await;
        }));
        tokio::time::sleep(stagger).await;
    }

    for h in client_handles {
        let _ = h.await;
    }
    let elapsed = test_started.elapsed();
    if let Some(p) = progress_handle {
        p.abort();
    }

    print_report(&shared, args, elapsed).await;
    Ok(())
}

fn room_for_index(i: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = [b'0'; 6];
    let mut n = i;
    for slot in bytes.iter_mut().rev() {
        *slot = ALPHABET[n % 32];
        n /= 32;
    }
    std::str::from_utf8(&bytes)
        .expect("alphabet is ascii")
        .to_string()
}

fn parse_room(url: &str) -> RoomCode {
    let code = url.rsplit('/').next().expect("at least one segment");
    RoomCode::parse(code).expect("loadtest-generated code is valid")
}

fn spawn_progress(shared: Arc<Shared>, total_clients: usize) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_sent = 0u64;
        let mut last_received = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let sent = shared.stats.sent.load(Ordering::Relaxed);
            let received_self = shared.stats.received_self.load(Ordering::Relaxed);
            let received_other = shared.stats.received_other.load(Ordering::Relaxed);
            let received = received_self + received_other;
            let connected = shared.stats.connected.load(Ordering::Relaxed);
            let ds = sent.saturating_sub(last_sent);
            let dr = received.saturating_sub(last_received);
            println!(
                "  +2s  connected={}/{}  sent={}/s  recv={}/s",
                connected,
                total_clients,
                ds / 2,
                dr / 2,
            );
            last_sent = sent;
            last_received = received;
        }
    })
}

async fn print_report(shared: &Shared, args: Args, elapsed: Duration) {
    let stats = &shared.stats;
    let hist = shared.global_hist.lock().await;
    let sent = stats.sent.load(Ordering::Relaxed);
    let recv_self = stats.received_self.load(Ordering::Relaxed);
    let recv_other = stats.received_other.load(Ordering::Relaxed);
    let received = recv_self + recv_other;
    let target_total = (args.clients as u64) * (args.rate as u64) * args.duration;

    println!();
    println!("--- report ---");
    println!("wall time:       {:.2}s", elapsed.as_secs_f64());
    println!();
    println!("connections");
    println!("  attempted:     {}", args.clients);
    println!(
        "  established:   {} ({:.1}%)",
        stats.connected.load(Ordering::Relaxed),
        100.0 * stats.connected.load(Ordering::Relaxed) as f64 / args.clients.max(1) as f64
    );
    println!(
        "  failed:        {}",
        stats.failed_connect.load(Ordering::Relaxed)
    );
    println!();
    println!("throughput");
    println!(
        "  strokes sent:  {:>10}  ({:.0}/s, target {})",
        sent,
        sent as f64 / elapsed.as_secs_f64().max(0.001),
        target_total,
    );
    println!(
        "  strokes recv:  {:>10}  ({:.0}/s, self={} other={})",
        received,
        received as f64 / elapsed.as_secs_f64().max(0.001),
        recv_self,
        recv_other,
    );
    if sent > 0 {
        let fanout = received as f64 / sent as f64;
        println!("  fanout ratio:  {fanout:.2}x");
    }
    println!();
    println!("stroke RTT (send → self-echo)");
    if !hist.is_empty() {
        println!("  samples:       {}", hist.len());
        println!("  min:           {:>7.2} ms", hist.min() as f64 / 1000.0);
        println!(
            "  p50:           {:>7.2} ms",
            hist.value_at_quantile(0.50) as f64 / 1000.0
        );
        println!(
            "  p95:           {:>7.2} ms",
            hist.value_at_quantile(0.95) as f64 / 1000.0
        );
        println!(
            "  p99:           {:>7.2} ms",
            hist.value_at_quantile(0.99) as f64 / 1000.0
        );
        println!("  max:           {:>7.2} ms", hist.max() as f64 / 1000.0);
    } else {
        println!("  (no samples)");
    }
    println!();
    println!("errors");
    println!(
        "  bad frames:    {}",
        stats.bad_frames.load(Ordering::Relaxed)
    );
    println!(
        "  ws errors:     {}",
        stats.ws_errors.load(Ordering::Relaxed)
    );
}

/// Build a rustls config that accepts any server cert. Only used when the
/// operator opted in with --insecure. Trades MITM detection for the ability
/// to hit self-signed dev clusters; never for production verification.
fn insecure_rustls_config() -> Arc<rustls::ClientConfig> {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, Error as RustlsError, SignatureScheme};

    #[derive(Debug)]
    struct NoVerify;

    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, RustlsError> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, RustlsError> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, RustlsError> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
            ]
        }
    }

    // rustls 0.22 has no process-level default provider; pass ring's
    // explicitly via builder_with_provider so we don't depend on whatever
    // the embedding application may or may not have installed.
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("safe default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerify))
        .with_no_client_auth(),
    )
}

async fn run_client(
    url: String,
    name: String,
    duration: Duration,
    send_interval: Duration,
    shared: Arc<Shared>,
    connector: Option<tokio_tungstenite::Connector>,
    connect_only: bool,
) -> Result<()> {
    let req = match url.parse::<tokio_tungstenite::tungstenite::http::Uri>() {
        Ok(u) => u,
        Err(_) => {
            shared.stats.failed_connect.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
    };
    let connect = tokio_tungstenite::connect_async_tls_with_config(req, None, false, connector);
    let (ws, _) = match connect.await {
        Ok(x) => x,
        Err(_) => {
            shared.stats.failed_connect.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
    };
    shared.stats.connected.fetch_add(1, Ordering::Relaxed);

    let (mut sink, mut stream) = ws.split();

    // Send Hello.
    let room = parse_room(&url);
    let hello = ClientMsg::Hello(Hello {
        room,
        name,
        resume_from: None,
        client_token: None,
        avatar: Avatar::default(),
    });
    if sink
        .send(Message::Binary(encode(&hello).unwrap()))
        .await
        .is_err()
    {
        shared.stats.ws_errors.fetch_add(1, Ordering::Relaxed);
        return Ok(());
    }

    // Read Welcome to learn our player id.
    let you_id = loop {
        let frame = match stream.next().await {
            Some(Ok(f)) => f,
            Some(Err(_)) => {
                shared.stats.ws_errors.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            None => return Ok(()),
        };
        let Message::Binary(bytes) = frame else {
            continue;
        };
        match decode::<ServerMsg>(&bytes) {
            Ok(ServerMsg::Welcome { you, .. }) => break you,
            Ok(_) => continue,
            Err(_) => {
                shared.stats.bad_frames.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
        }
    };

    // Connect-only mode: we've measured the full TLS+WS+Hello+Welcome
    // round-trip by reaching this point. Drop the connection and return so
    // the caller can fire the next handshake.
    if connect_only {
        let _ = sink.close().await;
        return Ok(());
    }

    let send_times: Arc<std::sync::Mutex<HashMap<u32, Instant>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));
    let local_hist: Arc<std::sync::Mutex<Histogram<u64>>> = Arc::new(std::sync::Mutex::new(
        Histogram::<u64>::new(3).expect("histogram"),
    ));
    let started = Instant::now();
    let stop_at = started + duration;
    let drain_for = Duration::from_millis(500);

    // Two-phase run with an outer hard deadline: steady-state send+recv until
    // stop_at, then drain for a fixed window. Even if the stream goes silent
    // (everyone else stopped), the absolute timer breaks us out cleanly.
    let outer = tokio::time::timeout(duration + drain_for + Duration::from_secs(2), async {
        // -- steady state: send on an interval, drain recv concurrently --
        let send_times_s = send_times.clone();
        let local_hist_s = local_hist.clone();
        let shared_s = shared.clone();
        let send_task = tokio::spawn(async move {
            let mut stroke_id: u32 = 1;
            let mut tick = tokio::time::interval(send_interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            while Instant::now() < stop_at {
                tick.tick().await;
                if Instant::now() >= stop_at {
                    break;
                }
                send_times_s
                    .lock()
                    .unwrap()
                    .insert(stroke_id, Instant::now());
                let msg = ClientMsg::Stroke {
                    stroke_id,
                    origin: (100, 100),
                    color: 0x000000,
                    width: 4,
                    points: vec![Point {
                        dx: 1,
                        dy: 1,
                        dt: 16,
                        pressure: 0,
                    }],
                    finished: false,
                };
                let bytes = encode(&msg).unwrap();
                if sink.send(Message::Binary(bytes)).await.is_err() {
                    shared_s.stats.ws_errors.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                shared_s.stats.sent.fetch_add(1, Ordering::Relaxed);
                stroke_id = stroke_id.wrapping_add(1);
            }
            let _ = local_hist_s;
        });

        let recv_send_times = send_times.clone();
        let recv_local_hist = local_hist.clone();
        let recv_shared = shared.clone();
        let recv_task = tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                let bytes = match frame {
                    Ok(Message::Binary(b)) => b,
                    Ok(_) => continue,
                    Err(_) => {
                        recv_shared.stats.ws_errors.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                };
                match decode::<ServerMsg>(&bytes) {
                    Ok(ServerMsg::Stroke {
                        player,
                        stroke_id: sid,
                        ..
                    }) => {
                        if player == you_id {
                            let at = recv_send_times.lock().unwrap().remove(&sid);
                            if let Some(t) = at {
                                let dt = t.elapsed().as_micros() as u64;
                                let _ = recv_local_hist.lock().unwrap().record(dt);
                                recv_shared
                                    .stats
                                    .received_self
                                    .fetch_add(1, Ordering::Relaxed);
                            }
                        } else {
                            recv_shared
                                .stats
                                .received_other
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Ok(_) => {}
                    Err(_) => {
                        recv_shared.stats.bad_frames.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                }
            }
        });

        let _ = send_task.await;
        // Drain phase: read more echoes for a bounded window, then
        // cancel the receiver. The outer timeout above is the safety
        // net if the abort doesn't take.
        tokio::time::sleep(drain_for).await;
        recv_task.abort();
        let _ = recv_task.await;
    })
    .await;
    if outer.is_err() {
        // Client overran the safety net; not fatal, just note it.
        shared.stats.ws_errors.fetch_add(1, Ordering::Relaxed);
    }

    let mut global = shared.global_hist.lock().await;
    let local = local_hist.lock().unwrap();
    let _ = global.add(&*local);
    Ok(())
}
