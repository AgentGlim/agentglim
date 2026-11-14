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
| `public-docs/` | Install, keys, settings and SuperAgent inbox resend guides. |
| `site/` | The project website. |

Runtime data never lives here. It sits in a working folder outside the repo (see below).

## Run the dashboard

Supported runtimes: Node 22.13-24, Python 3.11+ (for Python utilities).
The server uses `node:sqlite` and requires Node 22.13.0 or newer.

```sh
node app/server.mjs
```

Then open http://127.0.0.1:18990.

Optional: keep runtime data somewhere else with `AGENTGLIM_WORK=/path/to/agentglim-work node app/server.mjs`.
Only if port 18990 is already taken, pass another port: `node app/server.mjs <port>` (plan pages use the next port up).

### Update

On v0.2.14 or older, run `git pull --ff-only` first, then `npm run update`, then restart AgentGlim.

From the clone, on `main`: `npm run update`, then restart AgentGlim. That runs `git pull --ff-only`, re-links the
SuperAgent tools in your run folder and refreshes the global note and skill copies setup wrote. Your data folder is
kept. Custom run-folder files are preserved; managed notes and skills are refreshed, with a backup of each replaced skill.

### Where data goes

| Variable | Default | Holds |
|---|---|---|
| `AGENTGLIM_WORK` | unset (then `~/.agentglim`) | `data/`, `probes/`, `imported/`, `human-loaded-data/`, `_build/` when set |
| `AGENTGLIM_DATA` | `~/.agentglim` (`$AGENTGLIM_WORK/data` when `AGENTGLIM_WORK` is set) | history, caches, prices, approvals, goals, control state |
| `AGENTGLIM_PLANS` | the plans folder saved in Setup, else `$AGENTGLIM_DATA/plans` | the plans folder the dashboard watches |
| `AGENTGLIM_RUN` | `$AGENTGLIM_PLANS/_run` | the harness run folder |
| `AGENTGLIM_PROJECTS` | `~/dev/projects` | your projects folder, for the optional panels |

These are read in `app/paths.mjs` once at start, so restart AgentGlim after changing them (Setup says so when you change the plans folder). `node tools/first-run.mjs paths` prints what the running configuration resolves to, including the listener command; agents should use that rather than guess. Panels whose folder is missing stay empty.

A plans harness is optional. AgentGlim does not ship a driver, worker lanes, model routing or a local model
supervisor. It ships one tracked worker launcher (`harness/bin/worker-launch.sh`) for codex, claude, pi and opencode. To use the dashboard's Status, Watcher and
queue controls with your own SuperAgent, run `npm run scaffold-harness`; it creates the run folder and links the
small tools AgentGlim does ship. See [SETUP.md](SETUP.md#plans-harness-and-superagent-tools).

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

## Contributing

`main` is protected: work on a branch, open a pull request, and merge once CI (privacy scan, tests on Linux, macOS and
Windows) passes. Releases are tags (`vX.Y.Z`). Turn on the privacy check that runs before every commit with
`git config core.hooksPath .githooks`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
