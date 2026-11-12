//! Daemon lock file holding `"<pid> <start_time> <nonce>"`. A lock whose pid is dead, or whose pid now belongs to a
//! process with a different start time (pid reuse), is stale and reclaimed; a live one refuses start.
//! Acquire is atomic: `create_new` when absent; a stale lock is replaced (temp file + rename) only while holding a
//! `daemon.lock.guard` file created with `create_new`, so exactly one of several racing starters wins.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("another agentglimd (pid {0}) holds the lock")]
    Held(u32),
    #[error("no daemon.lock in the data dir")]
    NoLock,
    #[error("daemon.lock is malformed: {0}")]
    Malformed(String),
    #[error("daemon.lock names pid {0} and that process is not running")]
    Stale(u32),
    #[error(
        "daemon.lock names pid {0} with start time {1}, but that pid now started at {2}: the pid was reused"
    )]
    Mismatch(u32, u64, u64),
    #[error("cannot verify the lock owner: {0}")]
    Unverifiable(String),
    #[error("lock io: {0}")]
    Io(#[from] std::io::Error),
}

/// What `daemon.lock` says about its owner. `start_time: None` means the file predates start-time recording (or is
/// truncated), which [`verify_owner`] refuses rather than trusting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockIdentity {
    pub pid: u32,
    pub start_time: Option<u64>,
}

#[derive(Debug)]
pub struct DaemonLock {
    path: PathBuf,
    content: String,
    /// True when a stale lock from a crashed daemon was taken over.
    pub reclaimed: bool,
}

/// A guard file older than this is left over from a crash mid-reclaim and is removed.
const GUARD_STALE: Duration = Duration::from_secs(5);

/// Parsed lock content: pid and optional start time (old pid-only files have none).
fn parse(text: &str) -> Option<(u32, Option<u64>)> {
    let mut it = text.split_whitespace();
    let pid = it.next()?.parse().ok()?;
    let start = it.next().and_then(|s| s.parse().ok());
    Some((pid, start))
}

/// Strict parse for the identity checks: anything unreadable is a distinct error, never a silent `None`.
fn parse_lock(text: &str) -> Result<LockIdentity, LockError> {
    let mut it = text.split_whitespace();
    let pid: u32 = match it.next() {
        Some(tok) => tok
            .parse()
            .map_err(|_| LockError::Malformed("pid is not a number".into()))?,
        None => return Err(LockError::Malformed("empty file".into())),
    };
    if pid == 0 {
        return Err(LockError::Malformed("pid 0 is never a process".into()));
    }
    let start_time = match it.next() {
        Some(tok) => Some(
            tok.parse()
                .map_err(|_| LockError::Malformed("start time is not a number".into()))?,
        ),
        None => None,
    };
    Ok(LockIdentity { pid, start_time })
}

/// Live holder: pid alive and (when recorded and known) the same process start time.
/// Fail closed: a live pid whose start time cannot be read or recorded is a *live* holder here, never a stale one,
/// so `acquire` can never start a second daemon over an unverifiable lock.
fn holder_live(text: &str) -> Option<u32> {
    let (pid, start) = parse(text)?;
    if !pid_alive(pid) {
        return None;
    }
    match (start, start_time(pid)) {
        (Some(want), Some(have)) if want != 0 && have != 0 && want != have => None,
        _ => Some(pid),
    }
}

/// Reads `daemon.lock` and reports what it claims. Missing and malformed files are separate errors.
pub fn inspect(dir: &Path) -> Result<LockIdentity, LockError> {
    let path = dir.join("daemon.lock");
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(LockError::NoLock),
        Err(e) => return Err(LockError::Io(e)),
    };
    parse_lock(&text)
}

/// Re-reads the lock and proves the recorded process is still that exact process: the pid is alive, the lock
/// recorded a non-zero start time, and the pid's current start time equals it. Every other outcome is a refusal. Call
/// this immediately before signalling anything; there is no pid-only fallback.
pub fn verify_owner(dir: &Path) -> Result<LockIdentity, LockError> {
    let id = inspect(dir)?;
    if !pid_alive(id.pid) {
        return Err(LockError::Stale(id.pid));
    }
    let recorded = match id.start_time {
        Some(s) if s != 0 => s,
        _ => {
            return Err(LockError::Unverifiable(format!(
                "daemon.lock for pid {} records no start time",
                id.pid
            )))
        }
    };
    if !platform_identity_supported() {
        return Err(LockError::Unverifiable(
            "this platform cannot report a process start time".into(),
        ));
    }
    match start_time(id.pid) {
        None => Err(LockError::Unverifiable(format!(
            "start time of pid {} is not readable",
            id.pid
        ))),
        Some(have) if have != recorded => Err(LockError::Mismatch(id.pid, recorded, have)),
        Some(_) => Ok(id),
    }
}

impl DaemonLock {
    pub fn acquire(dir: &Path) -> Result<Self, LockError> {
        let path = dir.join("daemon.lock");
        let pid = std::process::id();
        let content = format!(
            "{pid} {} {:016x}\n",
            start_time(pid).unwrap_or(0),
            rand::random::<u64>()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    f.write_all(content.as_bytes())?;
                    f.sync_all()?;
                    return Ok(Self {
                        path,
                        content,
                        reclaimed: false,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            let text = fs::read_to_string(&path).unwrap_or_default();
            if let Some(holder) = holder_live(&text) {
                return Err(LockError::Held(holder));
            }
            // Empty and fresh: another starter is between create_new and write; wait for it.
            let fresh = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .is_none_or(|age| age < Duration::from_secs(2));
            if parse(&text).is_none() && fresh && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            // Stale: reclaim under the guard.
            if let Some(guard) = Guard::take(dir)? {
                let now = fs::read_to_string(&path).unwrap_or_default();
                if let Some(holder) = holder_live(&now) {
                    drop(guard);
                    return Err(LockError::Held(holder));
                }
                let tmp = dir.join(format!("daemon.lock.{pid}.{:x}.tmp", rand::random::<u32>()));
                fs::write(&tmp, &content)?;
                fs::rename(&tmp, &path)?;
                drop(guard);
                if fs::read_to_string(&path).ok().as_deref() == Some(content.as_str()) {
                    return Ok(Self {
                        path,
                        content,
                        reclaimed: true,
                    });
                }
            }
            if Instant::now() > deadline {
                let text = fs::read_to_string(&path).unwrap_or_default();
                return Err(LockError::Held(parse(&text).map(|p| p.0).unwrap_or(0)));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn read_pid(dir: &Path) -> Option<u32> {
        parse(&fs::read_to_string(dir.join("daemon.lock")).ok()?).map(|p| p.0)
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path).ok().as_deref() == Some(self.content.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Short-lived mutual exclusion for the reclaim step.
struct Guard(PathBuf);

impl Guard {
    fn take(dir: &Path) -> std::io::Result<Option<Guard>> {
        let p = dir.join("daemon.lock.guard");
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => Ok(Some(Guard(p))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let old = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| SystemTime::now().duration_since(m).ok())
                    .is_some_and(|age| age > GUARD_STALE);
                if old {
                    let _ = fs::remove_file(&p);
                }
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Whether this platform can establish process identity at all. One gate for the whole crate: where start time is
/// unknown, identity is unverifiable and every caller refuses.
/// Windows (sub-item 05) gets it from `OpenProcess` + `GetProcessTimes` (creation time); macOS would need
/// `sysctl(KERN_PROC_PID)` / `proc_pidinfo(PROC_PIDTBSDINFO)`. Until then only Linux can verify.
#[cfg(target_os = "linux")]
pub fn platform_identity_supported() -> bool {
    true
}

#[cfg(not(target_os = "linux"))]
pub fn platform_identity_supported() -> bool {
    false
}

/// Process start time in clock ticks since boot (`/proc/<pid>/stat` field 22); None if unknown.
#[cfg(target_os = "linux")]
pub fn start_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = stat.rsplit_once(')')?;
    // `rest` starts at field 3 (state), so field 22 is index 19.
    rest.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(not(target_os = "linux"))]
pub fn start_time(_pid: u32) -> Option<u64> {
    None
}

/// True if a process with this pid exists and is not a zombie.
#[cfg(target_os = "linux")]
pub fn pid_alive(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            // Field 3 (after the ")" that ends the command name) is the state.
            let state = stat
                .rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().next());
            !matches!(state, Some("Z") | Some("X"))
        }
        Err(_) => false,
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    /// A pid that cannot exist (above the default Linux pid_max).
    const DEAD_PID: u32 = 4_194_399;

    fn write_lock(dir: &Path, text: impl AsRef<[u8]>) {
        fs::write(dir.join("daemon.lock"), text).unwrap();
    }

    #[test]
    fn inspect_parses_pid_and_start_time() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(inspect(dir.path()), Err(LockError::NoLock)));
        write_lock(dir.path(), "1234 98765 abcdef\n");
        assert_eq!(
            inspect(dir.path()).unwrap(),
            LockIdentity {
                pid: 1234,
                start_time: Some(98765)
            }
        );
        // An old pid-only lock parses, but with no start time: verify_owner refuses it later.
        write_lock(dir.path(), "1234\n");
        assert_eq!(
            inspect(dir.path()).unwrap(),
            LockIdentity {
                pid: 1234,
                start_time: None
            }
        );
    }

    #[test]
    fn malformed_locks_are_errors_not_none() {
        let dir = tempfile::tempdir().unwrap();
        for text in ["", "   \n", "garbage\n", "0 5 ab\n", "12 notatime ab\n"] {
            write_lock(dir.path(), text);
            assert!(
                matches!(inspect(dir.path()), Err(LockError::Malformed(_))),
                "{text:?} must be Malformed"
            );
        }
    }

    #[test]
    fn verify_refuses_missing_malformed_and_stale() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(verify_owner(dir.path()), Err(LockError::NoLock)));
        write_lock(dir.path(), "nope\n");
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Malformed(_))
        ));
        write_lock(dir.path(), format!("{DEAD_PID} 12345 ab\n").as_str());
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Stale(p)) if p == DEAD_PID
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn verify_refuses_unverifiable_and_mismatched() {
        let dir = tempfile::tempdir().unwrap();
        let real = start_time(1).unwrap();
        // Live pid, but the lock records no start time: unverifiable, not trusted.
        write_lock(dir.path(), "1\n");
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Unverifiable(_))
        ));
        // A recorded 0 is "unknown", never "matches everything".
        write_lock(dir.path(), "1 0 ab\n");
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Unverifiable(_))
        ));
        // Pid reuse: the recorded start time no longer matches the live process.
        write_lock(dir.path(), format!("1 {} ab\n", real + 1).as_str());
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Mismatch(1, want, have)) if want == real + 1 && have == real
        ));
        // Matching identity verifies.
        write_lock(dir.path(), format!("1 {real} ab\n").as_str());
        assert_eq!(
            verify_owner(dir.path()).unwrap(),
            LockIdentity {
                pid: 1,
                start_time: Some(real)
            }
        );
    }

    /// Where identity cannot be established the answer is always a refusal, never a pid-only success.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn verify_refuses_when_platform_identity_is_unknown() {
        assert!(!platform_identity_supported());
        let dir = tempfile::tempdir().unwrap();
        write_lock(dir.path(), format!("{} 12345 ab\n", std::process::id()));
        assert!(matches!(
            verify_owner(dir.path()),
            Err(LockError::Unverifiable(_))
        ));
    }

    #[test]
    fn unverifiable_live_holder_is_not_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        // pid 1 with no recorded start time: live but unverifiable, so acquire must refuse rather than reclaim.
        write_lock(dir.path(), "1\n");
        assert!(matches!(
            DaemonLock::acquire(dir.path()),
            Err(LockError::Held(1))
        ));
        write_lock(dir.path(), "1 0 ab\n");
        assert!(matches!(
            DaemonLock::acquire(dir.path()),
            Err(LockError::Held(1))
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("daemon.lock")).unwrap(),
            "1 0 ab\n",
            "the unverifiable holder's lock is left untouched"
        );
    }

    #[test]
    fn stale_lock_is_reclaimed_and_live_lock_refuses() {
        let dir = tempfile::tempdir().unwrap();
        // A pid that cannot exist on Linux (above pid_max default).
        fs::write(dir.path().join("daemon.lock"), "4194399\n").unwrap();
        let lock = DaemonLock::acquire(dir.path()).unwrap();
        assert!(lock.reclaimed);
        assert_eq!(DaemonLock::read_pid(dir.path()), Some(std::process::id()));
        drop(lock);
        assert!(!dir.path().join("daemon.lock").exists());

        // pid 1 with its real start time (or pid-only) is alive on any Linux box.
        let st = start_time(1).unwrap_or(0);
        fs::write(dir.path().join("daemon.lock"), format!("1 {st} ab\n")).unwrap();
        assert!(matches!(
            DaemonLock::acquire(dir.path()),
            Err(LockError::Held(1))
        ));
        fs::write(dir.path().join("daemon.lock"), "1\n").unwrap();
        assert!(matches!(
            DaemonLock::acquire(dir.path()),
            Err(LockError::Held(1))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pid_reuse_with_wrong_start_time_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let wrong = start_time(1).unwrap() + 12345;
        fs::write(dir.path().join("daemon.lock"), format!("1 {wrong} ab\n")).unwrap();
        let lock = DaemonLock::acquire(dir.path()).unwrap();
        assert!(lock.reclaimed);
        assert_eq!(DaemonLock::read_pid(dir.path()), Some(std::process::id()));
    }

    #[test]
    fn concurrent_acquire_on_stale_lock_has_one_winner() {
        for _ in 0..20 {
            let dir = Arc::new(tempfile::tempdir().unwrap());
            fs::write(dir.path().join("daemon.lock"), "4194399 7 ab\n").unwrap();
            let n = 8;
            let barrier = Arc::new(Barrier::new(n));
            let handles: Vec<_> = (0..n)
                .map(|_| {
                    let (dir, barrier) = (dir.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        DaemonLock::acquire(dir.path()).ok()
                    })
                })
                .collect();
            let locks: Vec<DaemonLock> = handles
                .into_iter()
                .filter_map(|h| h.join().unwrap())
                .collect();
            assert_eq!(locks.len(), 1, "exactly one acquirer must win");
            assert!(locks[0].reclaimed);
            assert!(!dir.path().join("daemon.lock.guard").exists());
        }
    }
}
