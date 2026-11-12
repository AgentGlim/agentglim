//! Strata probe: owner_off when `<flags_dir>/local_off_owner` exists (no request at all); else llama.cpp-style.

use super::llamacpp::probe_llamacpp;
use crate::core::{BoxFut, Runtime, RuntimeState};
use std::path::PathBuf;

pub const OWNER_OFF_FLAG: &str = "local_off_owner";

pub struct Strata {
    pub base: String,
    pub flags_dir: Option<PathBuf>,
}

impl Strata {
    pub fn owner_off(&self) -> bool {
        self.flags_dir
            .as_ref()
            .is_some_and(|d| d.join(OWNER_OFF_FLAG).exists())
    }
}

impl Runtime for Strata {
    fn id(&self) -> &'static str {
        "strata"
    }
    fn probe(&self) -> BoxFut<'_, RuntimeState> {
        Box::pin(async move {
            if self.owner_off() {
                return RuntimeState::OwnerOff;
            }
            probe_llamacpp(&self.base).await
        })
    }
}
