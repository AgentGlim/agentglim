//! D32 privacy gate: secrets are redacted **before** the store transaction, before the in-process broadcast and in
//! every log line, and the non-secret part of the same record survives untouched.
//!
//! Every canary here is generated at runtime from fragments, so this file itself contains no token, address or home
//! path literal (the `scrub` target scans `tests/`). The canaries are asserted to be present in the batch *input*
//! before the daemon sees it, so "absent from the outputs" cannot pass vacuously.
//!
//! The batch travels the real production path: a fake `Source` polled by `spawn_poller`, committed by `Bus::commit`
//! into a real SQLite file and fanned out on the real broadcast channel. No network, no daemon process, no live data.

use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, ItemKind, RecordKey, Source,
    SourceCheckpoint, SourceKind,
};
use agentglimd::logging::{self, REDACTED, REDACTED_EMAIL};
use agentglimd::store::Store;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

// -------------------------------------------------------------------------------------------------- canaries

/// The five secret shapes the plan requires, each at least 8 characters of payload, built from fragments.
struct Canaries {
    /// Opaque install-token-like credential: 64 lowercase hex characters.
    install_token: String,
    /// A whole `Bearer` header line.
    bearer: String,
    /// An email-shaped address.
    email: String,
    /// An API-key-shaped string (`sk-` prefix plus a long opaque tail).
    api_key: String,
    /// An absolute home path under a test-only user name.
    home_path: String,
}

impl Canaries {
    fn planted() -> Self {
        // '@' via its scalar value: no address literal lives in this file.
        let at = char::from_u32(0x40).expect("U+0040");
        let install_token = format!(
            "{}{}{}",
            "6f1c4b8a9d2e5073", "a8b1c6d40e9f2a7b3c4d5e6f70819203", "a4b5c6d7e8f90123"
        );
        let bearer_value = format!("{}{}", "canary-bearer-", "7f3d9k2m5p8q1r4t");
        let email = format!("canary.user9f2{at}{}.{}", "example", "test");
        let api_key = format!("{}{}", "s", "k-canary9a8b7c6d5e4f3g2h1j0");
        let home_path = format!("{}me{}{}{}", "/ho", "/", "canary-home", "/project/.env");
        Self {
            bearer: format!("{} {}", "Bearer", bearer_value),
            install_token,
            email,
            api_key,
            home_path,
        }
    }

    /// Proves each canary really has the shape it is meant to test.
    fn assert_shapes(&self) {
        assert_eq!(self.install_token.len(), 64, "install token shape");
        assert!(
            self.install_token.chars().all(|c| c.is_ascii_hexdigit()),
            "install token shape"
        );
        assert!(self.bearer.starts_with(&format!("{} ", "Bearer")));
        assert!(self.bearer.len() > 16);
        assert_eq!(self.email.matches(char::from_u32(0x40).unwrap()).count(), 1);
        assert!(self.email.split('.').count() >= 2, "email shape");
        assert!(self.api_key.starts_with(&format!("{}-", "sk")));
        assert!(self.api_key.len() > 16);
        assert!(self.home_path.starts_with(&format!("{}me/", "/ho")));
        assert!(!self.home_path.ends_with('/'));
    }

    fn all(&self) -> [&str; 5] {
        [
            &self.install_token,
            &self.bearer,
            &self.email,
            &self.api_key,
            &self.home_path,
        ]
    }

    /// Every canary must be absent from `text`.
    fn assert_absent(&self, text: &str, where_: &str) {
        for c in self.all() {
            assert!(
                !text.contains(c),
                "{where_} still contains a planted canary"
            );
        }
        // The payload of a Bearer header is a secret on its own, even split off its prefix.
        let value = self.bearer.split_once(' ').expect("header has a value").1;
        assert!(
            !text.contains(value),
            "{where_} still contains a bearer value"
        );
    }
}

// --------------------------------------------------------------------------------------------- fake source

/// One scripted poll: the items, their producer identities and the checkpoint after reading them.
struct Scripted {
    items: Mutex<Vec<BatchItem>>,
    identities: Mutex<Vec<RecordKey>>,
    polls: AtomicUsize,
}

impl Scripted {
    fn new(items: Vec<BatchItem>, identities: Vec<RecordKey>) -> Arc<Self> {
        assert_eq!(items.len(), identities.len(), "one identity per item");
        Arc::new(Self {
            items: Mutex::new(items),
            identities: Mutex::new(identities),
            polls: AtomicUsize::new(0),
        })
    }
}

impl Source for Scripted {
    fn id(&self) -> &'static str {
        "privacy-fake"
    }
    fn kind(&self) -> SourceKind {
        SourceKind::CodingAgent
    }
    fn detect(&self, _env: &Env) -> Detection {
        Detection::Detected { paths: vec![] }
    }
    fn capabilities(&self) -> Caps {
        Caps::WATCH
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move {
            self.polls.fetch_add(1, Ordering::SeqCst);
            let items: Vec<BatchItem> = std::mem::take(&mut *self.items.lock().unwrap());
            let next = Cursor(since.0 + items.len() as u64);
            Ok(Batch { items, next })
        })
    }
    fn checkpoint(&self) -> SourceCheckpoint {
        SourceCheckpoint::default()
    }
    fn restore_checkpoint(&self, _checkpoint: SourceCheckpoint) {}
    fn identities(&self) -> Vec<RecordKey> {
        self.identities.lock().unwrap().clone()
    }
}

// ----------------------------------------------------------------------------------------------- helpers

/// The batch the daemon is asked to store: the canaries sit in the fields a real adapter would use.
fn planted_items(c: &Canaries) -> Vec<BatchItem> {
    vec![
        BatchItem {
            kind: ItemKind::Step,
            session: format!("sess-{}", "stable"),
            data: json!({
                "ts": "2026-11-01T10:00:00.000Z",
                "tool": "Read",
                "text": "non-secret text survives byte-for-byte",
                "install_token": c.install_token,
                "header": c.bearer,
                "author": format!("notify {} about the run", c.email),
                "api": format!("using key {} for the call", c.api_key),
                "cwd": format!("opened {} earlier", c.home_path),
                "input_tokens": 7,
                "tokens": {"input": 10, "output": 5},
            }),
        },
        BatchItem {
            kind: ItemKind::Session,
            session: format!("run-{}", c.email),
            data: json!({
                "ts": "2026-11-01T10:00:01.000Z",
                "text": "second record stays",
            }),
        },
    ]
}

fn identities_for(items: &[BatchItem]) -> Vec<RecordKey> {
    (0..items.len())
        .map(|i| RecordKey::Revision {
            namespace: "privacy-fake".into(),
            revision: "r1".into(),
            item: i as u32,
        })
        .collect()
}

async fn wait_until(what: &str, limit: Duration, mut ok: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < limit {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

fn stored_rows(store: &Store) -> Vec<(String, Option<String>)> {
    store
        .with(|c| {
            let mut st = c.prepare("SELECT data, session FROM events ORDER BY seq")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect()
        })
        .expect("read events")
}

fn audit_rows(store: &Store) -> Vec<(String, String, String)> {
    store
        .with(|c| {
            let mut st = c.prepare("SELECT actor, action, detail FROM audit ORDER BY rowid")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect()
        })
        .expect("read audit")
}

fn db(data: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(data.join("store.db")).expect("open db")
}

/// Reads every rotated log file of the data dir.
fn log_text(data: &Path) -> String {
    let dir = data.join("logs");
    let mut out = String::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for p in entries {
        if let Ok(t) = std::fs::read_to_string(&p) {
            out.push_str(&t);
        }
    }
    out
}

// -------------------------------------------------------------------------------------------------- tests

/// The whole path: fake source -> poller -> bus commit -> SQLite + broadcast, then audit and logs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secrets_are_redacted_before_storage_and_broadcast() {
    let c = Canaries::planted();
    c.assert_shapes();

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let guard = logging::init(&data).expect("json log writer");

    let store = Store::open(&data.join("store.db")).unwrap();
    let bus = Arc::new(Bus::new(store.clone()).unwrap());
    let mut rx = bus.subscribe();

    let items = planted_items(&c);
    let identities = identities_for(&items);

    // The canaries are demonstrably in the input the daemon receives.
    let input = serde_json::to_string(&items).unwrap();
    for canary in c.all() {
        assert!(
            input.contains(canary),
            "canary missing from the batch input"
        );
    }

    let src = Scripted::new(items.clone(), identities.clone());
    let (_refresh_tx, refresh) = watch::channel(0u64);
    let (stop_tx, stop_rx) = watch::channel(false);
    let deps = PollerDeps {
        store: store.clone(),
        bus: bus.clone(),
        sources: Arc::new(vec![src.clone() as Arc<dyn Source>]),
        runtimes: Arc::new(Vec::new()),
        status: Arc::new(StatusCache::new()),
        env: Env::default(),
        intervals: Intervals {
            poll: Duration::from_millis(20),
            discover: Duration::from_millis(20),
        },
        refresh,
    };
    let handle = spawn_poller(deps, stop_rx);
    wait_until(
        "the planted batch to be committed",
        Duration::from_secs(10),
        || store.event_count().unwrap_or(0) >= 2,
    )
    .await;

    // 1. Durable rows: payload and session.
    let rows = stored_rows(&store);
    assert_eq!(rows.len(), 2, "no record may be dropped for redaction");
    for (data_text, session) in &rows {
        c.assert_absent(data_text, "events.data");
        if let Some(session) = session {
            c.assert_absent(session, "events.session");
        }
    }
    let first: Value = serde_json::from_str(&rows[0].0).unwrap();
    // Non-secret fields survive byte-for-byte; only the sensitive run is replaced.
    assert_eq!(
        first["text"],
        json!("non-secret text survives byte-for-byte")
    );
    assert_eq!(first["tool"], json!("Read"));
    assert_eq!(first["input_tokens"], json!(7));
    assert_eq!(first["tokens"]["input"], json!(10));
    assert_eq!(first["install_token"], json!(REDACTED));
    assert_eq!(first["header"], json!(format!("{}{}", "Bearer ", REDACTED)));
    assert_eq!(
        first["author"],
        json!(format!("notify {} about the run", REDACTED_EMAIL))
    );
    assert_eq!(
        first["api"],
        json!(format!("using key {}{} for the call", "sk-", REDACTED))
    );
    assert_eq!(first["cwd"], json!("opened ~/project/.env earlier"));
    // The email-shaped session id is redacted in the same way, and the plain one is untouched.
    assert_eq!(rows[0].1.as_deref(), Some("sess-stable"));
    // The whole address-shaped session word is replaced, keeping the record itself.
    assert_eq!(rows[1].1.as_deref(), Some(REDACTED_EMAIL));

    // 2. The in-process broadcast carries exactly the stored (redacted) payload.
    for _ in 0..2 {
        let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("broadcast event within 5 s")
            .expect("broadcast channel open");
        c.assert_absent(&ev.data.to_string(), "bus payload");
        assert_eq!(ev.source, "privacy-fake");
    }

    // 3. Audit rows.
    store
        .audit(
            "install-token",
            "privacy.test",
            &format!(
                "token {} header {} mail {} key {} path {}",
                c.install_token, c.bearer, c.email, c.api_key, c.home_path
            ),
        )
        .unwrap();
    let audit = audit_rows(&store);
    assert_eq!(audit.len(), 1);
    let (actor, action, detail) = &audit[0];
    assert_eq!(actor, "install-token");
    assert_eq!(action, "privacy.test", "non-secret audit fields survive");
    assert!(detail.starts_with("token "), "{detail}");
    for canary in c.all() {
        assert!(!detail.contains(canary), "audit.detail still has a canary");
    }

    // 4. JSON logs (the real rotating writer behind `logging::init`).
    tracing::info!(
        target: "privacy",
        "canary log line {} {} {} {}",
        c.bearer,
        c.email,
        c.home_path,
        c.api_key
    );
    drop(guard);
    wait_until("the log line to reach disk", Duration::from_secs(5), || {
        log_text(&data).contains("canary log line")
    })
    .await;
    let logs = log_text(&data);
    c.assert_absent(&logs, "JSON logs");
    assert!(
        logs.contains("canary log line"),
        "the log line itself must be kept, not dropped"
    );

    // 5. A replayed batch with the same identities is still deduplicated after redaction.
    let ck = SourceCheckpoint::default();
    let again = bus
        .commit("privacy-fake", &items, &ck, &[], &[], &identities)
        .unwrap();
    assert!(again.is_empty(), "replay must insert nothing");
    assert_eq!(store.event_count().unwrap(), 2);

    let _ = stop_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

/// `Bus::publish` (the daemon's own events) goes through the same redaction, and the returned event matches the row.
#[test]
fn published_events_are_redacted_and_returned_redacted() {
    let c = Canaries::planted();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("s.db")).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let ev = bus
        .publish(
            "daemon",
            "daemon",
            json!({"state": "started", "install_token": c.install_token, "note": format!("see {}", c.home_path)}),
        )
        .unwrap();
    c.assert_absent(&ev.data.to_string(), "publish() return value");
    let row: String = store
        .with(|conn| {
            conn.query_row(
                "SELECT data FROM events WHERE seq=?1",
                [ev.seq as i64],
                |r| r.get(0),
            )
        })
        .unwrap();
    c.assert_absent(&row, "published row");
    let parsed: Value = serde_json::from_str(&row).unwrap();
    assert_eq!(parsed["state"], json!("started"));
    assert_eq!(parsed["note"], json!("see ~/project/.env"));
    assert_eq!(ev.data, parsed, "returned event equals the stored payload");
}

/// Redaction is deterministic and idempotent, which is what keeps dedup identities stable across retries.
#[test]
fn redaction_is_deterministic_and_idempotent() {
    let c = Canaries::planted();
    let samples = [
        c.bearer.clone(),
        format!("mail {}", c.email),
        format!("path {}", c.home_path),
        c.api_key.clone(),
    ];
    for s in samples {
        let once = logging::redact(&s, None);
        assert_eq!(once, logging::redact(&s, None), "deterministic");
        assert_eq!(logging::redact(&once, None), once, "idempotent");
        c.assert_absent(&once, "redacted sample");
    }
}

/// A failed transaction still commits nothing and the retried batch lands once, with the same redacted payload.
#[test]
fn rollback_then_retry_keeps_redaction_and_atomicity() {
    let c = Canaries::planted();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = Store::open(&path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let items = planted_items(&c);
    let identities = identities_for(&items);
    let ck = SourceCheckpoint::default();

    // Deterministic failure: every event insert aborts inside the transaction.
    db(dir.path())
        .execute_batch(
            "CREATE TRIGGER inject_fail BEFORE INSERT ON events
             BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
        )
        .unwrap();
    let failed = bus.commit("privacy-fake", &items, &ck, &[], &[], &identities);
    assert!(failed.is_err(), "the injected failure must surface");
    assert_eq!(
        store.event_count().unwrap(),
        0,
        "a failed commit stores nothing"
    );

    db(dir.path())
        .execute_batch("DROP TRIGGER inject_fail")
        .unwrap();
    let evs = bus
        .commit("privacy-fake", &items, &ck, &[], &[], &identities)
        .expect("retry succeeds");
    assert_eq!(evs.len(), 2);
    for ev in &evs {
        c.assert_absent(&ev.data.to_string(), "retried broadcast payload");
    }
    let rows = stored_rows(&store);
    assert_eq!(rows.len(), 2);
    for (data_text, session) in &rows {
        c.assert_absent(data_text, "retried row");
        if let Some(s) = session {
            c.assert_absent(s, "retried session");
        }
    }
    // Redacted values are byte-identical to the first attempt's inputs being redacted once.
    let first: Value = serde_json::from_str(&rows[0].0).unwrap();
    assert_eq!(
        first["text"],
        json!("non-secret text survives byte-for-byte")
    );
}
