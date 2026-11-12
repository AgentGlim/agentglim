//! Agentglim daemon library: core types, store, auth, API, adapters and logging.

pub mod adapters;
pub mod api;
pub mod auth;
pub mod config;
pub mod core;
pub mod logging;
pub mod runtimes;
pub mod store;

/// Crate version reported by `/api/v1/health`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// API contract version, sent as the `api_version` header on every response.
pub const API_VERSION: u32 = 1;
