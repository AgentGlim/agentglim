//! Codex adapter: tails `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (read-only).

use super::{num, stem, JsonlTail, RootSpec};
use crate::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileOffset, ItemKind,
    Source, SourceCheckpoint, SourceKind,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ID: &str = "codex";

pub struct Codex {
    spec: RootSpec,
    home: PathBuf,
    tail: JsonlTail,
    history_days: u32,
}

impl Codex {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        Self {
            spec: RootSpec {
                over: root,
                default_rel: ".codex/sessions",
            },
            home: home.to_path_buf(),
            tail: JsonlTail::default(),
            history_days,
        }
    }
}

/// Session id from `rollout-<ts>-<uuid>.jsonl` (the uuid is the last 36 chars), else the stem.
/// Used when the `session_meta` line is not in view (e.g. after offsets were restored).
fn file_session(rel: &str) -> String {
    let s = stem(rel);
    if s.starts_with("rollout-") && s.len() >= 36 && s.is_char_boundary(s.len() - 36) {
        s[s.len() - 36..].to_string()
    } else {
        s
    }
}

fn map_line(rel: &str, st: &mut super::FileState, v: &Value, out: &mut Vec<BatchItem>) {
    let ts = v.get("timestamp").cloned().unwrap_or(Value::Null);
    let p = v.get("payload").cloned().unwrap_or(Value::Null);
    let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
    let sid = |st: &super::FileState| st.session.clone().unwrap_or_else(|| file_session(rel));
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "session_meta" => {
            if let Some(id) = p.get("id").and_then(Value::as_str) {
                st.session = Some(id.to_string());
            }
            if !st.announced {
                st.announced = true;
                out.push(BatchItem {
                    kind: ItemKind::Session,
                    session: sid(st),
                    data: json!({"cwd": p.get("cwd"), "cli_version": p.get("cli_version"),
                                 "originator": p.get("originator"), "started": ts}),
                });
            }
        }
        "turn_context" => {
            if let Some(m) = p.get("model").and_then(Value::as_str) {
                st.model = Some(m.to_string());
            }
        }
        "response_item" => {
            let (role, name) = match ptype {
                "message" => (p.get("role").and_then(Value::as_str).unwrap_or("?"), None),
                "function_call" | "custom_tool_call" | "local_shell_call" => {
                    ("tool", p.get("name").and_then(Value::as_str))
                }
                _ => return,
            };
            out.push(BatchItem {
                kind: ItemKind::Step,
                session: sid(st),
                data: json!({"role": role, "ts": ts, "model": st.model, "tool": name}),
            });
        }
        "event_msg" if ptype == "token_count" => {
            let Some(u) = p.get("info").and_then(|i| i.get("last_token_usage")) else {
                return;
            };
            out.push(BatchItem {
                kind: ItemKind::Spend,
                session: sid(st),
                data: json!({"model": st.model, "ts": ts,
                             "input_tokens": num(u, "input_tokens"),
                             "cached_input_tokens": num(u, "cached_input_tokens"),
                             "output_tokens": num(u, "output_tokens"),
                             "reasoning_output_tokens": num(u, "reasoning_output_tokens")}),
            });
        }
        _ => {}
    }
}

impl Source for Codex {
    fn id(&self) -> &'static str {
        ID
    }
    fn kind(&self) -> SourceKind {
        SourceKind::CodingAgent
    }
    fn detect(&self, env: &Env) -> Detection {
        let root = self.spec.resolve(&env.home);
        if !root.is_dir() {
            return self.spec.detect(&env.home);
        }
        // Bounded, resumable and charged: a matrix of malformed candidates cannot spend more than one allowance,
        // and a supported file behind more entries than one pass allows is still found on a later call.
        self.tail.detect(&root, ID, |v| {
            matches!(
                v.get("type").and_then(Value::as_str).unwrap_or(""),
                "session_meta" | "turn_context" | "response_item" | "event_msg"
            ) || v.get("payload").is_some()
        })
    }
    fn capabilities(&self) -> Caps {
        Caps::WATCH
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move {
            let root = self.spec.resolve(&self.home);
            Ok(self.tail.poll(&root, since, self.history_days, map_line))
        })
    }
    fn offsets(&self) -> Vec<FileOffset> {
        self.tail.offsets()
    }
    fn restore_offsets(&self, offsets: Vec<FileOffset>) {
        self.tail.restore(offsets)
    }
    fn checkpoint(&self) -> SourceCheckpoint {
        self.tail.checkpoint()
    }
    fn supports_checkpoint_delta(&self) -> bool {
        true
    }
    fn checkpoint_delta(&self) -> crate::core::CheckpointDelta {
        self.tail.checkpoint_delta()
    }
    fn full_checkpoint(&self) -> SourceCheckpoint {
        self.tail.full_checkpoint()
    }
    fn restore_checkpoint(&self, checkpoint: SourceCheckpoint) {
        self.tail.restore_checkpoint(checkpoint)
    }
    fn discovery_epoch(&self) -> Option<u64> {
        self.tail.discovery_epoch()
    }
    fn retains_unseen_paths(&self) -> bool {
        self.tail.retains_unseen_paths()
    }
    fn discovery_complete(&self) -> bool {
        self.tail.discovery_complete()
    }
    fn restore_removed(&self, removed: &[crate::core::RemovedPath]) {
        self.tail.restore_removed(removed)
    }
    fn begin_turn(&self, allowance: std::sync::Arc<crate::core::TurnBudget>) {
        self.tail.begin_turn(allowance)
    }
    fn end_turn(&self) {
        self.tail.end_turn()
    }
    fn identities(&self) -> Vec<crate::core::RecordKey> {
        self.tail.identities()
    }
}

impl Codex {
    /// Narrow adapter work counters (entries, stats, opens, file visits, verification bytes, sweep outcome) for the
    /// independent oracle. Cumulative for this adapter instance.
    pub fn work_stats(&self) -> super::WorkStats {
        self.tail.work_stats()
    }

    /// Discovery completeness of the most recent bounded sweep (never "complete" before the first successful one).
    pub fn discovery_complete_now(&self) -> bool {
        self.tail.discovery_complete()
    }
}
