//! Independent physical-work probe for real JSONL adapter discovery + polling (v4-r2, G04).
//!
//! Method (BUILD-V4 §3 "Physical-work receipts"; r1 audit B6 corrections):
//!  * `/proc/self/io` `rchar` is measured around ONE real adapter call in this single process. `rchar` counts
//!    bytes returned by read-family syscalls (including page-cache hits); `read_bytes` (storage level) is
//!    reported separately because the page cache hides repeated reads.
//!  * A no-op control tree (same names/directories, zero-byte files) measures the non-content cost of the same
//!    call shape: instrumentation plus directory iteration. It is reported as `control_rchar` and used for the
//!    `source_rchar = raw - control` cross-check. **It is never subtracted twice.**
//!  * The measurement window itself includes exactly one `/proc/self/io` read (the "after" snapshot).
//!    Instrumentation is corrected **explicitly and exactly**, not statistically: `rchar` counts the bytes
//!    returned by that read, and the exact count is the length of the `/proc/self/io` text that was parsed
//!    (`io_now().len`). So `content = raw_rchar - snapshot_len`, with no tolerance window, no double
//!    subtraction and no dependence on when the runtime/allocator was first initialised (r2 B5: the old
//!    pre/post known-read calibration aborted on a 9-byte `/proc` record-length drift before it reported
//!    anything). A `/proc/self/io` record legitimately changes length between samples as its counters widen;
//!    that drift is now reported as information and cannot invalidate the correction.
//!  * A known single 65,536-byte read still verifies the method before and after every probe: its corrected
//!    content must be exactly 65,536 bytes. Calibration failure is reported (raw/control/adjusted probe values
//!    are printed first) and then fails the test; it never widens the source allowance.
//!  * Raw-probe headroom: the audit requires the malformed-file probe to stay ≤ 4,194,304 **raw** bytes, i.e.
//!    the adapter must reserve instrumentation headroom instead of filling exactly 4 MiB of content.
//!  * Directory entry vs content reads: measured on this kernel, `getdents64`/`stat` bytes are **not** visible
//!    in `rchar` or `syscr` (`directory_entry_work_is_not_visible_to_proc_io` proves it with a 100 vs 400 entry
//!    tree). Fixture cardinality is therefore reported as an *expected* layout count, never as a measured
//!    adapter visit count. The "≤200 application entries/visits per turn" acceptance stays **unpassed** here
//!    and needs product instrumentation or a syscall tracer; this probe does not claim it.
//!
//! All measurements in this binary are serialized by `MEASURE` so parallel tests cannot share `rchar`.
//! The synthetic trees are the verifier's reproduction plus the r2 counterexamples; no host data is read.

use agentglimd::adapters::claude_code::ClaudeCode;
use agentglimd::core::{Cursor, Detection, Env, ItemKind, Source};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// Per-source-pass content allowance (BUILD-V4 §3/§4).
const BUDGET: u64 = 4 * 1024 * 1024;
const FILES: usize = 100;
const FILE_BYTES: usize = 65_536;
/// Size of the known read used to calibrate the instrumentation cost of one measurement window.
const CAL_BYTES: usize = 65_536;

/// Serializes every physical measurement in this test binary (tests share one process and its `rchar`).
static MEASURE: Mutex<()> = Mutex::new(());

fn measure_lock() -> std::sync::MutexGuard<'static, ()> {
    MEASURE.lock().unwrap_or_else(|e| e.into_inner())
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime")
    })
    .block_on(f)
}

#[derive(Debug, Default, Clone, Copy)]
struct Io {
    rchar: u64,
    read_bytes: u64,
    syscr: u64,
    /// Exact bytes returned by the read syscalls that produced this snapshot. This is the only
    /// instrumentation a `measure` window contains, so it is the exact correction for `rchar`.
    len: u64,
}

fn io_now() -> Io {
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/self/io").expect("read /proc/self/io");
        let get = |k: &str| {
            s.lines()
                .find_map(|l| l.strip_prefix(k))
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0)
        };
        Io {
            rchar: get("rchar:"),
            read_bytes: get("read_bytes:"),
            syscr: get("syscr:"),
            len: s.len() as u64,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Io::default()
    }
}

fn rss_kb() -> (u64, u64) {
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let get = |k: &str| {
            s.lines()
                .find_map(|l| l.strip_prefix(k))
                .and_then(|v| v.split_whitespace().next())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
        };
        (get("VmRSS:"), get("VmHWM:"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        (0, 0)
    }
}

struct Probe {
    label: &'static str,
    raw_rchar: u64,
    read_bytes: u64,
    read_syscalls: u64,
    millis: f64,
    rss_before_kb: u64,
    rss_after_kb: u64,
    hwm_kb: u64,
    /// `rchar` of the instrumentation inside this window: the exact length of the `/proc/self/io` snapshot
    /// read after the closure. Subtracted exactly once from `raw_rchar`.
    instrument_rchar: u64,
    /// `/proc` record length of the snapshot taken *before* the window (informational drift only).
    before_snapshot_len: u64,
    /// Independently counted by the test from the synthetic layout. NOT a measured adapter visit count.
    expected_entries: usize,
}

/// Content-byte bounds derived from one probe and its exact instrumentation correction.
#[derive(Debug, Clone, Copy)]
struct Bound {
    /// `raw - exact instrumentation`: the content bytes the adapter actually caused to be returned.
    lower: i64,
    /// Equal to `lower`: the correction is exact, so there is no tolerated spread.
    upper: i64,
    instrument_min: u64,
    instrument_max: u64,
}

impl Bound {
    fn spread(&self) -> u64 {
        self.instrument_max - self.instrument_min
    }
}

impl Probe {
    /// Content bytes of one window: `raw_rchar` minus the exact `/proc/self/io` snapshot bytes read inside the
    /// same window. No calibration statistics, no double subtraction, no assumption about run initialisation.
    fn content(&self) -> Bound {
        let exact = self.instrument_rchar as i64;
        Bound {
            lower: self.raw_rchar as i64 - exact,
            upper: self.raw_rchar as i64 - exact,
            instrument_min: self.instrument_rchar,
            instrument_max: self.instrument_rchar,
        }
    }

    /// One machine-readable evidence line; the report quotes these verbatim.
    fn evidence(&self, control: &Probe, b: &Bound, inferred_file_visits: u64) -> String {
        format!(
            "EPROBE {{\"probe\":\"{}\",\"raw_rchar\":{},\"read_bytes\":{},\"read_syscalls\":{},\
             \"control_rchar\":{},\"source_rchar\":{},\"instrumentation_min\":{},\
             \"instrumentation_max\":{},\"instrumentation_spread\":{},\"content_lower\":{},\
             \"content_upper\":{},\"instrumentation_exact\":{},\"snapshot_len_before\":{},\
             \"expected_entries\":{},\
             \"entry_visit_count\":\"unavailable:getdents-not-in-rchar\",\
             \"inferred_file_visits\":{},\"duration_ms\":{:.3},\"vm_rss_before_kb\":{},\
             \"vm_rss_after_kb\":{},\"vm_hwm_kb\":{}}}",
            self.label,
            self.raw_rchar,
            self.read_bytes,
            self.read_syscalls,
            control.raw_rchar,
            self.raw_rchar as i64 - control.raw_rchar as i64,
            b.instrument_min,
            b.instrument_max,
            b.spread(),
            b.lower,
            b.upper,
            self.instrument_rchar,
            self.before_snapshot_len,
            self.expected_entries,
            inferred_file_visits,
            self.millis,
            self.rss_before_kb,
            self.rss_after_kb,
            self.hwm_kb
        )
    }
}

fn measure(label: &'static str, expected_entries: usize, f: impl FnOnce()) -> Probe {
    // RSS is read outside the measured window: /proc/self/status bytes are not source reads.
    let (rss0, _) = rss_kb();
    let before = io_now();
    let t0 = Instant::now();
    f();
    let millis = t0.elapsed().as_secs_f64() * 1000.0;
    let after = io_now();
    let (rss1, hwm) = rss_kb();
    Probe {
        label,
        raw_rchar: after.rchar.saturating_sub(before.rchar),
        read_bytes: after.read_bytes.saturating_sub(before.read_bytes),
        read_syscalls: after.syscr.saturating_sub(before.syscr),
        millis,
        rss_before_kb: rss0,
        rss_after_kb: rss1,
        hwm_kb: hwm,
        instrument_rchar: after.len,
        before_snapshot_len: before.len,
        expected_entries,
    }
}

/// Method verification for the exact instrumentation correction.
///
/// The correction itself is exact (`raw_rchar` minus the `/proc/self/io` snapshot length), so no statistical
/// calibration or tolerance is needed. This struct only *proves* the method still holds around a probe: a
/// window containing exactly one known `CAL_BYTES` read must correct to exactly `CAL_BYTES` bytes, before and
/// after the probe. The `/proc` record length may legitimately change between those samples (it grows with the
/// digit count of its counters); that drift is reported, never used to widen the source allowance.
struct Calibration {
    _tmp: TempDir,
    file: PathBuf,
    /// Corrected content bytes of the known read before the probe (must be exactly `CAL_BYTES`).
    before: u64,
    /// Same, after the probe.
    after: u64,
    before_snapshot: u64,
    after_snapshot: u64,
}

impl Calibration {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("calibration tempdir");
        let file = tmp.path().join("known-65536.bin");
        std::fs::write(&file, vec![b'k'; CAL_BYTES]).expect("write calibration file");
        // Warm-up: the first measured window in a process can include one-time lazy-initialisation reads
        // from other runtime layers (r2 B5's "cold" transition). One discarded known-read window moves the
        // measurement past it; the correction itself is still exact and the source allowance never changes.
        let _warmup = Self::sample(&file);
        let (before, before_snapshot) = Self::sample(&file);
        Self {
            _tmp: tmp,
            file,
            before,
            after: before,
            before_snapshot,
            after_snapshot: before_snapshot,
        }
    }

    /// Corrected content bytes of one window containing exactly one known read, plus that window's
    /// `/proc/self/io` snapshot length.
    ///
    /// A window that also caught an unrelated read from another thread of this process is reported and
    /// retried (up to three attempts) so the calibration verifies the method rather than a neighbour's I/O.
    /// It never changes the byte allowance: the probe under test always uses its own exact snapshot length.
    fn sample(file: &Path) -> (u64, u64) {
        let mut last = (0u64, 0u64);
        for attempt in 0..3 {
            let probe = measure("calibration_known_read", 0, || {
                let got = std::fs::read(file).expect("calibration read");
                assert_eq!(got.len(), CAL_BYTES, "calibration read length");
            });
            assert!(
                probe.raw_rchar >= CAL_BYTES as u64,
                "calibration window reported fewer bytes than the known read: {}",
                probe.raw_rchar
            );
            let content = probe.content().lower.max(0) as u64;
            last = (content, probe.instrument_rchar);
            if content == CAL_BYTES as u64 {
                return last;
            }
            println!(
                "ECALIBRATION_RETRY {{\"attempt\":{attempt},\"expected\":{CAL_BYTES},\
                 \"observed_content\":{content},\"snapshot_len\":{},\
                 \"note\":\"window included non-calibration reads; retried, allowance unchanged\"}}",
                probe.instrument_rchar
            );
        }
        last
    }

    /// Take the trailing calibration sample (call after the measured probe, before asserting).
    fn finish(&mut self) {
        let (after, after_snapshot) = Self::sample(&self.file);
        self.after = after;
        self.after_snapshot = after_snapshot;
    }

    /// Print the calibration receipt **and then** assert the exact-correction method. Called last in a test so
    /// the probe raw/control/adjusted evidence is already on stdout even when this fails.
    fn report_and_assert(&self) {
        let drift = self.before_snapshot.abs_diff(self.after_snapshot);
        println!(
            "ECALIBRATION {{\"expected_content\":{CAL_BYTES},\"known_read_content_before\":{},\
             \"known_read_content_after\":{},\"method_exact\":{},\"snapshot_len_before\":{},\
             \"snapshot_len_after\":{},\"snapshot_len_drift\":{drift},\
             \"method\":\"content = raw_rchar - exact /proc/self/io record bytes; no tolerance, one subtraction\"}}",
            self.before,
            self.after,
            self.before == CAL_BYTES as u64 && self.after == CAL_BYTES as u64,
            self.before_snapshot,
            self.after_snapshot
        );
        assert_eq!(
            self.before, CAL_BYTES as u64,
            "the exact instrumentation correction must reproduce a known {CAL_BYTES}-byte read (before); \
             if this fails the measurement method is invalid, the source allowance is not widened"
        );
        assert_eq!(
            self.after, CAL_BYTES as u64,
            "the exact instrumentation correction must reproduce a known {CAL_BYTES}-byte read (after); \
             if this fails the measurement method is invalid, the source allowance is not widened"
        );
    }
}

/// Assert the r2 physical gate for one measured call and return the reported content bound.
///
/// Two independent requirements:
///  * **raw headroom** — `raw_rchar <= 4,194,304` (BUILD-V4: "both raw and adjusted malformed-file probe
///    should stay ≤4,194,304 by reserving headroom"), and
///  * **content** — the calibrated content lower bound is within the same allowance, so a content overrun
///    cannot hide behind instrumentation bytes.
fn assert_bounded(what: &str, probe: &Probe) -> Bound {
    let b = probe.content();
    assert!(
        b.lower <= BUDGET as i64,
        "{what}: content read {} bytes (upper bound {}), above the {BUDGET}-byte allowance \
         (raw {}, calibrated instrument {}..{})",
        b.lower,
        b.upper,
        probe.raw_rchar,
        b.instrument_min,
        b.instrument_max
    );
    assert!(
        probe.raw_rchar <= BUDGET,
        "{what}: raw probe read {} bytes, above the {BUDGET}-byte allowance; the adapter must reserve \
         instrumentation headroom (calibrated instrument {}..{}, content bound {}..{})",
        probe.raw_rchar,
        b.instrument_min,
        b.instrument_max,
        b.lower,
        b.upper
    );
    b
}

/// `home/.claude/projects/-bulk` with `FILES` files of `bytes_per_file` bytes.
/// `newlines` = invalid JSON lines (malformed but complete lines); `false` = one unterminated non-JSON
/// byte run (the repeated-partial-read / discard-boundary path).
fn build_tree(home: &Path, bytes_per_file: usize, newlines: bool) -> PathBuf {
    let root = home.join(".claude/projects/-bulk");
    std::fs::create_dir_all(&root).expect("bulk dir");
    for i in 0..FILES {
        let bytes = malformed_bytes(bytes_per_file, newlines);
        std::fs::write(root.join(format!("f{i:03}.jsonl")), &bytes).expect("write malformed file");
    }
    root
}

/// Independently count the entries under `root` (the test's layout expectation, not an adapter visit count).
fn count_entries(root: &Path) -> usize {
    let mut n = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                n += 1;
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(e.path());
                }
            }
        }
    }
    n
}

fn malformed_bytes(bytes_per_file: usize, newlines: bool) -> Vec<u8> {
    if !newlines {
        return vec![b'x'; bytes_per_file];
    }
    let line = b"x not json, deliberately unsupported \\ 0123456789 abcdefghij klmnopqrst\n";
    let mut bytes = Vec::with_capacity(bytes_per_file);
    while bytes.len() + line.len() <= bytes_per_file {
        bytes.extend_from_slice(line);
    }
    bytes.resize(bytes_per_file, b'x');
    bytes
}

/// A supported Claude Code record (the adapter's detector accepts `type`/`sessionId`/`message`).
fn claude_supported(model: &str) -> String {
    format!(
        r#"{{"type":"assistant","sessionId":"bulk-session","message":{{"role":"assistant","model":"{model}"}},"timestamp":"2026-11-01T00:00:00.000Z"}}"#
    ) + "\n"
}

/// A supported Claude Code record padded to exactly `total` bytes, with the model token after byte 256.
fn claude_padded(total: usize, model: &str) -> String {
    let empty = format!(
        r#"{{"type":"assistant","sessionId":"bulk-session","pad":"","message":{{"role":"assistant","model":"{model}"}},"timestamp":"2026-11-01T00:00:00.000Z"}}"#
    ) + "\n";
    assert!(total > empty.len() + 300, "total {total} too small");
    let pad = "x".repeat(total - empty.len());
    let line = format!(
        r#"{{"type":"assistant","sessionId":"bulk-session","pad":"{pad}","message":{{"role":"assistant","model":"{model}"}},"timestamp":"2026-11-01T00:00:00.000Z"}}"#
    ) + "\n";
    assert_eq!(line.len(), total);
    assert!(line.find(model).expect("model token") > 256);
    line
}

fn claude(home: &Path) -> ClaudeCode {
    ClaudeCode::new(None, home, 30)
}

fn env(home: &Path) -> Env {
    Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    }
}

fn models(items: &[agentglimd::core::BatchItem]) -> Vec<String> {
    items
        .iter()
        .filter(|i| i.kind == ItemKind::Step)
        .filter_map(|i| {
            i.data
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Probe 1: discovery (detect) on the verifier's malformed tree.
// ---------------------------------------------------------------------------------------------

#[test]
fn detect_on_100_malformed_files_is_bounded() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    // Control tree: same names and directories, zero-byte files => no content reads at all.
    let control_tmp = tempfile::tempdir().expect("tempdir");
    let control_home = control_tmp.path().join("home");
    let control_root = build_tree(&control_home, 0, true);
    let control = measure(
        "control_empty_tree_detect",
        count_entries(&control_root),
        || {
            let src = claude(&control_home);
            let det = src.detect(&env(&control_home));
            assert!(
                matches!(det, Detection::NotDetected { .. }),
                "zero-byte files must not be reported as a supported layout: {det:?}"
            );
        },
    );

    // Verifier reproduction: 100 x 65,536-byte malformed files.
    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = build_tree(&home, FILE_BYTES, true);
    let expected_entries = count_entries(&root);
    let mut det = None;
    let probe = measure("malformed_detect", expected_entries, || {
        let src = claude(&home);
        det = Some(src.detect(&env(&home)));
    });
    cal.finish();
    assert!(
        matches!(det, Some(Detection::NotDetected { .. })),
        "malformed content must be reported honestly as not detected"
    );

    let bound = probe.content();
    let inferred_visits = bound.lower.max(0) as u64 / FILE_BYTES as u64;
    println!("{}", probe.evidence(&control, &bound, inferred_visits));
    println!(
        "ECONTROL {{\"probe\":\"control_empty_tree_detect\",\"raw_rchar\":{},\"read_bytes\":{},\
         \"read_syscalls\":{},\"expected_entries\":{},\"instrumentation_exact\":{},\
         \"note\":\"control is reported, subtracted once only as source_rchar\"}}",
        control.raw_rchar,
        control.read_bytes,
        control.read_syscalls,
        control.expected_entries,
        control.instrument_rchar
    );
    let _ = assert_bounded("detect on 100 malformed files", &probe);
    assert!(
        expected_entries >= FILES,
        "the layout must contain the 100 malformed files (counted {expected_entries})"
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 2: poll (and a warm unchanged poll) on the same malformed tree.
// ---------------------------------------------------------------------------------------------

#[test]
fn poll_and_unchanged_poll_on_malformed_files_are_bounded() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let control_tmp = tempfile::tempdir().expect("tempdir");
    let control_home = control_tmp.path().join("home");
    let control_root = build_tree(&control_home, 0, true);
    let control = measure(
        "control_empty_tree_poll",
        count_entries(&control_root),
        || {
            let src = claude(&control_home);
            let b = block_on(src.poll(Cursor(0))).expect("poll");
            assert!(b.items.is_empty());
        },
    );

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = build_tree(&home, FILE_BYTES, true);
    let expected_entries = count_entries(&root);
    let src = claude(&home);
    let first = measure("malformed_poll", expected_entries, || {
        let b = block_on(src.poll(Cursor(0))).expect("poll");
        assert!(
            !b.items.is_empty(),
            "each malformed line still yields an Error observation"
        );
    });
    let b1 = assert_bounded("first malformed poll", &first);
    // Drain the bounded backlog (line/byte caps split it across passes), then measure one pass over the
    // now-unchanged tree: it must not re-read content, only the fingerprint sample.
    let mut passes = 0usize;
    let mut items = 0usize;
    loop {
        passes += 1;
        let b = block_on(src.poll(Cursor(1))).expect("poll");
        items += b.items.len();
        if b.items.is_empty() {
            break;
        }
        assert!(
            passes < 64,
            "the bounded backlog must drain; still producing items after {passes} passes"
        );
    }
    cal.finish();
    let warm = measure("malformed_poll_unchanged", expected_entries, || {
        let b = block_on(src.poll(Cursor(1))).expect("poll");
        assert!(
            b.items.is_empty(),
            "an unchanged, fully consumed malformed tree must not re-emit items"
        );
    });
    let bw = warm.content();
    println!("{}", warm.evidence(&control, &bw, 0));
    println!(
        "EDRAIN {{\"probe\":\"malformed_backlog_drain\",\"passes\":{passes},\"items\":{items},\"files\":{FILES}}}"
    );
    println!(
        "EPROBE_FIRST {}",
        first.evidence(&control, &b1, b1.lower.max(0) as u64 / FILE_BYTES as u64)
    );

    assert!(
        warm.raw_rchar <= BUDGET,
        "unchanged malformed poll raw {} bytes above {BUDGET}",
        warm.raw_rchar
    );
    // Unchanged files must not be re-read: only the 256-byte prefix sample per file is allowed.
    let unchanged_floor = (FILES * 256) as i64;
    assert!(
        bw.lower >= 0,
        "negative content bytes means the calibration is inconsistent: {bw:?}"
    );
    assert!(
        bw.lower <= unchanged_floor + 65_536,
        "an unchanged malformed tree re-read content: {} content bytes (upper {}) vs a \
         {unchanged_floor}-byte prefix-only floor",
        bw.lower,
        bw.upper
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 3: the unterminated-line path (no newline => no cursor progress; repeated partial reads).
// ---------------------------------------------------------------------------------------------

#[test]
fn unterminated_malformed_poll_is_bounded_per_pass() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let control_tmp = tempfile::tempdir().expect("tempdir");
    let control_home = control_tmp.path().join("home");
    let control_root = build_tree(&control_home, 0, false);
    let control = measure(
        "control_empty_tree_partial",
        count_entries(&control_root),
        || {
            let src = claude(&control_home);
            let _ = block_on(src.poll(Cursor(0))).expect("poll");
        },
    );

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = build_tree(&home, FILE_BYTES, false);
    let expected_entries = count_entries(&root);
    let src = claude(&home);
    let probe = measure("malformed_poll_no_newline", expected_entries, || {
        let b = block_on(src.poll(Cursor(0))).expect("poll");
        // A file with no complete line cannot advance the consumed offset.
        assert!(
            !b.items.is_empty() || b.next.0 == 0,
            "unexpected partial-line progress"
        );
    });
    cal.finish();
    let bound = probe.content();
    let inferred = bound.lower.max(0) as u64 / FILE_BYTES as u64;
    println!("{}", probe.evidence(&control, &bound, inferred));
    let _ = assert_bounded("unterminated malformed poll", &probe);
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 4 (r2 gate): detect + poll in one source-service turn must share ONE 4 MiB allowance.
//
// The agreed interface (core `TurnBudget` + `Source::begin_turn`/`end_turn`, documented in
// `_build/NOTES.md`) is exercised here exactly as core drives it: one budget object, one `begin_turn`,
// then detect and poll against it, then `end_turn`. Two independent gates are asserted:
//  * the adapter must actually charge the shared budget for the content it reads (`used > 0`), and
//  * the independent process-level `rchar` measurement for the whole turn must stay inside 4,194,304
//    (raw headroom included).
//
// The r1 case only recorded that two independent passes totaled ~7.5 MB while accepting up to two
// budgets. This is now the strict single-allowance assertion the audit requires; until the JSONL owner
// wires its reads into `TurnBudget`, this case is expected to be RED and is never relaxed to two caps.
// ---------------------------------------------------------------------------------------------

#[test]
fn combined_detect_and_poll_turn_reports_the_two_pass_total() {
    use std::sync::Arc;

    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let control_tmp = tempfile::tempdir().expect("tempdir");
    let control_home = control_tmp.path().join("home");
    let control_root = build_tree(&control_home, 0, true);
    let control = measure(
        "control_empty_tree_combined",
        count_entries(&control_root),
        || {
            let src = claude(&control_home);
            let budget = agentglimd::core::TurnBudget::default_allowance();
            src.begin_turn(budget.clone());
            let _ = src.detect(&env(&control_home));
            let _ = block_on(src.poll(Cursor(0))).expect("poll");
            src.end_turn();
        },
    );

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = build_tree(&home, FILE_BYTES, true);
    let expected_entries = count_entries(&root);
    let budget = agentglimd::core::TurnBudget::default_allowance();
    let shared: Arc<agentglimd::core::TurnBudget> = budget.clone();
    let probe = measure("combined_detect_poll_turn", expected_entries, || {
        let src = claude(&home);
        src.begin_turn(shared.clone());
        let _ = src.detect(&env(&home));
        let _ = block_on(src.poll(Cursor(0))).expect("poll");
        src.end_turn();
    });
    cal.finish();
    let bound = probe.content();
    let inferred = bound.lower.max(0) as u64 / FILE_BYTES as u64;
    println!("{}", probe.evidence(&control, &bound, inferred));
    println!(
        "ECOMBINED {{\"raw_rchar\":{},\"content_lower\":{},\"content_upper\":{},\
         \"turn_budget_limit\":{},\"turn_budget_used\":{},\"turn_budget_remaining\":{},\
         \"single_4MiB_allowance\":{},\"note\":\"one scheduled source-service turn; detect+poll must share \
         one allowance, not two independent 4 MiB counters\"}}",
        probe.raw_rchar,
        bound.lower,
        bound.upper,
        budget.limit(),
        budget.used(),
        budget.remaining(),
        probe.raw_rchar <= BUDGET && bound.lower <= BUDGET as i64
    );

    // Contract gate: the shared counter exists but the JSONL reads are not charged through it yet.
    assert!(
        budget.used() > 0,
        "the adapter read {} raw bytes in this turn but charged 0 to the shared TurnBudget; detect and \
         poll must draw from the one allowance core creates (see _build/NOTES.md)",
        probe.raw_rchar
    );
    assert!(
        budget.used() <= budget.limit(),
        "the shared turn budget over-ran: used {} of {}",
        budget.used(),
        budget.limit()
    );
    assert_bounded("detect + poll in one source-service turn", &probe);
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 4b (r3 gate): a GENUINELY DETECTED source turn, exercised through the real poller and through
// the same detect+poll calls core performs.
//
// The forced all-malformed case above is not a turn the scheduler executes: core skips polling after
// `NotDetected`. The r2 audit's counterexample was a scheduled turn over a *Detected* source that read
// ~6.63 MB in one turn while the shared `TurnBudget` stayed at zero, because detection and polling each
// kept their own counter. This layout cannot be skipped by the scheduler and cannot depend on directory
// order: every candidate file carries one supported record, so `detect` honestly returns `Detected`.
//
// Independent evidence:
//  * the real poller must report the source detected and commit all records, and
//  * one direct detect+poll turn must stay inside ONE allowance with the shared budget actually charged,
//  * while the same detect and poll measured separately (no shared turn) sum to MORE than one allowance.
//    That last fact is what makes the single shared budget load-bearing rather than decorative.
// ---------------------------------------------------------------------------------------------

/// One 65,536-byte JSONL file: a supported Claude record first (visible in detection's 64 KiB prefix
/// sample) followed by one long malformed complete line. Each file has its own session id so the store
/// count is a real per-file count, not one deduplicated session name.
fn supported_plus_malformed(total: usize, model: &str, session: &str) -> Vec<u8> {
    let line = format!(
        r#"{{"type":"assistant","sessionId":"{session}","message":{{"role":"assistant","model":"{model}"}},"timestamp":"2026-11-01T00:00:00.000Z"}}"#
    ) + "\n";
    let mut bytes = line.into_bytes();
    bytes.extend_from_slice(b"x not json, deliberately unsupported padding \"");
    assert!(bytes.len() < total - 1, "supported record too large");
    bytes.resize(total - 1, b'p');
    bytes.push(b'\n');
    assert_eq!(bytes.len(), total);
    bytes
}

fn build_detected_tree(home: &Path, model: &str) -> PathBuf {
    let root = home.join(".claude/projects/-detected");
    std::fs::create_dir_all(&root).expect("detected dir");
    for i in 0..FILES {
        std::fs::write(
            root.join(format!("f{i:03}.jsonl")),
            supported_plus_malformed(FILE_BYTES, model, &format!("detected-session-{i:03}")),
        )
        .expect("write detected file");
    }
    root
}

#[test]
fn detected_source_turn_shares_one_allowance_with_detection() {
    use agentglimd::core::bus::Bus;
    use agentglimd::core::poller::{spawn_poller, Intervals, PollerDeps, StatusCache};
    use agentglimd::store::Store;
    use std::sync::Arc;

    let _guard = measure_lock();

    // ---- Part 1: the real scheduled path (unmeasured; the same window would include SQLite store reads).
    let poller_tmp = tempfile::tempdir().expect("tempdir");
    let poller_home = poller_tmp.path().join("home");
    build_detected_tree(&poller_home, "scheduled-model");
    let data = poller_tmp.path().join("data");
    std::fs::create_dir_all(&data).expect("data");
    let db = data.join("state.db");
    let mut observed_detected = false;
    let mut sessions = 0u64;
    let mut committed_steps = 0usize;
    block_on(async {
        let store = Store::open(&db).expect("open store");
        let bus = Arc::new(Bus::new(store.clone()).expect("bus"));
        let sources: Arc<Vec<Arc<dyn Source>>> =
            Arc::new(vec![
                Arc::new(ClaudeCode::new(None, &poller_home, 30)) as Arc<dyn Source>
            ]);
        let status = Arc::new(StatusCache::new());
        let (_refresh_tx, refresh_rx) = tokio::sync::watch::channel(0u64);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_poller(
            PollerDeps {
                store: store.clone(),
                bus,
                sources,
                runtimes: Arc::new(Vec::new()),
                status: status.clone(),
                env: env(&poller_home),
                intervals: Intervals {
                    poll: Duration::from_millis(20),
                    discover: Duration::from_millis(40),
                },
                refresh: refresh_rx,
            },
            stop_rx,
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            tokio::time::sleep(Duration::from_millis(25)).await;
            observed_detected |= status.sources().iter().any(|s| s.detected);
            sessions = store.session_count("claude-code").unwrap_or(0);
            let steps = count_steps(&db, "claude-code");
            if steps >= FILES || Instant::now() >= deadline {
                committed_steps = steps;
                break;
            }
        }
        let _ = stop_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
    });
    println!(
        "ESCHEDULED {{\"poller_detected\":{observed_detected},\"sessions_committed\":{sessions},\
         \"steps_committed\":{committed_steps},\"files\":{FILES},\
         \"note\":\"real poller: discovery tick detect -> same-turn poll -> Bus commit\"}}"
    );
    assert!(
        observed_detected,
        "the real poller must report a genuinely supported tree as Detected"
    );
    assert_eq!(
        sessions, FILES as u64,
        "the scheduled path must commit every file's supported record"
    );
    assert_eq!(
        count_steps(&db, "claude-code"),
        FILES,
        "exactly one Step per file over the whole scheduled drain, no duplicates"
    );

    // ---- Part 2: the same detect+poll in one turn, measured independently.
    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = build_detected_tree(&home, "detected-model");
    let expected_entries = count_entries(&root);

    let mut cal = Calibration::new();
    let mut det = None;
    let mut step_items = 0usize;
    let budget = agentglimd::core::TurnBudget::default_allowance();
    let shared = budget.clone();
    // One adapter instance for the measured turn and the continuation below, so the drain continues from
    // this turn's consumed offsets instead of re-reading every file from zero.
    let src = claude(&home);
    let turn = measure("detected_source_turn", expected_entries, || {
        src.begin_turn(shared.clone());
        det = Some(src.detect(&env(&home)));
        let b = block_on(src.poll(Cursor(0))).expect("poll");
        step_items = b.items.iter().filter(|i| i.kind == ItemKind::Step).count();
        src.end_turn();
    });

    // The same two passes without a shared turn, to prove this layout would exceed one allowance if
    // detection and polling kept separate counters.
    let mut det_only = None;
    let detect_alone = measure("detected_detect_alone", expected_entries, || {
        let src = claude(&home);
        det_only = Some(src.detect(&env(&home)));
    });
    let poll_alone = measure("detected_poll_alone", expected_entries, || {
        let src = claude(&home);
        let b = block_on(src.poll(Cursor(0))).expect("poll");
        assert!(
            b.items.iter().any(|i| i.kind == ItemKind::Step),
            "the standalone poll must read supported records"
        );
    });
    cal.finish();

    let bound = turn.content();
    let det_bound = detect_alone.content();
    let poll_bound = poll_alone.content();
    let unshared = det_bound.lower.max(0) + poll_bound.lower.max(0);
    println!(
        "EDETECTED {{\"raw_rchar\":{},\"content_lower\":{},\"content_upper\":{},\
         \"turn_budget_limit\":{},\"turn_budget_used\":{},\"turn_budget_remaining\":{},\
         \"step_items_committed\":{step_items},\"detect_only_content\":{},\
         \"poll_only_content\":{},\"separate_counters_total\":{unshared},\
         \"one_allowance_satisfied\":{}}}",
        turn.raw_rchar,
        bound.lower,
        bound.upper,
        budget.limit(),
        budget.used(),
        budget.remaining(),
        det_bound.lower,
        poll_bound.lower,
        turn.raw_rchar <= BUDGET && bound.lower <= BUDGET as i64 && budget.used() > 0
    );

    assert!(
        matches!(det, Some(Detection::Detected { .. })),
        "the detected layout must be accepted by detection: {det:?}"
    );
    assert!(
        matches!(det_only, Some(Detection::Detected { .. })),
        "the standalone detection used for the counterexample must also be Detected"
    );
    assert!(
        unshared > BUDGET as i64,
        "this case only tests the shared allowance if detect and poll measured separately exceed one \
         allowance: detect {} + poll {} = {unshared} vs {BUDGET}",
        det_bound.lower,
        poll_bound.lower
    );
    assert!(
        budget.used() > 0,
        "a genuinely detected turn read {} raw bytes but charged 0 to the shared TurnBudget",
        turn.raw_rchar
    );
    assert!(
        budget.used() <= budget.limit(),
        "the shared turn budget over-ran: used {} of {}",
        budget.used(),
        budget.limit()
    );
    assert!(
        step_items > 0,
        "the first detected turn must commit supported Steps, not only Error observations"
    );
    assert_bounded("genuinely detected detect+poll turn", &turn);

    // Drain the same source to a settled state: every supported record exactly once, unique keys.
    let mut drained = 0usize;
    let mut total_steps = step_items;
    while drained < 32 {
        drained += 1;
        let b = block_on(src.poll(Cursor(1))).expect("drain poll");
        let steps = b.items.iter().filter(|i| i.kind == ItemKind::Step).count();
        total_steps += steps;
        if b.items.is_empty() {
            break;
        }
    }
    assert_eq!(
        total_steps, FILES,
        "all {FILES} supported records are emitted exactly once across bounded turns"
    );
    cal.report_and_assert();
}

/// Count committed `step` events for one source (independent SQLite read, not adapter output).
fn count_steps(db: &Path, source: &str) -> usize {
    let c = rusqlite::Connection::open(db).expect("open db for verification");
    c.busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    c.query_row(
        "SELECT COUNT(*) FROM events WHERE source=?1 AND kind='step'",
        [source],
        |r| r.get::<_, i64>(0),
    )
    .expect("count steps") as usize
}

// ---------------------------------------------------------------------------------------------
// Probe 5: one-file 6 MiB discard boundary (the audit's independent counterexample).
//
// A single 6 MiB unterminated file makes the adapter read the discard boundary. The r1 probe measured
// 4,194,430 raw bytes for this shape, i.e. a source-content overrun, because one boundary byte was read
// without being charged. Every byte of this path must now stay inside the allowance, headroom included.
// ---------------------------------------------------------------------------------------------

#[test]
fn discard_boundary_single_6mib_file_poll_is_bounded() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = home.join(".claude/projects/-oversized");
    std::fs::create_dir_all(&root).expect("oversized dir");
    let file = root.join("one.jsonl");
    std::fs::write(&file, vec![b'x'; 6 * 1024 * 1024]).expect("write 6 MiB file");
    let expected_entries = count_entries(&root);
    let src = claude(&home);
    let mut items = 0usize;
    let mut next = 0u64;
    let probe = measure("discard_boundary_6mib", expected_entries, || {
        let b = block_on(src.poll(Cursor(0))).expect("poll");
        items = b.items.len();
        next = b.next.0;
        assert!(
            b.items.iter().all(|i| i.kind == ItemKind::Error),
            "a 6 MiB unterminated run must not parse as a supported record"
        );
    });
    cal.finish();
    let bound = probe.content();
    let control = Probe {
        label: "control_noop",
        raw_rchar: 0,
        read_bytes: 0,
        read_syscalls: 0,
        millis: 0.0,
        rss_before_kb: probe.rss_before_kb,
        rss_after_kb: probe.rss_after_kb,
        hwm_kb: probe.hwm_kb,
        instrument_rchar: 0,
        before_snapshot_len: 0,
        expected_entries: 0,
    };
    println!("{}", probe.evidence(&control, &bound, 0));
    println!(
        "EDISCARD {{\"file_bytes\":{},\"items\":{items},\"cursor_after\":{next},\"content_lower\":{},\
         \"content_upper\":{}}}",
        6 * 1024 * 1024,
        bound.lower,
        bound.upper
    );
    let _ = assert_bounded("one-file 6 MiB discard-boundary poll", &probe);
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 6: fair discovery beyond the first 200 candidate files.
//
// 240 matching files, none supported, plus a nested directory holding the only supported record. A
// detection probe that stops after the first 200 matches without retaining continuation can never see it,
// which permanently starves the source (core refuses to poll a not-detected source). Repeated detect calls
// must make fair progress and find it.
// ---------------------------------------------------------------------------------------------

#[test]
fn detect_fairness_finds_supported_file_beyond_two_hundred_candidates() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = home.join(".claude/projects/-fair");
    std::fs::create_dir_all(root.join("deep/last")).expect("fair dirs");
    for i in 0..240 {
        std::fs::write(
            root.join(format!("a{i:03}.jsonl")),
            b"{\"type\":\"log\",\"note\":\"unsupported candidate\"}\n",
        )
        .expect("write unsupported candidate");
    }
    std::fs::write(
        root.join("deep/last/supported.jsonl"),
        claude_supported("fair-model-a"),
    )
    .expect("write supported file");
    let expected_entries = count_entries(&root);
    let src = claude(&home);

    let mut detected_at: Option<usize> = None;
    let mut first_detection = None;
    for attempt in 0..4 {
        let mut det = None;
        let probe = measure("detect_fairness_attempt", expected_entries, || {
            det = Some(src.detect(&env(&home)));
        });
        let bound = assert_bounded("fair repeated detection attempt", &probe);
        let d = det.expect("detection result");
        println!(
            "EFAULT {{\"attempt\":{},\"detected\":{},\"raw_rchar\":{},\"content_lower\":{}}}",
            attempt,
            matches!(d, Detection::Detected { .. }),
            probe.raw_rchar,
            bound.lower
        );
        if matches!(d, Detection::Detected { .. }) {
            detected_at = Some(attempt);
            first_detection = Some(d);
            break;
        }
    }
    cal.finish();
    assert!(
        detected_at.is_some(),
        "a supported file placed after 200 unsupported candidate files must be found by repeated bounded \
         detection (r1 B4: the first 200 matches were selected with no continuation, so the source stays \
         NotDetected forever); 240 unsupported + 1 nested supported file"
    );
    assert!(
        matches!(first_detection, Some(Detection::Detected { .. })),
        "detected result is honest"
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 7: nonmatching entries and nested directories do not starve a supported file, and every poll
// stays inside the byte allowance while the bounded discovery sweep continues.
// ---------------------------------------------------------------------------------------------

#[test]
fn nonmatching_and_nested_entries_do_not_starve_a_supported_file() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = home.join(".claude/projects/-nonmatching");
    std::fs::create_dir_all(root.join("nested/one/two")).expect("nested dirs");
    for i in 0..300 {
        std::fs::write(root.join(format!("a{i:03}.txt")), b"unrelated\n").expect("txt file");
        // Empty directory entries and a few unrelated nested files must be visited too.
        std::fs::create_dir_all(root.join(format!("d{i:03}"))).expect("empty dir");
    }
    std::fs::write(root.join("nested/one/two/notes.md"), b"unrelated\n").expect("nested md");
    std::fs::write(
        root.join("zzzz-supported.jsonl"),
        claude_supported("nested-model"),
    )
    .expect("supported file");
    let expected_entries = count_entries(&root);
    let src = claude(&home);

    // One reset poll starts the bounded sweep; continuation happens on the following polls.
    let mut seen: Vec<String> = Vec::new();
    let mut turns = 0usize;
    let mut measured: Vec<String> = Vec::new();
    loop {
        turns += 1;
        let mut got: Vec<String> = Vec::new();
        let probe = measure("nonmatching_discovery_poll", expected_entries, || {
            let b = block_on(src.poll(Cursor(if turns == 1 { 0 } else { 1 }))).expect("poll");
            got = models(&b.items);
        });
        let bound = assert_bounded("nonmatching discovery poll", &probe);
        measured.push(format!(
            "EPOLL {{\"turn\":{turns},\"raw_rchar\":{},\"content_lower\":{},\"models\":{}}}",
            probe.raw_rchar,
            bound.lower,
            got.len()
        ));
        seen.extend(got);
        if !seen.is_empty() || turns >= 8 {
            break;
        }
    }
    cal.finish();
    for line in &measured {
        println!("{line}");
    }
    println!(
        "ENONMATCH {{\"expected_entries\":{expected_entries},\"turns\":{turns},\"models\":{seen:?}}}"
    );
    assert_eq!(
        seen,
        vec!["nested-model".to_string()],
        "a supported file behind 300 nonmatching entries and nested directories must still be discovered \
         and committed exactly once"
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 8: a late changed file among unchanged files is detected once, live and after a restore.
// ---------------------------------------------------------------------------------------------

#[test]
fn late_changed_file_among_unchanged_files_is_detected_once() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    let root = home.join(".claude/projects/-late");
    std::fs::create_dir_all(&root).expect("late dir");
    let names: Vec<String> = (0..40).map(|i| format!("a{i:03}.jsonl")).collect();
    for (i, name) in names.iter().enumerate() {
        std::fs::write(
            root.join(name),
            claude_padded(600, &format!("steady-{i:03}")),
        )
        .expect("write steady file");
    }
    let expected_entries = count_entries(&root);
    let src = claude(&home);
    let mut first = 0usize;
    let p0 = measure("late_initial_poll", expected_entries, || {
        let b = block_on(src.poll(Cursor(0))).expect("first poll");
        first = b.items.iter().filter(|i| i.kind == ItemKind::Step).count();
    });
    let _ = assert_bounded("late initial poll", &p0);
    assert_eq!(first, 40, "all 40 unchanged files are consumed first");

    // Change the LAST file in sorted order, same size, after byte 256, mtime advanced.
    let last = root.join(names.last().expect("names"));
    let edited = claude_padded(600, "steady-039-EDIT");
    std::fs::write(&last, &edited).expect("rewrite last file");
    let t = std::time::SystemTime::now() + Duration::from_secs(2 * 3600);
    std::fs::File::options()
        .write(true)
        .open(&last)
        .expect("open last")
        .set_modified(t)
        .expect("set mtime");

    let mut changed = Vec::new();
    let mut unchanged_rows = 0usize;
    for turn in 0..3 {
        let mut m: Vec<String> = Vec::new();
        let mut steps = 0usize;
        let probe = measure("late_changed_poll", expected_entries, || {
            let b = block_on(src.poll(Cursor(1))).expect("poll after edit");
            m = models(&b.items);
            steps = b.items.iter().filter(|i| i.kind == ItemKind::Step).count();
        });
        let bound = assert_bounded("late changed poll", &probe);
        println!(
            "ELATE {{\"turn\":{turn},\"raw_rchar\":{},\"content_lower\":{},\"steps\":{steps},\"models\":{m:?}}}",
            probe.raw_rchar, bound.lower
        );
        if steps > 0 {
            unchanged_rows += steps;
            changed.extend(m);
            break;
        }
    }
    cal.finish();
    assert_eq!(
        changed,
        vec!["steady-039-EDIT".to_string()],
        "only the late changed file is re-read; the other 39 unchanged files stay silent"
    );
    assert_eq!(unchanged_rows, 1, "exactly one changed Step is emitted");

    // Same edit shape after a serialized checkpoint restore.
    let checkpoint = serde_json::to_string(&src.checkpoint()).expect("serialize checkpoint");
    drop(src);
    let restored: agentglimd::core::SourceCheckpoint =
        serde_json::from_str(&checkpoint).expect("restore checkpoint");
    let src2 = claude(&home);
    src2.restore_checkpoint(restored);
    let edited2 = claude_padded(600, "steady-039-EDIT2");
    std::fs::write(&last, &edited2).expect("second rewrite");
    std::fs::File::options()
        .write(true)
        .open(&last)
        .expect("open last")
        .set_modified(t + Duration::from_secs(3600))
        .expect("set mtime");
    let mut restored_models = Vec::new();
    for _ in 0..3 {
        let mut m: Vec<String> = Vec::new();
        let probe = measure("late_changed_restored_poll", count_entries(&root), || {
            let b = block_on(src2.poll(Cursor(1))).expect("restored poll");
            m = models(&b.items);
        });
        let _ = assert_bounded("late changed restored poll", &probe);
        if !m.is_empty() {
            restored_models.extend(m);
            break;
        }
    }
    assert_eq!(
        restored_models,
        vec!["steady-039-EDIT2".to_string()],
        "the restored checkpoint must detect the late changed file exactly once"
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Probe 9: cross-check what /proc/self/io can and cannot measure about directory work.
//
// This is the honest limitation receipt for B6: on this kernel `getdents64` and `stat` bytes do not appear
// in `rchar`/`syscr`, so a control-tree subtraction cannot prove per-entry work. The test proves the
// measurement boundary and prints both values; the ≤200 application entry/visit acceptance therefore stays
// unpassed rather than being asserted from fixture cardinality.
// ---------------------------------------------------------------------------------------------

#[test]
fn directory_entry_work_is_not_visible_to_proc_io() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let small_tmp = tempfile::tempdir().expect("tempdir");
    let small_home = small_tmp.path().join("home");
    let small_root = small_home.join(".claude/projects/-entries-small");
    std::fs::create_dir_all(&small_root).expect("small dir");
    for i in 0..100 {
        std::fs::File::create(small_root.join(format!("e{i:03}.txt"))).expect("small entry");
    }
    let small = measure("dir_entries_100", count_entries(&small_root), || {
        let src = claude(&small_home);
        let _ = src.detect(&env(&small_home));
    });

    let large_tmp = tempfile::tempdir().expect("tempdir");
    let large_home = large_tmp.path().join("home");
    let large_root = large_home.join(".claude/projects/-entries-large");
    std::fs::create_dir_all(&large_root).expect("large dir");
    for i in 0..400 {
        std::fs::File::create(large_root.join(format!("e{i:03}.txt"))).expect("large entry");
    }
    for i in 0..20 {
        std::fs::create_dir_all(large_root.join(format!("sub{i:02}"))).expect("nested dir");
    }
    let large = measure("dir_entries_400", count_entries(&large_root), || {
        let src = claude(&large_home);
        let _ = src.detect(&env(&large_home));
    });
    cal.finish();

    let sb = small.content();
    let lb = large.content();
    println!(
        "EDIRVIS {{\"small_entries\":{},\"small_content_lower\":{},\"large_entries\":{},\
         \"large_content_lower\":{},\"delta\":{},\"small_syscr\":{},\"large_syscr\":{}}}",
        small.expected_entries,
        sb.lower,
        large.expected_entries,
        lb.lower,
        lb.lower - sb.lower,
        small.read_syscalls,
        large.read_syscalls
    );
    // The adapter must not read content for zero-byte files: both measured windows stay at instrumentation
    // level. A kernel that starts charging directory reads to rchar would make this fail visibly instead of
    // letting the suite pretend that entry work had been measured.
    assert!(
        sb.lower <= 65_536 && lb.lower <= 65_536,
        "zero-byte entry trees must not trigger content reads (small {}, large {})",
        sb.lower,
        lb.lower
    );
    assert!(
        large.expected_entries - small.expected_entries >= 300,
        "the layout must differ by 300+ entries"
    );
    // This is the measured proof that the entry delta is not visible to the byte counter.
    assert!(
        (lb.lower - sb.lower).abs() < 4_096,
        "if this fails the kernel now exposes directory-entry bytes in rchar; the entry/visit accounting \
         could then be strengthened (delta {})",
        lb.lower - sb.lower
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Positive control: the same measurement on the recorded supported fixture home.
// ---------------------------------------------------------------------------------------------

#[test]
fn supported_fixture_detect_reads_are_bounded_and_detected() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().join("home");
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-code/2.0/home"),
        &home,
    );
    let root = home.join(".claude/projects");
    let mut det = None;
    let probe = measure("supported_fixture_detect", count_entries(&root), || {
        let src = claude(&home);
        det = Some(src.detect(&env(&home)));
    });
    cal.finish();
    assert!(
        matches!(det, Some(Detection::Detected { .. })),
        "the recorded supported fixture must be detected: {det:?}"
    );
    let unit = Probe {
        label: "control_noop",
        raw_rchar: 0,
        read_bytes: 0,
        read_syscalls: 0,
        millis: 0.0,
        rss_before_kb: probe.rss_before_kb,
        rss_after_kb: probe.rss_after_kb,
        hwm_kb: probe.hwm_kb,
        instrument_rchar: 0,
        before_snapshot_len: 0,
        expected_entries: 0,
    };
    let bound = assert_bounded("supported fixture detect", &probe);
    println!("{}", probe.evidence(&unit, &bound, 0));
    assert!(
        bound.lower > 0,
        "the probe must observe the fixture content reads (content lower bound {})",
        bound.lower
    );
    cal.report_and_assert();
}

// ---------------------------------------------------------------------------------------------
// Measurement control: a known read size shows up exactly in `rchar`, and the calibration is linear.
// ---------------------------------------------------------------------------------------------

#[test]
fn probe_reads_are_linear_and_deterministic() {
    let _guard = measure_lock();
    let mut cal = Calibration::new();
    let tmp = tempfile::tempdir().expect("tempdir");
    let file = tmp.path().join("known.bin");
    std::fs::write(&file, vec![b'k'; FILE_BYTES]).expect("write");

    // Exact calibration: one known 65,536-byte read; content must be exactly 65,536 bytes.
    let one = measure("known_read_65536", 1, || {
        let got = std::fs::read(&file).expect("read");
        assert_eq!(got.len(), FILE_BYTES);
    });
    let two = measure("known_read_131072", 1, || {
        // Two independent reads of the same known file: exactly 2 x 65,536 bytes.
        for _ in 0..2 {
            let got = std::fs::read(&file).expect("read");
            assert_eq!(got.len(), FILE_BYTES);
        }
    });
    cal.finish();
    let one_b = one.content();
    let two_b = two.content();
    println!(
        "ECONTROLREAD {{\"raw_one\":{},\"raw_two\":{},\"content_one_lower\":{},\"content_one_upper\":{},\
         \"content_two_lower\":{},\"content_two_upper\":{},\"instrumentation_min\":{},\
         \"instrumentation_max\":{},\"instrumentation_spread\":{},\"expected_one\":{},\
         \"expected_two\":{},\"read_syscalls_one\":{},\"read_syscalls_two\":{},\"duration_ms\":{:.3}}}",
        one.raw_rchar,
        two.raw_rchar,
        one_b.lower,
        one_b.upper,
        two_b.lower,
        two_b.upper,
        one_b.instrument_min,
        one_b.instrument_max,
        one_b.spread(),
        FILE_BYTES,
        2 * FILE_BYTES,
        one.read_syscalls,
        two.read_syscalls,
        one.millis
    );
    // Exact: the corrected content of one 65,536-byte read is 65,536 bytes (instrumentation subtracted once).
    assert_eq!(
        one_b.lower, FILE_BYTES as i64,
        "the exact correction must account for the read bytes and the /proc snapshot once only"
    );
    assert_eq!(
        one_b.upper, FILE_BYTES as i64,
        "the correction is exact, so lower and upper must be the same 65,536 (no tolerated spread)"
    );
    // Linear: doubling the known content doubles the measured content exactly.
    assert_eq!(
        two_b.lower,
        (2 * FILE_BYTES) as i64,
        "the byte measurement must be linear in the known read size"
    );
    assert_eq!(
        two_b.upper,
        (2 * FILE_BYTES) as i64,
        "the 131,072-byte probe must also be exact (no tolerated spread)"
    );
    assert_eq!(
        two.raw_rchar as i64 - one.raw_rchar as i64,
        FILE_BYTES as i64,
        "raw bytes must grow by exactly one known read between the two probes"
    );
    assert!(
        (one.millis as u64) < 5_000,
        "a 64 KiB read must not take seconds"
    );
    assert!(one.hwm_kb > 0 || !cfg!(target_os = "linux"));
    cal.report_and_assert();
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).expect("mkdir");
    for e in std::fs::read_dir(src).expect("read fixture dir").flatten() {
        let to = dst.join(e.file_name());
        if e.file_type().expect("file type").is_dir() {
            copy_dir(&e.path(), &to);
        } else {
            std::fs::copy(e.path(), &to).expect("copy fixture");
        }
    }
}
