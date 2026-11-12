//! Daemon-owned tasks with the duplicate-task lock: a task id runs at most once, ever.

use super::bus::Bus;
use super::now_ms;
use crate::store::{Store, StoreError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::AbortHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskRow {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub created: u64,
    pub updated: u64,
    pub detail: String,
}

/// Task kinds the daemon runs. `sleep` exists for lifecycle tests and status refresh simulation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskKind {
    Noop,
    /// Sleeps; on a shutdown cancel signal it stops at once and is marked `interrupted`.
    Sleep(u64),
    /// Internal (not exposed by the API): ignores the cancel signal and finishes after `ms`, like a task that must
    /// complete its current step. Used to test the shutdown grace period.
    Settle(u64),
    /// Triggers one immediate pass of the poll loop (sources discovery, tail and runtime probes).
    StatusRefresh,
}

/// Grace given to running tasks after the shutdown cancel signal (PLAN 6 row 2; total exit stays < 10 s).
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(7);

struct Running {
    abort: AbortHandle,
    cancel: watch::Sender<bool>,
}

#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    #[error("task {0} already exists")]
    Duplicate(String),
    #[error("task {0} not found")]
    NotFound(String),
    #[error("daemon is draining and accepts no new tasks")]
    Draining,
    #[error("invalid task: {0}")]
    Invalid(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

pub struct TaskRunner {
    store: Store,
    bus: Arc<Bus>,
    running: Mutex<HashMap<String, Running>>,
    accepting: AtomicBool,
    refresh: watch::Sender<u64>,
}

pub fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl TaskRunner {
    pub fn new(store: Store, bus: Arc<Bus>) -> Arc<Self> {
        Arc::new(Self {
            store,
            bus,
            running: Mutex::new(HashMap::new()),
            accepting: AtomicBool::new(true),
            refresh: watch::channel(0).0,
        })
    }

    /// Receiver the poller waits on; each `status-refresh` task bumps it.
    pub fn refresh_rx(&self) -> watch::Receiver<u64> {
        self.refresh.subscribe()
    }

    /// After a restart, tasks left running are marked `interrupted` and never re-run.
    pub fn recover(&self) -> Result<usize, StoreError> {
        self.store.mark_tasks(&["queued", "running"], "interrupted")
    }

    pub fn submit(self: &Arc<Self>, id: &str, kind: TaskKind) -> Result<TaskRow, TaskError> {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(TaskError::Draining);
        }
        if !valid_task_id(id) {
            return Err(TaskError::Invalid(
                "id must be 1-64 chars of [A-Za-z0-9._-]".into(),
            ));
        }
        let kind_name = match kind {
            TaskKind::Noop => "noop",
            TaskKind::Sleep(_) => "sleep",
            TaskKind::Settle(_) => "settle",
            TaskKind::StatusRefresh => "status-refresh",
        };
        let now = now_ms();
        if !self.store.insert_task(id, kind_name, "running", now)? {
            return Err(TaskError::Duplicate(id.to_string()));
        }
        let _ = self.bus.publish(
            "task",
            "daemon",
            serde_json::json!({"id": id, "state": "running"}),
        );
        let me = Arc::clone(self);
        let tid = id.to_string();
        let (cancel, mut rx) = watch::channel(false);
        let mut running = self.running.lock().expect("tasks lock");
        let handle = tokio::spawn(async move {
            let state = match kind {
                TaskKind::Noop => "done",
                TaskKind::StatusRefresh => {
                    me.refresh.send_modify(|n| *n += 1);
                    "done"
                }
                TaskKind::Sleep(ms) => tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => "done",
                    _ = rx.wait_for(|c| *c) => "interrupted",
                },
                TaskKind::Settle(ms) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    "done"
                }
            };
            me.finish(&tid, state);
        });
        running.insert(
            id.to_string(),
            Running {
                abort: handle.abort_handle(),
                cancel,
            },
        );
        drop(running);
        Ok(self.get(id)?.expect("task just inserted"))
    }

    fn finish(&self, id: &str, state: &str) {
        self.running.lock().expect("tasks lock").remove(id);
        if self
            .store
            .set_task_state_if(id, "running", state)
            .unwrap_or(false)
        {
            let _ = self.bus.publish(
                "task",
                "daemon",
                serde_json::json!({"id": id, "state": state}),
            );
        }
    }

    pub fn cancel(&self, id: &str) -> Result<TaskRow, TaskError> {
        let row = self
            .get(id)?
            .ok_or_else(|| TaskError::NotFound(id.to_string()))?;
        if let Some(h) = self.running.lock().expect("tasks lock").remove(id) {
            h.abort.abort();
        }
        if row.state == "running" {
            self.finish(id, "cancelled");
        }
        Ok(self.get(id)?.expect("task exists"))
    }

    pub fn get(&self, id: &str) -> Result<Option<TaskRow>, StoreError> {
        self.store.get_task(id)
    }

    pub fn list(&self) -> Result<Vec<TaskRow>, StoreError> {
        self.store.list_tasks()
    }

    pub fn running_count(&self) -> usize {
        self.running.lock().expect("tasks lock").len()
    }

    /// Graceful stop: refuse new tasks, send running ones a cancel signal, wait up to `grace` for them to end, then
    /// abort the rest. Tasks that end within the grace keep their own end state; the rest become `interrupted`.
    /// Returns how many of the tasks running at shutdown ended `interrupted`.
    pub async fn shutdown(&self, grace: Duration) -> usize {
        self.accepting.store(false, Ordering::SeqCst);
        let ids: Vec<String> = {
            let running = self.running.lock().expect("tasks lock");
            for r in running.values() {
                let _ = r.cancel.send(true);
            }
            running.keys().cloned().collect()
        };
        let deadline = tokio::time::Instant::now() + grace;
        while self.running_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        for (_, r) in self.running.lock().expect("tasks lock").drain() {
            r.abort.abort();
        }
        let _ = self.store.mark_tasks(&["queued", "running"], "interrupted");
        ids.iter()
            .filter(|id| {
                self.get(id)
                    .ok()
                    .flatten()
                    .is_some_and(|t| t.state == "interrupted")
            })
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> Arc<TaskRunner> {
        let store = Store::open_in_memory().unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        TaskRunner::new(store, bus)
    }

    #[tokio::test]
    async fn duplicate_id_is_refused_even_after_done() {
        let r = runner();
        r.submit("t1", TaskKind::Noop).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(r.get("t1").unwrap().unwrap().state, "done");
        assert!(matches!(
            r.submit("t1", TaskKind::Noop),
            Err(TaskError::Duplicate(_))
        ));
        assert!(matches!(
            r.submit("bad id", TaskKind::Noop),
            Err(TaskError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn cancel_and_shutdown() {
        let r = runner();
        r.submit("a", TaskKind::Sleep(60_000)).unwrap();
        r.submit("b", TaskKind::Sleep(60_000)).unwrap();
        assert_eq!(r.cancel("a").unwrap().state, "cancelled");
        assert!(matches!(r.cancel("zzz"), Err(TaskError::NotFound(_))));
        assert_eq!(r.shutdown(Duration::from_secs(2)).await, 1);
        assert_eq!(r.get("b").unwrap().unwrap().state, "interrupted");
        assert!(matches!(
            r.submit("c", TaskKind::Noop),
            Err(TaskError::Draining)
        ));
    }

    #[tokio::test]
    async fn shutdown_grace_lets_finishing_tasks_keep_their_state() {
        let r = runner();
        r.submit("quick", TaskKind::Settle(200)).unwrap();
        r.submit("stuck", TaskKind::Settle(60_000)).unwrap();
        r.submit("sleepy", TaskKind::Sleep(60_000)).unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(r.shutdown(Duration::from_millis(600)).await, 2);
        assert!(t0.elapsed() < Duration::from_secs(2));
        assert_eq!(r.get("quick").unwrap().unwrap().state, "done");
        assert_eq!(r.get("stuck").unwrap().unwrap().state, "interrupted");
        assert_eq!(r.get("sleepy").unwrap().unwrap().state, "interrupted");
    }
}
