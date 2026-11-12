//! Ollama probe: `GET /api/ps` (read-only).

use super::http;
use crate::core::{BoxFut, Runtime, RuntimeState};
use serde_json::Value;

pub struct Ollama {
    pub base: String,
}

impl Runtime for Ollama {
    fn id(&self) -> &'static str {
        "ollama"
    }
    fn probe(&self) -> BoxFut<'_, RuntimeState> {
        Box::pin(async move {
            match http::get(&self.base, "/api/ps").await {
                Ok(r) if r.status == 200 => parse_ps(&r.body).unwrap_or(RuntimeState::Down),
                _ => RuntimeState::Down,
            }
        })
    }
}

/// `{"models":[{"name","size","size_vram",..}]}` -> Up. vram = sum size_vram, ram = sum (size - size_vram).
pub fn parse_ps(body: &[u8]) -> Option<RuntimeState> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let list = v.get("models")?.as_array()?;
    let (mut models, mut vram, mut ram) = (Vec::new(), 0u64, 0u64);
    for m in list {
        if let Some(n) = m
            .get("name")
            .or_else(|| m.get("model"))
            .and_then(Value::as_str)
        {
            models.push(n.to_string());
        }
        let size = m.get("size").and_then(Value::as_u64).unwrap_or(0);
        let sv = m.get("size_vram").and_then(Value::as_u64).unwrap_or(0);
        vram += sv;
        ram += size.saturating_sub(sv);
    }
    Some(RuntimeState::Up {
        models,
        vram_bytes: vram,
        ram_bytes: ram,
        slots: 0,
        ctx: 0,
        tps: 0.0,
    })
}
