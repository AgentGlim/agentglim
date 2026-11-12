//! Install token: 32 random bytes (hex), file mode 0600, created on first run.

use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("token")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex(&b)
}

/// SHA-256 hex digest; device tokens are stored only as this hash (03).
pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// Reads the install token, creating it with mode 0600 if missing.
pub fn load_or_create(data_dir: &Path) -> std::io::Result<String> {
    let path = token_path(data_dir);
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(t);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "token file is malformed",
        ));
    }
    let token = new_token();
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path)?;
    writeln!(f, "{token}")?;
    Ok(token)
}

/// Constant-time comparison.
pub fn verify(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_created_once_with_0600() {
        let d = tempfile::tempdir().unwrap();
        let t1 = load_or_create(d.path()).unwrap();
        let t2 = load_or_create(d.path()).unwrap();
        assert_eq!(t1, t2);
        assert_eq!(t1.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(token_path(d.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn verify_and_hash() {
        assert!(verify("abc", "abc"));
        assert!(!verify("abd", "abc"));
        assert!(!verify("ab", "abc"));
        assert_eq!(hash_token("x").len(), 64);
        assert_ne!(hash_token("x"), "x");
    }
}
