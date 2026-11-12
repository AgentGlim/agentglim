//! Google Antigravity (agy) adapter: tails per-conversation transcripts
//! `<root>/<conversation-id>/.system_generated/logs/transcript.jsonl` (read-only).
//! format: unverified. The directory layout comes from third-party write-ups (no official spec);
//! the line schema below is a best guess and tolerant of missing fields. Root default is
//! `~/.gemini/antigravity-cli/brain`; the IDE variant uses `~/.gemini/antigravity-ide/brain`
//! (override with `"roots": {"agy": "..."}`).

use super::{FileState, JsonlTail, RootSpec};
use crate::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileOffset, ItemKind,
    Source, SourceCheckpoint, SourceKind,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ID: &str = "agy";

pub struct Agy {
    spec: RootSpec,
    home: PathBuf,
    tail: JsonlTail,
    history_days: u32,
}

impl Agy {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        Self {
            spec: RootSpec {
                over: root,
                default_rel: ".gemini/antigravity-cli/brain",
            },
            home: home.to_path_buf(),
            tail: JsonlTail::with_suffix("transcript.jsonl"),
            history_days,
        }
    }
}

fn n(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

// format: unverified
fn map_line(rel: &str, st: &mut FileState, v: &Value, out: &mut Vec<BatchItem>) {
    let sid = rel.split('/').next().unwrap_or(rel).to_string();
    let ts = v
        .get("timestamp")
        .or_else(|| v.get("ts"))
        .cloned()
        .unwrap_or(Value::Null);
    let kind = v
        .get("type")
        .or_else(|| v.get("role"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let role = match kind {
        "user" | "user_input" | "user_message" => "user",
        "assistant" | "model" | "planner_response" | "agent_response" => "assistant",
        "tool_call" | "tool" | "tool_result" => "tool",
        _ => return,
    };
    if let Some(m) = v.get("model").and_then(Value::as_str) {
        st.model = Some(m.to_string());
    }
    if !st.announced {
        st.announced = true;
        out.push(BatchItem {
            kind: ItemKind::Session,
            session: sid.clone(),
            data: json!({"conversation": sid, "started": ts}),
        });
    }
    out.push(BatchItem {
        kind: ItemKind::Step,
        session: sid.clone(),
        data: json!({"role": role, "ts": ts, "model": st.model,
                     "tool": v.get("name").or_else(|| v.get("tool"))}),
    });
    if let Some(u) = v.get("usage") {
        out.push(BatchItem {
            kind: ItemKind::Spend,
            session: sid,
            data: json!({"model": st.model, "ts": ts,
                         "input_tokens": n(u, "input_tokens"),
                         "output_tokens": n(u, "output_tokens")}),
        });
    }
}

impl Source for Agy {
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
                v.get("type")
                    .or_else(|| v.get("role"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                "user"
                    | "user_input"
                    | "user_message"
                    | "assistant"
                    | "model"
                    | "planner_response"
                    | "agent_response"
                    | "tool_call"
                    | "tool"
                    | "tool_result"
            ) || v.get("timestamp").is_some()
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

impl Agy {
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
