//! JSON-lines logs with size rotation (10 MB x 5 files) and the shared secret redactor.
//!
//! [`redact`] / [`redact_value`] are the one deterministic redaction policy of the daemon: the rotating log writer
//! uses them on every line, and the store uses them on event payloads, session ids and audit rows *before* the
//! SQLite transaction and before the in-process broadcast (see `Store::commit_batch`, `Store::audit`,
//! `Bus::publish`). They replace only the sensitive run, never the record, and are idempotent, so the same value can
//! pass through them more than once.

use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILES: usize = 5;
pub const LOG_NAME: &str = "agentglimd.log";

/// Replacement for an opaque secret value.
pub const REDACTED: &str = "[redacted]";
/// Replacement for a whole email address.
pub const REDACTED_EMAIL: &str = "[redacted-email]";

/// The home directory used for path redaction: `$HOME`, or `%USERPROFILE%` on Windows. Read once, because it is on
/// the hot path of every stored event. A one-character or empty value is ignored.
pub fn redaction_home() -> Option<&'static str> {
    static HOME: OnceLock<Option<String>> = OnceLock::new();
    HOME.get_or_init(|| {
        ["HOME", "USERPROFILE"]
            .iter()
            .find_map(|k| std::env::var(k).ok())
            .filter(|h| h.len() > 1)
    })
    .as_deref()
}

/// Size-rotating writer: `name`, `name.1` .. `name.{max_files-1}`; the oldest is dropped.
pub struct RotatingWriter {
    dir: PathBuf,
    name: String,
    max_bytes: u64,
    max_files: usize,
    file: File,
    size: u64,
    home: Option<String>,
}

impl RotatingWriter {
    pub fn new(dir: &Path, name: &str, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(name);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            max_bytes,
            max_files: max_files.max(1),
            file,
            size,
            home: std::env::var("HOME").ok().filter(|h| h.len() > 1),
        })
    }

    fn rotated(&self, i: usize) -> PathBuf {
        if i == 0 {
            self.dir.join(&self.name)
        } else {
            self.dir.join(format!("{}.{i}", self.name))
        }
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        let last = self.rotated(self.max_files - 1);
        if last.exists() {
            fs::remove_file(&last)?;
        }
        for i in (0..self.max_files - 1).rev() {
            let from = self.rotated(i);
            if from.exists() {
                fs::rename(&from, self.rotated(i + 1))?;
            }
        }
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.rotated(0))?;
        self.size = 0;
        Ok(())
    }
}

impl Write for RotatingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = redact(&String::from_utf8_lossy(buf), self.home.as_deref());
        let bytes = text.as_bytes();
        if self.size > 0 && self.size + bytes.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(bytes)?;
        self.size += bytes.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn is_tok(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+' | '/')
}

/// Redaction policy for one piece of text: home paths, `Bearer` headers, prefixed API keys and email addresses.
/// Everything else is returned unchanged.
pub fn redact(input: &str, home: Option<&str>) -> String {
    let mut s = input.to_string();
    if let Some(h) = home.filter(|h| !h.is_empty()) {
        s = s.replace(h, "~");
    }
    // scrub-allow: redactor path-prefix literal
    for prefix in ["/home/", "/Users/"] {
        s = replace_after(&s, prefix, is_path_seg, "~", true);
    }
    for prefix in ["Bearer ", "bearer ", "Basic ", "basic "] {
        s = replace_after(&s, prefix, is_tok, REDACTED, false);
    }
    // scrub-allow: redactor token-prefix literal
    for prefix in ["sk-", "ghp_", "xoxb-", "github_pat_"] {
        s = replace_after(&s, prefix, is_tok, REDACTED, false);
    }
    s = redact_context_tokens(&s);
    redact_emails(&s)
}

/// Words that name a credential in free text (`token`, `secret`, `password`, ...).
const CONTEXT_WORDS: [&str; 10] = [
    "token",
    "secret",
    "password",
    "passwd",
    "api key",
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "private key",
];

/// Replaces an opaque credential that follows a credential-naming word in free text, e.g. an install token quoted in
/// an audit detail (`token 6f1c...`). The run must be at least 20 characters and mix letters with digits, so a token
/// *count*, a timestamp or a plain `sha256` hash quoted next to an ordinary word is never touched.
fn redact_context_tokens(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for needle in CONTEXT_WORDS {
        let mut from = 0;
        while let Some(i) = lower[from..].find(needle) {
            let at = from + i;
            let end = at + needle.len();
            // Look a short way past the word (separators, quotes, a `=`) for the value.
            let limit = (end + 64).min(s.len());
            let mut j = end;
            while j < limit {
                let c = s[j..].chars().next().expect("in bounds");
                if is_tok(c) {
                    let run_len = s[j..]
                        .chars()
                        .take_while(|c| is_tok(*c))
                        .map(|c| c.len_utf8())
                        .sum::<usize>();
                    let run = &s[j..j + run_len];
                    let opaqueness = run.len() >= 20
                        && run.chars().any(|c| c.is_ascii_alphabetic())
                        && run.chars().any(|c| c.is_ascii_digit())
                        && !run.contains(REDACTED);
                    if opaqueness {
                        ranges.push((j, j + run_len));
                    }
                    // Either way this run is not the credential itself for this context word.
                    j += run_len.max(1);
                } else {
                    j += c.len_utf8();
                }
            }
            from = end;
        }
    }
    if ranges.is_empty() {
        return s.to_string();
    }
    ranges.sort_unstable();
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        if start < cursor {
            continue;
        }
        out.push_str(&s[cursor..start]);
        out.push_str(REDACTED);
        cursor = end;
    }
    out.push_str(&s[cursor..]);
    out
}

/// Redaction for text taken from the environment (log lines): uses [`redaction_home`].
pub fn redact_text(input: &str) -> String {
    redact(input, redaction_home())
}

/// Recursively redacts a JSON payload: every string value goes through [`redact`], and the value of a
/// secret-named key ([`is_secret_key`]) is replaced whole even when it does not look like a token. Keys, numbers,
/// booleans and nulls are kept, so the payload's structure and every non-secret field survive.
pub fn redact_value(value: &Value, home: Option<&str>) -> Value {
    match value {
        Value::String(s) => Value::String(redact(s, home)),
        Value::Array(items) => Value::Array(items.iter().map(|v| redact_value(v, home)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let redacted = if is_secret_key(k) {
                        redact_secret_value(v, home)
                    } else {
                        redact_value(v, home)
                    };
                    (k.clone(), redacted)
                })
                .collect::<Map<String, Value>>(),
        ),
        other => other.clone(),
    }
}

/// [`redact_value`] with the process home directory.
pub fn redact_json(value: &Value) -> Value {
    redact_value(value, redaction_home())
}

/// A secret-named key whose value is a string, or an object/array of them, is replaced with [`REDACTED`]. Non-string
/// scalars (a usage count under `*_tokens`, a boolean flag) stay, so token *counters* are never destroyed.
fn redact_secret_value(value: &Value, home: Option<&str>) -> Value {
    match value {
        Value::String(_) => Value::String(REDACTED.to_string()),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| match v {
                    Value::String(_) => Value::String(REDACTED.to_string()),
                    other => redact_value(other, home),
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), redact_secret_value(v, home)))
                .collect::<Map<String, Value>>(),
        ),
        other => other.clone(),
    }
}

/// JSON key names whose string value is a credential. Exact names plus the suffixes an adapter or API body uses.
/// `input_tokens`, `output_tokens` and other counters are deliberately *not* matched (they are plurals, and the
/// value rule only replaces strings), so spend data survives untouched.
pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    const EXACT: [&str; 14] = [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "cookie",
        "set-cookie",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "install_token",
        "private_key",
        "credentials",
    ];
    if EXACT.contains(&k.as_str()) {
        return true;
    }
    const SUFFIXES: [&str; 8] = [
        "_token",
        "-token",
        "_secret",
        "-secret",
        "_password",
        "_passwd",
        "_api_key",
        "_private_key",
    ];
    SUFFIXES.iter().any(|s| k.ends_with(s))
}

/// A path segment run: stops at a separator, whitespace or a JSON quote.
fn is_path_seg(c: char) -> bool {
    c != '/' && c != '"' && c != '\\' && !c.is_whitespace()
}

/// Email-shaped words: an alnum-ish local part, an at sign and a hostname domain. Words that carry a URL or
/// or scp-style separator (`/`, `:`, `@` inside) are left alone, so URLs and git remotes keep their shape.
fn redact_emails(s: &str) -> String {
    if !s.contains('@') {
        return s.to_string();
    }
    // Walk word by word, copying the original whitespace runs verbatim, so a string with an address in it keeps its
    // spacing and newlines unchanged.
    let mut out = String::with_capacity(s.len());
    let mut word_start: Option<usize> = None;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() {
            if let Some(start) = word_start.take() {
                out.push_str(&redact_email_word(&s[start..i]));
            }
            out.push(c);
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }
    if let Some(start) = word_start {
        out.push_str(&redact_email_word(&s[start..]));
    }
    out
}

fn redact_email_word(word: &str) -> String {
    const TRIM: [char; 14] = [
        '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '<', '>',
    ];
    let core = word.trim_matches(|c: char| TRIM.contains(&c) || c == '"' || c == '\'');
    let core = core.trim_end_matches('.');
    if core.is_empty() || core.contains('/') || core.contains('\\') || core.contains(':') {
        return word.to_string();
    }
    let Some((local, domain)) = core.split_once('@') else {
        return word.to_string();
    };
    let local_ok = !local.is_empty()
        && local.len() <= 64
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-'));
    let labels: Vec<&str> = domain.split('.').collect();
    let domain_ok = labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        && labels
            .last()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    if !(local_ok && domain_ok) {
        return word.to_string();
    }
    word.replacen(core, REDACTED_EMAIL, 1)
}

/// For each `prefix` followed by >= 8 (or >= 1 for paths) matching chars, replace the run.
fn replace_after(
    s: &str,
    prefix: &str,
    ok: impl Fn(char) -> bool,
    with: &str,
    drop_prefix: bool,
) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let min = if drop_prefix { 1 } else { 8 };
    while let Some(i) = rest.find(prefix) {
        out.push_str(&rest[..i]);
        let after = &rest[i + prefix.len()..];
        let run: usize = after
            .chars()
            .take_while(|c| ok(*c))
            .map(|c| c.len_utf8())
            .sum();
        let nchars = after[..run].chars().count();
        if nchars >= min && !after[..run].contains(REDACTED) {
            if !drop_prefix {
                out.push_str(prefix);
            }
            out.push_str(with);
        } else {
            out.push_str(prefix);
            out.push_str(&after[..run]);
        }
        rest = &after[run..];
    }
    out.push_str(rest);
    out
}

/// Installs the global JSON subscriber writing to `<data>/logs/agentglimd.log`.
pub fn init(data_dir: &Path) -> io::Result<tracing_appender::non_blocking::WorkerGuard> {
    let w = RotatingWriter::new(&data_dir.join("logs"), LOG_NAME, MAX_BYTES, MAX_FILES)?;
    let (nb, guard) = tracing_appender::non_blocking(w);
    let filter = tracing_subscriber::EnvFilter::try_from_env("AGENTGLIM_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_writer(nb)
        .with_current_span(false)
        .try_init();
    Ok(guard)
}

pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join(LOG_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_secrets_and_paths() {
        let r = redact(
            "auth Bearer abcdefgh12345678 key sk-ABCDEFGHIJKLMNOP path /home/someone/x and /Users/a/b sk-1", // scrub-allow: redactor fixtures use home-path literals
            None,
        );
        assert!(!r.contains("abcdefgh12345678"), "{r}");
        assert!(!r.contains("ABCDEFGHIJKLMNOP"), "{r}");
        assert!(!r.contains("someone"), "{r}");
        assert!(r.contains("~/x") && r.contains("~/b"), "{r}");
        assert!(r.contains("sk-1"), "short ids are kept: {r}");
        assert_eq!(redact("/opt/x HOMEDIR/y", Some("HOMEDIR")), "/opt/x ~/y");
    }

    #[test]
    fn redacts_emails_and_keeps_urls() {
        let r = redact(
            "mail a.b+tag@example.org, see https://x.test/a@b and git@github.com:o/r.git", // scrub-allow: redactor fixture address
            None,
        );
        assert!(!r.contains("a.b+tag@example.org"), "{r}"); // scrub-allow: redactor fixture address
        assert!(r.contains(REDACTED_EMAIL), "{r}");
        assert!(r.contains("https://x.test/a@b"), "{r}");
        assert!(r.contains("git@github.com:o/r.git"), "{r}");
    }

    #[test]
    fn context_word_redacts_opaque_token_but_not_counts() {
        let token = format!(
            "{}{}",
            "6f1c4b8a9d2e5073", "a8b1c6d40e9f2a7b3c4d5e6f70819203"
        );
        let r = redact(&format!("token {token} and key sk-{token}"), None);
        assert!(!r.contains(&token), "{r}");
        assert!(r.contains("token [redacted]"), "{r}");
        // A token *count* and a content hash quoted next to an ordinary word survive.
        let count = format!(
            "input_tokens {} and sha256 {}",
            "123456789012345678",
            "a".repeat(64)
        );
        assert_eq!(redact(&count, None), count);
    }

    #[test]
    fn json_rule_keeps_structure_and_counters() {
        let v = json!({
            "text": "kept",
            "input_tokens": 7,
            "tokens": {"input": 10, "output": 5},
            "install_token": "a".repeat(64),
            "nested": [{"secret": "value"}, "plain"]
        });
        let r = redact_json(&v);
        assert_eq!(r["text"], json!("kept"));
        assert_eq!(r["input_tokens"], json!(7));
        assert_eq!(r["tokens"]["input"], json!(10));
        assert_eq!(r["install_token"], json!(REDACTED));
        assert_eq!(r["nested"][0]["secret"], json!(REDACTED));
        assert_eq!(r["nested"][1], json!("plain"));
        // idempotent: a second pass is a no-op
        assert_eq!(redact_json(&r), r);
    }
}
