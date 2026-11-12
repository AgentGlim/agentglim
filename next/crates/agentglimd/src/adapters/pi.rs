//! pi coding agent adapter: tails `~/.pi/agent/sessions/<project>/<ts>_<uuid>.jsonl` (read-only).
//! format: unverified against a real install (field names follow pi's published session-format
//! docs: header `{"type":"session","version":3,"id","timestamp","cwd"}`, then `message` entries
//! wrapping `{role, content, model, usage{input,output,cacheRead,cacheWrite,cost{total}}}`).

use super::{stem, FileState, JsonlTail, RootSpec};
use crate::core::{
    Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, FileOffset, ItemKind,
    Source, SourceCheckpoint, SourceKind,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const ID: &str = "pi";

pub struct Pi {
    spec: RootSpec,
    home: PathBuf,
    tail: JsonlTail,
    history_days: u32,
}

impl Pi {
    pub fn new(root: Option<PathBuf>, home: &Path, history_days: u32) -> Self {
        Self {
            spec: RootSpec {
                over: root,
                default_rel: ".pi/agent/sessions",
            },
            home: home.to_path_buf(),
            tail: JsonlTail::default(),
            history_days,
        }
    }
}

fn f(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn map_line(rel: &str, st: &mut FileState, v: &Value, out: &mut Vec<BatchItem>) {
    let ts = v.get("timestamp").cloned().unwrap_or(Value::Null);
    let sid = |st: &FileState| {
        st.session.clone().unwrap_or_else(|| {
            let s = stem(rel);
            s.rsplit('_').next().unwrap_or(&s).to_string()
        })
    };
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "session" => {
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                st.session = Some(id.to_string());
            }
            if !st.announced {
                st.announced = true;
                out.push(BatchItem {
                    kind: ItemKind::Session,
                    session: sid(st),
                    data: json!({"project": rel.split('/').next(), "cwd": v.get("cwd"),
                                 "version": v.get("version"), "started": ts}),
                });
            }
        }
        "model_change" => {
            if let Some(m) = v.get("modelId").and_then(Value::as_str) {
                st.model = Some(m.to_string());
            }
        }
        "message" => {
            let m = v.get("message").cloned().unwrap_or(Value::Null);
            let role = m.get("role").and_then(Value::as_str).unwrap_or("?");
            if let Some(model) = m.get("model").and_then(Value::as_str) {
                st.model = Some(model.to_string());
            }
            let tools: Vec<&str> = m
                .get("content")
                .and_then(Value::as_array)
                .map(|c| {
                    c.iter()
                        .filter(|p| p.get("type").and_then(Value::as_str) == Some("toolCall"))
                        .filter_map(|p| p.get("name").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            let (role_out, tool_result) = match role {
                "toolResult" => ("tool", true),
                r => (r, false),
            };
            out.push(BatchItem {
                kind: ItemKind::Step,
                session: sid(st),
                data: json!({"role": role_out, "ts": ts, "model": st.model,
                             "tool_result": tool_result, "tools": tools}),
            });
            if let Some(u) = m.get("usage") {
                out.push(BatchItem {
                    kind: ItemKind::Spend,
                    session: sid(st),
                    data: json!({"model": st.model, "ts": ts,
                                 "input_tokens": f(u, "input"),
                                 "output_tokens": f(u, "output"),
                                 "cache_read_tokens": f(u, "cacheRead"),
                                 "cache_write_tokens": f(u, "cacheWrite"),
                                 "cost": u.get("cost").and_then(|c| c.get("total"))}),
                });
            }
        }
        _ => {}
    }
}

impl Source for Pi {
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
                "session" | "message" | "model_change"
            ) || v.get("message").is_some()
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

impl Pi {
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
