# AgentGlim

AgentGlim watches a fleet of coding agents (Claude Code, Codex, Pi, OpenCode and friends)
and lets you steer them. One page shows which agents are running, which provider and model
each one uses, what it costs against your plan limits, and what is waiting on you to approve.

The name: a glim is a small light, a quick look. You glance at it and know what your agents are doing.

## What's in this repo

| Path | What it is |
|---|---|
| `app/` | The dashboard that runs today: a single Node server (`server.mjs`) plus one HTML page, the control/chat page (`control/`) and helper modules. No npm dependencies. |
| `next/` | The next version (Rust daemon `agentglimd` + web UI), built under plan 68 of the plans harness. |
| `assets/` | Logo (`agentglim-logo.svg`). |
| `desktop/` | Tauri desktop wrapper and installers (Linux, macOS, Windows). |
| `public-docs/` | Install, keys and settings guides. |
| `site/` | The project website. |

Runtime data never lives here. It sits in a working folder outside the repo (see below).

## Run the dashboard

Supported runtimes: Node 22.13-24, Python 3.11+ (for Python utilities).
The server uses `node:sqlite` and requires Node 22.13.0 or newer.

```sh
cd app
AGENTGLIM_WORK=/path/to/agentglim-work node server.mjs        # port 18990
node server.mjs 19000                                         # another port
```

Then open http://127.0.0.1:18990.

### Where data goes

| Variable | Default | Holds |
|---|---|---|
| `AGENTGLIM_WORK` | `~/dev/projects/plans/_agentglim` if it exists, else `~/.local/share/agentglim` | `data/`, `probes/`, `imported/`, `human-loaded-data/`, `_build/` |
| `AGENTGLIM_DATA` | `$AGENTGLIM_WORK/data` | history, caches, prices, approvals, control state |
| `AGENTGLIM_PLANS` | `~/projects/dev/plans` if it exists, else `~/dev/projects/plans` | the plans harness the dashboard watches |
| `AGENTGLIM_RUN` | `$AGENTGLIM_PLANS/_run` | the harness run folder |
| `AGENTGLIM_PROJECTS` | `~/dev/projects` | your projects folder, for the optional panels |

These are read in `app/paths.mjs`. Panels whose folder is missing stay empty.

### As a systemd user service

```ini
[Service]
WorkingDirectory=/path/to/agentglim/app
Environment=AGENTGLIM_WORK=/path/to/agentglim-work
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
```

## API keys

AgentGlim reads API keys from a `.env` file in the repo root. Copy the example and fill in the keys you use:

```sh
cp .env.example .env
chmod 600 .env
```

Every key is listed in `.env.example` with what it is for and whether it is optional. A key set in your shell or service
environment wins over `.env`. `.env` is git-ignored; never commit it. An old `export NAME=...` line in `~/.bashrc` still
works as a last fallback, but the server prints a note asking you to move it.

## Known gaps before this goes public

- Defaults are now relative to your home folder (`app/paths.mjs`); `dev/leak-scan.mjs` checks every release for home paths.
- The dashboard reads the plans harness layout directly. A generic adapter layer is the job of `next/`.

## Contributing

`main` is protected: work on a branch, open a pull request, and merge once CI (privacy scan, tests on Linux, macOS and
Windows) passes. Releases are tags (`vX.Y.Z`). Turn on the privacy check that runs before every commit with
`git config core.hooksPath .githooks`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
