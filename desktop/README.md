# AgentGlim desktop

Tauri v2 opens a native **AgentGlim** window at http://127.0.0.1:18990.
The identifier is `dev.agentglim.app`. The dashboard and server code ship as
resources; Node.js is installed separately. No npm install is needed.

## Requirements

- Rust stable and Cargo: https://rustup.rs
- System Node.js **22 or newer**: https://nodejs.org/en/download
- Linux: WebKitGTK 4.1 development libraries and a graphical desktop session.
- macOS: Xcode command line tools.
- Windows: Visual Studio C++ build tools and WebView2.

Linux prerequisites (run yourself if missing; the build does not use sudo):

```sh
sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev librsvg2-bin patchelf xdg-utils
```

Upstream platform requirements: https://v2.tauri.app/start/prerequisites/

## Build

From the repository root:

```sh
cargo install tauri-cli --version 2.12.4 --locked
cd desktop
cargo tauri build --bundles deb,appimage -- --locked
```

Cargo normally installs the CLI in `~/.cargo/bin`. All project build output
stays in `desktop/target/`; generated resources, schemas and build output are
git-ignored. `Cargo.lock` is retained for repeatable builds.

In this restricted build workspace, `~/.cargo` is read-only. The local CLI
and registry cache are instead under `desktop/target/`. To reuse them here,
run from `desktop/`:

```sh
PATH="$PWD/target/tools/bin:$PATH" CARGO_HOME="$PWD/target/cargo-home" XDG_CACHE_HOME="$PWD/target/cache" cargo tauri build --bundles deb,appimage -- --locked
```

Installers are written to:

```text
desktop/target/release/bundle/deb/AgentGlim_0.1.0_amd64.deb
desktop/target/release/bundle/appimage/AgentGlim_0.1.0_amd64.AppImage
```

On macOS use `--bundles dmg`; on Windows use `--bundles nsis,msi` (before `-- --locked`).
These installers are unsigned; signing and notarization are not configured.
Node.js 22+ is required at runtime; the Debian package does not require a
distribution Node package. Both DEB and AppImage support user-installed Node.

For development:

```sh
cd desktop
cargo tauri dev
```

`prepare.mjs` stages the server before development/build. It includes app
code, assets, schemas, example goals and public harness code. It excludes
tests, symlinks, runtime data, `.env` and machine-specific Jev routes. Previous
staged resources move to `desktop/_archive/`; they are never deleted.

## Icons

The committed icon set is generated from `assets/agentglim-logo.svg`:

```sh
cd desktop
rsvg-convert -w 1024 -h 1024 ../assets/agentglim-logo.svg -o icons/source-1024.png
cargo tauri icon icons/source-1024.png --output icons
```

This generates the Linux PNG sizes, Windows ICO and macOS ICNS, plus the
other platform sizes provided by Tauri's icon command.

## Server lifecycle

The launcher checks port 18990 on IPv4 loopback first. If it is listening,
the launcher waits for HTTP 200 and uses that server without owning it.
Otherwise it discovers a system Node 22+ executable, starts the bundled
`app/server.mjs`, and waits up to 30 seconds for HTTP readiness before opening
the window. Older Node 22 versions receive `--experimental-sqlite` too.

Discovery tries `AGENTGLIM_NODE` first, then every directory on `PATH`,
`~/.local/bin`, `~/.nvm/versions/node/*/bin` (newest first), `/usr/local/bin`,
`/opt/homebrew/bin` and `/usr/bin`. On Windows it also checks the standard
Node installation folders. Each candidate must report version 22 or newer;
an invalid or older candidate does not prevent checking the remaining paths.

Closing the window, quitting the app or sending SIGTERM/SIGINT on Unix stops
and reaps only its owned child, using the retained process handle/pid. An
existing server survives. Force-killing the desktop app with SIGKILL cannot
run cleanup. Node launch failures and startup timeouts show a native error
dialog; a missing/old Node dialog includes its install URL. A TODO beside
Node discovery marks where a future `bundle.externalBin` sidecar belongs.

The server inherits `AGENTGLIM_*` environment settings. When it starts a
server, the launcher defaults API configuration to `$AGENTGLIM_DATA/.env`
or `~/.agentglim/.env`; override with `AGENTGLIM_ENV_FILE`. Packaged resources
remain read-only. Existing servers keep their own configuration. Runtime data
locations follow `SETUP.md`. External web pages receive no Tauri capabilities.

## Verification

```sh
cd desktop
node prepare.mjs
cargo test --locked
cargo fmt --check
node smoke-test.mjs
```

The Linux smoke script requires `Xvfb` and `xwininfo`. It opens the release
binary in an isolated virtual display, checks its window and HTTP endpoint
for 10 seconds, stops it by pid, and verifies owned-server cleanup and
existing-server preservation. It refuses to disturb an occupied port.
To test while another server uses port 18990, run from the repository root:

```sh
unshare --user --map-root-user --net sh -c 'ip link set lo up && node desktop/smoke-test.mjs'
```

Finish bundling before running the smoke test: Tauri patches the binary
during packaging, and a running binary can cause `Text file busy`.

For a manual check, launch the built AppImage in a graphical session, verify HTTP 200 from
http://127.0.0.1:18990 and a visible window titled AgentGlim, leave it alive
for at least 10 seconds, then send SIGTERM to that launcher's exact PID.
Check that its child server exited. Repeat with a separately started server
to confirm that server survives the window closing.

## GitHub releases

`.github/workflows/desktop.yml` builds Linux DEB/AppImage, macOS DMG and
Windows NSIS/MSI installers and uploads them to the GitHub Release when a
`v*` tag is pushed. Set the version in both `Cargo.toml` and
`tauri.conf.json` before tagging. The workflow does not run on ordinary pushes.
