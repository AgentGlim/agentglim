//! v5 G07 (OpenCode half): coherent snapshot revisions through the REAL adapter and store.
//!
//! Scenarios use the production `OpenCode` adapter's own `Source` methods, and either the production
//! `spawn_poller` (`Source -> Bus -> SQLite`) or `Bus::commit` with the adapter's own items/checkpoint/identities.
//! No test-side parser, hashing or reconciliation stands in for the adapter.
//!
//! Expectations come from BUILD-V5 T05: a metadata-preserving content edit must eventually be accepted as a new
//! coherent revision (distinct producer identity), unchanged/metadata-only polls must be silent with no extra
//! Step/Spend, deletion and reappearance must be tombstone-based, A->B->A must be three distinct revisions, and a
//! legacy checkpoint must not duplicate committed observations.

use agentglimd::adapters::opencode;
use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{Batch, Cursor, Env, FileCheckpoint, Source, SourceCheckpoint};
use agentglimd::store::Store;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tempfile::TempDir;
use tokio::sync::watch;

const SOURCE: &str = opencode::ID;

// ------------------------------------------------------------------------------------------------- fixtures

struct OcHome {
    _t: TempDir,
    home: PathBuf,
}

impl OcHome {
    fn new() -> OcHome {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let base = root_of(&home);
        fs::create_dir_all(base.join("session/demo")).unwrap();
        fs::create_dir_all(base.join("message/ses1")).unwrap();
        fs::write(
            base.join("session/demo/ses1.json"),
            r#"{"id":"ses1","directory":"/work","title":"t","version":"1","time":{"created":100}}"#,
        )
        .unwrap();
        OcHome { _t: t, home }
    }

    fn base(&self) -> PathBuf {
        root_of(&self.home)
    }

    fn source(&self) -> Arc<dyn Source> {
        Arc::new(opencode::OpenCode::new(None, &self.home, 30))
    }

    fn indexed(&self) -> opencode::OpenCode {
        opencode::OpenCode::new(None, &self.home, 30)
    }

    fn message_path(&self) -> PathBuf {
        self.base().join("message/ses1/m1.json")
    }

    fn write_message(&self, doc: &str) -> SystemTime {
        fs::write(self.message_path(), doc).unwrap();
        fs::metadata(self.message_path())
            .unwrap()
            .modified()
            .unwrap()
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }
}

fn root_of(home: &Path) -> PathBuf {
    home.join(".local/share/opencode/storage")
}

/// Supported user message with a 10,000-character blob; `flip` chooses the byte at offset 1000.
fn blob_doc(flip: char) -> String {
    let mut b = "p".repeat(10_000);
    b.replace_range(1000..1001, &flip.to_string());
    format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"blob":"{b}"}}"#
    )
}

fn small_doc(text: &str) -> String {
    format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":101}},"text":"{text}"}}"#
    )
}

fn set_mtime(p: &Path, t: SystemTime) {
    fs::File::options()
        .write(true)
        .open(p)
        .unwrap()
        .set_modified(t)
        .unwrap();
}

// ----------------------------------------------------------------------------------------------- store rig

struct Rig {
    data: PathBuf,
    store: Store,
    bus: Arc<Bus>,
}

impl Rig {
    fn new(dir: &Path) -> Rig {
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        Rig { data, store, bus }
    }

    fn open_existing(data: &Path) -> Rig {
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        Rig {
            data: data.to_path_buf(),
            store,
            bus,
        }
    }

    fn db(&self) -> Connection {
        Connection::open(self.data.join("state.db")).unwrap()
    }

    /// `(seq, producer, data)` for stored step observations of the fixture session.
    fn steps(&self) -> Vec<(u64, Option<String>, Value)> {
        let c = self.db();
        let mut st = c
            .prepare(
                "SELECT seq, producer, data FROM events \
                 WHERE source=?1 AND kind='step' AND session='ses1' ORDER BY seq",
            )
            .unwrap();
        let rows = st
            .query_map([SOURCE], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap();
        rows.map(|r| {
            let (seq, producer, raw) = r.unwrap();
            (seq, producer, serde_json::from_str(&raw).unwrap())
        })
        .collect()
    }

    fn spends(&self) -> u64 {
        let c = self.db();
        c.query_row(
            "SELECT COUNT(*) FROM events WHERE source=?1 AND kind='spend'",
            [SOURCE],
            |r| r.get::<_, i64>(0),
        )
        .unwrap() as u64
    }

    fn events(&self) -> u64 {
        self.store.event_count().unwrap() as u64
    }

    /// Commits one adapter poll exactly as the poller does for a source without tombstones in this step:
    /// the adapter's items, checkpoint and identities go through the single production transaction.
    fn commit(
        &self,
        batch: &Batch,
        checkpoint: &SourceCheckpoint,
        identities: &[agentglimd::core::RecordKey],
    ) {
        self.bus
            .commit(SOURCE, &batch.items, checkpoint, &[], &[], identities)
            .unwrap();
    }
}

struct Run {
    data: PathBuf,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Run {
    fn start(data: PathBuf, home: &OcHome) -> Run {
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let (refresh_tx, refresh) = watch::channel(0u64);
        std::mem::forget(refresh_tx);
        let (stop, stop_rx) = watch::channel(false);
        let deps = PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![home.source()]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: home.env(),
            intervals: Intervals {
                poll: Duration::from_millis(20),
                discover: Duration::from_millis(20),
            },
            refresh,
        };
        let handle = spawn_poller(deps, stop_rx);
        Run { data, stop, handle }
    }

    async fn stop(self) -> PathBuf {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), self.handle).await;
        self.data
    }
}

async fn wait_for(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let t0 = Instant::now();
    while t0.elapsed() < within {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Six real adapter polls, each committed through the store; returns the number of items emitted, in order.
async fn six_polls(src: &opencode::OpenCode, rig: &Rig, cursor: &mut Cursor) -> Vec<usize> {
    let mut counts = Vec::new();
    for _ in 0..6 {
        let batch = src.poll(*cursor).await.unwrap();
        *cursor = batch.next;
        let identities = src.identities();
        rig.commit(&batch, &src.checkpoint(), &identities);
        counts.push(batch.items.len());
    }
    counts
}

// ------------------------------------------------------------------------------------------------ scenarios

/// The exact S3 content edit (10k blob, byte 1000) must be accepted as a new coherent revision that reaches
/// SQLite within six real polls, with a distinct producer identity, and unchanged polls afterwards add nothing.
#[tokio::test]
async fn opencode_between_window_edit_reaches_store_within_six_polls() {
    let h = OcHome::new();
    let t = tempfile::tempdir().unwrap();
    let rig = Rig::new(t.path());
    let src = h.indexed();

    let mtime = h.write_message(&blob_doc('p'));
    let mut cursor = Cursor(0);
    let batch = src.poll(cursor).await.unwrap();
    cursor = batch.next;
    rig.commit(&batch, &src.checkpoint(), &src.identities());
    assert_eq!(
        rig.steps().len(),
        1,
        "the initial supported message must be stored once; got {:?}",
        rig.steps()
    );

    // Same inode, same length, same mtime: only one byte inside the blob changes.
    h.write_message(&blob_doc('q'));
    set_mtime(&h.message_path(), mtime);

    let counts = six_polls(&src, &rig, &mut cursor).await;
    let steps = rig.steps();
    assert!(
        steps.len() >= 2,
        "the metadata-preserving edit must be accepted within six real polls; poll item counts {counts:?}, \
         stored steps {}",
        steps.len()
    );
    let producers: Vec<Option<String>> = steps.iter().map(|(_, p, _)| p.clone()).collect();
    let distinct: BTreeSet<Option<String>> = producers.iter().cloned().collect();
    assert_eq!(
        distinct.len(),
        producers.len(),
        "each accepted revision needs its own producer identity, got {producers:?}"
    );
    assert!(
        producers
            .iter()
            .flatten()
            .all(|p| p.starts_with("rev\u{1f}")),
        "snapshot revisions must use the revision namespace: {producers:?}"
    );
    assert_eq!(
        steps[0].2, steps[1].2,
        "the emitted payload is unchanged (only the content witness moved), so the two rows must differ only by \
         revision identity"
    );

    // Unchanged polls: nothing new, no duplicate steps, no invented spend.
    let before = rig.events();
    let steps_before = steps.len();
    let mut counts = Vec::new();
    for _ in 0..4 {
        let b = src.poll(cursor).await.unwrap();
        cursor = b.next;
        rig.commit(&b, &src.checkpoint(), &src.identities());
        counts.push(b.items.len());
    }
    assert!(
        counts.iter().all(|n| *n == 0),
        "an accepted, unchanged document must be silent afterwards, got {counts:?}"
    );
    assert_eq!(
        rig.events(),
        before,
        "unchanged polls must not store any new event row"
    );
    assert_eq!(rig.steps().len(), steps_before);
    assert_eq!(rig.spends(), 0, "a user message has no token spend");
}

/// The same edit observed through the real poller after a restart of the process state: the durable witness must
/// still detect it, and a further unchanged restart must stay silent.
#[tokio::test]
async fn opencode_edit_is_detected_after_restart_and_then_silent() {
    let h = OcHome::new();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");

    let mtime = h.write_message(&small_doc("first"));
    let run = Run::start(data.clone(), &h);
    wait_for("initial message stored", Duration::from_secs(20), || {
        let c = Connection::open(data.join("state.db")).unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM events WHERE source=?1 AND kind='step'",
            [SOURCE],
            |r| r.get::<_, i64>(0),
        )
        .unwrap() as u64
            == 1
    })
    .await;
    run.stop().await;

    // Fresh process state over the same store: the witness is restored, the edit must still be detected.
    h.write_message(&small_doc("second"));
    set_mtime(&h.message_path(), mtime);
    let run = Run::start(data.clone(), &h);
    wait_for(
        "revised message stored after restart",
        Duration::from_secs(25),
        || {
            let c = Connection::open(data.join("state.db")).unwrap();
            c.query_row(
                "SELECT COUNT(*) FROM events WHERE source=?1 AND kind='step'",
                [SOURCE],
                |r| r.get::<_, i64>(0),
            )
            .unwrap() as u64
                >= 2
        },
    )
    .await;
    run.stop().await;

    // Count rows, restart unchanged, and prove nothing is re-emitted or duplicated.
    let rig = Rig::open_existing(&data);
    let rows = rig.events();
    assert_eq!(
        rig.steps().len(),
        2,
        "exactly two accepted revisions, got {:?}",
        rig.steps()
    );
    let run = Run::start(data.clone(), &h);
    settle(500).await;
    run.stop().await;
    let after = Rig::open_existing(&data);
    assert_eq!(
        after.events(),
        rows,
        "an unchanged restart must not store anything new"
    );
    assert_eq!(
        after.steps().len(),
        2,
        "an unchanged restart must not re-emit"
    );
}

/// A metadata-only touch (same size, same content, new mtime) is silent, and a legacy checkpoint without a
/// content witness must not duplicate the already committed observation.
#[tokio::test]
async fn opencode_touch_and_legacy_checkpoint_are_silent_and_deduplicated() {
    let h = OcHome::new();
    let t = tempfile::tempdir().unwrap();
    let rig = Rig::new(t.path());
    let src = h.indexed();
    h.write_message(&small_doc("stable"));
    let mut cursor = Cursor(0);
    let batch = src.poll(cursor).await.unwrap();
    cursor = batch.next;
    rig.commit(&batch, &src.checkpoint(), &src.identities());
    assert_eq!(rig.steps().len(), 1);

    // Metadata-only touch: content and size unchanged, mtime moved.
    let later = SystemTime::now() + Duration::from_secs(5);
    set_mtime(&h.message_path(), later);
    let counts = six_polls(&src, &rig, &mut cursor).await;
    assert!(
        counts.iter().all(|n| *n == 0),
        "a metadata-only touch must not emit items, got {counts:?}"
    );
    assert_eq!(rig.steps().len(), 1, "a touch must not add an observation");
    assert_eq!(rig.spends(), 0);

    // Legacy checkpoint: the committed offset/size is present, but no content witness or revision token exists.
    let legacy = SourceCheckpoint {
        files: vec![FileCheckpoint {
            path: "message/ses1/m1.json".to_string(),
            generation: 0,
            offset: fs::metadata(h.message_path()).unwrap().len(),
            size: fs::metadata(h.message_path()).unwrap().len(),
            mtime_ms: 0,
            fingerprint: String::new(),
            session: Some("ses1".to_string()),
            model: None,
            announced: true,
            discarded_bytes: 0,
            incomplete: false,
            revision: None,
        }],
        revisions: Default::default(),
    };
    let legacy_src = h.indexed();
    legacy_src.restore_checkpoint(legacy);
    let mut legacy_cursor = Cursor(1);
    for _ in 0..4 {
        let b = legacy_src.poll(legacy_cursor).await.unwrap();
        legacy_cursor = b.next;
        rig.commit(&b, &legacy_src.checkpoint(), &legacy_src.identities());
    }
    assert_eq!(
        rig.steps().len(),
        1,
        "a legacy checkpoint may re-read the document but must not store a duplicate observation: {:?}",
        rig.steps()
    );
}

/// A deleted supported document is tombstoned only after a completed sweep, and its reappearance clears the
/// tombstone and is accepted as a new observation rather than a silent resurrection.
#[tokio::test]
async fn opencode_deletion_and_reappearance() {
    let h = OcHome::new();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    h.write_message(&small_doc("live"));
    let run = Run::start(data.clone(), &h);
    wait_for("initial observation", Duration::from_secs(20), || {
        counts(&data, "step") >= 1
    })
    .await;

    let msg = h.message_path();
    fs::remove_file(&msg).unwrap();
    wait_for(
        "tombstone for the deleted document",
        Duration::from_secs(25),
        || {
            let c = Connection::open(data.join("state.db")).unwrap();
            c.query_row(
            "SELECT COUNT(*) FROM source_removed WHERE source=?1 AND path='message/ses1/m1.json'",
            [SOURCE],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            >= 1
        },
    )
    .await;
    run.stop().await;

    // Reappearance: same supported document, new observation expected, tombstone gone.
    h.write_message(&small_doc("live"));
    let run = Run::start(data.clone(), &h);
    wait_for(
        "tombstone cleared on reappearance",
        Duration::from_secs(25),
        || {
            let c = Connection::open(data.join("state.db")).unwrap();
            c.query_row(
                "SELECT COUNT(*) FROM source_removed WHERE source=?1",
                [SOURCE],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                == 0
        },
    )
    .await;
    let rig = Rig::open_existing(&data);
    assert!(
        rig.steps().len() >= 2,
        "a reappeared document is a new accepted observation, got {:?}",
        rig.steps()
    );
    run.stop().await;
}

/// A -> B -> A content cycle with preserved metadata must remain three distinct accepted revisions, even though
/// the first and last payloads are identical.
#[tokio::test]
async fn opencode_a_b_a_keeps_three_revisions() {
    let h = OcHome::new();
    let t = tempfile::tempdir().unwrap();
    let rig = Rig::new(t.path());
    let src = h.indexed();
    let a = blob_doc('p');
    let b = blob_doc('q');
    assert_eq!(a.len(), b.len());
    h.write_message(&a);
    let mut cursor = Cursor(0);
    let batch = src.poll(cursor).await.unwrap();
    cursor = batch.next;
    rig.commit(&batch, &src.checkpoint(), &src.identities());

    for (label, doc) in [("B", &b), ("A again", &a)] {
        let before = fs::metadata(h.message_path()).unwrap();
        fs::write(h.message_path(), doc).unwrap();
        // Keep length and inode; move mtime so the metadata is honest about a write but content decides.
        set_mtime(
            &h.message_path(),
            before.modified().unwrap() + Duration::from_secs(1),
        );
        let mut emitted = 0usize;
        for _ in 0..8 {
            let batch = src.poll(cursor).await.unwrap();
            cursor = batch.next;
            emitted += batch.items.len();
            rig.commit(&batch, &src.checkpoint(), &src.identities());
            if emitted > 0 {
                break;
            }
        }
        assert!(
            emitted > 0,
            "the {label} revision must be observed, otherwise the cycle collapses"
        );
    }

    let steps = rig.steps();
    assert_eq!(
        steps.len(),
        3,
        "A -> B -> A must be three accepted revisions, got {:?}",
        steps
    );
    assert_eq!(
        steps[0].2, steps[2].2,
        "the first and third revision carry the same payload; identity must come from the revision"
    );
    let producers: BTreeSet<Option<String>> = steps.iter().map(|(_, p, _)| p.clone()).collect();
    assert_eq!(
        producers.len(),
        3,
        "three distinct producer identities required, got {producers:?}"
    );
    assert_eq!(rig.spends(), 0);
}

fn counts(data: &Path, kind: &str) -> u64 {
    let c = Connection::open(data.join("state.db")).unwrap();
    c.query_row(
        "SELECT COUNT(*) FROM events WHERE source=?1 AND kind=?2",
        rusqlite::params![SOURCE, kind],
        |r| r.get::<_, i64>(0),
    )
    .unwrap() as u64
}

// ------------------------------------------------------------------------------- r2 added integration cases

/// A large supported document whose two versions differ in an early field (`time.created`) and a late field
/// (`modelID`), with identical length. A document assembled from two versions therefore produces a
/// `(ts, model)` pair that neither version has, which is how a mixed read becomes observable in SQLite.
/// Verification runs in 4 KiB witness chunks with a finite per-visit bound, so a 400 KB document needs several
/// polls and a partial witness pass is reachable deterministically.
fn large_doc(created: u64, model: &str, fill: char) -> String {
    let blob: String = std::iter::repeat_n(fill, 400_000).collect();
    format!(
        r#"{{"id":"m1","sessionID":"ses1","role":"user","time":{{"created":{created}}},"modelID":"{model}","blob":"{blob}"}}"#
    )
}

fn step_data(created: u64, model: &str) -> Value {
    serde_json::json!({"role": "user", "ts": created, "model": model})
}

/// In-place rewrite: same inode, same length, no truncation, so a concurrent reader can legitimately observe a
/// mixture unless the adapter proves coherence before publishing.
fn overwrite_in_place(p: &Path, doc: &str) {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = fs::File::options().write(true).open(p).unwrap();
    f.seek(SeekFrom::Start(0)).unwrap();
    f.write_all(doc.as_bytes()).unwrap();
    f.set_len(doc.len() as u64).unwrap();
    f.flush().unwrap();
}

/// Partial full-content witness -> metadata-preserving edit -> completion: exactly one coherent document per
/// accepted revision reaches SQLite. The stored payload is checked field by field, so a witness chain or a
/// payload buffer assembled across the two versions cannot pass.
#[tokio::test]
async fn opencode_partial_witness_edit_completion_stores_one_coherent_version() {
    let h = OcHome::new();
    let t = tempfile::tempdir().unwrap();
    let rig = Rig::new(t.path());
    let src = h.indexed();

    let doc_a = large_doc(111, "modelA", 'p');
    let doc_b = large_doc(222, "modelB", 'q');
    assert_eq!(doc_a.len(), doc_b.len());

    // 1. Accept version A through the adapter and store it.
    let mtime = h.write_message(&doc_a);
    let mut cursor = Cursor(0);
    let mut stored_a = false;
    for _ in 0..8 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        let items = batch.items.len();
        rig.commit(&batch, &src.checkpoint(), &src.identities());
        if rig.steps().len() == 1 {
            stored_a = true;
            break;
        }
        assert!(items <= 64, "a bounded poll emitted {items} items");
    }
    assert!(
        stored_a,
        "version A must be stored once; got {:?}",
        rig.steps()
    );
    assert_eq!(rig.steps()[0].2, step_data(111, "modelA"));

    // 2. A later poll resumes (but does not finish) the full-content witness pass of A.
    let before = src.work_stats();
    let batch = src.poll(cursor).await.unwrap();
    cursor = batch.next;
    rig.commit(&batch, &src.checkpoint(), &src.identities());
    let after = src.work_stats();
    assert_eq!(
        batch.items.len(),
        0,
        "an unchanged large document must not emit while its witness pass is incomplete"
    );
    assert!(
        after.verify_bytes > before.verify_bytes,
        "the unchanged document must start/continue a full-content witness pass \
         (verify bytes {} -> {})",
        before.verify_bytes,
        after.verify_bytes
    );
    assert_eq!(
        after.verifications_completed, before.verifications_completed,
        "the 400 KB document must still have a partial witness pass after one visit"
    );

    // 3. Metadata-preserving edit while the pass is partial: new content in the unverified suffix.
    overwrite_in_place(&h.message_path(), &doc_b);
    set_mtime(&h.message_path(), mtime);

    // 4. Completion + store: the accepted revision must be exactly version B, once.
    let mut emitted = 0usize;
    for _ in 0..12 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        emitted += batch.items.len();
        rig.commit(&batch, &src.checkpoint(), &src.identities());
        if rig.steps().len() >= 2 {
            break;
        }
    }
    assert!(
        emitted > 0,
        "the edited document must be accepted after the partial witness pass completes"
    );
    let steps = rig.steps();
    assert_eq!(
        steps.len(),
        2,
        "exactly two accepted revisions (old, new) must be stored, got {:?}",
        steps.iter().map(|(_, _, d)| d.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        steps[0].2,
        step_data(111, "modelA"),
        "the first revision must stay version A"
    );
    assert_eq!(
        steps[1].2,
        step_data(222, "modelB"),
        "the second revision must be the complete new document, never a mix of both versions \
         (an A prefix with a B suffix would store ts=111 with model=modelB)"
    );

    // 5. Unchanged polls and a restart stay silent: no third revision, no duplicate.
    let before_rows = rig.events();
    for _ in 0..4 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        rig.commit(&batch, &src.checkpoint(), &src.identities());
    }
    assert_eq!(
        rig.events(),
        before_rows,
        "an accepted, unchanged document must be silent afterwards"
    );
    assert_eq!(rig.steps().len(), 2);
    assert_eq!(rig.spends(), 0);
}

/// Concurrent in-place rewrites between the two exact versions (same inode/length/mtime) while the adapter is
/// polling: every stored revision must be one of the two complete documents. A document assembled from both
/// versions would store a `(ts, model)` pair that neither version has and fails the assertion below.
#[tokio::test]
async fn opencode_concurrent_in_place_rewrites_never_store_a_mixed_document() {
    let h = OcHome::new();
    let t = tempfile::tempdir().unwrap();
    let rig = Rig::new(t.path());
    let src = h.indexed();

    let doc_a = large_doc(111, "modelA", 'p');
    let doc_b = large_doc(222, "modelB", 'q');
    let mtime = h.write_message(&doc_a);
    let mut cursor = Cursor(0);
    for _ in 0..8 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        rig.commit(&batch, &src.checkpoint(), &src.identities());
        if !rig.steps().is_empty() {
            break;
        }
    }
    assert_eq!(
        rig.steps().first().map(|(_, _, d)| d.clone()),
        Some(step_data(111, "modelA")),
        "the initial version must be stored first"
    );

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        let path = h.message_path();
        let (a, b) = (doc_a.clone(), doc_b.clone());
        std::thread::spawn(move || {
            let mut n = 0u64;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                overwrite_in_place(&path, if n.is_multiple_of(2) { &b } else { &a });
                let _ = fs::File::options()
                    .write(true)
                    .open(&path)
                    .and_then(|f| f.set_modified(mtime));
                n += 1;
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };

    for _ in 0..40 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        rig.commit(&batch, &src.checkpoint(), &src.identities());
        tokio::time::sleep(Duration::from_millis(3)).await;
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();

    // Settle on version B and prove it is accepted after the churn.
    overwrite_in_place(&h.message_path(), &doc_b);
    set_mtime(&h.message_path(), mtime);
    for _ in 0..20 {
        let batch = src.poll(cursor).await.unwrap();
        cursor = batch.next;
        rig.commit(&batch, &src.checkpoint(), &src.identities());
        if rig
            .steps()
            .iter()
            .any(|(_, _, d)| *d == step_data(222, "modelB"))
        {
            break;
        }
    }

    let steps = rig.steps();
    let allowed = [step_data(111, "modelA"), step_data(222, "modelB")];
    for (seq, producer, data) in &steps {
        assert!(
            allowed.contains(data),
            "stored revision at seq {seq} (producer {producer:?}) mixes the two document versions: {data}"
        );
    }
    assert!(
        steps.iter().any(|(_, _, d)| *d == step_data(222, "modelB")),
        "the final edit must still be accepted after concurrent rewrites; stored {:?}",
        steps.iter().map(|(_, _, d)| d.clone()).collect::<Vec<_>>()
    );
    // Every accepted revision needs its own durable producer identity (no duplicate rows for one revision).
    let producers: BTreeSet<Option<String>> = steps.iter().map(|(_, p, _)| p.clone()).collect();
    assert!(
        producers.len() == steps.len() || producers.iter().all(Option::is_none),
        "accepted revisions must not share a producer identity: {:?}",
        steps.iter().map(|(_, p, _)| p.clone()).collect::<Vec<_>>()
    );
    assert_eq!(rig.spends(), 0);
}
