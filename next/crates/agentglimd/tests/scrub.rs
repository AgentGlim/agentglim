//! Scrub gate: no emails, home paths or token-like strings anywhere in the distributable tree — Rust source, tests,
//! web assets, fixtures and docs — not just in fixtures and docs.
//!
//! The scan is offline and line-oriented, and reports `path:line: reason` only: it never echoes the offending text,
//! so a real leak is not copied into CI output. A line may be exempt only when
//! * the file is one of the two files that exist to *define* the detector/redactor patterns, and
//! * the line itself (or the line immediately before it) carries the `scrub-allow` marker with a reason,
//!   and the total number of exempt lines is capped, so an exemption cannot quietly cover new content.
//!
//! `scrub_finds_planted_canary_in_a_copy` is the negative self-test: it plants every canary shape in a temporary
//! copy of the layout and proves the detector finds each one, so a green main scan cannot be vacuous.

use std::path::{Path, PathBuf};

/// Everything the daemon ships or the repo publishes.
const ROOTS: [&str; 5] = [
    "crates/agentglimd/src",
    "crates/agentglimd/tests",
    "web",
    "fixtures",
    "docs",
];

/// Generated/vendored trees that are not hand-written distributable code.
const SKIP_DIRS: [&str; 4] = ["node_modules", "dist", "target", ".git"];

/// Paths (relative to `build/`) whose literals *are* the detector: the log/store redactor and this test file.
const DETECTOR_FILES: [&str; 2] = [
    "crates/agentglimd/src/logging.rs",
    "crates/agentglimd/tests/scrub.rs",
];

/// Exempt lines are rare by construction: 15 today (7 detector needles, 3 detector-behaviour assertions and 5
/// redactor literals), counting only lines that would otherwise have been findings. A growth here means an exemption
/// is being used to hide content.
const MAX_EXEMPT_LINES: usize = 18;

const MARKER: &str = "scrub-allow:";

/// Findings that belong to another worker's file: they are *reported*, not fixed here, because editing `web/` is
/// outside this task's ownership. The scan must match this list exactly — a new finding fails the gate, and an entry
/// whose file was fixed elsewhere must be deleted here (see `_build/NOTES.md`, v3-r3 privacy-scrub).
const REPORTED_CROSS_OWNER: [(&str, &str); 1] = [("web/tests/browser-check.mjs", "home path")];

/// Literal shapes that never belong in distributable code.
fn needle(text: &str) -> Option<&'static str> {
    for (n, why) in [
        ("/home/", "home path"),  // scrub-allow: detector literal
        ("/Users/", "home path"), // scrub-allow: detector literal
        ("sk-ant-", "api key"),   // scrub-allow: detector literal
        ("sk-proj-", "api key"),  // scrub-allow: detector literal
        ("ghp_", "token"),        // scrub-allow: detector literal
        ("xoxb-", "token"),       // scrub-allow: detector literal
        ("github_pat_", "token"), // scrub-allow: detector literal
    ] {
        if text.contains(n) {
            return Some(why);
        }
    }
    None
}

/// An email-shaped word inside `text`.
fn email_in(text: &str) -> Option<&'static str> {
    let shaped = text.split_whitespace().any(|w| {
        let w = w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '@' && c != '.');
        match w.split_once('@') {
            Some((u, d)) => {
                !u.is_empty()
                    && d.contains('.')
                    && !d.starts_with('.')
                    && !d.ends_with('.')
                    // A URL or scp-style remote keeps its shape: only plain address words are flagged.
                    && !u.contains(['/', ':'])
                    && !d.contains(['/', ':'])
            }
            None => false,
        }
    });
    shaped.then_some("email")
}

/// The reason `text` cannot ship, if any.
fn bad(text: &str) -> Option<&'static str> {
    needle(text).or_else(|| email_in(text))
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    walk(&p, out);
                }
            } else {
                out.push(p);
            }
        }
    }
}

/// Result of one scan: findings (path:line: reason), the files visited and how many lines used an exemption.
#[derive(Debug, Default)]
struct Scan {
    hits: Vec<String>,
    files: Vec<String>,
    exempt_lines: usize,
}

fn scan(root: &Path) -> Scan {
    let mut paths = Vec::new();
    for r in ROOTS {
        walk(&root.join(r), &mut paths);
    }
    paths.sort();
    let mut scan = Scan::default();
    for f in &paths {
        let rel = f
            .strip_prefix(root)
            .unwrap_or(f)
            .to_string_lossy()
            .replace('\\', "/");
        scan.files.push(rel.clone());
        // Binary or non-UTF-8 files are not distributable text; they are skipped rather than guessed at.
        let Ok(text) = std::fs::read_to_string(f) else {
            continue;
        };
        let detector = DETECTOR_FILES.contains(&rel.as_str());
        let mut marked_before = false;
        for (n, line) in text.lines().enumerate() {
            let marked = detector && line.contains(MARKER);
            // A marker exempts its own line and the line right after it, so it can sit above the literal it
            // justifies (`rustfmt` keeps a leading comment there) or trail it.
            if marked || (detector && marked_before) {
                // Only a line that would otherwise have been a finding counts, so the cap measures real exemptions.
                if bad(line).is_some() {
                    scan.exempt_lines += 1;
                }
                marked_before = marked;
                continue;
            }
            marked_before = marked;
            if let Some(why) = bad(line) {
                scan.hits.push(format!("{rel}:{}: {why}", n + 1));
            }
        }
    }
    scan
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn scrub_distributable_tree() {
    let root = root();
    let scan = scan(&root);

    // Cannot pass vacuously: the scan must really walk the source, the tests, the web, the fixtures and the docs.
    assert!(
        scan.files.len() > 100,
        "scan covered only {} files",
        scan.files.len()
    );
    for required in [
        "crates/agentglimd/src/logging.rs",
        "crates/agentglimd/src/store/mod.rs",
        "crates/agentglimd/src/core/bus.rs",
        "crates/agentglimd/tests/scrub.rs",
        "crates/agentglimd/tests/privacy.rs",
        "docs/lifecycle.md",
    ] {
        assert!(
            scan.files.iter().any(|f| f == required),
            "scan missed {required}"
        );
    }
    assert!(
        scan.files
            .iter()
            .any(|f| f.starts_with("fixtures/") && f.ends_with("expected.json")),
        "scan missed the adapter fixtures"
    );
    assert!(
        scan.files.iter().any(|f| f.starts_with("web/")),
        "scan missed the web assets"
    );

    // Every adapter fixture set is present and complete (unchanged assertion from the fixtures-only gate).
    let expected: Vec<_> = scan
        .files
        .iter()
        .filter(|f| f.ends_with("expected.json"))
        .collect();
    for a in [
        "plans-harness",
        "claude-code",
        "codex",
        "opencode",
        "agy",
        "pi",
    ] {
        assert!(
            expected
                .iter()
                .any(|f| f.contains(&format!("fixtures/{a}/"))),
            "fixtures/{a}/<version>/expected.json missing"
        );
    }
    // Claude Code project slugs encode the cwd; a real home dir shows up as -home-<name>-.
    for f in &scan.files {
        assert!(
            !f.contains("-home-") && !f.contains("-Users-"),
            "{f}: home path in file name"
        );
    }

    assert!(
        scan.exempt_lines <= MAX_EXEMPT_LINES,
        "{} exempt lines, cap is {MAX_EXEMPT_LINES}",
        scan.exempt_lines
    );
    // The scan is line-exact: a hit is a `path:line: reason`. Only the declared cross-owner findings may remain.
    let mut found: Vec<(String, String)> = scan
        .hits
        .iter()
        .map(|h| {
            let (loc, why) = h.rsplit_once(": ").expect("hit has a reason");
            let (file, _line) = loc.rsplit_once(':').expect("hit has a line");
            (file.to_string(), why.to_string())
        })
        .collect();
    found.sort();
    let mut reported: Vec<(String, String)> = REPORTED_CROSS_OWNER
        .iter()
        .map(|(f, w)| ((*f).to_string(), (*w).to_string()))
        .collect();
    reported.sort();
    assert_eq!(
        found, reported,
        "scrub findings changed: {:?} (a new finding must be fixed; a fixed cross-owner finding must be removed \
         from REPORTED_CROSS_OWNER)",
        scan.hits
    );
    for h in &scan.hits {
        eprintln!("scrub: reported cross-owner finding (not fixed here): {h}");
    }
}

#[test]
fn scrub_detector_works() {
    assert_eq!(bad(&format!("see {}x/y", "/home/")), Some("home path")); // scrub-allow: detector literal
    assert_eq!(bad(&format!("see {}x/y", "/Users/")), Some("home path")); // scrub-allow: detector literal
    assert_eq!(bad("mail a.b@example.org now"), Some("email")); // scrub-allow: detector fixture address
    assert_eq!(bad("plain text"), None);
    // URLs and scp-style remotes are not addresses.
    assert_eq!(bad("https://x.test/a@b"), None);
    assert_eq!(bad("git@github.com:o/r.git"), None);
}

/// Negative self-test: every canary shape is detected in a temporary copy of the layout, and the `scrub-allow`
/// marker only exempts a single marked line in a detector file. Canaries are assembled at runtime so this file
/// stays clean.
#[test]
fn scrub_finds_planted_canary_in_a_copy() {
    let at = char::from_u32(0x40).expect("U+0040");
    let email = format!("planted.user7c1{at}{}.{}", "example", "test");
    let home = format!("{}me{}{}", "/ho", "/", "planted-home/work");
    let key = format!("{}{}", "s", "k-ant-planted9a8b7c6d5e4f3g2h");
    let token = format!("{}{}", "gh", "p_planted9a8b7c6d5e4f3g2h");

    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();
    let write = |rel: &str, body: &str| {
        let p = base.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
    };
    write(
        "crates/agentglimd/src/planted.rs",
        &format!("const A: &str = \"{email}\";\n"),
    );
    write(
        "crates/agentglimd/tests/planted.rs",
        &format!("let p = \"{home}\";\n"),
    );
    write("web/planted.ts", &format!("const key = \"{key}\";\n"));
    write(
        "fixtures/planted/1/record.jsonl",
        &format!("{{\"t\":\"{token}\"}}\n"),
    );
    write("docs/planted.md", &format!("contact {email}\n"));
    // A canary inside a detector file is still caught without the marker...
    write(
        "crates/agentglimd/src/logging.rs",
        &format!("let p = \"{home}\";\n"),
    );
    // ...while a marker exempts its own line and the one right after it, and nothing beyond that.
    write(
        "crates/agentglimd/tests/scrub.rs",
        &format!(
            "const NEEDLE: &str = \"{home}\"; {MARKER} detector literal\nconst OK: &str = \"clean\";\nconst X: &str = \"{home}\";\n"
        ),
    );
    // A file that is not a detector file cannot exempt itself.
    write(
        "web/marked.ts",
        &format!("const p = \"{home}\"; {MARKER} not allowed here\n"),
    );
    // Clean sibling: must not be reported.
    write("docs/clean.md", "no secrets here\n");

    let scan = scan(base);
    let hit_lines: Vec<_> = scan.hits.iter().map(|h| h.as_str()).collect();
    let expect = |needle: &str| {
        assert!(
            hit_lines.iter().any(|h| h.contains(needle)),
            "detector missed a planted canary in {needle}: {:?}",
            scan.hits
        );
    };
    expect("crates/agentglimd/src/planted.rs");
    expect("crates/agentglimd/tests/planted.rs");
    expect("web/planted.ts");
    expect("fixtures/planted/1/record.jsonl");
    expect("docs/planted.md");
    // Unmarked canary inside a detector file: caught.
    expect("crates/agentglimd/src/logging.rs:1");
    // The line right after a marker is covered by it; the one after that is caught.
    assert!(
        !scan
            .hits
            .iter()
            .any(|h| h.starts_with("crates/agentglimd/tests/scrub.rs:2")),
        "the line after a marker must be exempt: {:?}",
        scan.hits
    );
    expect("crates/agentglimd/tests/scrub.rs:3");
    // Marker in a non-detector file: not exempt.
    expect("web/marked.ts");
    // Clean file: never reported.
    assert!(
        !hit_lines.iter().any(|h| h.contains("docs/clean.md")),
        "false positive: {:?}",
        scan.hits
    );
    assert_eq!(
        scan.exempt_lines, 1,
        "exactly the one marked line that would otherwise be a finding"
    );
    // Nothing leaks into the output: hits carry a location and a reason, never the value.
    for h in &scan.hits {
        assert!(
            !h.contains(&email) && !h.contains(&home) && !h.contains(&key) && !h.contains(&token)
        );
    }
}
