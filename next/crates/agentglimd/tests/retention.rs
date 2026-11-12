//! Retention: events older than `retention_days` are pruned; recent ones and the newest seq stay.

use agentglimd::core::{now_ms, Event};
use agentglimd::store::Store;

fn ev(seq: u64, ts: u64) -> Event {
    Event {
        seq,
        kind: "test".into(),
        source: "daemon".into(),
        ts,
        data: serde_json::json!({}),
    }
}

#[test]
fn prune_removes_old_events_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("state.db")).unwrap();
    let day = 86_400_000;
    let now = now_ms();
    store.insert_event(&ev(1, now - 40 * day)).unwrap();
    store.insert_event(&ev(2, now - 31 * day)).unwrap();
    store.insert_event(&ev(3, now - 2 * day)).unwrap();
    store.insert_event(&ev(4, now)).unwrap();
    assert_eq!(store.prune_events(30).unwrap(), 2);
    assert_eq!(store.event_count().unwrap(), 2);
    assert_eq!(store.max_seq().unwrap(), 4);
    assert_eq!(store.prune_events(30).unwrap(), 0);
}

#[test]
fn prune_keeps_newest_event_so_seq_stays_monotonic() {
    let store = Store::open_in_memory().unwrap();
    let old = now_ms() - 100 * 86_400_000;
    store.insert_event(&ev(7, old)).unwrap();
    store.insert_event(&ev(8, old)).unwrap();
    assert_eq!(store.prune_events(1).unwrap(), 1);
    assert_eq!(store.max_seq().unwrap(), 8);
}
