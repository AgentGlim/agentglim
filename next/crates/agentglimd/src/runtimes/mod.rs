//! Local model runtimes (Runtime impls): read-only probes only. Never start, stop or load models.

pub mod http;
pub mod llamacpp;
pub mod ollama;
pub mod strata;

use crate::config::Config;
use crate::core::{BoxFut, Runtime, RuntimeState};
use std::path::PathBuf;
use std::sync::Arc;

pub const DEFAULT_OLLAMA: &str = "http://127.0.0.1:11434";
pub const DEFAULT_LLAMACPP: &str = "http://127.0.0.1:8080";
pub const DEFAULT_STRATA: &str = "http://127.0.0.1:8081";

/// Ollama, llama.cpp and Strata, with base URLs from `cfg.runtime_urls` or the defaults above.
pub fn registry(cfg: &Config) -> Vec<Arc<dyn Runtime>> {
    let url = |id: &str, def: &str| {
        cfg.runtime_urls
            .get(id)
            .cloned()
            .unwrap_or_else(|| def.into())
    };
    vec![
        Arc::new(ollama::Ollama {
            base: url("ollama", DEFAULT_OLLAMA),
        }),
        Arc::new(llamacpp::LlamaCpp {
            base: url("llamacpp", DEFAULT_LLAMACPP),
        }),
        Arc::new(strata::Strata {
            base: url("strata", DEFAULT_STRATA),
            flags_dir: cfg.flags_dir.as_ref().map(PathBuf::from),
        }),
    ]
}

/// Fixed-state runtime for tests.
pub struct StaticRuntime(pub &'static str, pub RuntimeState);

impl Runtime for StaticRuntime {
    fn id(&self) -> &'static str {
        self.0
    }
    fn probe(&self) -> BoxFut<'_, RuntimeState> {
        let s = self.1.clone();
        Box::pin(async move { s })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn static_runtime_probes() {
        let r = StaticRuntime("strata", RuntimeState::OwnerOff);
        assert_eq!(r.probe().await, RuntimeState::OwnerOff);
        let ids: Vec<_> = registry(&Config::default())
            .iter()
            .map(|r| r.id())
            .collect();
        assert_eq!(ids, ["ollama", "llamacpp", "strata"]);
    }

    #[tokio::test]
    async fn non_loopback_url_is_down_without_network() {
        let mut cfg = Config::default();
        cfg.runtime_urls
            .insert("ollama".into(), "http://192.0.2.1:11434".into());
        assert_eq!(registry(&cfg)[0].probe().await, RuntimeState::Down);
    }
}
