# Changelog

## 0.2.25

- T27 Credit tracker: the API-key card reads provider-backed cost and usage history (spend source, estimate and incomplete flags, optional top-ups) and shows two 30-day SVG charts: balance with daily spend, and the 5-hour and 7-day usage. Without provider data it keeps the earlier Pi-ledger numbers.

## 0.2.24

- Linux and macOS gate releases. Windows checks moved to a weekly workflow and no longer block the release installer.

## 0.2.23

- "Jev routing" is now "Decisions routing". The page lives at `/decisions-routing` (`/routing` and `/jev-routing` redirect there; `/api/routing`, `/api/routing-feedback` and `/api/setup/jev` still answer). Its table has a Router column: the model that made each decision, `jev` or `gemini-decision`. Only the router model keeps a model name.
- Settings: the `decisions` block replaces `jev` in harness.json and setup.json. Old files are read as before and Setup writes both keys; `AGENTGLIM_DECISIONS_ROUTES` joins `AGENTGLIM_JEV_ROUTES`. Harness page edits send `decisions.close` / `decisions.notifyPicks` (`jev.*` still accepted). First-run asks `decisions` (answers with `jev` still work).
- The `jev-gate` add-on is now `decisions-gate`, with `jev-gate` kept as a thin wrapper. It accepts `[decisions: ...]` / `[decisions-override: ...]` tags as well as the old `[jev...]` tags, logs `router` on every record and has `decisions-gate config-path` (`~/.config/decisions-gate`, old `~/.config/jev-gate` as a fallback).

## 0.2.22

- F23 Development cycle: opt-in coding loops with protected evidence, independent validation, budgets and recovery.
- Protected test execution supports Node 22.13+ on 22.x and Node 24.x while retaining assertion and evidence checks.
- CI includes the development-cycle browser check; mobile header controls stay together.
- Windows batches process identities in the background so PowerShell startup does not stall the dashboard.
- Clean-checkout fixtures cover feature numbering, public documentation and plan folder matching.

## 0.2.21

- F31 Live-worker liveness: verified process and lineage evidence distinguish live workers, unknown registrations and saved history.
- F36 Standardized build intake: versioned defaults, seven answer rounds, role recommendations and tracked dispatch receipts.
- F42 Fast VM test: ready snapshots, agentless install/update checks, smart change scope and parallel local CI.
- Harden startup with one atomic Control database initialization and fewer synchronous Setup reads; bound startup waits in tests.
- Desktop CI builds installers without uploading; release publication finds drafts through the paginated releases list.

## Unreleased (aimed at 0.2.18)

- Finished jobs stay on the dashboard until you have seen them. When a job ends, its model icon in the WORKING cell turns into a green ring with a check (red ring and "!" when it failed) and stays there through reloads, restarts and the 30-minute window. Hover or focus shows a detail card (what the task was, outcome, end time, duration, model, result). Click an icon, or "Clear N" at the row end, to mark it seen; Undo shows for 6 seconds. The chip next to the Active builds title ("3 finished · 1 failed") opens a side panel with the not-seen list, 30 days of seen history with Undo, and "Mark all seen"; an "all seen" button sits next to the chip too. The tab title shows the count. A plan stays in Active builds while it has an unseen finished job.
- Scope: jobs you or the SuperAgent launched that ran 2 minutes or longer, plus every failure (setting `doneAck.minMinutes`). Pipeline rounds, helpers of helpers, chat turns, tests and `[quiet]` jobs never get an icon; a relaunch replaces the failed run's icon. Desktop pop-up for failures only, at most one a minute (`doneAck.notify`: off / failed / all).
- New harness tool `done-ack.mjs` (list, show, count, `ack <job> --quote "<owner's words>"`, unack). The SuperAgent marks a job seen in chat only when the owner's own message is about it, and must quote it. The listener adds an `UNSEEN:` hint to `CHAT:` and `STATUS:` lines.
- `jobs-track` writes a one-sentence `desc` at launch (`--desc`, a `[task: ...]` prompt tag, the label or the prompt's first sentence), `quiet` (`--quiet` or `[quiet]`) and `launchedBy`.
- Click an agent icon to copy its tooltip text (a brief "Copied" toast shows). Each card in the finished-jobs panel shows the job's model icon; its tooltip gives harness, model and effort (when recorded).
- DEFERRED (v2): the panel's "Open report" button is hidden until job HTML reports exist (none are generated).
- Fixed (Windows): `npm run update` said "not a git checkout" on a real clone when its path held an 8.3 short name (such as `RUNNER~1` for the profile folder on GitHub's Windows runners, whose TEMP uses the short form). It compared git's top-level path with its own path as strings, and git spells the long name. It now asks git directly (`git rev-parse --show-prefix` is empty only at the top level), so short names, slashes and case no longer matter; a copy nested inside another checkout is still refused. When git refuses the folder for "dubious ownership", update now says so and prints the `safe.directory` command instead of calling it a tarball. New `app/tests/v0218-wincifix.test.mjs` covers a git that spells the top level differently, the dubious-ownership message, a real 8.3 short path on Windows, and a HOME with a `~` in it.
- Tests: the `~\` plans-path test no longer fails when HOME itself contains a `~` (8.3 short names such as `RUNNER~1` on GitHub's Windows runners); it now checks that the resolved plans folder is exactly HOME plus `plansdir`.

## 0.2.17

- Fixed (Windows): a plans path Setup saved as `~\\...` is now expanded (`app/paths.mjs` `expandHome`, used by setup, settings and the other `~` readers). Before, `npm run update` scaffolded into a literal `~` folder inside the repo and missed stale scheduled chats.
- Fixed (Windows): worker tracking no longer times out. jobs-track finds parent processes from one Toolhelp32 snapshot instead of a PowerShell `Get-CimInstance` per lookup, and worker-launch records the job asynchronously, so a slow tracker never holds up the worker.
- worker-launch no longer says "jobs-track start failed" when the agent CLI itself did not start; it reports the missing CLI, and real tracking failures name the cause.
- Doctor's tracking fix hint names the Python it found (`python` on Windows); doctor checks the same tool list scaffold-harness links (10 tools, listed in SETUP.md).
- `npm run update` no longer says "Your data folder was not changed." before archiving a stale chat in it.
- The harness.json `run` override is honoured by `app/paths.mjs` too, so the dashboard, doctor and scaffold agree on the run folder.
- Native Windows listener: `harness/bin/auditq-wait.mjs` (Node twin of `auditq-wait.sh`, linked into `<run>/bin`); `first-run.mjs paths` prints it as `waitCommand` on Windows.
- `/api/setup` answers 502 (with `saved: true` and the error) when linking the tools fails, instead of 200.
- Setup Save merges into `setup.json` instead of overwriting it: unknown fields and omitted optional ones (`projectIcons`, `skillPrefixes`, ...) are kept.
- Fixed: agent icon over-count (from main).
- Fixed (Windows): `<run>/bin/worker-launch.sh` run from Git Bash could miss `worker-launch.mjs`. Bash followed the link through its own view of a mounted folder (the Temp folder is `/tmp`); the script now lets Node resolve the link when that happens.
- Fixed (Windows): a harness.json `run` override such as `{plans}/custom-run` now gets native separators in `app/paths.mjs`, the same as in settings.
- CI: Mac and Windows jobs test the published copy.
- CI: the tests pass on Windows (CRLF checkouts, `.cmd` fixture CLIs, Windows paths and error codes) and in the published export, where the `public.txt` check is skipped. The update-check server tests stop the server before removing its data folder. Before, Windows refused to delete the open `control.db` (EBUSY), the server kept running and the job hit its 30-minute limit.

## 0.2.16

- CI test fixes: the test suite passes in the stamped public export.

The rest of the former 0.2.16 notes shipped as 0.2.17:


- Review fixes: Windows setup imports app modules by file URL; npm `.cmd` shims run through `cmd.exe /d /s /c` with the prompt on stdin or as a file reference (`app/cli-spawn.mjs`, shared resolver with `deps.mjs`); timeouts kill and await the whole process tree. Turn delivery tracks delivered vs answered (re-delivers once, then marks failed; armed only after an answered round trip), caps failures with exponential backoff, sends bounded batches with long chats by file reference, and `--session auto` matches cwd and refuses ambiguous picks; resumes run in the registered cwd with write permissions (Codex workspace-write + `--add-dir`, Claude `--allowedTools` for the writers). The header dot uses the turn state; doctor's probe no longer arms it; doctor checks resume permissions and a worker tracking round trip; degraded tracking is reported. SECURITY.md notes that dashboard chat now reaches a headless agent.
- Worker launcher: `harness/bin/worker-launch.sh` (node; Python 3 for dashboard tracking) starts one worker on codex, claude, pi or opencode with a prompt file, cwd, timeout and effort, tracks it with the shipped jobs-track so it appears on the dashboard, and writes `pid`, `rc`, `last.txt`, logs and `meta.json` to an outdir. It never stores credentials. `--background`, `--dry-run`, `--model`, `--plan`, `--label`. Setup links it into `<run>/bin`; the setup skill and AGENTS.md teach it.
- Fixed: the Jev router's launch lines (`harness/jev-routes.json`, `app/jev-routes.example.json`) called an unshipped `_run/bin/agent.sh`; they now call `worker-launch.sh`.
- Turn-based SuperAgents: Codex, Pi and OpenCode chats register once (`node app/turn-delivery.mjs register --harness codex --session auto`) and the server delivers each Refresh, Watcher chat and done-check request as a resumed turn through the send-to-agent path (`codex exec resume`, `claude --resume -p`, and new `pi --session -p` and `opencode run --session` adapters). Each request is delivered once; a failed delivery is retried after two minutes and turns the header dot red. The v0.2.15 `auditq-wait.sh` listener path is unchanged and takes precedence while it beats.
- `node tools/first-run.mjs doctor [--json]` checks data and run folder writes, a localhost call to the dashboard, the tool links and heartbeat/listener freshness, and prints the exact fix for each failure (for example `codex --add-dir ~/.agentglim`).
- Run-mode controls show "not included in this install" when no mode handler exists, and `/api/mode` answers 501 with that message instead of a 500.
- `status-write.mjs --help` prints usage instead of writing a status. It finds a dashboard on a non-default port through `<data>/server-url.json` (written by the running server; `AGENTGLIM_URL` overrides) and warns when the dashboard does not answer instead of silently writing empty plan counts.
- The header no longer shows "run started undefined" on a fresh install.
- A scaffold failure with one cause (for example `<run>/bin` is a file) is reported once, naming the folder, instead of "(ENOTDIR; ENOTDIR)" per tool.
- README starts the dashboard with `node app/server.mjs`, like SETUP.md.
- Upgrade cleanup: installs upgraded from v0.2.13/v0.2.14 no longer print an old queued "Run the weekly goals review with the goals-weekly-review skill (scheduled)" chat before Refresh. `npm run update` and server start move unanswered goals-app scheduled chats whose skill is not installed into `<run>/chat_inbox/_archive/` (never deleted).

## 0.2.15

- SuperAgent arming is now one verifiable procedure in AGENTS.md, the `agentglim-setup` skill and the run folder's `AGENTGLIM-HARNESS.md`: resolve the paths with `node tools/first-run.mjs paths`, touch the heartbeat, run the listener in a session you read, re-run it after every exit, and confirm one Refresh reply before saying ready.
- Fixed: the header dot stayed red after setup. It is now armed by a fresh SuperAgent heartbeat alone (`heartbeats/superagent`), whatever the install; the listener's own beat and the 30-minute check are extra information, and a silent listener is named separately ("Dashboard listener not running. Ask your agent to start it.", with a Copy button for the startup prompt and the exact resolved command). "Driver is off" no longer shows when no driver is installed.
- Fixed: Refresh status failed with HTTP 500 on a fresh install because `<run>/modes.json` did not exist. It is optional now.
- Fixed: the setup skill's heartbeat command wrote to `/heartbeats/superagent` when `AGENTGLIM_DATA` was unset. Paths now come from `app/paths.mjs` through `first-run.mjs paths`; Setup shows "restart needed" after the plans folder changes; README defaults match the code.
- Setup no longer says "Saved" when linking the SuperAgent tools failed: `/api/setup` returns `saved`, `ready` and the error, the Setup page shows them separately, and both Setup and `first-run.mjs apply` record completion only after the tools are linked. An old completion marker cannot hide a failed repair.
- Updates are one command: `npm run update` runs `git pull --ff-only` on `main`, then refreshes the global note, the skill copies and the run folder's links, scripts and note without touching your data. README, docs/install and SETUP.md document only that path; the header pill copies it. Version stamping stays with the release script.
- `auditq-wait.sh` no longer hints at scripts that do not ship: the `MODE:` wake-up and the `modes.mjs decline-at` hint are gone, and every hint names the run folder it resolved (`<run>/bin/...`).
- Startup commands and listener hints safely quote paths; copied CLI wrappers execute on systems without symlink permission, including upgrades from older Windows wrappers. CI syntax-checks harness and tools scripts.
- The public `AGENTS.md` no longer carries owner machine learnings or private launcher paths; they moved to a local, unshipped notes file.

No worker launcher or mode handler ships in this version.
