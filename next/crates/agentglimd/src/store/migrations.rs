//! Numbered migrations; each runs in its own transaction and is recorded in `schema_migrations`.

use rusqlite::{params, Connection};

pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", include_str!("../../migrations/0001_init.sql")),
    (
        2,
        "task_detail_event_ts",
        include_str!("../../migrations/0002_task_detail_event_ts.sql"),
    ),
    (
        3,
        "source_offsets",
        include_str!("../../migrations/0003_source_offsets.sql"),
    ),
    (
        4,
        "occurrence_time_and_identity",
        include_str!("../../migrations/0004_occurrence_time_and_identity.sql"),
    ),
    (
        5,
        "checkpoint_state",
        include_str!("../../migrations/0005_checkpoint_state.sql"),
    ),
    (
        6,
        "producer_identity",
        include_str!("../../migrations/0006_producer_identity.sql"),
    ),
    (
        7,
        "logical_generations",
        include_str!("../../migrations/0007_logical_generations.sql"),
    ),
];

pub fn latest() -> i64 {
    MIGRATIONS.last().map(|m| m.0).unwrap_or(0)
}

/// Applies every pending migration.
pub fn run(conn: &mut Connection) -> rusqlite::Result<Vec<i64>> {
    run_up_to(conn, latest())
}

/// Applies pending migrations up to and including `target`; returns the versions applied now.
pub fn run_up_to(conn: &mut Connection, target: i64) -> rusqlite::Result<Vec<i64>> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied INTEGER NOT NULL)",
    )?;
    let done = applied(conn)?;
    let mut now = Vec::new();
    for (v, name, sql) in MIGRATIONS.iter().filter(|m| m.0 <= target) {
        if done.contains(v) {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations(version,name,applied) VALUES (?1,?2,?3)",
            params![v, name, crate::core::now_ms() as i64],
        )?;
        tx.commit()?;
        now.push(*v);
    }
    Ok(now)
}

pub fn applied(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let mut st = conn.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let rows = st.query_map([], |r| r.get(0))?;
    rows.collect()
}
