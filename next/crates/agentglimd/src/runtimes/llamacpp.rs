//! llama.cpp server probe: `GET /health` then `GET /slots` (read-only).

use super::http;
use crate::core::{BoxFut, Runtime, RuntimeState};
use serde_json::Value;

pub struct LlamaCpp {
    pub base: String,
}

impl Runtime for LlamaCpp {
    fn id(&self) -> &'static str {
        "llamacpp"
    }
    fn probe(&self) -> BoxFut<'_, RuntimeState> {
        Box::pin(probe_llamacpp(&self.base))
    }
}

/// Shared by llama.cpp and Strata (llama.cpp-compatible). `/health` must be 200; `/slots` may be disabled.
pub async fn probe_llamacpp(base: &str) -> RuntimeState {
    match http::get(base, "/health").await {
        Ok(r) if r.status == 200 => {}
        _ => return RuntimeState::Down,
    }
    let slots = match http::get(base, "/slots").await {
        Ok(r) if r.status == 200 => r.body,
        _ => Vec::new(),
    };
    parse_slots(&slots)
}

/// `[{"id","n_ctx","model",..}]` -> Up{slots, ctx (n_ctx of the first slot), models (deduped)}.
pub fn parse_slots(body: &[u8]) -> RuntimeState {
    let list: Vec<Value> = serde_json::from_slice(body).unwrap_or_default();
    let mut models: Vec<String> = Vec::new();
    for s in &list {
        if let Some(m) = s.get("model").and_then(Value::as_str) {
            if !m.is_empty() && !models.iter().any(|x| x == m) {
                models.push(m.to_string());
            }
        }
    }
    let ctx = list
        .first()
        .and_then(|s| s.get("n_ctx"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    RuntimeState::Up {
        models,
        vram_bytes: 0,
        ram_bytes: 0,
        slots: list.len() as u32,
        ctx: u32::try_from(ctx).unwrap_or(u32::MAX),
        tps: 0.0,
    }
}
