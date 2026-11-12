//! Error envelope: `{"error":{"code","message"}}`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid token",
        )
    }
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", what)
    }
    pub fn method_not_allowed() -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "method not allowed for this route",
        )
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_body", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({"error": {"code": self.code, "message": self.message}});
        (self.status, Json(body)).into_response()
    }
}

impl From<crate::store::StoreError> for ApiError {
    fn from(e: crate::store::StoreError) -> Self {
        tracing::error!(error = %e, "store error");
        ApiError::internal("storage error")
    }
}
