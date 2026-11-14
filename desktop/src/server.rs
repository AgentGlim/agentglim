use std::{
    ffi::OsString,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const URL: &str = "http://127.0.0.1:18990";
const ADDRESS: &str = "127.0.0.1:18990";
const INSTALL: &str = "https://nodejs.org/en/download";

#[derive(Default)]
pub struct Server {
    child: Option<Child>,
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: no extra console.
    }
    cmd.stdin(Stdio::null());
    cmd
}

fn node_major(version: &str) -> Option<u32> {
    version
        .trim()
        .strip_prefix('v')?
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn node_candidates(
    override_path: Option<OsString>,
    search_path: Option<OsString>,
    home: Option<OsString>,
) -> Vec<PathBuf> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();
    if let Some(value) = override_path.filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(value));
    }
    // Check every PATH entry so an old system Node cannot mask a newer runtime.
    if let Some(value) = search_path {
        candidates.extend(std::env::split_paths(&value).map(|folder| folder.join(executable)));
    }
    // Desktop launchers may have a shorter PATH than a login shell.
    if let Some(home) = home {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(executable));
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
            versions.sort_by_key(|folder| {
                folder
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .trim_start_matches('v')
                    .split('.')
                    .map(|part| part.parse::<u32>().unwrap_or(0))
                    .collect::<Vec<_>>()
            });
            candidates.extend(
                versions
                    .into_iter()
                    .rev()
                    .map(|folder| folder.join("bin").join(executable)),
            );
        }
    }
    #[cfg(unix)]
    {
        candidates.extend(
            [
                "/usr/local/bin/node",
                "/opt/homebrew/bin/node",
                "/usr/bin/node",
            ]
            .map(PathBuf::from),
        );
    }
    #[cfg(windows)]
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(folder) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(folder).join("nodejs/node.exe"));
        }
    }
    candidates
}

fn find_node() -> Result<PathBuf, String> {
    let candidates = node_candidates(
        std::env::var_os("AGENTGLIM_NODE"),
        std::env::var_os("PATH"),
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }),
    );
    find_supported_node(candidates)
}

fn find_supported_node(candidates: Vec<PathBuf>) -> Result<PathBuf, String> {
    for candidate in candidates {
        if let Ok(output) = command(&candidate).arg("--version").output() {
            if output.status.success()
                && node_major(&String::from_utf8_lossy(&output.stdout)).is_some_and(|v| v >= 22)
            {
                return Ok(candidate);
            }
        }
    }
    Err(format!("AgentGlim needs Node.js 22 or newer. Install the current Node.js LTS, then restart AgentGlim.\n\nInstall: {INSTALL}\n\nNode.js must be available on PATH (or in a standard installation folder)."))
}

fn connect() -> Option<TcpStream> {
    TcpStream::connect_timeout(
        &ADDRESS.parse::<SocketAddr>().unwrap(),
        Duration::from_millis(250),
    )
    .ok()
}

fn http_ready() -> bool {
    let Some(mut stream) = connect() else {
        return false;
    };
    let timeout = Some(Duration::from_secs(1));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:18990\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut header = [0; 12];
    stream.read_exact(&mut header).is_ok()
        && &header[..9] == b"HTTP/1.1 "
        && &header[9..12] == b"200"
}

impl Server {
    pub fn start(&mut self, resource_dir: &Path) -> Result<(), String> {
        if connect().is_none() {
            let node = find_node()?;
            let app = resource_dir.join("server/app");
            if !app.join("server.mjs").is_file() {
                return Err(
                    "The packaged AgentGlim server is missing. Rebuild with cargo tauri build."
                        .into(),
                );
            }
            // TODO: bundle a target-specific Node sidecar in bundle.externalBin,
            // then resolve it here instead of discovering the system Node runtime.
            let mut cmd = command(node);
            cmd.arg("--experimental-sqlite")
                .arg(app.join("server.mjs"))
                .arg("18990")
                .current_dir(&app)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Packaged resources are read-only; API configuration belongs in the private data folder.
            if std::env::var_os("AGENTGLIM_ENV_FILE").is_none() {
                if let Some(data) = std::env::var_os("AGENTGLIM_DATA")
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                            .map(|home| PathBuf::from(home).join(".agentglim"))
                    })
                {
                    cmd.env("AGENTGLIM_ENV_FILE", data.join(".env"));
                }
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("Could not start the AgentGlim server: {e}"))?;
            eprintln!("AgentGlim started server pid {}", child.id());
            self.child = Some(child);
        } else {
            eprintln!("AgentGlim is using the existing server at {URL}");
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Some(child) = &mut self.child {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    self.child = None;
                    // Another launcher may have won the bind race. We own no server now.
                    if connect().is_none() {
                        return Err(format!("AgentGlim's server exited ({status}). Check your Node.js installation and private data folder."));
                    }
                }
            }
            if http_ready() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(150));
        }
        self.stop();
        Err(format!("AgentGlim did not answer at {URL} within 30 seconds. Check whether another application is using port 18990."))
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Child retains our exact process handle/pid; never discover or kill by name or port.
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_boundary() {
        assert_eq!(node_major("v22.0.0\n"), Some(22));
        assert_eq!(node_major("v24.22.0"), Some(24));
        assert_eq!(node_major("v20.19.0"), Some(20));
        assert_eq!(node_major("garbage"), None);
    }

    #[cfg(unix)]
    #[test]
    fn node_discovery_with_minimal_path() {
        use std::os::unix::fs::PermissionsExt;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/node-discovery-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let home = root.join("home");
        let old = root.join("system/node");
        let local = home.join(".local/bin/node");
        let nvm = home.join(".nvm/versions/node/v24.22.0/bin/node");
        let override_node = root.join("custom/node");
        for (file, version) in [(&old, 20), (&local, 24), (&nvm, 24), (&override_node, 22)] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, format!("#!/bin/sh\necho v{version}.0.0\n")).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let candidates = || {
            node_candidates(
                Some(root.join("missing-node").into_os_string()),
                Some(old.parent().unwrap().as_os_str().to_owned()),
                Some(home.clone().into_os_string()),
            )
        };
        assert_eq!(find_supported_node(candidates()).unwrap(), local);
        std::fs::rename(&local, local.with_extension("disabled")).unwrap();
        assert_eq!(find_supported_node(candidates()).unwrap(), nvm);
        let mut overridden = candidates();
        overridden.insert(0, override_node.clone());
        assert_eq!(find_supported_node(overridden).unwrap(), override_node);
        let all_path =
            std::env::join_paths([old.parent().unwrap(), nvm.parent().unwrap()]).unwrap();
        assert_eq!(
            find_supported_node(node_candidates(None, Some(all_path), None)).unwrap(),
            nvm
        );
        assert!(find_supported_node(vec![old])
            .unwrap_err()
            .contains("Node.js 22 or newer"));
    }

    #[test]
    fn cleanup_reaps_only_owned_child() {
        let node = find_node().expect("Node 22+ for lifecycle test");
        let mut external = command(&node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap();
        let owned = command(node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap();
        let mut server = Server { child: Some(owned) };
        server.stop();
        server.stop();
        assert!(external.try_wait().unwrap().is_none());
        external.kill().unwrap();
        external.wait().unwrap();
    }
}
