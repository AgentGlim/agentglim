//! Durable producer identity, full checkpoint persistence and removal/reappearance recovery (v2-r3 T1).
//!
//! Nothing here starts a daemon process: a scripted `Source` is driven by the real `spawn_poller` over a real
//! SQLite file, so every assertion is about the actual core/store path (pending batch, one transaction per
//! batch, restore before polling) and not about test-only code. Fixtures only, no network, no live roots.

use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileCheckpoint, ItemKind,
    RecordKey, RemovedPath, Source, SourceCheckpoint, SourceKind,
};
use agentglimd::store::Store;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

// --------------------------------------------------------------------------------------------- scripted source

/// One scripted poll result: the items, their producer identities and the checkpoint after reading them.
#[derive(Clone)]
struct Frame {
    items: Vec<BatchItem>,
    identities: Vec<RecordKey>,
    checkpoint: SourceCheckpoint,
}

impl Frame {
    fn new(
        items: Vec<BatchItem>,
        identities: Vec<RecordKey>,
        checkpoint: SourceCheckpoint,
    ) -> Self {
        assert_eq!(items.len(), identities.len(), "one identity per item");
        Self {
            items,
            identities,
            checkpoint,
        }
    }

    fn empty(checkpoint: SourceCheckpoint) -> Self {
        Self {
            items: Vec::new(),
            identities: Vec::new(),
            checkpoint,
        }
    }
}

struct Scripted {
    frames: Mutex<VecDeque<Frame>>,
    checkpoint: Mutex<SourceCheckpoint>,
    last_identities: Mutex<Vec<RecordKey>>,
    restored: Mutex<Vec<SourceCheckpoint>>,
    restored_removed: Mutex<Vec<RemovedPath>>,
    polls: AtomicUsize,
    complete: std::sync::atomic::AtomicBool,
    /// The one allowance core hands the current turn, and its final usage once `end_turn` closed it (v5-r3:
    /// lets a test see how much of the shared per-turn visit cap the core-side reconciliation actually used).
    current: Mutex<Option<Arc<agentglimd::core::TurnBudget>>>,
    turns: Mutex<Vec<agentglimd::core::TurnUsage>>,
}

impl Scripted {
    fn new(frames: Vec<Frame>) -> Arc<Self> {
        Self::new_with_complete(frames, true)
    }

    fn new_with_complete(frames: Vec<Frame>, complete: bool) -> Arc<Self> {
        Arc::new(Self {
            frames: Mutex::new(frames.into()),
            checkpoint: Mutex::new(SourceCheckpoint::default()),
            last_identities: Mutex::new(Vec::new()),
            restored: Mutex::new(Vec::new()),
            restored_removed: Mutex::new(Vec::new()),
            polls: AtomicUsize::new(0),
            complete: std::sync::atomic::AtomicBool::new(complete),
            current: Mutex::new(None),
            turns: Mutex::new(Vec::new()),
        })
    }

    fn polls(&self) -> usize {
        self.polls.load(Ordering::SeqCst)
    }

    /// Whole-turn usage of every scheduled turn that closed, in order (one entry per `begin_turn`/`end_turn`).
    fn turns(&self) -> Vec<agentglimd::core::TurnUsage> {
        self.turns.lock().unwrap().clone()
    }

    fn restored(&self) -> Vec<SourceCheckpoint> {
        self.restored.lock().unwrap().clone()
    }

    fn restored_removed(&self) -> Vec<RemovedPath> {
        self.restored_removed.lock().unwrap().clone()
    }
}

impl Source for Scripted {
    fn id(&self) -> &'static str {
        "scripted"
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
            let frame = self.frames.lock().unwrap().pop_front();
            let next = match &frame {
                Some(f) => {
                    *self.checkpoint.lock().unwrap() = f.checkpoint.clone();
                    *self.last_identities.lock().unwrap() = f.identities.clone();
                    Cursor(since.0 + f.items.len() as u64)
                }
                None => {
                    *self.last_identities.lock().unwrap() = Vec::new();
                    Cursor(since.0)
                }
            };
            Ok(Batch {
                items: frame.map(|f| f.items).unwrap_or_default(),
                next,
            })
        })
    }
    fn checkpoint(&self) -> SourceCheckpoint {
        self.checkpoint.lock().unwrap().clone()
    }
    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        self.restored.lock().unwrap().push(checkpoint.clone());
        *self.checkpoint.lock().unwrap() = checkpoint;
    }
    fn identities(&self) -> Vec<RecordKey> {
        self.last_identities.lock().unwrap().clone()
    }
    fn restore_removed(&self, removed: &[RemovedPath]) {
        self.restored_removed
            .lock()
            .unwrap()
            .extend_from_slice(removed);
    }
    fn discovery_complete(&self) -> bool {
        self.complete.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn begin_turn(&self, allowance: Arc<agentglimd::core::TurnBudget>) {
        *self.current.lock().unwrap() = Some(allowance);
    }
    fn end_turn(&self) {
        if let Some(b) = self.current.lock().unwrap().take() {
            self.turns.lock().unwrap().push(b.usage());
        }
    }
}

// ---------------------------------------------------------------------------------------------------- harness

struct Harness {
    data: PathBuf,
    store: Store,
    bus: Arc<Bus>,
    src: Arc<Scripted>,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Harness {
    fn path(data: &Path) -> PathBuf {
        data.join("state.db")
    }

    fn open(data: &Path, src: Arc<Scripted>) -> Self {
        let store = Store::open(&Self::path(data)).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let (refresh_tx, refresh) = watch::channel(0u64);
        std::mem::forget(refresh_tx); // keeps at least one sender alive for the loop's lifetime
        let (stop, stop_rx) = watch::channel(false);
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
        Self {
            data: data.to_path_buf(),
            store,
            bus,
            src,
            stop,
            handle,
        }
    }

    fn start(dir: &tempfile::TempDir, frames: Vec<Frame>) -> Self {
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let src = Scripted::new(frames);
        Self::open(&data, src)
    }

    /// Same, but the schema is created and a trigger that aborts every file-state insert is installed BEFORE the
    /// poller starts, so the first batch's transaction fails deterministically instead of by timing.
    fn start_with_failing_commit(dir: &tempfile::TempDir, frames: Vec<Frame>) -> Self {
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        drop(Store::open(&Self::path(&data)).unwrap());
        db(&data)
            .execute_batch(
                "CREATE TRIGGER inject_fail BEFORE INSERT ON source_file_state
                 BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;",
            )
            .unwrap();
        let src = Scripted::new(frames);
        Self::open(&data, src)
    }

    async fn stop(self) -> Self {
        let _ = self.stop.send(true);
        let Self {
            data,
            store,
            bus,
            src,
            stop,
            handle,
        } = self;
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        Self {
            data,
            store,
            bus,
            src,
            stop,
            handle: tokio::spawn(async {}),
        }
    }
}

fn db(data: &Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(Harness::path(data)).unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    c
}

/// Connection to a store file that is not the harness's `state.db`.
fn open_db(path: &Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(path).unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    c
}

fn count(data: &Path) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) FROM events WHERE source='scripted'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

fn data_of(data: &Path) -> Vec<String> {
    let c = db(data);
    let mut st = c
        .prepare("SELECT data FROM events WHERE source='scripted' ORDER BY seq")
        .unwrap();
    st.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

fn producer_keys(data: &Path) -> Vec<String> {
    let c = db(data);
    let mut st = c
        .prepare("SELECT producer FROM events WHERE source='scripted' ORDER BY seq")
        .unwrap();
    st.query_map([], |r| r.get::<_, Option<String>>(0))
        .unwrap()
        .map(|r| r.unwrap().expect("row carries a producer identity"))
        .collect()
}

async fn wait_for(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while t0.elapsed() < within {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

fn item(kind: ItemKind, session: &str, payload: Value) -> BatchItem {
    BatchItem {
        kind,
        session: session.to_string(),
        data: payload,
    }
}

/// Checkpoint holding one offset-based file.
fn one_file(path: &str, generation: u64, offset: u64, size: u64) -> SourceCheckpoint {
    SourceCheckpoint {
        files: vec![FileCheckpoint {
            path: path.to_string(),
            generation,
            offset,
            size,
            mtime_ms: 1_000,
            fingerprint: format!("fp-{generation}"),
            session: Some("s1".into()),
            model: Some("m".into()),
            announced: true,
            discarded_bytes: 0,
            incomplete: false,
            revision: Some(generation.to_string()),
        }],
        revisions: BTreeMap::new(),
    }
}

const LOG: &str = "logs/a.jsonl";

// ------------------------------------------------------------------------------------------------------ tests

/// A checkpoint-only advance (no events: e.g. a parser that skipped undecodable bytes, bumped a generation or
/// updated a fingerprint) is committed and restored before the next poll, i.e. it survives a restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_checkpoint_only_update_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let mut first = one_file(LOG, 3, 512, 512);
    first.revisions.insert("round".into(), "7".into());
    let h = Harness::start(&dir, vec![Frame::empty(first)]);
    let data_path = h.data.clone();

    wait_for("checkpoint-only commit", Duration::from_secs(5), || {
        let c = db(&data_path);
        c.query_row(
            "SELECT COUNT(*) FROM source_file_state WHERE source='scripted' AND path=?1 AND offset=512 AND generation=3",
            [LOG],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
            == 1
    })
    .await;
    let revisions = h.store.load_revisions("scripted").unwrap();
    assert_eq!(revisions.get("round").map(String::as_str), Some("7"));
    assert_eq!(count(&data_path), 0, "checkpoint-only: no events");
    let h = h.stop().await;
    drop(h);

    // Restart with a source that has no script: it must be handed the durable checkpoint before polling.
    let src = Scripted::new(Vec::new());
    let h2 = Harness::open(&data_path, src.clone());
    wait_for("restore on restart", Duration::from_secs(5), || {
        !src.restored().is_empty()
    })
    .await;
    let restored = src.restored();
    let files = &restored[0].files;
    assert_eq!(files.len(), 1, "whole checkpoint restored: {files:?}");
    assert_eq!(files[0].path, LOG);
    assert_eq!((files[0].generation, files[0].offset), (3, 512));
    assert_eq!(
        restored[0].revisions.get("round").map(String::as_str),
        Some("7"),
        "source-level revisions are restored too"
    );
    assert_eq!(count(&data_path), 0);
    let h2 = h2.stop().await;
    drop(h2);
    drop(data);
}

/// A first batch whose transaction fails inserts nothing and is retried exactly once, unchanged: the poller does
/// not re-poll the advanced source while a pending batch is uncommitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn b_failed_first_batch_retries_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut frame_ck = one_file(LOG, 1, 40, 40);
    frame_ck.revisions.insert("gen".into(), "1".into());
    let frame = Frame::new(
        vec![
            item(
                ItemKind::Step,
                "s1",
                json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
            ),
            item(
                ItemKind::Spend,
                "s1",
                json!({"model": "m", "input_tokens": 7, "ts": "2026-11-01T10:00:00.000Z"}),
            ),
        ],
        vec![
            RecordKey::offset(LOG, 1, 0, 0),
            RecordKey::offset(LOG, 1, 0, 1),
        ],
        frame_ck,
    );
    let h = Harness::start_with_failing_commit(&dir, vec![frame]);
    let data = h.data.clone();

    wait_for("a failed commit attempt", Duration::from_secs(5), || {
        h.src.polls() >= 1
    })
    .await;
    settle(250).await;
    assert_eq!(count(&data), 0, "failed transaction inserted nothing");
    assert!(producer_keys(&data).is_empty());
    assert_eq!(
        h.src.polls(),
        1,
        "an uncommitted pending batch is retried, not re-polled"
    );

    db(&data)
        .execute_batch("DROP TRIGGER inject_fail;")
        .unwrap();
    wait_for("the retried batch", Duration::from_secs(5), || {
        count(&data) == 2
    })
    .await;
    settle(300).await;
    assert_eq!(count(&data), 2, "exactly the pending items, once");
    assert_eq!(
        producer_keys(&data),
        vec![
            RecordKey::offset(LOG, 1, 0, 0).key(),
            RecordKey::offset(LOG, 1, 0, 1).key()
        ],
        "identities committed with the retried batch"
    );
    assert_eq!(
        h.store
            .load_revisions("scripted")
            .unwrap()
            .get("gen")
            .map(String::as_str),
        Some("1"),
        "checkpoint committed with the same transaction"
    );
    let h = h.stop().await;
    drop(h);
    drop(data);
}

/// Commit succeeded but the process died before anything was published. A restart that re-reads the very same
/// records (worst case: the adapter restarted from offset 0) must neither duplicate nor lose them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn c_commit_before_publish_restart_has_no_loss_or_duplication() {
    let dir = tempfile::tempdir().unwrap();
    let items = vec![
        item(
            ItemKind::Step,
            "s1",
            json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
        ),
        item(
            ItemKind::Step,
            "s1",
            json!({"text": "B", "ts": "2026-11-01T10:00:00.000Z"}),
        ),
    ];
    let keys = vec![
        RecordKey::offset(LOG, 1, 0, 0),
        RecordKey::offset(LOG, 1, 40, 0),
    ];
    let frame = Frame::new(items.clone(), keys.clone(), one_file(LOG, 1, 80, 80));
    let h = Harness::start(&dir, vec![frame.clone()]);
    let data = h.data.clone();
    wait_for("commit", Duration::from_secs(5), || count(&data) == 2).await;
    let before = data_of(&data);
    // Nothing is lost when the daemon is killed right here: the rows are already durable.
    let h = h.stop().await;
    drop(h);

    // Restart; the adapter has a stale (offset 0) view and re-reads the same two records.
    let replay = Frame::new(items, keys, one_file(LOG, 1, 80, 80));
    let h2 = Harness::start(&dir, vec![replay, frame]);
    wait_for("a replay pass", Duration::from_secs(5), || {
        h2.src.polls() >= 2
    })
    .await;
    settle(300).await;
    assert_eq!(data_of(&data), before, "no lost observation after restart");
    assert_eq!(count(&data), 2, "replayed identities inserted nothing");
    let h2 = h2.stop().await;
    drop(h2);
    drop(data);
}

/// The same two observations delivered in different batch partitions (one batch, then one each, then the whole
/// batch again) insert exactly once: identity does not depend on the batch boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn d_identical_records_across_partitions_dedup() {
    let dir = tempfile::tempdir().unwrap();
    let a = item(
        ItemKind::Step,
        "s1",
        json!({"text": "same", "ts": "2026-11-01T10:00:00.000Z"}),
    );
    let b = item(
        ItemKind::Spend,
        "s1",
        json!({"model": "m", "input_tokens": 3, "ts": "2026-11-01T10:00:00.000Z"}),
    );
    let ka = RecordKey::offset(LOG, 1, 0, 0);
    let kb = RecordKey::offset(LOG, 1, 10, 0);
    let frames = vec![
        Frame::new(
            vec![a.clone(), b.clone()],
            vec![ka.clone(), kb.clone()],
            one_file(LOG, 1, 20, 20),
        ),
        Frame::new(vec![a.clone()], vec![ka.clone()], one_file(LOG, 1, 20, 20)),
        Frame::new(vec![b.clone()], vec![kb.clone()], one_file(LOG, 1, 20, 20)),
        Frame::new(vec![a, b], vec![ka, kb], one_file(LOG, 1, 20, 20)),
    ];
    let h = Harness::start(&dir, frames);
    let data = h.data.clone();
    wait_for("every partition polled", Duration::from_secs(5), || {
        h.src.polls() >= 4
    })
    .await;
    settle(400).await;
    assert_eq!(
        count(&data),
        2,
        "identical observations from any partition once"
    );
    let h = h.stop().await;
    drop(h);
    drop(data);
}

/// An offset-less (snapshot) producer with durable semantic revisions: A -> B -> A keeps every observation and
/// the sequence survives a restart with an exact replay of all three.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn e_offset_less_a_b_a_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let payload_a = json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"});
    let payload_b = json!({"text": "B", "ts": "2026-11-01T10:00:00.000Z"});
    let frame = |payload: Value, revision: &str, round: &str| {
        let mut ck = SourceCheckpoint::default();
        ck.revisions.insert("round".into(), round.into());
        Frame::new(
            vec![item(ItemKind::Step, "snap", payload)],
            vec![RecordKey::revision("snap", revision, 0)],
            ck,
        )
    };
    let f1 = frame(payload_a.clone(), "rev-1", "1");
    let f2 = frame(payload_b.clone(), "rev-2", "2");
    let f3 = frame(payload_a.clone(), "rev-3", "3");
    let h = Harness::start(&dir, vec![f1.clone(), f2.clone()]);
    let data = h.data.clone();
    wait_for("A and B", Duration::from_secs(5), || count(&data) == 2).await;
    let h = h.stop().await;
    drop(h);

    let h2 = Harness::start(&dir, vec![f3.clone(), f1.clone(), f2.clone(), f3]);
    wait_for("the second A", Duration::from_secs(5), || count(&data) == 3).await;
    settle(400).await;
    assert_eq!(count(&data), 3, "A -> B -> A stored three times");
    let keys = producer_keys(&data);
    let distinct: std::collections::BTreeSet<&String> = keys.iter().collect();
    assert_eq!(
        distinct.len(),
        3,
        "each observation has its own identity: {keys:?}"
    );
    let a_rows = data_of(&data)
        .iter()
        .filter(|d| d.contains("\"text\":\"A\""))
        .count();
    assert_eq!(
        a_rows, 2,
        "both A observations kept with identical payload/time"
    );
    assert_eq!(
        h2.store
            .load_revisions("scripted")
            .unwrap()
            .get("round")
            .map(String::as_str),
        Some("3"),
        "the last committed revision is durable"
    );
    let h2 = h2.stop().await;
    drop(h2);
    drop(data);
    drop(dir);
}

/// A path removed after a completed discovery sweep is tombstoned durably, its cursor and parser state are gone,
/// and a later reappearance starts clean (new generation, no stale offset) instead of resuming the old position.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f_removal_then_reappearance_is_clean() {
    let dir = tempfile::tempdir().unwrap();
    let first = Frame::new(
        vec![item(
            ItemKind::Step,
            "s1",
            json!({"text": "1", "ts": "2026-11-01T10:00:00.000Z"}),
        )],
        vec![RecordKey::offset(LOG, 1, 0, 0)],
        one_file(LOG, 1, 10, 10),
    );
    // Completed sweep found nothing: the adapter stops reporting the path.
    let removed = Frame::empty(SourceCheckpoint::default());
    let h = Harness::start(&dir, vec![first, removed]);
    let data = h.data.clone();
    wait_for("removal committed", Duration::from_secs(5), || {
        let c = db(&data);
        let tomb: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='scripted' AND path=?1",
                [LOG],
                |r| r.get(0),
            )
            .unwrap();
        let states: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM source_file_state WHERE source='scripted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        tomb == 1 && states == 0
    })
    .await;
    assert_eq!(
        h.store.load_removed("scripted").unwrap(),
        vec![RemovedPath {
            path: LOG.into(),
            generation: 1,
            removed_ms: h.store.load_removed("scripted").unwrap()[0].removed_ms,
        }],
        "tombstone records the removed path and its generation"
    );
    assert!(
        h.store.load_offsets("scripted").unwrap().is_empty(),
        "no stale cursor for a removed path"
    );
    let h = h.stop().await;
    drop(h);

    // Restart: the tombstone is handed to the source; then the path reappears at generation 2, offset 0.
    let recreated = Frame::new(
        vec![item(
            ItemKind::Step,
            "s1",
            json!({"text": "2", "ts": "2026-11-01T10:00:05.000Z"}),
        )],
        vec![RecordKey::offset(LOG, 2, 0, 0)],
        one_file(LOG, 2, 4, 4),
    );
    let src = Scripted::new(vec![recreated]);
    let h2 = Harness::open(&data, src.clone());
    wait_for("reappearance committed", Duration::from_secs(5), || {
        let c = db(&data);
        let tomb: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='scripted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let offset: i64 = c
            .query_row(
                "SELECT offset FROM source_file_state WHERE source='scripted' AND path=?1",
                [LOG],
                |r| r.get(0),
            )
            .unwrap_or(-1);
        tomb == 0 && offset == 4
    })
    .await;
    assert_eq!(
        count(&data),
        2,
        "the reappeared record is a new observation"
    );
    assert_eq!(
        src.restored_removed(),
        vec![RemovedPath {
            path: LOG.into(),
            generation: 1,
            removed_ms: src.restored_removed()[0].removed_ms,
        }],
        "tombstones delivered to the adapter before its first poll"
    );
    assert_eq!(
        producer_keys(&data).last().unwrap(),
        &RecordKey::offset(LOG, 2, 0, 0).key(),
        "the new generation is a distinct identity"
    );
    let h2 = h2.stop().await;
    drop(h2);
    drop(data);
}

/// The store transaction covers events, offsets, file state, source revisions and tombstones together: a failure
/// in the last of them rolls all of it back, and a successful replay of the same identities inserts nothing.
#[test]
fn g_store_commit_is_atomic_and_deduplicates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = Store::open(&path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let ck = one_file(LOG, 1, 10, 10);
    let items = vec![item(
        ItemKind::Step,
        "s1",
        json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
    )];
    let keys = vec![RecordKey::offset(LOG, 1, 0, 0)];
    let tomb = RemovedPath {
        path: "logs/gone.jsonl".into(),
        generation: 4,
        removed_ms: 1234,
    };
    // Fail the tombstone write: nothing of the same transaction may survive.
    store
        .with(|c| {
            c.execute_batch(
                "CREATE TRIGGER inject_fail BEFORE INSERT ON source_removed
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
        })
        .unwrap();
    assert!(bus
        .commit(
            "scripted",
            &items,
            &ck,
            std::slice::from_ref(&tomb),
            &[],
            &keys
        )
        .is_err());
    assert_eq!(store.event_count().unwrap(), 0, "events rolled back");
    assert!(store.load_file_state("scripted").unwrap().is_empty());
    assert!(store.load_offsets("scripted").unwrap().is_empty());
    assert!(store.load_removed("scripted").unwrap().is_empty());
    store
        .with(|c| c.execute_batch("DROP TRIGGER inject_fail;"))
        .unwrap();

    let evs = bus
        .commit(
            "scripted",
            &items,
            &ck,
            std::slice::from_ref(&tomb),
            &[],
            &keys,
        )
        .unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(store.producers("scripted").unwrap(), vec![keys[0].key()]);
    assert_eq!(store.load_removed("scripted").unwrap(), vec![tomb]);
    assert_eq!(store.load_file_state("scripted").unwrap()[0].offset, 10);

    // A replay of the same producer identity (with an identical checkpoint) inserts nothing and keeps one row.
    let evs = bus
        .commit(
            "scripted",
            &items,
            &ck,
            &[],
            &["logs/gone.jsonl".to_string()],
            &keys,
        )
        .unwrap();
    assert!(evs.is_empty(), "identical replay deduplicated");
    assert_eq!(store.event_count().unwrap(), 1);
    assert!(
        store.load_removed("scripted").unwrap().is_empty(),
        "the reappeared path's tombstone is cleared in the same transaction"
    );
    // A new identity for the same payload/time is a new observation.
    let keys2 = vec![RecordKey::offset(LOG, 1, 40, 0)];
    assert_eq!(
        bus.commit("scripted", &items, &ck, &[], &[], &keys2)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(store.event_count().unwrap(), 2);
    assert_eq!(
        store.max_seq().unwrap(),
        2,
        "seq consecutive, dedup consumed none"
    );
}

/// An incomplete discovery sweep never tombstones a path that disappeared from its (partial) checkpoint, and
/// leaves the prior parser state/high-water intact. Re-running a complete sweep later can still remove it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h_incomplete_discovery_does_not_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let first = Frame::new(
        vec![item(
            ItemKind::Step,
            "s1",
            json!({"text": "1", "ts": "2026-11-01T10:00:00.000Z"}),
        )],
        vec![RecordKey::offset(LOG, 1, 0, 0)],
        one_file(LOG, 1, 10, 10),
    );
    // Partial sweep reports nothing, but is marked incomplete.
    let partial = Frame::empty(SourceCheckpoint::default());
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let src = Scripted::new_with_complete(vec![first, partial], false);
    let h = Harness::open(&data, src.clone());
    wait_for("first commit", Duration::from_secs(5), || count(&data) == 1).await;
    // Wait for the (incomplete) second pass to be attempted.
    wait_for("second pass", Duration::from_secs(5), || src.polls() >= 2).await;
    settle(300).await;
    // No tombstone created, file state retained, high-water preserved.
    assert_eq!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='scripted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0,
        "incomplete sweep does not tombstone"
    );
    assert_eq!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_file_state WHERE source='scripted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1,
        "prior parser state retained on incomplete sweep"
    );
    assert_eq!(h.store.load_generation("scripted", LOG).unwrap(), 1);
    let h = h.stop().await;
    drop(h);
    drop(data);
}

// ------------------------------------------------------- logical-generation claims (v4-r2 core contract)

/// Starts the real poller over `data` with one arbitrary source and the given intervals (milliseconds).
fn spawn_for_every(
    data: &Path,
    source: Arc<dyn Source>,
    poll_ms: u64,
    discover_ms: u64,
) -> (Store, watch::Sender<bool>, tokio::task::JoinHandle<()>) {
    let store = Store::open(&Harness::path(data)).unwrap();
    let bus = Arc::new(Bus::new(store.clone()).unwrap());
    let (refresh_tx, refresh) = watch::channel(0u64);
    std::mem::forget(refresh_tx);
    let (stop, stop_rx) = watch::channel(false);
    let handle = spawn_poller(
        PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![source]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: Env::default(),
            intervals: Intervals {
                poll: Duration::from_millis(poll_ms),
                discover: Duration::from_millis(discover_ms),
            },
            refresh,
        },
        stop_rx,
    );
    (store, stop, handle)
}

/// [`spawn_for_every`] with the test-fast 20 ms poll/discovery cadence.
fn spawn_for(
    data: &Path,
    source: Arc<dyn Source>,
) -> (Store, watch::Sender<bool>, tokio::task::JoinHandle<()>) {
    spawn_for_every(data, source, 20, 20)
}

fn generation_rows(path: &Path) -> i64 {
    open_db(path)
        .query_row("SELECT COUNT(*) FROM source_generations", [], |r| r.get(0))
        .unwrap()
}

/// A candidate is side-effect free, and a batch that commits one is all-or-nothing: an aborted insertion leaves
/// no high-water, event, file state, offset, revision, tombstone or seq behind and publishes nothing. The exact
/// retry then commits once, and a replay of the same producer identities inserts nothing.
#[test]
fn i_aborted_claim_batch_commits_no_generation_state() {
    use agentglimd::store::StoreError;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claims.db");
    let store = Store::open(&path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let mut rx = bus.subscribe();

    // Deriving a candidate must not persist anything.
    let candidate = store.candidate_generation("scripted", LOG).unwrap();
    assert_eq!((candidate.observed, candidate.generation), (0, 1));
    for _ in 0..3 {
        assert_eq!(
            store.candidate_generation("scripted", LOG).unwrap(),
            candidate
        );
    }
    assert_eq!(store.load_generation("scripted", LOG).unwrap(), 0);
    assert_eq!(
        generation_rows(&path),
        0,
        "a candidate wrote no high-water row"
    );
    let claim = candidate.claim();

    let mut ck = one_file(LOG, 1, 10, 10);
    ck.revisions.insert("gen".into(), "1".into());
    let items = vec![item(
        ItemKind::Step,
        "s1",
        json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
    )];
    let keys = vec![RecordKey::offset(LOG, 1, 0, 0)];
    let tomb = RemovedPath {
        path: "logs/gone.jsonl".into(),
        generation: 0,
        removed_ms: 42,
    };
    store
        .with(|c| {
            c.execute_batch(
                "CREATE TRIGGER abort_batch BEFORE INSERT ON source_file_state
                 BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;",
            )
        })
        .unwrap();

    let seq_before = bus.last_seq();
    let err = bus
        .commit_claimed(
            "scripted",
            &items,
            &ck,
            std::slice::from_ref(&tomb),
            &[],
            &keys,
            std::slice::from_ref(&claim),
        )
        .unwrap_err();
    assert!(
        matches!(err, StoreError::Sqlite(_)),
        "the injected abort surfaces as a store error: {err:?}"
    );
    // Nothing of the batch survived, including the claimed generation.
    assert_eq!(
        store.load_generation("scripted", LOG).unwrap(),
        0,
        "aborted batch left the high-water untouched"
    );
    assert_eq!(
        generation_rows(&path),
        0,
        "the claim rolled back with the batch"
    );
    assert_eq!(store.event_count().unwrap(), 0, "no event committed");
    assert!(store.producers("scripted").unwrap().is_empty());
    assert!(store.load_file_state("scripted").unwrap().is_empty());
    assert!(store.load_offsets("scripted").unwrap().is_empty());
    assert!(store.load_revisions("scripted").unwrap().is_empty());
    assert!(store.load_removed("scripted").unwrap().is_empty());
    assert_eq!(bus.last_seq(), seq_before, "no seq consumed");
    assert!(rx.try_recv().is_err(), "nothing was published");

    // The exact same pending batch (same claim, same identities) retries after the cause is gone.
    store
        .with(|c| c.execute_batch("DROP TRIGGER abort_batch;"))
        .unwrap();
    let evs = bus
        .commit_claimed(
            "scripted",
            &items,
            &ck,
            std::slice::from_ref(&tomb),
            &[],
            &keys,
            std::slice::from_ref(&claim),
        )
        .unwrap();
    assert_eq!(evs.len(), 1, "retry committed exactly once");
    assert_eq!(evs[0].seq, seq_before + 1);
    assert_eq!(rx.try_recv().unwrap().seq, evs[0].seq);
    assert_eq!(store.load_generation("scripted", LOG).unwrap(), 1);
    assert_eq!(
        store.load_revisions("scripted").unwrap().get("gen"),
        Some(&"1".to_string())
    );

    // A replay of the same identities (no new claim) inserts nothing and does not move the high-water again.
    let replay = bus
        .commit("scripted", &items, &ck, &[], &[], &keys)
        .unwrap();
    assert!(replay.is_empty(), "replayed identities deduplicated");
    assert_eq!(store.event_count().unwrap(), 1);
    assert_eq!(store.load_generation("scripted", LOG).unwrap(), 1);
    assert!(rx.try_recv().is_err(), "a deduped replay publishes nothing");
}

/// Two candidates derived from the same observation cannot both commit the same next logical generation: the
/// first wins inside its transaction, the loser gets a conflict, writes nothing and publishes nothing, and a
/// re-derived candidate commits under a distinct key.
#[test]
fn j_two_candidates_cannot_commit_the_same_generation() {
    use agentglimd::store::{BatchCommit, StoreError};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("competing.db");
    let store_a = Store::open(&path).unwrap();
    let bus_a = Bus::new(store_a.clone()).unwrap();
    let store_b = Store::open(&path).unwrap();
    let mut rx = bus_a.subscribe();

    let cand_a = store_a.candidate_generation("scripted", LOG).unwrap();
    let cand_b = store_b.candidate_generation("scripted", LOG).unwrap();
    assert_eq!(
        (cand_a.observed, cand_a.generation),
        (0, 1),
        "both read the same high-water"
    );
    assert_eq!(cand_b, cand_a, "competing candidates are identical");

    let step =
        |text: &str, ts: &str| vec![item(ItemKind::Step, "s1", json!({"text": text, "ts": ts}))];
    let items_a = step("A", "2026-11-01T10:00:00.000Z");
    let items_b = step("B", "2026-11-01T10:00:05.000Z");
    let ck_a = one_file(LOG, 1, 10, 10);
    let ck_b = one_file(LOG, 1, 20, 20);
    let key_a = RecordKey::offset(LOG, 1, 0, 0);
    let key_b = RecordKey::offset(LOG, 1, 10, 0);

    let commit_b = |items: &[BatchItem],
                    ck: &SourceCheckpoint,
                    key: &RecordKey,
                    claims: &[agentglimd::core::GenerationClaim],
                    first_seq: u64| {
        // The file state and the claim advance the high-water together, in the same transaction.
        let states: Vec<agentglimd::store::FileStateRow> = ck
            .files
            .iter()
            .map(|f| agentglimd::store::FileStateRow {
                source: "scripted".into(),
                path: f.path.clone(),
                size: f.size,
                mtime_ms: f.mtime_ms,
                fingerprint: f.fingerprint.clone(),
                session: f.session.clone(),
                model: f.model.clone(),
                generation: f.generation,
                offset: f.offset,
                discarded_bytes: f.discarded_bytes,
                incomplete: f.incomplete,
                announced: f.announced,
                revision: f.revision.clone(),
            })
            .collect();
        store_b.commit_batch(BatchCommit {
            source: "scripted",
            items,
            offsets: &[],
            file_states: &states,
            revisions: &BTreeMap::new(),
            removed: &[],
            reappeared: &[],
            identities: std::slice::from_ref(key),
            claims,
            first_seq,
        })
    };

    // A wins generation 1.
    let evs = bus_a
        .commit_claimed(
            "scripted",
            &items_a,
            &ck_a,
            &[],
            &[],
            std::slice::from_ref(&key_a),
            std::slice::from_ref(&cand_a.claim()),
        )
        .unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(store_a.load_generation("scripted", LOG).unwrap(), 1);

    // B's claim was derived from high-water 0, which no longer exists: conflict, nothing written or published.
    let err = commit_b(&items_b, &ck_b, &key_b, &[cand_b.claim()], 50).unwrap_err();
    match &err {
        StoreError::GenerationConflict { path, base, actual } => {
            assert_eq!(path, LOG);
            assert_eq!((*base, *actual), (0, 1));
        }
        other => panic!("expected a generation conflict, got {other:?}"),
    }
    assert_eq!(store_b.event_count().unwrap(), 1, "only A's event exists");
    assert_eq!(
        store_b.load_generation("scripted", LOG).unwrap(),
        1,
        "the losing claim did not advance the high-water"
    );
    assert_eq!(
        store_b.producers("scripted").unwrap(),
        vec![key_a.key()],
        "the losing batch inserted no identity"
    );
    assert_eq!(
        open_db(&path)
            .query_row("SELECT COUNT(*) FROM events WHERE seq>=50", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0,
        "the losing batch consumed no row"
    );
    assert_eq!(rx.try_recv().unwrap().seq, 1);
    assert!(rx.try_recv().is_err(), "the conflict published nothing");

    // Re-deriving the candidate (high-water 1 -> generation 2) commits under a distinct key.
    let cand_b2 = store_b.candidate_generation("scripted", LOG).unwrap();
    assert_eq!((cand_b2.observed, cand_b2.generation), (1, 2));
    let evs = commit_b(
        &items_b,
        &one_file(LOG, 2, 20, 20),
        &RecordKey::offset(LOG, 2, 10, 0),
        &[cand_b2.claim()],
        50,
    )
    .unwrap();
    assert_eq!(evs.len(), 1, "the re-derived claim committed");
    assert_eq!(store_b.load_generation("scripted", LOG).unwrap(), 2);
    let keys = store_b.producers("scripted").unwrap();
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1], "distinct generations, distinct keys");
    assert_eq!(
        store_b
            .with(|c| c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0)))
            .unwrap(),
        2
    );
}

/// A claim that does not advance the high-water, or a claimed batch that advances it behind the claim's back,
/// is refused instead of silently committing.
#[test]
fn k_invalid_and_unclaimed_generation_claims_are_refused() {
    use agentglimd::core::GenerationClaim;
    use agentglimd::store::{BatchCommit, StoreError};

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("invalid.db")).unwrap();
    let items = vec![item(
        ItemKind::Step,
        "s1",
        json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
    )];
    let commit = |claims: &[GenerationClaim], states: &[agentglimd::store::FileStateRow]| {
        store.commit_batch(BatchCommit {
            source: "scripted",
            items: &items,
            offsets: &[],
            file_states: states,
            revisions: &BTreeMap::new(),
            removed: &[],
            reappeared: &[],
            identities: &[RecordKey::offset(LOG, 1, 0, 0)],
            claims,
            first_seq: 1,
        })
    };
    let state = |generation: u64| agentglimd::store::FileStateRow {
        source: "scripted".into(),
        path: LOG.into(),
        generation,
        offset: 10,
        size: 10,
        ..Default::default()
    };

    let flat = GenerationClaim {
        path: LOG.into(),
        base: 0,
        generation: 0,
    };
    assert!(matches!(
        commit(&[flat], &[state(0)]).unwrap_err(),
        StoreError::InvalidGenerationClaim { .. }
    ));

    let unclaimed = GenerationClaim {
        path: LOG.into(),
        base: 0,
        generation: 1,
    };
    assert!(matches!(
        commit(&[unclaimed], &[state(2)]).unwrap_err(),
        StoreError::UnclaimedGeneration { .. }
    ));
    assert_eq!(store.load_generation("scripted", LOG).unwrap(), 0);
    assert_eq!(store.event_count().unwrap(), 0);

    // The same claim with a matching file state commits both together.
    let claim = GenerationClaim {
        path: LOG.into(),
        base: 0,
        generation: 1,
    };
    assert_eq!(commit(&[claim], &[state(1)]).unwrap().len(), 1);
    assert_eq!(store.load_generation("scripted", LOG).unwrap(), 1);
    assert_eq!(
        store.load_file_state("scripted").unwrap()[0].generation,
        1,
        "file state and high-water agree after one transaction"
    );
}

/// One scheduled source turn shares a single 4 MiB allowance between `detect` and `poll`: detection cannot leave
/// the poll a second budget, a poll-only turn gets a fresh one, and every turn is closed exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn l_one_turn_allowance_is_shared_by_detect_and_poll() {
    use agentglimd::core::{TurnBudget, TURN_ALLOWANCE_BYTES};

    #[derive(Default, Clone)]
    struct Turn {
        id: u64,
        limit: u64,
        after_detect: u64,
        after_poll: u64,
        grants: Vec<u64>,
        closed: bool,
    }

    struct Probe {
        turns: Mutex<Vec<Turn>>,
        current: Mutex<Option<(u64, Arc<TurnBudget>)>>,
        next_id: AtomicUsize,
        standalone_polls: AtomicUsize,
        ends: AtomicUsize,
        detect_charge: u64,
        poll_charge: u64,
    }

    impl Probe {
        fn new(detect_charge: u64, poll_charge: u64) -> Arc<Self> {
            Arc::new(Self {
                turns: Mutex::new(Vec::new()),
                current: Mutex::new(None),
                next_id: AtomicUsize::new(0),
                standalone_polls: AtomicUsize::new(0),
                ends: AtomicUsize::new(0),
                detect_charge,
                poll_charge,
            })
        }

        fn charge(&self, want: u64, after: impl Fn(&mut Turn, u64)) {
            let guard = self.current.lock().unwrap();
            let Some((id, budget)) = guard.as_ref() else {
                return;
            };
            let grant = budget.charge(want);
            assert!(
                budget.used() <= budget.limit(),
                "never grant more than the allowance"
            );
            let mut turns = self.turns.lock().unwrap();
            let t = turns.iter_mut().find(|t| t.id == *id).expect("turn record");
            t.grants.push(grant);
            after(t, budget.used());
        }
    }

    impl Source for Probe {
        fn id(&self) -> &'static str {
            "turn-probe"
        }
        fn kind(&self) -> SourceKind {
            SourceKind::CodingAgent
        }
        fn detect(&self, _env: &Env) -> Detection {
            self.charge(self.detect_charge, |t, used| t.after_detect = used);
            Detection::Detected { paths: vec![] }
        }
        fn capabilities(&self) -> Caps {
            Caps::WATCH
        }
        fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
            Box::pin(async move {
                if self.current.lock().unwrap().is_none() {
                    self.standalone_polls.fetch_add(1, Ordering::SeqCst);
                }
                self.charge(self.poll_charge, |t, used| t.after_poll = used);
                Ok(Batch {
                    items: Vec::new(),
                    next: Cursor(since.0),
                })
            })
        }
        fn begin_turn(&self, allowance: Arc<TurnBudget>) {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst) as u64 + 1;
            self.turns.lock().unwrap().push(Turn {
                id,
                limit: allowance.limit(),
                after_detect: 0,
                after_poll: 0,
                grants: Vec::new(),
                closed: false,
            });
            *self.current.lock().unwrap() = Some((id, allowance));
        }
        fn end_turn(&self) {
            self.ends.fetch_add(1, Ordering::SeqCst);
            if let Some((id, _)) = self.current.lock().unwrap().take() {
                let mut turns = self.turns.lock().unwrap();
                if let Some(t) = turns.iter_mut().find(|t| t.id == id) {
                    t.closed = true;
                }
            }
        }
    }

    // Detection asks for 3 MiB, polling for another 3 MiB: together they must still stop at 4 MiB.
    let src = Probe::new(3 * 1024 * 1024, 3 * 1024 * 1024);
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    // One discovery pass at once, then poll-only turns.
    let (_store, stop, handle) = spawn_for_every(&data, src.clone() as Arc<dyn Source>, 20, 30_000);
    wait_for("first discovered turn", Duration::from_secs(5), || {
        src.turns.lock().unwrap().iter().any(|t| t.after_detect > 0)
    })
    .await;
    wait_for("poll-only turns", Duration::from_secs(5), || {
        src.turns
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.after_detect == 0 && t.after_poll > 0)
            .count()
            >= 2
    })
    .await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;

    let turns = src.turns.lock().unwrap().clone();
    assert!(!turns.is_empty());
    assert_eq!(
        src.ends.load(Ordering::SeqCst),
        turns.len(),
        "every turn is closed exactly once"
    );
    assert!(turns.iter().all(|t| t.closed), "no turn left open");
    assert!(
        turns.iter().all(|t| t.limit == TURN_ALLOWANCE_BYTES),
        "one 4 MiB allowance per turn"
    );
    let discovered: Vec<&Turn> = turns.iter().filter(|t| t.after_detect > 0).collect();
    assert_eq!(
        discovered.len(),
        1,
        "the discovery tick detects once, inside the same turn as its poll"
    );
    let first = discovered[0];
    assert_eq!(
        first.grants,
        vec![3 * 1024 * 1024, 1024 * 1024],
        "detect got 3 MiB and poll was clamped to the 1 MiB left: one shared counter, not two"
    );
    assert_eq!(
        first.after_poll, TURN_ALLOWANCE_BYTES,
        "the turn spent exactly its one allowance"
    );
    for t in turns.iter().filter(|t| t.after_detect == 0) {
        assert_eq!(
            t.grants,
            vec![3 * 1024 * 1024],
            "a poll-only turn gets a fresh allowance"
        );
    }

    // A direct poll (no begin_turn) is not handed a turn allowance by core.
    let before = turns.len();
    let _ = src.poll(Cursor(0)).await.unwrap();
    assert_eq!(
        src.turns.lock().unwrap().len(),
        before,
        "a standalone poll creates no turn budget"
    );
    assert_eq!(
        src.ends.load(Ordering::SeqCst),
        before,
        "a standalone poll ends no turn"
    );
}

/// Cancelling the poll (shutdown mid-fetch) closes the turn, commits nothing of the unfinished scan and keeps the
/// last committed checkpoint restorable: no premature removal, no partial state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn m_cancelled_poll_keeps_committed_state_and_no_removal() {
    use std::sync::atomic::AtomicBool;

    struct Hanging {
        first: Mutex<Option<Frame>>,
        polls: AtomicUsize,
        staged: AtomicBool,
        ends: AtomicUsize,
        checkpoint: Mutex<SourceCheckpoint>,
        last_identities: Mutex<Vec<RecordKey>>,
    }

    impl Source for Hanging {
        fn id(&self) -> &'static str {
            "hanging"
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
                let n = self.polls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    let f = self.first.lock().unwrap().take().expect("one first frame");
                    *self.checkpoint.lock().unwrap() = f.checkpoint.clone();
                    *self.last_identities.lock().unwrap() = f.identities.clone();
                    return Ok(Batch {
                        items: f.items,
                        next: Cursor(since.0 + 1),
                    });
                }
                // A scan that never finishes: the poller drops this future on shutdown.
                self.staged.store(true, Ordering::SeqCst);
                std::future::pending::<()>().await;
                unreachable!()
            })
        }
        fn checkpoint(&self) -> SourceCheckpoint {
            self.checkpoint.lock().unwrap().clone()
        }
        fn identities(&self) -> Vec<RecordKey> {
            self.last_identities.lock().unwrap().clone()
        }
        fn begin_turn(&self, _allowance: Arc<agentglimd::core::TurnBudget>) {}
        fn end_turn(&self) {
            self.ends.fetch_add(1, Ordering::SeqCst);
        }
        fn discovery_complete(&self) -> bool {
            // An unfinished sweep never certifies absence.
            !self.staged.load(Ordering::SeqCst)
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let events = |data: &Path| -> i64 {
        db(data)
            .query_row(
                "SELECT COUNT(*) FROM events WHERE source='hanging'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    let src = Arc::new(Hanging {
        first: Mutex::new(Some(Frame::new(
            vec![item(
                ItemKind::Step,
                "s1",
                json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
            )],
            vec![RecordKey::offset(LOG, 1, 0, 0)],
            one_file(LOG, 1, 10, 10),
        ))),
        polls: AtomicUsize::new(0),
        staged: AtomicBool::new(false),
        ends: AtomicUsize::new(0),
        checkpoint: Mutex::new(SourceCheckpoint::default()),
        last_identities: Mutex::new(Vec::new()),
    });
    let store = Store::open(&Harness::path(&data)).unwrap();
    let bus = Arc::new(Bus::new(store.clone()).unwrap());
    let (refresh_tx, refresh) = watch::channel(0u64);
    std::mem::forget(refresh_tx);
    let (stop, stop_rx) = watch::channel(false);
    let handle = spawn_poller(
        PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![src.clone() as Arc<dyn Source>]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: Env::default(),
            intervals: Intervals {
                poll: Duration::from_millis(20),
                discover: Duration::from_millis(20),
            },
            refresh,
        },
        stop_rx,
    );
    wait_for("the first batch", Duration::from_secs(5), || {
        events(&data) == 1
    })
    .await;
    wait_for("a poll in flight", Duration::from_secs(5), || {
        src.staged.load(Ordering::SeqCst)
    })
    .await;
    settle(100).await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;

    assert_eq!(events(&data), 1, "the unfinished scan committed nothing");
    assert!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='hanging'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
            == 0,
        "an unfinished scan never tombstones"
    );
    let states = store.load_file_state("hanging").unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!((states[0].generation, states[0].offset), (1, 10));
    assert!(
        src.ends.load(Ordering::SeqCst) >= 2,
        "the cancelled turn was still closed (end_turn ran)"
    );

    // The last committed checkpoint is still restorable after the cancellation.
    struct Quiet {
        restored: Mutex<Vec<SourceCheckpoint>>,
    }
    impl Source for Quiet {
        fn id(&self) -> &'static str {
            "hanging"
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
                Ok(Batch {
                    items: Vec::new(),
                    next: since,
                })
            })
        }
        fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
            self.restored.lock().unwrap().push(checkpoint);
        }
    }
    let quiet = Arc::new(Quiet {
        restored: Mutex::new(Vec::new()),
    });
    let (_store2, stop2, handle2) = spawn_for(&data, quiet.clone() as Arc<dyn Source>);
    let seen = quiet.clone();
    wait_for("restore after cancellation", Duration::from_secs(5), || {
        !seen.restored.lock().unwrap().is_empty()
    })
    .await;
    let restored = {
        let guard = seen.restored.lock().unwrap();
        guard.clone()
    };
    assert_eq!(restored[0].files.len(), 1);
    assert_eq!(
        (restored[0].files[0].generation, restored[0].files[0].offset),
        (1, 10),
        "the committed checkpoint survives cancellation and restart"
    );
    let _ = stop2.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle2).await;
    drop(data);
}

// ------------------------------------- checkpoint-only verification progress (v4-r3 core integration)

/// Checkpoint-only progress (resumable verification/discovery state: no new events) commits in the same
/// all-or-nothing transaction as events. When that transaction fails, no durable revision, file state, offset,
/// generation row or seq is written and nothing is published; the poller retries the exact same checkpoint once.
/// The committed progress then survives a restart, so a resumable sweep continues instead of starting over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn n_failed_checkpoint_only_commit_is_atomic_and_retries_once() {
    const PROGRESS: &str = "{\"pass\":1,\"hashed\":131072,\"next\":131072}";
    let dir = tempfile::tempdir().unwrap();
    let mut ck = one_file(LOG, 2, 512, 512);
    ck.revisions.insert("verify".into(), PROGRESS.into());
    ck.files[0].revision = Some("witness-pass-1".into());
    ck.files[0].incomplete = true; // the bounded verification sweep has not finished yet
    let h = Harness::start_with_failing_commit(&dir, vec![Frame::empty(ck)]);
    let data = h.data.clone();

    wait_for(
        "a failed checkpoint-only commit attempt",
        Duration::from_secs(5),
        || h.src.polls() >= 1,
    )
    .await;
    settle(250).await;

    // Nothing durable and nothing published: the whole checkpoint-only batch rolled back.
    assert_eq!(count(&data), 0, "a checkpoint-only batch carries no events");
    assert_eq!(
        h.src.polls(),
        1,
        "the pending checkpoint-only batch is retried, never re-polled"
    );
    assert_eq!(h.bus.last_seq(), 0, "a failed commit consumes no seq");
    assert!(
        h.store.load_revisions("scripted").unwrap().is_empty(),
        "no source revision survived the failed commit"
    );
    assert!(
        h.store.load_file_state("scripted").unwrap().is_empty(),
        "no file state survived the failed commit"
    );
    assert!(
        h.store.load_offsets("scripted").unwrap().is_empty(),
        "no offsets survived the failed commit"
    );
    assert_eq!(
        h.store.load_generation("scripted", LOG).unwrap(),
        0,
        "the generation high-water did not move"
    );

    // The exact retry commits the checkpoint once, still without events.
    db(&data)
        .execute_batch("DROP TRIGGER inject_fail;")
        .unwrap();
    wait_for(
        "the retried checkpoint-only batch",
        Duration::from_secs(5),
        || !h.store.load_revisions("scripted").unwrap().is_empty(),
    )
    .await;
    settle(200).await;
    assert_eq!(count(&data), 0, "no event was invented by the retry");
    assert_eq!(
        h.store
            .load_revisions("scripted")
            .unwrap()
            .get("verify")
            .map(String::as_str),
        Some(PROGRESS),
        "the retried verification progress is durable"
    );
    let states = h.store.load_file_state("scripted").unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!(
        (states[0].generation, states[0].offset, states[0].size),
        (2, 512, 512)
    );
    assert_eq!(
        states[0].revision.as_deref(),
        Some("witness-pass-1"),
        "the adapter's verification witness is checkpointed with the progress"
    );
    assert!(
        states[0].incomplete,
        "unfinished verification stays honestly marked incomplete"
    );
    assert_eq!(
        h.store.load_generation("scripted", LOG).unwrap(),
        2,
        "the committed checkpoint raised the high-water once"
    );
    assert_eq!(h.bus.last_seq(), 0, "still nothing published");
    let h = h.stop().await;

    // Restart: the poller hands the adapter the resumed progress, not a fresh sweep.
    let src = Scripted::new(Vec::new());
    let h2 = Harness::open(&data, src.clone());
    let seen = src.clone();
    wait_for(
        "restore of the resumed progress",
        Duration::from_secs(5),
        || !seen.restored().is_empty(),
    )
    .await;
    let restored = seen.restored();
    assert_eq!(
        restored[0].revisions.get("verify").map(String::as_str),
        Some(PROGRESS),
        "verification progress is restored after restart"
    );
    assert_eq!(restored[0].files.len(), 1);
    assert_eq!(
        restored[0].files[0].revision.as_deref(),
        Some("witness-pass-1")
    );
    assert!(
        restored[0].files[0].incomplete,
        "a restart resumes an unfinished verification instead of declaring it clean"
    );
    assert_eq!(
        (restored[0].files[0].generation, restored[0].files[0].offset),
        (2, 512)
    );
    let _ = h2.stop().await;
    drop(h);
    drop(data);
}

// ------------------------------- one scheduled real-adapter turn on one shared allowance (v4-r3 step 4)

/// One pass-through [`Source`] around the **real** Claude Code adapter that records the [`TurnBudget`] core hands
/// the turn and how much of it the adapter actually charged in `detect` and in `poll`.
struct TurnProbe {
    inner: Arc<agentglimd::adapters::claude_code::ClaudeCode>,
    turns: Mutex<Vec<ProbeTurn>>,
    current: Mutex<Option<usize>>,
    begins: AtomicUsize,
    ends: AtomicUsize,
}

#[derive(Clone)]
struct ProbeTurn {
    budget: Arc<agentglimd::core::TurnBudget>,
    after_detect: u64,
    after_poll: u64,
    /// Cumulative whole-turn usage at the end of the turn (entries/visits/bytes share one allowance).
    usage: agentglimd::core::TurnUsage,
    closed: bool,
}

impl TurnProbe {
    fn new(inner: Arc<agentglimd::adapters::claude_code::ClaudeCode>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            turns: Mutex::new(Vec::new()),
            current: Mutex::new(None),
            begins: AtomicUsize::new(0),
            ends: AtomicUsize::new(0),
        })
    }

    /// Records the shared allowance's used bytes at the point `f` runs (right after the real adapter returned).
    fn mark(&self, f: impl Fn(&mut ProbeTurn, u64)) {
        let Some(i) = *self.current.lock().unwrap() else {
            return;
        };
        let mut turns = self.turns.lock().unwrap();
        let used = turns[i].budget.used();
        f(&mut turns[i], used);
    }
}

impl Source for TurnProbe {
    fn id(&self) -> &'static str {
        self.inner.id()
    }
    fn kind(&self) -> SourceKind {
        self.inner.kind()
    }
    fn detect(&self, env: &Env) -> Detection {
        let d = self.inner.detect(env);
        self.mark(|t, used| t.after_detect = used);
        d
    }
    fn capabilities(&self) -> Caps {
        self.inner.capabilities()
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        let inner = self.inner.clone();
        Box::pin(async move {
            let r = inner.poll(since).await;
            self.mark(|t, used| t.after_poll = used);
            r
        })
    }
    fn checkpoint(&self) -> SourceCheckpoint {
        self.inner.checkpoint()
    }
    fn supports_checkpoint_delta(&self) -> bool {
        self.inner.supports_checkpoint_delta()
    }
    fn checkpoint_delta(&self) -> agentglimd::core::CheckpointDelta {
        self.inner.checkpoint_delta()
    }
    fn full_checkpoint(&self) -> SourceCheckpoint {
        self.inner.full_checkpoint()
    }
    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        self.inner.restore_checkpoint(checkpoint)
    }
    fn identities(&self) -> Vec<RecordKey> {
        self.inner.identities()
    }
    fn discovery_complete(&self) -> bool {
        self.inner.discovery_complete()
    }
    fn restore_removed(&self, removed: &[RemovedPath]) {
        self.inner.restore_removed(removed)
    }
    fn begin_turn(&self, allowance: Arc<agentglimd::core::TurnBudget>) {
        self.begins.fetch_add(1, Ordering::SeqCst);
        self.inner.begin_turn(allowance.clone());
        let i = {
            let mut turns = self.turns.lock().unwrap();
            turns.push(ProbeTurn {
                budget: allowance,
                after_detect: 0,
                after_poll: 0,
                usage: agentglimd::core::TurnBudget::default_allowance().usage(),
                closed: false,
            });
            turns.len() - 1
        };
        *self.current.lock().unwrap() = Some(i);
    }
    fn end_turn(&self) {
        self.ends.fetch_add(1, Ordering::SeqCst);
        self.inner.end_turn();
        if let Some(i) = self.current.lock().unwrap().take() {
            let mut turns = self.turns.lock().unwrap();
            turns[i].usage = turns[i].budget.usage();
            turns[i].closed = true;
        }
    }
}

/// The actual scheduled source turn through the real poller with a **real** Claude Code adapter (no scripted
/// fake, no test-only counter): core creates one 4 MiB allowance; the adapter's detection and polling both charge
/// that same counter and never exceed it; every begin has exactly one end once the loop stops; and the turn
/// commits real observations through store. Physical evidence, not a fake that charges a supplied counter.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p_scheduled_real_adapter_turn_shares_one_allowance_and_closes() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use agentglimd::core::TURN_ALLOWANCE_BYTES;

    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let root = home.join(".claude").join("projects").join("-work-turn");
    std::fs::create_dir_all(&root).unwrap();
    let line = format!(
        "{{\"type\":\"assistant\",\"pad\":\"{}\",\"cwd\":\"/work/demo\",\"sessionId\":\"turn-1\",\"version\":\"2.0.14\",\"message\":{{\"role\":\"assistant\",\"model\":\"model-turn\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}],\"usage\":{{\"input_tokens\":5,\"output_tokens\":2}}}},\"uuid\":\"turn-u1\",\"timestamp\":\"2026-11-01T10:00:00.000Z\"}}\n",
        "x".repeat(600)
    );
    std::fs::write(root.join("s1.jsonl"), line).unwrap();

    let adapter = Arc::new(ClaudeCode::new(Some(root.clone()), &home, 30));
    let probe = TurnProbe::new(adapter);
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let (_store, stop, handle) = spawn_for_every(&data, probe.clone() as Arc<dyn Source>, 20, 100);

    wait_for(
        "real adapter observations stored",
        Duration::from_secs(5),
        || {
            db(&data)
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE source='claude-code'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0
        },
    )
    .await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;

    let turns = probe.turns.lock().unwrap();
    assert!(!turns.is_empty(), "core ran at least one source turn");
    assert_eq!(
        probe.ends.load(Ordering::SeqCst),
        probe.begins.load(Ordering::SeqCst),
        "every begin_turn has exactly one end_turn"
    );
    assert!(
        turns.iter().all(|t| t.closed),
        "no turn is left open after shutdown"
    );
    assert!(
        turns
            .iter()
            .all(|t| t.budget.limit() == TURN_ALLOWANCE_BYTES),
        "core hands out exactly one 4 MiB allowance per turn"
    );
    // The source loop starts with one discovery tick, so the first turn is the detect+poll turn.
    let t = &turns[0];
    assert!(
        t.budget.used() <= TURN_ALLOWANCE_BYTES,
        "the whole turn stayed inside its one allowance: used {} of {}",
        t.budget.used(),
        t.budget.limit()
    );
    assert!(
        t.after_detect > 0,
        "the real adapter's detect charged the shared allowance (not a second private counter): {}",
        t.after_detect
    );
    assert!(
        t.after_poll > t.after_detect,
        "the poll kept charging the same counter: detect={} poll={}",
        t.after_detect,
        t.after_poll
    );
    assert!(
        t.after_poll <= TURN_ALLOWANCE_BYTES,
        "detect + poll of one turn are jointly bounded: {}",
        t.after_poll
    );
    // The turn committed the adapter's real observations and nothing else: no removal was certified and the
    // stored events are exactly the committed Step/Spend/Session of the one record.
    assert_eq!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='claude-code'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0,
        "a scheduled turn never tombstones before a complete sweep"
    );
    assert_eq!(
        db(&data)
            .query_row(
                "SELECT COUNT(*) FROM events WHERE source='claude-code' AND kind='step'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1,
        "the one supported record is stored exactly once"
    );
}

// ---------------- one scheduled turn shares entry AND visit allowances (v5-r1: whole-turn, not per phase)

/// 420 supported Claude transcripts under one project: an amount that used to turn into 202 returned entries in
/// the *detection* pass alone while the poll kept an independent 200-entry budget of its own.
fn write_supported_claude_tree(root: &Path, files: usize) {
    std::fs::create_dir_all(root).unwrap();
    for i in 0..files {
        let line = format!(
            "{{\"type\":\"assistant\",\"sessionId\":\"turn-cap-{i:04}\",\"message\":{{\"role\":\"assistant\",\
             \"model\":\"m\"}},\"timestamp\":\"2026-11-01T00:00:00.000Z\"}}\n"
        );
        std::fs::write(root.join(format!("s{i:04}.jsonl")), line).unwrap();
    }
}

/// The whole-turn allowance is multidimensional: `begin_turn → detect → poll → end_turn` must stay inside one
/// ≤200 returned-entry allowance **and** one ≤200 work-visit allowance **and** one ≤4 MiB content allowance,
/// with the same counters carried across the detect→poll transition. Later turns make progress with their own
/// fresh allowance and eventually ingest every supported occurrence exactly once.
///
/// The counters are the application accounting of the real `TurnBudget` core hands the real `ClaudeCode`
/// adapter through the real poller; they are not kernel evidence (see `_build/NOTES.md`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn q_scheduled_turns_share_entry_visit_and_byte_allowances() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use agentglimd::core::{TURN_ALLOWANCE_BYTES, TURN_ALLOWANCE_ENTRIES, TURN_ALLOWANCE_VISITS};

    const FILES: usize = 420;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let root = home.join(".claude").join("projects").join("-turn-cap");
    write_supported_claude_tree(&root, FILES);

    let adapter = Arc::new(ClaudeCode::new(Some(root.clone()), &home, 30));
    let probe = TurnProbe::new(adapter);
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    // One discovery tick at start, then poll-only turns: the first turn is the detect+poll turn.
    let (_store, stop, handle) =
        spawn_for_every(&data, probe.clone() as Arc<dyn Source>, 20, 30_000);

    let steps = |data: &Path| -> i64 {
        db(data)
            .query_row(
                "SELECT COUNT(*) FROM events WHERE source='claude-code' AND kind='step'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && steps(&data) < FILES as i64 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Let at least two more poll-only turns close so the "fresh allowance per turn" claim is observed.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;

    let turns: Vec<ProbeTurn> = probe.turns.lock().unwrap().iter().cloned().collect();
    assert!(turns.len() >= 3, "expected several scheduled turns");
    assert_eq!(
        probe.ends.load(Ordering::SeqCst),
        probe.begins.load(Ordering::SeqCst),
        "every begin_turn has exactly one end_turn"
    );
    let mut max_entries = 0u64;
    let mut max_visits = 0u64;
    let mut max_bytes = 0u64;
    for (i, t) in turns.iter().enumerate() {
        let u = t.usage;
        assert!(
            u.entries.used <= TURN_ALLOWANCE_ENTRIES,
            "turn {i} returned {} entries, above the shared {} entry allowance",
            u.entries.used,
            TURN_ALLOWANCE_ENTRIES
        );
        assert!(
            u.visits.used <= TURN_ALLOWANCE_VISITS,
            "turn {i} used {} work visits, above the shared {} visit allowance",
            u.visits.used,
            TURN_ALLOWANCE_VISITS
        );
        assert!(
            u.bytes.used <= TURN_ALLOWANCE_BYTES,
            "turn {i} read {} content bytes, above the shared {} byte allowance",
            u.bytes.used,
            TURN_ALLOWANCE_BYTES
        );
        max_entries = max_entries.max(u.entries.used);
        max_visits = max_visits.max(u.visits.used);
        max_bytes = max_bytes.max(u.bytes.used);
    }
    // The detect+poll turn really did charge the same counters inside one allowance.
    assert!(
        turns[0].after_detect > 0 && turns[0].after_poll >= turns[0].after_detect,
        "the first turn is the detect+poll turn on one allowance: detect={} poll={}",
        turns[0].after_detect,
        turns[0].after_poll
    );
    // Multi-turn continuation: the whole tree is ingested and nothing is stored twice.
    assert_eq!(
        steps(&data),
        FILES as i64,
        "bounded turns must eventually ingest every supported occurrence exactly once"
    );
    let sessions: i64 = db(&data)
        .query_row(
            "SELECT COUNT(DISTINCT session) FROM events WHERE source='claude-code' AND kind='step'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sessions, FILES as i64, "one step per distinct session");
    let dupes: i64 = db(&data)
        .query_row(
            "SELECT COUNT(*) - COUNT(DISTINCT producer) FROM events WHERE source='claude-code' \
             AND producer IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dupes, 0, "no duplicate producer identity across turns");
    println!(
        "ETURNCAP {{\"files\":{FILES},\"turns\":{},\"max_entries\":{max_entries},\
         \"max_visits\":{max_visits},\"max_bytes\":{max_bytes},\"entry_cap\":{TURN_ALLOWANCE_ENTRIES},\
         \"visit_cap\":{TURN_ALLOWANCE_VISITS},\"byte_cap\":{TURN_ALLOWANCE_BYTES},\
         \"steps\":{},\"duplicate_producer_keys\":{dupes}}}",
        turns.len(),
        steps(&data)
    );
}

/// `RecordKey::Revision` is the snapshot producer-identity contract (v5-r2 lane A): the producer key is the exact
/// triple `(namespace, revision, item)`, so one observation can only ever land once, a different revision or item
/// is a different observation even with an identical payload, a failed commit publishes nothing, and the exact
/// retry commits exactly once — live and across a restart. No schema change; this is the existing
/// `events_producer` unique index plus the transactional `Bus::commit`.
#[test]
fn r_revision_identity_is_exact_at_bus_and_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("revisions.db");
    let store = Store::open(&path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    let mut rx = bus.subscribe();

    let mut ck = SourceCheckpoint::default();
    ck.revisions.insert("round".into(), "1".into());
    let step_a = item(
        ItemKind::Step,
        "snap",
        json!({"text": "A", "ts": "2026-11-01T10:00:00.000Z"}),
    );
    let spend_b = item(
        ItemKind::Spend,
        "snap",
        json!({"model": "m", "output_tokens": 7, "ts": "2026-11-01T10:00:00.000Z"}),
    );
    let rev1 = vec![
        RecordKey::revision("snap", "1", 0),
        RecordKey::revision("snap", "1", 1),
    ];
    let items = vec![step_a.clone(), spend_b.clone()];

    // 1. One revision-level observation committed once: two items, two identities, two seqs.
    let evs = bus.commit("snap", &items, &ck, &[], &[], &rev1).unwrap();
    assert_eq!(evs.len(), 2, "both items of the observation are stored");
    assert_eq!(
        evs.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2],
        "seqs are consecutive and dedup consumes none"
    );
    assert_eq!(
        store.producers("snap").unwrap(),
        rev1.iter().map(RecordKey::key).collect::<Vec<_>>(),
        "the stored producer keys are exactly the revision identities"
    );
    assert_eq!(
        store.load_revisions("snap").unwrap().get("round"),
        Some(&"1".to_string()),
        "the source revision high-water is durable"
    );
    assert_eq!(rx.try_recv().unwrap().seq, 1);
    assert_eq!(rx.try_recv().unwrap().seq, 2);

    // 2. The same namespace/revision/item committed again stores nothing: no event, no seq, no broadcast.
    let evs = bus.commit("snap", &items, &ck, &[], &[], &rev1).unwrap();
    assert!(
        evs.is_empty(),
        "an identical revision replay is deduplicated"
    );
    assert_eq!(store.event_count().unwrap(), 2);
    assert_eq!(store.max_seq().unwrap(), 2, "dedup consumed no seq");
    assert!(
        rx.try_recv().is_err(),
        "a deduplicated replay publishes nothing"
    );

    // 3. A different revision with an identical payload/time is a new observation.
    let mut ck2 = ck.clone();
    ck2.revisions.insert("round".into(), "2".into());
    let evs = bus
        .commit(
            "snap",
            &items,
            &ck2,
            &[],
            &[],
            &[
                RecordKey::revision("snap", "2", 0),
                RecordKey::revision("snap", "2", 1),
            ],
        )
        .unwrap();
    assert_eq!(evs.len(), 2, "a distinct revision stores its own events");
    assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3, 4]);

    // 4. Same revision, different item index: a distinct identity (never a shift/alias).
    let evs = bus
        .commit(
            "snap",
            &items,
            &ck2,
            &[],
            &[],
            &[
                RecordKey::revision("snap", "2", 2),
                RecordKey::revision("snap", "2", 3),
            ],
        )
        .unwrap();
    assert_eq!(evs.len(), 2, "item index is part of the identity");
    assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![5, 6]);

    // 5. A failed commit publishes and stores nothing, including its new revision and identity.
    while rx.try_recv().is_ok() {
        // drain the broadcasts of the successful commits above so the failure is what is observed below
    }
    store
        .with(|c| {
            c.execute_batch(
                "CREATE TRIGGER inject_fail BEFORE INSERT ON source_removed
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
        })
        .unwrap();
    let mut ck3 = ck.clone();
    ck3.revisions.insert("round".into(), "3".into());
    let rev3 = vec![
        RecordKey::revision("snap", "3", 0),
        RecordKey::revision("snap", "3", 1),
    ];
    let tomb = RemovedPath {
        path: "gone.json".into(),
        generation: 1,
        removed_ms: 7,
    };
    assert!(
        bus.commit(
            "snap",
            &items,
            &ck3,
            std::slice::from_ref(&tomb),
            &[],
            &rev3
        )
        .is_err(),
        "the injected tombstone failure aborts the batch"
    );
    assert_eq!(
        store.event_count().unwrap(),
        6,
        "no event of the failed batch"
    );
    assert_eq!(
        store.max_seq().unwrap(),
        6,
        "no seq consumed by the failure"
    );
    assert_eq!(
        store.load_revisions("snap").unwrap().get("round"),
        Some(&"2".to_string()),
        "the failed batch did not advance the durable revision"
    );
    assert!(store.load_removed("snap").unwrap().is_empty());
    let stored = store.producers("snap").unwrap();
    assert!(
        !stored.iter().any(|k| k.contains("\u{1f}3\u{1f}")),
        "no producer row of the failed revision: {stored:?}"
    );
    assert!(
        rx.try_recv().is_err(),
        "a failed commit publishes nothing on the bus"
    );

    // 6. The exact retry commits exactly once; a further identical replay stores nothing.
    store
        .with(|c| c.execute_batch("DROP TRIGGER inject_fail;"))
        .unwrap();
    let evs = bus
        .commit(
            "snap",
            &items,
            &ck3,
            std::slice::from_ref(&tomb),
            &[],
            &rev3,
        )
        .unwrap();
    assert_eq!(evs.len(), 2, "the exact retry commits the batch once");
    assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![7, 8]);
    assert_eq!(
        store.load_revisions("snap").unwrap().get("round"),
        Some(&"3".to_string())
    );
    assert_eq!(store.load_removed("snap").unwrap(), vec![tomb]);
    assert!(bus
        .commit("snap", &items, &ck3, &[], &[], &rev3)
        .unwrap()
        .is_empty());

    // 7. Across a restart the identities still deduplicate and a new revision is a new observation.
    let last = store.max_seq().unwrap();
    drop(bus);
    let store2 = Store::open(&path).unwrap();
    let bus2 = Bus::new(store2.clone()).unwrap();
    assert_eq!(bus2.last_seq(), last, "seqs survive the restart");
    assert!(
        bus2.commit("snap", &items, &ck3, &[], &[], &rev3)
            .unwrap()
            .is_empty(),
        "a restored revision replay is silent"
    );
    let mut ck4 = ck.clone();
    ck4.revisions.insert("round".into(), "4".into());
    let evs = bus2
        .commit(
            "snap",
            &items,
            &ck4,
            &[],
            &[],
            &[
                RecordKey::revision("snap", "4", 0),
                RecordKey::revision("snap", "4", 1),
            ],
        )
        .unwrap();
    assert_eq!(evs.len(), 2, "a new revision after restart commits once");
    assert_eq!(evs[0].seq, last + 1);
    assert_eq!(
        store2.load_revisions("snap").unwrap().get("round"),
        Some(&"4".to_string())
    );
    let dupes: i64 = open_db(&path)
        .query_row(
            "SELECT COUNT(*) - COUNT(DISTINCT producer) FROM events \
             WHERE source='snap' AND producer IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dupes, 0, "no duplicate producer identity anywhere");
}

/// The shared `adapters::io` boundary records the bytes a read actually returned (v5-r2 lane A): the payload
/// bytes land in `WorkStats.payload_bytes` exactly once, verification bytes in `verify_bytes`, and every
/// successful read is noted on the turn's `TurnBudget` (`read_calls` / `returned_bytes`). This is application
/// accounting, not kernel evidence.
#[test]
fn s_boundary_records_actual_returned_bytes() {
    use agentglimd::adapters::claude_code::ClaudeCode;
    use agentglimd::core::{Batch, Cursor, TurnBudget, TURN_ALLOWANCE_BYTES};

    const FILES: usize = 3;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let root = home.join(".claude").join("projects").join("-payload");
    std::fs::create_dir_all(&root).unwrap();
    let mut total = 0u64;
    for i in 0..FILES {
        let line = format!(
            "{{\"type\":\"assistant\",\"sessionId\":\"payload-{i}\",\"message\":{{\"role\":\"assistant\",\
             \"model\":\"m-payload\",\"usage\":{{\"input_tokens\":3,\"output_tokens\":2}}}},\
             \"timestamp\":\"2026-11-01T00:00:00.000Z\"}}\n"
        );
        total += line.len() as u64;
        std::fs::write(root.join(format!("p{i}.jsonl")), line).unwrap();
    }

    let src = ClaudeCode::new(Some(root.clone()), &home, 30);
    let before = src.work_stats();
    let env = Env {
        home: home.clone(),
        vars: Default::default(),
    };
    let budget = TurnBudget::default_allowance();
    src.begin_turn(budget.clone());
    assert!(matches!(src.detect(&env), Detection::Detected { .. }));
    let batch: Batch = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(src.poll(Cursor(0)))
        .unwrap();
    src.end_turn();
    let after = src.work_stats();

    assert_eq!(
        batch
            .items
            .iter()
            .filter(|i| i.kind == ItemKind::Step)
            .count(),
        FILES,
        "one Step per supported transcript"
    );
    assert_eq!(
        after.payload_bytes - before.payload_bytes,
        total,
        "payload bytes are the fixture's content bytes, recorded exactly once by the boundary"
    );
    assert_eq!(
        after.verify_bytes - before.verify_bytes,
        0,
        "a first ingest verifies nothing"
    );
    assert!(budget.read_calls() >= FILES as u64, "a read per payload");
    assert!(
        budget.returned_bytes() >= after.payload_bytes - before.payload_bytes,
        "the turn saw at least the payload bytes it classified: returned {} payload {}",
        budget.returned_bytes(),
        after.payload_bytes
    );
    assert!(
        budget.returned_bytes() <= budget.used(),
        "returned bytes can never exceed the charged allowance: returned {} used {}",
        budget.returned_bytes(),
        budget.used()
    );
    assert!(
        budget.used() <= TURN_ALLOWANCE_BYTES - agentglimd::adapters::RAW_PROBE_HEADROOM,
        "the whole turn stayed inside the shared allowance: {} of {}",
        budget.used(),
        TURN_ALLOWANCE_BYTES
    );
    println!(
        "EBOUNDARY {{\"files\":{FILES},\"content_bytes\":{total},\"payload_delta\":{},\
         \"returned\":{},\"charged\":{},\"released\":{},\"read_calls\":{}}}",
        after.payload_bytes - before.payload_bytes,
        budget.returned_bytes(),
        budget.used(),
        budget.used().saturating_sub(budget.returned_bytes()),
        budget.read_calls()
    );
}

// ------------------------------- bounded checkpoint reconciliation (v5-r3: no pre-cap path/tombstone setup)

/// One checkpoint file row per path; `files` stays ordered by path, as `Source::checkpoint` requires.
fn checkpoint_of_sorted(mut paths: Vec<String>) -> SourceCheckpoint {
    paths.sort();
    SourceCheckpoint {
        files: paths
            .into_iter()
            .map(|path| FileCheckpoint {
                path,
                generation: 1,
                offset: 1,
                size: 1,
                ..Default::default()
            })
            .collect(),
        revisions: BTreeMap::new(),
    }
}

fn removed_count(data: &Path, source: &str) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) FROM source_removed WHERE source=?1",
            [source],
            |r| r.get(0),
        )
        .unwrap()
}

fn file_state_count(data: &Path, source: &str) -> i64 {
    db(data)
        .query_row(
            "SELECT COUNT(*) FROM source_file_state WHERE source=?1",
            [source],
            |r| r.get(0),
        )
        .unwrap()
}

/// Waits (asynchronously, so the poller keeps running) until `f` holds, failing loudly on a deadline.
async fn until_async(what: &str, ms: u64, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

fn reconciliation_turns(src: &Scripted) -> usize {
    src.turns().iter().filter(|u| u.visits.used > 0).count()
}

/// 451 saved paths are replaced by one: core must reconcile them without building a path set or a tombstone
/// vector first, inside the same ≤200-visit allowance the source turn uses (the scripted source charges nothing,
/// so every visit in a turn is core's reconciliation work). Removals appear only after the whole round is decided,
/// the round is spread over several turns, and 250 of those paths coming back later clears exactly 250 tombstones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn t_large_checkpoint_reconciliation_is_bounded_and_converges() {
    use agentglimd::core::{TURN_ALLOWANCE_BYTES, TURN_ALLOWANCE_ENTRIES, TURN_ALLOWANCE_VISITS};

    const SAVED: usize = 450;
    const BACK: usize = 250;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();

    let keep = "keep.jsonl".to_string();
    let mut initial_paths: Vec<String> = (0..SAVED).map(|i| format!("p/{i:04}.jsonl")).collect();
    initial_paths.push(keep.clone());
    let initial = checkpoint_of_sorted(initial_paths.clone());
    let shrunken = checkpoint_of_sorted(vec![keep.clone()]);
    let mut back_paths: Vec<String> = initial_paths.iter().take(BACK).cloned().collect();
    back_paths.push(keep.clone());
    let back = checkpoint_of_sorted(back_paths);

    let src = Scripted::new(vec![
        Frame::empty(initial),
        Frame::empty(shrunken),
        Frame::empty(back),
    ]);
    let (_store, stop, handle) = spawn_for(&data, src.clone() as Arc<dyn Source>);

    // The initial 451-path checkpoint itself has to be walked once (451 charged visits, one turn cannot do it).
    until_async("the second (shrinking) poll", 10_000, || src.polls() >= 2).await;
    let turn_of_shrink_poll = src.turns().len();
    until_async("that turn to close", 5_000, || {
        src.turns().len() > turn_of_shrink_poll
    })
    .await;
    let base = src.turns().len();

    // No premature removal: nothing may be tombstoned until the round is fully decided.
    let mut observed_mid_round = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && removed_count(&data, "scripted") != SAVED as i64 {
        if removed_count(&data, "scripted") != 0 {
            panic!(
                "a removal was published before the round completed: {} tombstones",
                removed_count(&data, "scripted")
            );
        }
        observed_mid_round = true;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        observed_mid_round,
        "the removal round was observed in progress, not as one instantaneous step"
    );
    assert_eq!(
        removed_count(&data, "scripted"),
        SAVED as i64,
        "every path the new checkpoint no longer reports is tombstoned exactly once"
    );
    assert_eq!(
        file_state_count(&data, "scripted"),
        1,
        "only the surviving path keeps parser state"
    );
    assert!(
        src.turns().len() > base,
        "the 451-path round did not finish inside the turn that polled the shrunken checkpoint"
    );

    // 250 of the removed paths come back: exactly those tombstones are cleared, the other 200 stay.
    until_async("the reappearance commit", 20_000, || {
        removed_count(&data, "scripted") == (SAVED - BACK) as i64
    })
    .await;
    assert_eq!(
        file_state_count(&data, "scripted"),
        (BACK + 1) as i64,
        "the returned paths plus the survivor are in the checkpoint"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;

    let turns = src.turns();
    assert!(
        turns.len() >= 6,
        "several bounded turns were needed: {}",
        turns.len()
    );
    // Two 451-comparison rounds, each exactly three bounded turns: the cap is filled, then the tail finishes the
    // round. This is the bounded-setup result: the round is a resumable walk, not a pre-cap materialization.
    let reconciliation: Vec<u64> = turns
        .iter()
        .filter(|u| u.visits.used > 0)
        .map(|u| u.visits.used)
        .collect();
    assert!(
        reconciliation.len() >= 6,
        "six capped turns of reconciliation work: {reconciliation:?}"
    );
    assert_eq!(
        &reconciliation[..6],
        &[200, 200, 51, 200, 200, 51],
        "each 451-path round is 200 + 200 + 51 charged visits over three turns"
    );
    let mut max_visits = 0;
    for (i, u) in turns.iter().enumerate() {
        assert!(
            u.visits.used <= TURN_ALLOWANCE_VISITS,
            "turn {i} used {} work visits, above the shared {TURN_ALLOWANCE_VISITS} cap",
            u.visits.used
        );
        assert!(
            u.entries.used <= TURN_ALLOWANCE_ENTRIES,
            "turn {i} returned {} entries above the cap",
            u.entries.used
        );
        assert!(
            u.bytes.used <= TURN_ALLOWANCE_BYTES,
            "turn {i} spent {} bytes above the cap",
            u.bytes.used
        );
        max_visits = max_visits.max(u.visits.used);
    }
    assert_eq!(
        max_visits, TURN_ALLOWANCE_VISITS,
        "the visit cap is binding: the 451-path round fills a whole turn and stops"
    );
    let dupes: i64 = db(&data)
        .query_row(
            "SELECT COUNT(*) - COUNT(DISTINCT path) FROM source_removed WHERE source='scripted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dupes, 0, "no duplicated tombstone row");
    println!(
        "ERECONCILE {{\"saved_paths\":{SAVED},\"reappeared\":{BACK},\"turns\":{},\
         \"reconciliation_turns\":{},\"max_visits\":{max_visits},\"visit_cap\":{TURN_ALLOWANCE_VISITS},\
         \"tombstones_left\":{},\"file_states\":{}}}",
        turns.len(),
        reconciliation_turns(&src),
        removed_count(&data, "scripted"),
        file_state_count(&data, "scripted"),
    );
}

/// A failed removal commit publishes nothing and keeps the *exact* pending batch: no re-poll, no partial
/// tombstone, no lost parser state. Lifting the injected failure commits that same reconciliation once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn u_failed_removal_commit_retries_the_same_reconciliation() {
    const SAVED: usize = 450;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    drop(Store::open(&Harness::path(&data)).unwrap());
    db(&data)
        .execute_batch(
            "CREATE TRIGGER inject_removal_fail BEFORE INSERT ON source_removed
             BEGIN SELECT RAISE(ABORT, 'injected removal failure'); END;",
        )
        .unwrap();

    let keep = "keep.jsonl".to_string();
    let mut paths: Vec<String> = (0..SAVED).map(|i| format!("p/{i:04}.jsonl")).collect();
    paths.push(keep.clone());
    let src = Scripted::new(vec![
        Frame::empty(checkpoint_of_sorted(paths)),
        Frame::empty(checkpoint_of_sorted(vec![keep])),
    ]);
    let (_store, stop, handle) = spawn_for(&data, src.clone() as Arc<dyn Source>);

    until_async("the shrinking poll", 10_000, || src.polls() >= 2).await;
    // Let the round finish and several commits fail against the trigger.
    until_async("a finished reconciliation round", 10_000, || {
        reconciliation_turns(&src) >= 4
    })
    .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        src.polls(),
        2,
        "a failed commit keeps the pending batch: the source is not polled again"
    );
    assert_eq!(
        removed_count(&data, "scripted"),
        0,
        "the aborted transaction wrote no tombstone"
    );
    assert_eq!(
        file_state_count(&data, "scripted"),
        (SAVED + 1) as i64,
        "the aborted transaction rolled the checkpoint back too"
    );

    // Remove the injected failure: the still-pending batch is retried, unchanged, by the next turn.
    let polls_before_drop = src.polls();
    db(&data)
        .execute_batch("DROP TRIGGER inject_removal_fail")
        .unwrap();
    until_async("the retried removal commit", 10_000, || {
        removed_count(&data, "scripted") == SAVED as i64
    })
    .await;
    assert!(
        src.polls() <= polls_before_drop + 1,
        "the retry reused the exact pending batch instead of re-polling an advanced source: {}          polls, {polls_before_drop} before the failure was lifted",
        src.polls()
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(removed_count(&data, "scripted"), SAVED as i64);
    assert_eq!(file_state_count(&data, "scripted"), 1);
    let dupes: i64 = db(&data)
        .query_row(
            "SELECT COUNT(*) - COUNT(DISTINCT path) FROM source_removed WHERE source='scripted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dupes, 0, "the retried write is not duplicated");
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

/// Stopping mid-reconciliation publishes no removal (the round is not a partial proof) and keeps the committed
/// checkpoint; a restart over the same SQLite state runs the round again from the start and converges.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v_restart_mid_reconciliation_keeps_state_and_converges() {
    use agentglimd::core::TURN_ALLOWANCE_VISITS;

    const SAVED: usize = 450;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let keep = "keep.jsonl".to_string();
    let mut paths: Vec<String> = (0..SAVED).map(|i| format!("p/{i:04}.jsonl")).collect();
    paths.push(keep.clone());
    let shrunken = checkpoint_of_sorted(vec![keep.clone()]);
    let src = Scripted::new(vec![
        Frame::empty(checkpoint_of_sorted(paths)),
        Frame::empty(shrunken.clone()),
    ]);
    let (_store, stop, handle) = spawn_for(&data, src.clone() as Arc<dyn Source>);

    until_async("the shrinking poll", 10_000, || src.polls() >= 2).await;
    let before = src.turns().len();
    until_async("one bounded turn of the removal round", 5_000, || {
        src.turns().len() > before
    })
    .await;
    assert_eq!(
        removed_count(&data, "scripted"),
        0,
        "mid-round there is no committed removal"
    );
    let _ = stop.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    // Interrupted state is the last committed checkpoint: every path still there, no tombstone.
    assert_eq!(removed_count(&data, "scripted"), 0);
    assert_eq!(file_state_count(&data, "scripted"), (SAVED + 1) as i64);

    // Restart on the same data dir with a source that still reports only the surviving path.
    let src2 = Scripted::new(vec![Frame::empty(shrunken)]);
    let h = Harness::open(&data, src2.clone());
    until_async("the restarted reconciliation", 20_000, || {
        removed_count(&data, "scripted") == SAVED as i64
    })
    .await;
    assert_eq!(file_state_count(&data, "scripted"), 1);
    assert_eq!(
        src2.restored().len(),
        1,
        "the restart restored the committed checkpoint (every saved path) before polling"
    );
    assert_eq!(
        src2.restored()[0].files.len(),
        SAVED + 1,
        "the restored checkpoint still had all 451 paths"
    );
    let turns = src2.turns();
    assert!(
        turns.len() >= 3,
        "the restarted round is bounded over several turns: {}",
        turns.len()
    );
    assert!(
        turns.iter().all(|u| u.visits.used <= TURN_ALLOWANCE_VISITS),
        "no restarted turn exceeded the shared visit cap"
    );
    let h = h.stop().await;
    drop(h);
}

/// The disclosed residual, measured instead of inferred: one committed checkpoint is still handled as a whole
/// tree. `Source::checkpoint()` builds one `FileCheckpoint` per known path, `Bus::commit` converts that into an
/// offsets vector **and** a file-state vector, and `Store::commit_batch` deletes and re-inserts every file-state
/// row (plus every revision row and the generation high-water). The work is linear in known files and is charged
/// to no visit budget, so the scheduled turn is bounded in its traversal dimensions (entries, visits, content
/// bytes) but **not** in this whole-checkpoint bookkeeping cost. This test pins the linear relation so nobody can
/// quietly claim a fully bounded turn; the timings printed are application samples on this machine, not kernel
/// evidence and not a latency guarantee.
#[test]
fn w_whole_checkpoint_commit_is_linear_in_known_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut samples = Vec::new();
    for files in [100usize, 1000] {
        let path = dir.path().join(format!("state-{files}.db"));
        let store = Store::open(&path).unwrap();
        let bus = Bus::new(store.clone()).unwrap();
        let paths: Vec<String> = (0..files).map(|i| format!("p/{i:05}.jsonl")).collect();
        let checkpoint = checkpoint_of_sorted(paths);
        let json_bytes = serde_json::to_vec(&checkpoint).unwrap().len();
        let t0 = Instant::now();
        let evs = bus
            .commit("scripted", &[], &checkpoint, &[], &[], &[])
            .unwrap();
        let commit_ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(evs.is_empty(), "a checkpoint-only commit publishes nothing");
        let c = open_db(&path);
        let states: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM source_file_state WHERE source='scripted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let tombs: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source='scripted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            states, files as i64,
            "one row per known file: the write is whole-tree"
        );
        assert_eq!(tombs, 0, "a pure checkpoint commit creates no tombstone");
        samples.push((files, json_bytes, commit_ms));
        drop(store);
    }
    let (small_n, small_bytes, _) = samples[0];
    let (large_n, large_bytes, _) = samples[1];
    let byte_ratio = large_bytes as f64 / small_bytes as f64;
    let file_ratio = large_n as f64 / small_n as f64;
    assert!(
        (byte_ratio / file_ratio - 1.0).abs() < 0.1,
        "checkpoint bookkeeping grows with the known path count: {small_n} files = {small_bytes} bytes, \
         {large_n} files = {large_bytes} bytes"
    );
    println!(
        "ECKPT {{\"samples\":{:?},\"note\":\"whole-checkpoint serialization + delete/insert per commit; \
         traversal dimensions are capped separately\"}}",
        samples
    );
}

// ------------------------------- bounded checkpoint deltas (v6 T03: incremental transactional commits)

fn delta_of(files: Vec<FileCheckpoint>) -> agentglimd::core::CheckpointDelta {
    agentglimd::core::CheckpointDelta {
        upserts: files,
        revisions: BTreeMap::new(),
        removed: Vec::new(),
    }
}

fn delta_file(path: &str, offset: u64) -> FileCheckpoint {
    FileCheckpoint {
        path: path.to_string(),
        generation: 1,
        offset,
        size: offset,
        ..Default::default()
    }
}

/// A delta commit writes only the rows it names: untouched file states and revision keys survive,
/// an oversized delta is refused before any write, and a removal deletes its file state and gains
/// its tombstone in the same transaction (failed commit rolls both back; exact retry commits once;
/// reappearance clears the tombstone and restores the state).
#[test]
fn checkpoint_delta_commits_incrementally_and_removes_transactionally() {
    use agentglimd::core::CheckpointDelta;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("delta.db");
    let store = Store::open(&path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();

    // Initial delta: three files + two revision keys.
    let mut d0 = delta_of(vec![
        delta_file("a.jsonl", 10),
        delta_file("b.jsonl", 20),
        delta_file("c.jsonl", 30),
    ]);
    d0.revisions.insert("round".to_string(), "r1".to_string());
    d0.revisions.insert("other".to_string(), "o1".to_string());
    assert!(bus
        .commit_delta("delta-src", &[], &d0, &[], &[])
        .unwrap()
        .is_empty());
    assert_eq!(store.load_file_state("delta-src").unwrap().len(), 3);

    // One changed file + one changed revision: the other rows must be untouched.
    let mut d1 = delta_of(vec![delta_file("b.jsonl", 25)]);
    d1.revisions.insert("round".to_string(), "r2".to_string());
    bus.commit_delta("delta-src", &[], &d1, &[], &[]).unwrap();
    let states = store.load_file_state("delta-src").unwrap();
    assert_eq!(states.len(), 3, "a delta never drops untouched files");
    let off = |p: &str| {
        states
            .iter()
            .find(|s| s.path == p)
            .map(|s| s.offset)
            .unwrap()
    };
    assert_eq!(
        (off("a.jsonl"), off("b.jsonl"), off("c.jsonl")),
        (10, 25, 30)
    );
    let revs = store.load_revisions("delta-src").unwrap();
    assert_eq!(revs.get("round").map(String::as_str), Some("r2"));
    assert_eq!(
        revs.get("other").map(String::as_str),
        Some("o1"),
        "an untouched revision key survives a delta"
    );

    // An oversized delta is refused wholesale: nothing is written.
    let big = delta_of(
        (0..300)
            .map(|i| delta_file(&format!("x/{i:04}.jsonl"), 1))
            .collect(),
    );
    assert!(bus.commit_delta("delta-src", &[], &big, &[], &[]).is_err());
    assert_eq!(
        store.load_file_state("delta-src").unwrap().len(),
        3,
        "a refused delta writes nothing"
    );

    // Removal delta under a failing trigger: rollback keeps the file state and writes no tombstone.
    let mut removal = CheckpointDelta {
        removed: vec![RemovedPath {
            path: "c.jsonl".to_string(),
            generation: 1,
            removed_ms: 7,
        }],
        ..Default::default()
    };
    store
        .with(|c| {
            c.execute_batch(
                "CREATE TRIGGER abort_delta BEFORE INSERT ON source_removed
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
        })
        .unwrap();
    assert!(bus
        .commit_delta("delta-src", &[], &removal, &[], &[])
        .is_err());
    assert!(
        store
            .load_file_state("delta-src")
            .unwrap()
            .iter()
            .any(|s| s.path == "c.jsonl"),
        "a failed removal commit keeps the prior committed file state"
    );
    assert_eq!(
        store.load_removed("delta-src").unwrap().len(),
        0,
        "a failed removal commit writes no tombstone"
    );
    store
        .with(|c| c.execute_batch("DROP TRIGGER abort_delta;"))
        .unwrap();
    // Exact retry of the same delta commits once.
    bus.commit_delta("delta-src", &[], &removal, &[], &[])
        .unwrap();
    assert!(
        !store
            .load_file_state("delta-src")
            .unwrap()
            .iter()
            .any(|s| s.path == "c.jsonl"),
        "the removal drops exactly its own file state"
    );
    let tombs = store.load_removed("delta-src").unwrap();
    assert_eq!(tombs.len(), 1);
    assert_eq!(tombs[0].path, "c.jsonl");
    assert_eq!(store.load_file_state("delta-src").unwrap().len(), 2);
    // Replay of the same removal delta is idempotent (one tombstone, no duplicate).
    bus.commit_delta("delta-src", &[], &removal, &[], &[])
        .unwrap();
    assert_eq!(store.load_removed("delta-src").unwrap().len(), 1);

    // Reappearance: upsert the path again and clear the tombstone in the same commit.
    let back = delta_of(vec![delta_file("c.jsonl", 5)]);
    bus.commit_delta("delta-src", &[], &back, &["c.jsonl".to_string()], &[])
        .unwrap();
    assert!(store.load_removed("delta-src").unwrap().is_empty());
    assert_eq!(store.load_file_state("delta-src").unwrap().len(), 3);
    let _ = &mut removal;
}
