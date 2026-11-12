//! /api/v1 handlers shipped in 01: health, status, config, tasks, logs.

use super::errors::ApiError;
use super::AppState;
use crate::config::ConfigPatch;
use crate::core::tasks::{TaskError, TaskKind};
use crate::core::{Detection, Env};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

/// Strict JSON body parse: unknown fields and bad types give 422.
fn parse<T: DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|e| ApiError::invalid(e.to_string()))
}

pub async fn health(State(st): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "version": crate::VERSION,
        "api_version": crate::API_VERSION,
        "uptime_s": st.started.elapsed().as_secs(),
    }))
}

/// `/status` never probes: sources, runtimes and session counts come from the poller's `StatusCache`. Before the
/// first refresh (`updated_ms == 0`) sources come from a cheap detect pass and runtimes are `{"state":"unknown"}`.
pub async fn status(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    let updated_ms = st.status.updated_ms();
    let cached = st.status.sources();
    let (sources, total): (Vec<Value>, u64) = if updated_ms == 0 || cached.is_empty() {
        let env = Env {
            home: std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var_os("USERPROFILE"))
                .filter(|v| !v.is_empty())
                .map(Into::into)
                .unwrap_or_default(),
            vars: Default::default(),
        };
        let v = st
            .sources
            .iter()
            .map(|s| {
                let (detected, reason, paths) = match s.detect(&env) {
                    Detection::Detected { paths } => (
                        true,
                        None,
                        paths
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>(),
                    ),
                    Detection::NotDetected { reason } => (false, Some(reason), Vec::new()),
                };
                json!({"id": s.id(), "kind": s.kind(), "detected": detected, "reason": reason,
                       "paths": paths, "sessions": 0, "caps": s.capabilities().names()})
            })
            .collect();
        (v, 0)
    } else {
        let v = cached
            .iter()
            .map(|c| {
                let caps = st
                    .sources
                    .iter()
                    .find(|s| s.id() == c.id)
                    .map(|s| s.capabilities().names())
                    .unwrap_or_default();
                json!({"id": c.id, "kind": c.kind, "detected": c.detected, "reason": c.reason,
                       "paths": c.paths, "sessions": c.sessions, "caps": caps})
            })
            .collect();
        (v, cached.iter().map(|c| c.sessions).sum())
    };
    let cached_rt = st.status.runtimes();
    let runtimes: Vec<Value> = st
        .runtimes
        .iter()
        .map(|r| {
            let state = cached_rt
                .iter()
                .find(|(id, _)| id == r.id())
                .map(|(_, s)| json!(s))
                .unwrap_or_else(|| json!({"state": "unknown"}));
            json!({"id": r.id(), "state": state})
        })
        .collect();
    let tasks = st.tasks.list()?;
    let count = |s: &str| tasks.iter().filter(|t| t.state == s).count();
    Ok(Json(json!({
        "version": crate::VERSION,
        "api_version": crate::API_VERSION,
        "uptime_s": st.started.elapsed().as_secs(),
        "updated_ms": updated_ms,
        "sources": sources,
        "runtimes": runtimes,
        "sessions": {"total": total, "active": 0},
        "needs_you": 0,
        "tasks": {"running": count("running"), "interrupted": count("interrupted"), "total": tasks.len()},
        "last_seq": st.bus.last_seq(),
    })))
}

pub async fn get_config(State(st): State<AppState>) -> Json<Value> {
    let cfg = st.config.read().expect("config lock").clone();
    Json(
        json!({"config": cfg, "restart_required_for": ["bind", "port", "sources", "history_days"]}),
    )
}

pub async fn patch_config(
    State(st): State<AppState>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let patch: ConfigPatch = parse(&body)?;
    let next = {
        let cur = st.config.read().expect("config lock");
        cur.apply(patch)
            .map_err(|e| ApiError::invalid(e.to_string()))?
    };
    next.save(&st.data_dir)
        .map_err(|e| ApiError::internal(format!("saving config: {e}")))?;
    *st.config.write().expect("config lock") = next.clone();
    st.store.audit(
        "install-token",
        "config.patch",
        &String::from_utf8_lossy(&body),
    )?;
    st.bus
        .publish("config", "daemon", json!({"changed": true}))?;
    tracing::info!(action = "config.patch", "config updated");
    Ok(Json(
        json!({"config": next, "restart_required_for": ["bind", "port", "sources", "history_days"]}),
    ))
}

pub async fn list_tasks(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"tasks": st.tasks.list()?})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewTask {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub ms: Option<u64>,
}

fn task_err(e: TaskError) -> ApiError {
    match e {
        TaskError::Duplicate(id) => ApiError::new(
            StatusCode::CONFLICT,
            "duplicate_task",
            format!("task {id} already exists"),
        ),
        TaskError::NotFound(id) => ApiError::not_found(format!("task {id}")),
        TaskError::Draining => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "draining",
            "daemon is shutting down",
        ),
        TaskError::Invalid(m) => ApiError::invalid(m),
        TaskError::Store(e) => e.into(),
    }
}

pub async fn post_task(
    State(st): State<AppState>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let t: NewTask = parse(&body)?;
    let kind = match (t.kind.as_str(), t.ms) {
        ("noop", None) => TaskKind::Noop,
        ("status-refresh", None) => TaskKind::StatusRefresh,
        ("sleep", Some(ms)) if ms <= 3_600_000 => TaskKind::Sleep(ms),
        _ => {
            return Err(ApiError::invalid(
                "kind must be noop, status-refresh, or sleep with ms <= 3600000",
            ))
        }
    };
    let row = st.tasks.submit(&t.id, kind).map_err(task_err)?;
    st.store.audit("install-token", "task.create", &t.id)?;
    Ok((StatusCode::CREATED, Json(json!({"task": row}))))
}

pub async fn cancel_task(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = st.tasks.cancel(&id).map_err(task_err)?;
    st.store.audit("install-token", "task.cancel", &id)?;
    Ok(Json(json!({"task": row})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogQuery {
    #[serde(default)]
    pub since: usize,
    #[serde(default)]
    pub level: Option<String>,
}

pub async fn logs(
    State(st): State<AppState>,
    q: Result<Query<LogQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let Query(q) =
        q.map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, "bad_query", e.body_text()))?;
    let want = q.level.map(|l| l.to_ascii_uppercase());
    if let Some(l) = &want {
        if !["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].contains(&l.as_str()) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "bad_query",
                "level must be trace|debug|info|warn|error",
            ));
        }
    }
    let text = std::fs::read_to_string(crate::logging::log_path(&st.data_dir)).unwrap_or_default();
    Ok(Json(log_page(&text, q.since, want.as_deref(), LOG_PAGE)))
}

/// Max lines returned per `/logs` call.
pub const LOG_PAGE: usize = 500;

/// One `/logs` page. `since` is an opaque cursor (line index into the current file). `next` is the index after the
/// last line scanned, so following it never skips lines. A cursor past the end (rotation or truncation) restarts
/// from 0 with `reset: true`.
pub fn log_page(text: &str, since: usize, level: Option<&str>, cap: usize) -> Value {
    let total = text.lines().count();
    let (start, reset) = if since > total {
        (0, true)
    } else {
        (since, false)
    };
    let mut lines = Vec::new();
    let mut next = start;
    for l in text.lines().skip(start) {
        if lines.len() >= cap {
            break;
        }
        next += 1;
        let Ok(v) = serde_json::from_str::<Value>(&crate::logging::redact(l, None)) else {
            continue;
        };
        if level.is_none_or(|w| v["level"].as_str() == Some(w)) {
            lines.push(v);
        }
    }
    json!({"lines": lines, "next": next, "reset": reset})
}

#[cfg(test)]
mod tests {
    use super::log_page;

    fn text(n: usize) -> String {
        (0..n)
            .map(|i| format!("{{\"level\":\"INFO\",\"i\":{i}}}\n"))
            .collect()
    }

    #[test]
    fn page_cap_does_not_skip() {
        let t = text(7);
        let a = log_page(&t, 0, None, 3);
        assert_eq!(a["next"], 3);
        let b = log_page(&t, 3, None, 3);
        assert_eq!(b["lines"][0]["i"], 3);
        let c = log_page(&t, 6, None, 3);
        assert_eq!(c["next"], 7);
        assert_eq!(
            log_page(&t, 7, None, 3)["lines"].as_array().unwrap().len(),
            0
        );
        assert_eq!(log_page(&t, 7, None, 3)["reset"], false);
    }

    #[test]
    fn cursor_past_end_resets() {
        let p = log_page(&text(2), 10, None, 3);
        assert_eq!(p["reset"], true);
        assert_eq!(p["next"], 2);
        assert_eq!(p["lines"][0]["i"], 0);
    }
}
