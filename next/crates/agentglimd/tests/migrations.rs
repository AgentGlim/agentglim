use agentglimd::store::migrations::{applied, latest, run, run_up_to};
use agentglimd::store::Store;
use rusqlite::Connection;

#[test]
fn every_migration_on_empty_db() {
    let mut c = Connection::open_in_memory().unwrap();
    let now = run(&mut c).unwrap();
    assert_eq!(now, (1..=latest()).collect::<Vec<_>>());
    assert!(run(&mut c).unwrap().is_empty(), "idempotent");
    assert_eq!(applied(&c).unwrap().len() as i64, latest());
}

#[test]
fn upgrade_v1_fixture_db_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.db");
    {
        // Build the v1 fixture: schema at migration 1 with rows in it.
        let mut c = Connection::open(&path).unwrap();
        run_up_to(&mut c, 1).unwrap();
        c.execute(
            "INSERT INTO tasks(id,kind,state,created,updated) VALUES ('old','noop','done',1,1)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data) VALUES (41,'task','daemon',1,'{}')",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let row = store.get_task("old").unwrap().unwrap();
    assert_eq!(row.state, "done");
    assert_eq!(row.detail, "");
    assert_eq!(store.max_seq().unwrap(), 41);
    let versions = store.with(applied).unwrap();
    assert_eq!(versions.last().copied(), Some(latest()));
    let wal: String = store
        .with(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(wal, "wal");
}

#[test]
fn failed_migration_rolls_back() {
    let mut c = Connection::open_in_memory().unwrap();
    run_up_to(&mut c, 1).unwrap();
    // Simulate a half-applied v2 conflict: the index already exists, so migration 2 fails.
    c.execute_batch("CREATE INDEX events_ts ON events(ts)")
        .unwrap();
    assert!(run(&mut c).is_err());
    assert_eq!(applied(&c).unwrap(), vec![1]);
    let has_detail = c.prepare("SELECT detail FROM tasks").is_ok();
    assert!(
        !has_detail,
        "ALTER TABLE rolled back with the failed migration"
    );
}

/// An existing database that predates occurrence time/identity upgrades in place: rows keep their data with
/// `occurred_ms` unknown, cursors survive, and new offset-less ingestion gets an identity.
#[test]
fn upgrade_from_pre_occurrence_database_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("older.db");
    {
        let mut c = Connection::open(&path).unwrap();
        run_up_to(&mut c, 3).unwrap();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data,session,dedup) VALUES (7,'step','claude-code',100,'{}','s1',NULL)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_offsets(source,path,offset,size) VALUES ('claude-code','a.jsonl',10,10)",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.with(applied).unwrap().last().copied(), Some(latest()));
    let (occurred, occurrence) = store
        .with(|c| {
            c.query_row(
                "SELECT occurred_ms, occurrence FROM events WHERE seq=7",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
            )
        })
        .unwrap();
    assert_eq!(occurred, 0, "old rows keep an unknown occurrence time");
    assert_eq!(occurrence, None);
    assert_eq!(store.max_seq().unwrap(), 7);
    assert_eq!(store.load_offsets("claude-code").unwrap().len(), 1);

    let items = [agentglimd::core::BatchItem {
        kind: agentglimd::core::ItemKind::Step,
        session: "s1".into(),
        data: serde_json::json!({"ts": "2026-10-30T09:00:00.000Z"}),
    }];
    assert_eq!(
        store.append_batch_at("fake", &items, &[], 8).unwrap().len(),
        1
    );
}

/// A database from the checkpoint-state schema (0005) upgrades in place: existing events keep their data and get no
/// invented producer identity, stored cursors and file parser state survive, and new ingestion with a producer
/// identity works (including dedup) next to the old rows.
#[test]
fn upgrade_from_checkpoint_state_database_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v5.db");
    {
        let mut c = Connection::open(&path).unwrap();
        run_up_to(&mut c, 5).unwrap();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data,session,dedup,occurred_ms,occurrence)
             VALUES (9,'step','claude-code',100,'{\"ts\":\"2026-10-30T09:00:00.000Z\"}','s1',NULL,1793350800000,'occ:old')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_offsets(source,path,offset,size) VALUES ('claude-code','a.jsonl',10,10)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision)
             VALUES ('claude-code','a.jsonl',10,1,'fp','s1','m',1,2,10,0,0,1,'2')",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.with(applied).unwrap().last().copied(), Some(latest()));
    assert_eq!(store.max_seq().unwrap(), 9);

    // Old rows: unchanged data, no new identity invented.
    let (occurrence, producer): (Option<String>, Option<String>) = store
        .with(|c| {
            c.query_row(
                "SELECT occurrence, producer FROM events WHERE seq=9",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(occurrence.as_deref(), Some("occ:old"));
    assert_eq!(producer, None, "history keeps its old identity policy");

    // Cursors and parser state survived the upgrade.
    assert_eq!(store.load_offsets("claude-code").unwrap().len(), 1);
    let states = store.load_file_state("claude-code").unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!((states[0].generation, states[0].offset), (2, 10));
    assert!(store.load_revisions("claude-code").unwrap().is_empty());
    assert!(store.load_removed("claude-code").unwrap().is_empty());

    // New producer identity: inserted once, deduplicated on replay, seq continues after the old row.
    let items = [agentglimd::core::BatchItem {
        kind: agentglimd::core::ItemKind::Step,
        session: "s1".into(),
        data: serde_json::json!({"ts": "2026-10-30T09:00:05.000Z"}),
    }];
    let key = agentglimd::core::RecordKey::offset("a.jsonl", 2, 10, 0);
    let mut ck = agentglimd::core::SourceCheckpoint::default();
    ck.revisions.insert("round".into(), "5".into());
    let commit = |store: &Store, ids: &[agentglimd::core::RecordKey]| {
        store
            .commit_batch(agentglimd::store::BatchCommit {
                source: "claude-code",
                items: &items,
                offsets: &[],
                file_states: &[],
                revisions: &ck.revisions,
                removed: &[],
                reappeared: &[],
                identities: ids,
                claims: &[],
                first_seq: 10,
            })
            .unwrap()
    };
    let first = commit(&store, std::slice::from_ref(&key));
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].seq, 10, "seq continues after the upgraded rows");
    assert!(commit(&store, &[key]).is_empty(), "replay deduplicated");
    assert_eq!(
        store
            .load_revisions("claude-code")
            .unwrap()
            .get("round")
            .map(String::as_str),
        Some("5"),
        "source revisions are durable on the upgraded schema"
    );
    assert_eq!(store.producers("claude-code").unwrap().len(), 1);
    assert_eq!(store.event_count().unwrap(), 2);
}

/// A v6 database (producer identity schema) upgrades in place to the latest schema: old events, cursors and
/// parser state survive, the logical-generation high-water is seeded from the v6 file state and tombstones,
/// and new ingestion with a producer identity keeps working next to the old rows.
#[test]
fn upgrade_from_v6_database_keeps_data_and_seeds_generations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v6.db");
    {
        let mut c = Connection::open(&path).unwrap();
        run_up_to(&mut c, 6).unwrap();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data,session,dedup,occurred_ms,occurrence,producer) \
             VALUES (11,'step','claude-code',100,'{}','s1',NULL,0,NULL,'off\\u001fa.jsonl\\u001f2\\u001f0\\u001f0')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_offsets(source,path,offset,size) VALUES ('claude-code','a.jsonl',10,10)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision) \
             VALUES ('claude-code','a.jsonl',10,1,'fp','s1','m',1,2,10,0,0,1,'2')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_removed(source,path,generation,removed_ms) VALUES ('claude-code','gone.jsonl',4,99)",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.with(applied).unwrap().last().copied(), Some(latest()));
    assert_eq!(store.max_seq().unwrap(), 11);
    assert_eq!(store.load_offsets("claude-code").unwrap().len(), 1);
    let states = store.load_file_state("claude-code").unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!((states[0].generation, states[0].offset), (2, 10));
    assert_eq!(store.load_generation("claude-code", "a.jsonl").unwrap(), 2);
    assert_eq!(
        store.load_generation("claude-code", "gone.jsonl").unwrap(),
        4
    );

    // New producer identity still inserts once, and seq continues after the upgraded rows.
    let items = [agentglimd::core::BatchItem {
        kind: agentglimd::core::ItemKind::Step,
        session: "s1".into(),
        data: serde_json::json!({"ts": "2026-10-30T09:00:05.000Z"}),
    }];
    let key = agentglimd::core::RecordKey::offset("a.jsonl", 3, 10, 0);
    let evs = store
        .commit_batch(agentglimd::store::BatchCommit {
            source: "claude-code",
            items: &items,
            offsets: &[],
            file_states: &[],
            revisions: &std::collections::BTreeMap::new(),
            removed: &[],
            reappeared: &[],
            identities: &[key],
            claims: &[],
            first_seq: 12,
        })
        .unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].seq, 12);
}

/// A failed 0007 migration leaves the database at v6 (rollback), so a later run can apply it again.
#[test]
fn failed_logical_generation_migration_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v6fail.db");
    {
        let mut c = Connection::open(&path).unwrap();
        run_up_to(&mut c, 6).unwrap();
    }
    // Pre-create the table that migration 0007 creates, so the migration's CREATE TABLE fails.
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE source_generations (source TEXT, path TEXT, PRIMARY KEY(source,path))",
        )
        .unwrap();
    }
    let mut c = Connection::open(&path).unwrap();
    assert!(run(&mut c).is_err());
    assert_eq!(applied(&c).unwrap(), (1..=6).collect::<Vec<_>>());
    // Dropping the conflicting table lets the migration succeed on retry.
    c.execute_batch("DROP TABLE source_generations").unwrap();
    assert_eq!(run(&mut c).unwrap(), vec![7]);
    assert_eq!(applied(&c).unwrap().last().copied(), Some(latest()));
}

// ------------------------------------------------- real adapter over an upgraded v6 store (v4-r2 T01 step 4)

/// The checkpoint the poller builds from persisted rows (the poller's loader is private).
fn checkpoint_from_store(store: &Store, source: &str) -> agentglimd::core::SourceCheckpoint {
    use agentglimd::core::{FileCheckpoint, SourceCheckpoint};
    SourceCheckpoint {
        files: store
            .load_file_state(source)
            .unwrap()
            .into_iter()
            .map(|st| FileCheckpoint {
                path: st.path,
                generation: st.generation,
                offset: st.offset,
                size: st.size,
                mtime_ms: st.mtime_ms,
                fingerprint: st.fingerprint,
                session: st.session,
                model: st.model,
                announced: st.announced,
                discarded_bytes: st.discarded_bytes,
                incomplete: st.incomplete,
                revision: st.revision,
            })
            .collect(),
        revisions: store.load_revisions(source).unwrap(),
    }
}

fn hex_prefix(path: &std::path::Path, n: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    let mut f = std::fs::File::open(path).unwrap();
    let got = f.read(&mut buf).unwrap();
    buf[..got].iter().map(|b| format!("{b:02x}")).collect()
}

fn mtime_ms(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// One supported Claude Code assistant record; the `pad` field puts the model marker past byte 256.
fn claude_line(model: &str, uuid: &str, ts: &str) -> String {
    format!(
        "{{\"type\":\"assistant\",\"pad\":\"{}\",\"cwd\":\"/work/demo\",\"sessionId\":\"s1\",\"version\":\"2.0.14\",\"gitBranch\":\"main\",\"message\":{{\"role\":\"assistant\",\"model\":\"{model}\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}],\"usage\":{{\"input_tokens\":3,\"output_tokens\":2}}}},\"uuid\":\"{uuid}\",\"timestamp\":\"{ts}\"}}\n",
        "x".repeat(600)
    )
}

fn stored_models(store: &Store, source: &str) -> Vec<String> {
    store
        .with(|c| {
            let mut st =
                c.prepare("SELECT data FROM events WHERE source=?1 AND kind='step' ORDER BY seq")?;
            let rows = st.query_map([source], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })
        .unwrap()
        .iter()
        .filter_map(|d| {
            serde_json::from_str::<serde_json::Value>(d)
                .ok()
                .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string))
        })
        .collect()
}

/// A real Claude Code adapter restored from an upgraded v6 store keeps producer history, stays silent on an
/// unchanged restart, stores an appended record exactly once, never duplicates a re-polled committed record,
/// and commits an aborted batch only on the exact retry.
#[tokio::test]
async fn v6_upgrade_feeds_a_real_claude_source_without_loss_or_duplication() {
    use agentglimd::adapters::claude_code;
    use agentglimd::core::bus::Bus;
    use agentglimd::core::{Cursor, RecordKey, Source};

    const SOURCE: &str = "claude-code";
    const REL: &str = "s1.jsonl";

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("v6-adapter.db");
    let home = dir.path().join("home");
    let root = home.join(".claude").join("projects").join("-work-demo");
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join(REL);
    std::fs::write(
        &file,
        claude_line("model-a", "u1", "2026-11-01T10:00:00.000Z"),
    )
    .unwrap();

    // A v6 store: one historical observation plus the legacy parser state (no content hash, `revision` NULL).
    {
        let mut c = Connection::open(&db_path).unwrap();
        run_up_to(&mut c, 6).unwrap();
        let key = RecordKey::offset(REL, 1, 0, 0).key();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data,session,dedup,occurred_ms,occurrence,producer) \
             VALUES (11,'step',?1,100,?2,'s1',NULL,1793520000000,NULL,?3)",
            rusqlite::params![
                SOURCE,
                serde_json::json!({"role": "assistant", "model": "model-a", "ts": "2026-11-01T10:00:00.000Z"})
                    .to_string(),
                key
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision) \
             VALUES (?1,?2,?3,?4,?5,'s1','model-a',1,1,?3,0,0,1,NULL)",
            rusqlite::params![
                SOURCE,
                REL,
                std::fs::metadata(&file).unwrap().len() as i64,
                mtime_ms(&file) as i64,
                hex_prefix(&file, 256)
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_offsets(source,path,offset,size) VALUES (?1,?2,?3,?3)",
            rusqlite::params![SOURCE, REL, std::fs::metadata(&file).unwrap().len() as i64],
        )
        .unwrap();
    }

    let store = Store::open(&db_path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();
    assert_eq!(
        store.load_generation(SOURCE, REL).unwrap(),
        1,
        "the v6 generation seeds the high-water"
    );
    assert_eq!(
        store.producers(SOURCE).unwrap().len(),
        1,
        "history preserved"
    );

    // Unchanged restart through the real adapter: nothing new, no error item.
    let src = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    src.restore_checkpoint(checkpoint_from_store(&store, SOURCE));
    let batch = src.poll(Cursor(1)).await.unwrap();
    assert!(
        batch.items.is_empty(),
        "an unchanged restart is silent: {:?}",
        batch.items
    );
    assert!(stored_models(&store, SOURCE) == vec!["model-a"]);

    // Append a supported record: exactly one new observation, committed once under a fresh producer key.
    let before_append_len = std::fs::metadata(&file).unwrap().len();
    let before_append_mtime = mtime_ms(&file);
    let before_append_fingerprint = hex_prefix(&file, 256);
    let appended_len = claude_line("model-b", "u2", "2026-11-01T10:00:05.000Z").len() as u64;
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&claude_line("model-b", "u2", "2026-11-01T10:00:05.000Z"));
    std::fs::write(&file, text).unwrap();
    let batch = src.poll(Cursor(1)).await.unwrap();
    assert_eq!(
        batch.items.len(),
        2,
        "one appended record = its Step and Spend items: {:?}",
        batch.items
    );
    let ids = src.identities();
    assert_eq!(ids.len(), batch.items.len(), "one producer identity each");
    let committed_ck = src.checkpoint();
    let evs = bus
        .commit(SOURCE, &batch.items, &committed_ck, &[], &[], &ids)
        .unwrap();
    assert_eq!(evs.len(), 2, "appended record committed");
    assert_eq!(
        store.load_generation(SOURCE, REL).unwrap(),
        1,
        "an append keeps the logical generation"
    );
    assert_eq!(
        store.producers(SOURCE).unwrap().len(),
        3,
        "history plus the appended Step and Spend identities"
    );
    assert_eq!(stored_models(&store, SOURCE), vec!["model-a", "model-b"]);

    // Restart on the committed checkpoint: the poller hands the adapter exactly what was committed. (Whether the
    // adapter then stays silent is its own content-witness contract, covered by the JSONL recovery task and the
    // independent oracle; this task asserts the core-visible restore fidelity.)
    let ck_committed = checkpoint_from_store(&store, SOURCE);
    assert_eq!(ck_committed.files.len(), 1);
    assert_eq!(ck_committed.files[0].path, REL);
    assert_eq!(
        ck_committed.files[0].offset,
        before_append_len + appended_len
    );
    assert_eq!(ck_committed.files[0].generation, 1);
    assert!(ck_committed.files[0].announced, "session already announced");
    // Re-poll from the *pre-append* checkpoint (crash before the checkpoint advanced): the same identities come
    // back and the commit deduplicates instead of duplicating.
    let stale = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    let mut old_ck = ck_committed.clone();
    for f in &mut old_ck.files {
        f.offset = before_append_len;
        f.size = before_append_len;
        f.mtime_ms = before_append_mtime;
        f.fingerprint = before_append_fingerprint.clone();
        f.revision = None;
    }
    stale.restore_checkpoint(old_ck.clone());
    let batch = stale.poll(Cursor(1)).await.unwrap();
    assert_eq!(batch.items.len(), 2, "the appended record is re-read");
    let ids = stale.identities();
    assert_eq!(
        ids[0],
        RecordKey::offset(REL, 1, old_ck.files[0].offset, 0),
        "the re-read record keeps its committed identity"
    );
    let evs = bus
        .commit(SOURCE, &batch.items, &stale.checkpoint(), &[], &[], &ids)
        .unwrap();
    assert!(
        evs.is_empty(),
        "re-polling a committed record duplicates nothing"
    );
    assert_eq!(stored_models(&store, SOURCE), vec!["model-a", "model-b"]);

    // Aborted commit: nothing durable, nothing published; the exact retry commits once.
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&claude_line("model-c", "u3", "2026-11-01T10:00:09.000Z"));
    std::fs::write(&file, text).unwrap();
    let src = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    src.restore_checkpoint(checkpoint_from_store(&store, SOURCE));
    let batch = src.poll(Cursor(1)).await.unwrap();
    assert_eq!(batch.items.len(), 2);
    let ids = src.identities();
    let ck = src.checkpoint();
    let mut rx = bus.subscribe();
    let seq_before = bus.last_seq();
    store
        .with(|c| {
            c.execute_batch(
                "CREATE TRIGGER abort_batch BEFORE INSERT ON source_file_state
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
        })
        .unwrap();
    assert!(bus
        .commit(SOURCE, &batch.items, &ck, &[], &[], &ids)
        .is_err());
    assert_eq!(stored_models(&store, SOURCE), vec!["model-a", "model-b"]);
    assert_eq!(bus.last_seq(), seq_before, "no seq consumed");
    assert!(rx.try_recv().is_err(), "nothing published");
    assert_eq!(store.load_generation(SOURCE, REL).unwrap(), 1);
    store
        .with(|c| c.execute_batch("DROP TRIGGER abort_batch;"))
        .unwrap();
    let evs = bus
        .commit(SOURCE, &batch.items, &ck, &[], &[], &ids)
        .unwrap();
    assert_eq!(evs.len(), 2, "the exact retry commits once");
    assert_eq!(
        stored_models(&store, SOURCE),
        vec!["model-a", "model-b", "model-c"]
    );
    let replay = bus
        .commit(SOURCE, &batch.items, &ck, &[], &[], &ids)
        .unwrap();
    assert!(replay.is_empty(), "a further replay inserts nothing");
}

// ------------------------------------- v4-r3: committed append boundary + same-size suffix edit

/// v4-r3 step 3 (core-recovery). On an upgraded v6 store, after one supported record has been appended and
/// committed:
///  1. a brand-new real adapter restored at that committed checkpoint is **silent** on unchanged content (no replay
///     of the historical records);
///  2. a second fully consumed single-record session file, discovered by a fresh adapter, is announced once;
///  3. a supported same-size edit after byte 256 on that file (same inode/length, changed content and mtime) yields
///     exactly **one** new Step observation (plus its Spend), committed once under a new logical generation, and
///     re-polling is silent again.
///
/// The historical-key, rollback and exact-retry assertions stay in
/// `v6_upgrade_feeds_a_real_claude_source_without_loss_or_duplication` above; this case adds the committed append
/// boundary and the suffix-edit oracle without weakening it.
#[tokio::test]
async fn v6_committed_append_boundary_is_silent_then_detects_a_same_size_suffix_edit() {
    use agentglimd::adapters::claude_code;
    use agentglimd::core::bus::Bus;
    use agentglimd::core::{Cursor, ItemKind, RecordKey, Source};

    const SOURCE: &str = "claude-code";
    const REL: &str = "s1.jsonl";

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("v6-append-boundary.db");
    let home = dir.path().join("home");
    let root = home.join(".claude").join("projects").join("-work-demo");
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join(REL);
    std::fs::write(
        &file,
        claude_line("model-a", "u1", "2026-11-01T10:00:00.000Z"),
    )
    .unwrap();

    // A v6 store: one historical observation plus the legacy parser state (no content witness, `revision` NULL).
    {
        let mut c = Connection::open(&db_path).unwrap();
        run_up_to(&mut c, 6).unwrap();
        let key = RecordKey::offset(REL, 1, 0, 0).key();
        c.execute(
            "INSERT INTO events(seq,kind,source,ts,data,session,dedup,occurred_ms,occurrence,producer) \
             VALUES (11,'step',?1,100,?2,'s1',NULL,1793520000000,NULL,?3)",
            rusqlite::params![
                SOURCE,
                serde_json::json!({"role": "assistant", "model": "model-a", "ts": "2026-11-01T10:00:00.000Z"})
                    .to_string(),
                key
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_file_state(source,path,size,mtime_ms,fingerprint,session,model,updated,generation,offset,discarded_bytes,incomplete,announced,revision) \
             VALUES (?1,?2,?3,?4,?5,'s1','model-a',1,1,?3,0,0,1,NULL)",
            rusqlite::params![
                SOURCE,
                REL,
                std::fs::metadata(&file).unwrap().len() as i64,
                mtime_ms(&file) as i64,
                hex_prefix(&file, 256)
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO source_offsets(source,path,offset,size) VALUES (?1,?2,?3,?3)",
            rusqlite::params![SOURCE, REL, std::fs::metadata(&file).unwrap().len() as i64],
        )
        .unwrap();
    }
    let store = Store::open(&db_path).unwrap();
    let bus = Bus::new(store.clone()).unwrap();

    // Append one supported record to the v6-committed state and commit it exactly once.
    let src = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    src.restore_checkpoint(checkpoint_from_store(&store, SOURCE));
    let batch = src.poll(Cursor(1)).await.unwrap();
    assert!(
        batch.items.is_empty(),
        "the legacy v6 checkpoint is silent on unchanged content: {:?}",
        batch.items
    );
    let appended = claude_line("model-b", "u2", "2026-11-01T10:00:05.000Z");
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&appended);
    std::fs::write(&file, text).unwrap();
    let batch = src.poll(Cursor(1)).await.unwrap();
    assert_eq!(batch.items.len(), 2, "Step + Spend for the appended record");
    let ids = src.identities();
    let evs = bus
        .commit(SOURCE, &batch.items, &src.checkpoint(), &[], &[], &ids)
        .unwrap();
    assert_eq!(evs.len(), 2, "the appended record is committed once");
    assert_eq!(stored_models(&store, SOURCE), vec!["model-a", "model-b"]);

    // 1. A brand-new real adapter restored at the committed append boundary: unchanged content is silent.
    let fresh = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    fresh.restore_checkpoint(checkpoint_from_store(&store, SOURCE));
    let batch = fresh.poll(Cursor(1)).await.unwrap();
    assert!(
        batch.items.is_empty(),
        "an unchanged restart at the committed append boundary must be silent, got: {:?}",
        batch.items
    );
    assert_eq!(
        stored_models(&store, SOURCE),
        vec!["model-a", "model-b"],
        "the silent restart stored nothing"
    );

    // 2. A fully consumed single-record session file, found by another fresh adapter's first sweep.
    let file2 = root.join("s2.jsonl");
    std::fs::write(
        &file2,
        claude_line("model-s", "u4", "2026-11-01T10:00:12.000Z"),
    )
    .unwrap();
    let fresh2 = claude_code::ClaudeCode::new(Some(root.clone()), &home, 30);
    fresh2.restore_checkpoint(checkpoint_from_store(&store, SOURCE));
    let batch = fresh2.poll(Cursor(1)).await.unwrap();
    let announced_steps: Vec<&str> = batch
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Step)
        .filter_map(|i| i.data.get("model").and_then(|m| m.as_str()))
        .collect();
    assert_eq!(
        announced_steps,
        vec!["model-s"],
        "the new session file is announced exactly once, with no replay of the committed file: {:?}",
        batch.items
    );
    let ids = fresh2.identities();
    let evs = bus
        .commit(SOURCE, &batch.items, &fresh2.checkpoint(), &[], &[], &ids)
        .unwrap();
    assert_eq!(evs.len(), batch.items.len());
    assert_eq!(
        stored_models(&store, SOURCE),
        vec!["model-a", "model-b", "model-s"]
    );
    let producers_before_edit = store.producers(SOURCE).unwrap().len();
    let batch = fresh2.poll(Cursor(1)).await.unwrap();
    assert!(
        batch.items.is_empty(),
        "both committed files are silent on the next poll: {:?}",
        batch.items
    );

    // 3. Supported same-size suffix edit after byte 256: exactly one new Step observation, stored once.
    let size_before = std::fs::metadata(&file2).unwrap().len();
    let stored_mtime = store
        .load_file_state(SOURCE)
        .unwrap()
        .into_iter()
        .find(|st| st.path == "s2.jsonl")
        .expect("the s2 checkpoint is committed")
        .mtime_ms;
    let before = std::fs::read_to_string(&file2).unwrap();
    let edited = before.replacen("\"model\":\"model-s\"", "\"model\":\"model-t\"", 1);
    assert_eq!(edited.len(), before.len(), "the edit keeps the file size");
    assert_ne!(edited, before, "the edit really changed the record");
    std::fs::write(&file2, &edited).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&file2)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(stored_mtime + 1000))
        .unwrap();
    assert_eq!(
        std::fs::metadata(&file2).unwrap().len(),
        size_before,
        "same-size edit: inode and length unchanged"
    );

    let batch = fresh2.poll(Cursor(1)).await.unwrap();
    let steps: Vec<&str> = batch
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Step)
        .filter_map(|i| i.data.get("model").and_then(|m| m.as_str()))
        .collect();
    let spends = batch
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Spend)
        .count();
    assert_eq!(
        steps,
        vec!["model-t"],
        "the same-size suffix edit yields exactly one new Step observation: {:?}",
        batch.items
    );
    assert_eq!(spends, 1, "and exactly its one Spend observation");
    assert!(
        !batch.items.iter().any(|i| i.kind == ItemKind::Error),
        "a supported edit is not an error item: {:?}",
        batch.items
    );
    let ids = fresh2.identities();
    assert_eq!(ids.len(), batch.items.len(), "one identity per item");
    let evs = bus
        .commit(SOURCE, &batch.items, &fresh2.checkpoint(), &[], &[], &ids)
        .unwrap();
    assert_eq!(evs.len(), batch.items.len(), "the edit is committed once");
    assert_eq!(
        stored_models(&store, SOURCE),
        vec!["model-a", "model-b", "model-s", "model-t"],
        "the edited record reached SQLite without replaying the other file"
    );
    assert_eq!(
        store.producers(SOURCE).unwrap().len(),
        producers_before_edit + ids.len(),
        "the edit used new producer identities"
    );
    assert!(
        store.load_generation(SOURCE, "s2.jsonl").unwrap() >= 2,
        "a proven replacement advances the edited file's logical generation"
    );
    let batch = fresh2.poll(Cursor(1)).await.unwrap();
    assert!(
        batch.items.is_empty(),
        "re-polling the committed edit is silent: {:?}",
        batch.items
    );
}
