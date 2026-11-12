//! Axum router: auth + Host check middleware, `api_version` header, /api/v1 routes.

pub mod errors;
pub mod v1;

use crate::auth::tokens;
use crate::config::Config;
use crate::core::bus::Bus;
use crate::core::tasks::TaskRunner;
use crate::core::{Runtime, Source};
use crate::store::Store;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use errors::ApiError;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub bus: Arc<Bus>,
    pub tasks: Arc<TaskRunner>,
    pub token: Arc<String>,
    pub config: Arc<RwLock<Config>>,
    pub data_dir: PathBuf,
    pub started: Instant,
    pub sources: Arc<Vec<Arc<dyn Source>>>,
    pub runtimes: Arc<Vec<Arc<dyn Runtime>>>,
    pub status: Arc<crate::core::poller::StatusCache>,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(v1::health))
        .route("/status", get(v1::status))
        .route("/config", get(v1::get_config).patch(v1::patch_config))
        .route("/tasks", get(v1::list_tasks).post(v1::post_task))
        .route("/tasks/:id/cancel", post(v1::cancel_task))
        .route("/logs", get(v1::logs))
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() });
    Router::new()
        .nest("/api/v1", api)
        .method_not_allowed_fallback(|| async { ApiError::method_not_allowed() })
        .fallback(|| async { ApiError::not_found("no such route") })
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Host names allowed in the `Host` header (DNS-rebinding defence).
fn host_allowed(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

fn bearer(req: &Request) -> Option<&str> {
    let h = req.headers();
    if let Some(v) = h.get("x-agentglim-token").and_then(|v| v.to_str().ok()) {
        return Some(v.trim());
    }
    let v = h.get(header::AUTHORIZATION)?.to_str().ok()?.trim_start();
    // RFC 9110: the auth scheme is case-insensitive.
    let (scheme, rest) = v.split_once([' ', '\t'])?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| rest.trim())
        .filter(|t| !t.is_empty())
}

async fn guard(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let mut resp = match check(&st, peer, &req) {
        Ok(()) => next.run(req).await,
        Err(e) => e.into_response(),
    };
    resp.headers_mut()
        .insert("api_version", HeaderValue::from(crate::API_VERSION));
    resp
}

fn check(st: &AppState, peer: SocketAddr, req: &Request) -> Result<(), ApiError> {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !host_allowed(host) {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "bad_host",
            "Host header not allowed",
        ));
    }
    let public = req.uri().path() == "/api/v1/health" && peer.ip().is_loopback();
    if public {
        return Ok(());
    }
    match bearer(req) {
        Some(t) if tokens::verify(t, &st.token) => Ok(()),
        _ => Err(ApiError::unauthorized()),
    }
}

#[cfg(test)]
mod tests {
    use super::host_allowed;

    #[test]
    fn hosts() {
        assert!(host_allowed("127.0.0.1:19360"));
        assert!(host_allowed("localhost"));
        assert!(host_allowed("[::1]:19360"));
        assert!(!host_allowed("evil.example:19360"));
        assert!(!host_allowed(""));
    }
}
