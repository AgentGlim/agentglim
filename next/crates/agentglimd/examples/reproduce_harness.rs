use agentglimd::adapters::plans_harness;
use agentglimd::core::bus::Bus;
use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
use agentglimd::core::{Env, Source};
use agentglimd::store::Store;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::sync::watch;

const SOURCE: &str = plans_harness::ID;

fn plans_root(home: &Path) -> PathBuf {
    home.join("projects/dev/plans")
}

struct Home {
    _t: TempDir,
    home: PathBuf,
}

impl Home {
    fn new() -> Home {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        fs::create_dir_all(plans_root(&home)).unwrap();
        Home { _t: t, home }
    }

    fn add_plan_round(&self, plan: &str, round: &str, workers: &[&str]) {
        let rdir = plans_root(&self.home).join(plan).join("_build").join(round);
        fs::create_dir_all(rdir.join("workers")).unwrap();
        fs::write(rdir.join("BUILD-LOG.md"), "log\n").unwrap();
        for w in workers {
            let d = rdir.join("workers").join(w);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("DONE"), "").unwrap();
        }
    }

    fn remove_round(&self, plan: &str, round: &str) {
        let rdir = plans_root(&self.home).join(plan).join("_build").join(round);
        if rdir.exists() {
            fs::remove_dir_all(rdir).unwrap();
        }
    }

    fn source(&self) -> Arc<dyn Source> {
        println!("Creating source for home: {:?}", self.home);
        Arc::new(plans_harness::PlansHarness::new(None, &self.home, 30))
    }

    fn env(&self) -> Env {
        Env {
            home: self.home.clone(),
            vars: Default::default(),
        }
    }
}

struct Run {
    _t: TempDir,
    data: PathBuf,
    store: Store,
    stop: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Run {
    fn start(home: &Home) -> Run {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data.join("state.db")).unwrap();
        let bus = Arc::new(Bus::new(store.clone()).unwrap());
        let src = home.source();
        let (_tx, refresh) = watch::channel(0u64);
        let (stop, stop_rx) = watch::channel(false);
        let deps = PollerDeps {
            store: store.clone(),
            bus,
            sources: Arc::new(vec![src]),
            runtimes: Arc::new(Vec::new()),
            status: Arc::new(StatusCache::new()),
            env: home.env(),
            intervals: Intervals {
                poll: Duration::from_millis(10),
                discover: Duration::from_millis(10),
            },
            refresh,
        };
        let handle = spawn_poller(deps, stop_rx);
        Run {
            _t: t,
            data,
            store,
            stop,
            handle,
        }
    }

    async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.handle).await;
    }

    fn db(&self) -> Connection {
        Connection::open(self.data.join("state.db")).unwrap()
    }
}

#[tokio::main]
async fn main() {
    let h = Home::new();
    h.add_plan_round("p1", "r1", &["w1", "w2"]);
    h.add_plan_round("p2", "r1", &["w1", "w2"]);

    let run = Run::start(&h);

    let t0 = Instant::now();
    loop {
        let c = run.db();
        let evs: Vec<(String, String)> = c
            .prepare("SELECT kind, session FROM events WHERE source = ?1")
            .unwrap()
            .query_map(params![SOURCE], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        if !evs.is_empty() {
            println!("Current events: {:?}", evs);
        }
        let count = evs.iter().filter(|(k, _)| k == "child").count();
        if count >= 4 {
            break;
        }
        if t0.elapsed() > Duration::from_secs(20) {
            panic!("Timed out waiting for 4 children, got {}", count);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("Step 1: Observed 4 children.");

    h.remove_round("p1", "r1");
    println!("Step 2: Removed p1/r1.");
    tokio::time::sleep(Duration::from_secs(2)).await;

    h.add_plan_round("p1", "r1", &["w1", "w2"]);
    println!("Step 3: Restored p1/r1.");

    let t0 = Instant::now();
    let mut max_count = 4;
    loop {
        let c = run.db();
        let count: u32 = c
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind='child' AND source=?1",
                params![SOURCE],
                |r| r.get(0),
            )
            .unwrap();
        if count > max_count {
            max_count = count;
            println!("Child count increased to {}", count);
        }
        if t0.elapsed() > Duration::from_secs(10) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    println!("Final child count: {}", max_count);
    if max_count > 4 {
        println!(
            "REPRODUCTION SUCCESSFUL: Found {} children (expected 4).",
            max_count
        );
    } else {
        println!("REPRODUCTION FAILED: Found only {} children.", max_count);
    }

    let stored_events = run.store.event_count().unwrap();
    let stored_sessions = run.store.session_count(SOURCE).unwrap();
    let max_seq = run.store.max_seq().unwrap();
    println!(
        "Stored via Run.store: source={} events={} sessions={} max_seq={}",
        SOURCE, stored_events, stored_sessions, max_seq
    );

    run.stop().await;
}
