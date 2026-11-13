# AGENTS.md

## Privacy rule

Never write personal data into this repo: no goals, plan state, usage, leads, names or home-folder paths.
Personal data goes in `$AGENTGLIM_DATA` (default `~/.agentglim/`). Run `npm run privacy-check` before committing.

## Setting up a new user

When the user asks you to set up AgentGlim, use the bundled `skills/agentglim-setup/SKILL.md`.

1. Quick setup is the default, under a minute. Read SETUP.md and schemas. Infer the most important projects
   on this machine and track their weekly progress. Infer useful metrics from project context; do not interview
   the user about goals or metrics. Create a plans folder under the private data directory by default. A plans
   folder alone does not include a plans driver or worker routing: AgentGlim ships neither, and no setup step
   may claim it can spawn or route build agents.
2. Detect logged-in Claude, Codex, Pi and OpenCode independently. Enable only subscriptions the user uses.
   Start built-in usage tracking immediately; no plans driver is required. If the user wants the Status card,
   Watcher thread and queue controls, run `npm run scaffold-harness` and say what it does and does not add.
   Never write credentials.
3. Create goals and goal-map JSON from examples under `$AGENTGLIM_DATA` (default `~/.agentglim`), validating
   against schemas. Keep all private state outside this repository.
4. Propose one default budget: detected subscription prices plus a $5/day API tracking cap. Ask the user once
   to accept or change it. These are local tracking limits, not provider spending controls. Persist the accepted
   budget in the private data directory and save Setup via its local API (include the app Origin).
5. On successful setup, save the private `setup-complete` marker. Run refresh/status, then say: "Refresh
   AgentGlim and send status to your AI agent." Offer to be their SuperAgent. Update the private
   `heartbeats/superagent` file at least every five minutes while supervising. Do not claim a running watcher
   without an actual heartbeat. No step assumes a particular AI harness.
6. Start with `node app/server.mjs` and report the local URL from the configured port.

Privacy checks are contributor checks before commits, never user setup steps. See CONTRIBUTING.md.

## Plans, merges and jobs on the board (2026-11-11)

- Plans: every `NN-slug` folder with a PLAN.md under the plans root is listed, with or without driver state (`app/plan-meta.mjs`).
- Merges: one source of truth, a `> **Folded into NN-slug** (date)` line at the top of the merged plan's PLAN.md. `subprojects.json` only adds names and item ids for older merges. Parents of folded plans (and plans the driver has not run yet) get a row in Active builds.
- Icons: hand picks in `app/plan-icons.js` (HAND, by plan number); any other plan gets a POOL glyph by keywords, saved in `data/plan-icons.json`. Never the default "i".
- Jobs: `--plan NN-slug` on every launch (agent.sh, `jobs-track run`) or a `[plan: NN-slug]` prompt tag; inference order and end states are in `tools/addons/jobs-track.py`. Keep it identical to `plans/_run/bin/jobs-track.py` except the config lines.

## Applied learning

- If systemctl cannot connect, use busctl at unix:path=$XDG_RUNTIME_DIR/bus.
- Finish Tauri bundling before smoke tests; packaging patches the executable.
- Xvfb smoke tests may need Mesa EGL selection and GLX disabled on some GPU drivers.
- Read-only Git metadata: commit from a writable temporary clone, then push the authorized branch.
- GitHub CLI can reuse host-scoped Git credential helpers; capture credentials without printing them.
- After repository renames, verify assets directly; successful upload logs can hide missing installers.

- Use a writable npm cache in sandboxed sessions.
- Sandbox loopback can differ from host services; test server and browser together.
- Chromium sandbox testing needs writable HOME and XDG config/cache directories.
- Price parsers must bound plan cards; comparison headings can resemble tiers.
- Server fixtures need isolated HOME; default goals sync scans session transcripts.
- Server fixtures bind both listeners to port zero; read actual ports from readiness output.
- Checkbox rollback tests need click(); uncheck() fails when handlers immediately restore checked state.
- Sandbox PIDs are per-exec; stop long-running tool sessions through write_stdin Ctrl-C.
- Video narration always uses ElevenLabs voice Brian (nPczCjzI2devNBz1zQrb).
