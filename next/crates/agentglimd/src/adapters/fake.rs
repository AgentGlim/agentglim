//! Fake adapter used by tests and the 03 control-verb work. Never touches processes.

use crate::core::{
    Ack, Batch, BatchItem, BoxFut, Caps, CoreError, Cursor, Detection, Env, ItemKind, SessionId,
    Source, SourceKind, Verb,
};
use std::sync::Mutex;

#[derive(Default)]
pub struct FakeSource {
    pub controls: Mutex<Vec<(String, Verb)>>,
}

impl Source for FakeSource {
    fn id(&self) -> &'static str {
        "fake"
    }
    fn kind(&self) -> SourceKind {
        SourceKind::CodingAgent
    }
    fn detect(&self, _env: &Env) -> Detection {
        Detection::Detected { paths: vec![] }
    }
    fn capabilities(&self) -> Caps {
        Caps::WATCH | Caps::PAUSE | Caps::RESUME
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move {
            Ok(Batch {
                items: vec![BatchItem {
                    kind: ItemKind::Heartbeat,
                    session: "fake-1".into(),
                    data: serde_json::json!({"n": since.0}),
                }],
                next: Cursor(since.0 + 1),
            })
        })
    }
    fn control<'a>(&'a self, sid: &'a SessionId, verb: Verb) -> BoxFut<'a, Result<Ack, CoreError>> {
        Box::pin(async move {
            if !self.capabilities().contains(verb.required_cap()) {
                return Err(CoreError::Unsupported);
            }
            self.controls
                .lock()
                .expect("fake lock")
                .push((sid.0.clone(), verb));
            Ok(Ack {
                ok: true,
                message: "fake ack".into(),
            })
        })
    }
}

/// A source that only implements the required methods, proving `control` defaults to Unsupported.
pub struct WatchOnly;

impl Source for WatchOnly {
    fn id(&self) -> &'static str {
        "watch-only"
    }
    fn kind(&self) -> SourceKind {
        SourceKind::Harness
    }
    fn detect(&self, _env: &Env) -> Detection {
        Detection::NotDetected {
            reason: "fixture".into(),
        }
    }
    fn capabilities(&self) -> Caps {
        Caps::WATCH
    }
    fn poll(&self, since: Cursor) -> BoxFut<'_, Result<Batch, CoreError>> {
        Box::pin(async move {
            Ok(Batch {
                items: vec![],
                next: since,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_polls_and_controls() {
        let f = FakeSource::default();
        let b = f.poll(Cursor(4)).await.unwrap();
        assert_eq!(b.next, Cursor(5));
        let sid = SessionId("fake-1".into());
        assert!(f.control(&sid, Verb::Pause).await.unwrap().ok);
        assert_eq!(
            f.control(&sid, Verb::Kill).await,
            Err(CoreError::Unsupported)
        );
        assert_eq!(
            WatchOnly.control(&sid, Verb::Pause).await,
            Err(CoreError::Unsupported)
        );
    }
}
