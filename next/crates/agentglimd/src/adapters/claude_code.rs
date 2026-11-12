//! Claude Code adapter: tails `~/.claude/projects/<slug>/<session>.jsonl` (read-only).

use super::{num, stem, JsonlTail, RootSpec};
use crate::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileOffset, ItemKind,
    Source, SourceCheckpoint, SourceKind,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ID: &str = "claude-code";

pub struct ClaudeCode {
    spec: RootSpec,
    home: PathBuf,
    tail: JsonlTail,
    history_days: u32,
}

impl ClaudeCode {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        Self {
            spec: RootSpec {
                over: root,
                default_rel: ".claude/projects",
            },
            home: home.to_path_buf(),
            tail: JsonlTail::default(),
            history_days,
        }
    }
}

fn map_line(rel: &str, st: &mut super::FileState, v: &Value, out: &mut Vec<BatchItem>) {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return;
    }
    let sid = v
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| st.session.clone())
        .unwrap_or_else(|| stem(rel));
    st.session = Some(sid.clone());
    let ts = v.get("timestamp").cloned().unwrap_or(Value::Null);
    if !st.announced {
        st.announced = true;
        let project = rel.split('/').next().unwrap_or("").to_string();
        out.push(BatchItem {
            kind: ItemKind::Session,
            session: sid.clone(),
            data: json!({"project": project, "cwd": v.get("cwd"), "version": v.get("version"),
                         "git_branch": v.get("gitBranch"), "started": ts}),
        });
    }
    let msg = v.get("message").cloned().unwrap_or(Value::Null);
    let model = msg.get("model").and_then(Value::as_str);
    let tool_result = msg
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|c| {
            c.iter()
                .any(|p| p.get("type").and_then(Value::as_str) == Some("tool_result"))
        });
    let tools: Vec<&str> = msg
        .get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|p| p.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    out.push(BatchItem {
        kind: ItemKind::Step,
        session: sid.clone(),
        data: json!({"role": kind, "ts": ts, "model": model, "tool_result": tool_result,
                     "tools": tools}),
    });
    if let Some(u) = msg.get("usage") {
        out.push(BatchItem {
            kind: ItemKind::Spend,
            session: sid,
            data: json!({"model": model, "ts": ts,
                         "input_tokens": num(u, "input_tokens"),
                         "output_tokens": num(u, "output_tokens"),
                         "cache_read_tokens": num(u, "cache_read_input_tokens"),
                         "cache_write_tokens": num(u, "cache_creation_input_tokens")}),
        });
    }
}

impl Source for ClaudeCode {
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
            v.get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t == "user" || t == "assistant")
                || v.get("sessionId").is_some()
                || v.get("message").is_some()
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

impl ClaudeCode {
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
