//! Daemon config: loaded from `<data>/config.json`, validated before start (never half-start).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub bind: String,
    pub port: u16,
    /// Must be true for any non-loopback bind (LAN or tailnet).
    pub allow_remote: bool,
    /// Sources on/off by adapter id.
    pub sources: BTreeMap<String, bool>,
    pub retention_days: u32,
    /// Only newer files are read as history; older ones are adopted at EOF.
    pub history_days: u32,
    /// Per-adapter root dir overrides (adapter id -> dir). Default: derived from HOME.
    pub roots: BTreeMap<String, String>,
    /// Harness flags dir; if `<flags_dir>/local_off_owner` exists, Strata reports owner_off.
    pub flags_dir: Option<String>,
    /// Runtime base URLs by id (ollama, llamacpp, strata). Defaults in `runtimes::registry`.
    pub runtime_urls: BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".into(),
            port: 19360,
            allow_remote: false,
            sources: BTreeMap::new(),
            retention_days: 30,
            history_days: 30,
            roots: BTreeMap::new(),
            flags_dir: None,
            runtime_urls: BTreeMap::new(),
        }
    }
}

/// PATCH body for `/config`; unknown fields are rejected.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigPatch {
    pub bind: Option<String>,
    pub port: Option<u16>,
    pub allow_remote: Option<bool>,
    pub sources: Option<BTreeMap<String, bool>>,
    pub retention_days: Option<u32>,
    pub history_days: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config file {0}: {1}")]
    Read(String, String),
    #[error("invalid config: {0}")]
    Invalid(String),
}

impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let ip: IpAddr = self.bind.parse().map_err(|_| {
            ConfigError::Invalid(format!("bind '{}' is not an IP address", self.bind))
        })?;
        if !ip.is_loopback() && !self.allow_remote {
            return Err(ConfigError::Invalid(format!(
                "bind {ip} is not loopback; set allow_remote=true to bind LAN or tailnet"
            )));
        }
        if self.port < 1024 {
            return Err(ConfigError::Invalid(format!(
                "port {} must be >= 1024",
                self.port
            )));
        }
        if !(1..=3650).contains(&self.retention_days) {
            return Err(ConfigError::Invalid(
                "retention_days must be 1..=3650".into(),
            ));
        }
        if !(1..=365).contains(&self.history_days) {
            return Err(ConfigError::Invalid("history_days must be 1..=365".into()));
        }
        for id in self.sources.keys() {
            if id.is_empty()
                || !id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return Err(ConfigError::Invalid(format!(
                    "source id '{id}' must be [a-z0-9-]"
                )));
            }
        }
        Ok(())
    }

    pub fn load(data_dir: &Path) -> Result<Self, ConfigError> {
        let path = data_dir.join("config.json");
        let cfg = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| ConfigError::Read("config.json".into(), e.to_string()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(ConfigError::Read("config.json".into(), e.to_string())),
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// Harness flags dir: the configured one, else `<plans root>/_run/flags`. The plans root is found by walking up
    /// from the plans-harness root (config override or `<home>/projects/dev/plans`) to the first dir holding `_run`;
    /// without one, the harness root itself is used.
    pub fn resolve_flags_dir(&self, home: &Path) -> PathBuf {
        if let Some(d) = &self.flags_dir {
            return PathBuf::from(d);
        }
        let root = self
            .roots
            .get("plans-harness")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("projects/dev/plans"));
        let base = root
            .ancestors()
            .find(|a| a.join("_run").is_dir())
            .unwrap_or(&root);
        base.join("_run").join("flags")
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let tmp = data_dir.join("config.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).expect("config json"))?;
        std::fs::rename(tmp, data_dir.join("config.json"))
    }

    /// Returns the patched config if it validates; self stays unchanged otherwise.
    pub fn apply(&self, p: ConfigPatch) -> Result<Config, ConfigError> {
        let mut c = self.clone();
        if let Some(v) = p.bind {
            c.bind = v;
        }
        if let Some(v) = p.port {
            c.port = v;
        }
        if let Some(v) = p.allow_remote {
            c.allow_remote = v;
        }
        if let Some(v) = p.sources {
            c.sources = v;
        }
        if let Some(v) = p.retention_days {
            c.retention_days = v;
        }
        if let Some(v) = p.history_days {
            c.history_days = v;
        }
        c.validate()?;
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_loopback() {
        let c = Config::default();
        c.validate().unwrap();
        assert_eq!(c.bind, "127.0.0.1");
    }

    #[test]
    fn remote_bind_needs_allow_remote() {
        let c = Config {
            bind: "0.0.0.0".into(),
            ..Config::default()
        };
        assert!(c.validate().is_err());
        let c = Config {
            allow_remote: true,
            ..c
        };
        c.validate().unwrap();
    }

    #[test]
    fn unknown_fields_and_bad_values_rejected() {
        assert!(serde_json::from_str::<Config>(r#"{"bind":"127.0.0.1","nope":1}"#).is_err());
        assert!(serde_json::from_str::<ConfigPatch>(r#"{"x":1}"#).is_err());
        assert!(Config {
            port: 80,
            ..Config::default()
        }
        .validate()
        .is_err());
        assert!(Config {
            bind: "localhost-ish".into(),
            ..Config::default()
        }
        .validate()
        .is_err());
        let p = ConfigPatch {
            retention_days: Some(0),
            ..Default::default()
        };
        assert!(Config::default().apply(p).is_err());
    }

    #[test]
    fn flags_dir_default_walks_up_to_plans_root() {
        let d = tempfile::tempdir().unwrap();
        let plans = d.path().join("plans");
        std::fs::create_dir_all(plans.join("_run/flags")).unwrap();
        std::fs::create_dir_all(plans.join("sub")).unwrap();
        let mut c = Config::default();
        c.roots.insert(
            "plans-harness".into(),
            plans.join("sub").display().to_string(),
        );
        assert_eq!(c.resolve_flags_dir(d.path()), plans.join("_run/flags"));
        c.flags_dir = Some("/x/y".into());
        assert_eq!(c.resolve_flags_dir(d.path()), PathBuf::from("/x/y"));
    }

    #[test]
    fn load_refuses_bad_file() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Config::load(d.path()).unwrap(), Config::default());
        std::fs::write(d.path().join("config.json"), "{not json").unwrap();
        assert!(Config::load(d.path()).is_err());
    }
}
