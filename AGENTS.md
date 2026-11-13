# AGENTS.md

## Privacy rule

Never write personal data into this repo: no goals, plan state, usage, leads, names or home-folder paths.
Personal data goes in `$AGENTGLIM_DATA` (default `~/.agentglim/`). Run `npm run privacy-check` before committing.

## What AgentGlim is, and the SuperAgent

AgentGlim is this folder: a local Node dashboard (`node app/server.mjs`, default http://localhost:18990) that tracks the
user's coding agents (Claude Code, Codex, Pi, OpenCode): usage limits, goals, project plans and a Status card. The
**SuperAgent** is the user's own agent session that supervises it. If you are asked to "be the SuperAgent", "be the
AgentGlim SuperAgent" or "set up AgentGlim", or you were opened in or near this folder, this is the project: do not ask
what AgentGlim is. Read `skills/agentglim-setup/SKILL.md` (Claude Code also finds it as the `agentglim-setup` skill)
and follow it. In short: run `node tools/first-run.mjs status`; if setup or goals are missing, run the first-run
interview below; then keep `$AGENTGLIM_DATA/heartbeats/superagent` fresh (at least every five minutes) and answer the
dashboard's requests with `bash <run>/bin/auditq-wait.sh`, `status-write.mjs`, `chat-write.mjs` and `owner-check.mjs`.
From another folder, the global note that setup installs (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`) gives the path.

## First run: the agent leads the setup, in chat

When `node tools/first-run.mjs status` says `needsSetup` (no `setup.json` / `setup-complete`, or goals still the bundled
examples), run the setup as a plan-mode-style interview in the chat, **one question at a time**, never a batch:
harnesses, Jev routing, daily API budget, then the user's goals (and one follow-up per goal), then whether to install the
global note. Give a recommended answer with each question. Confirm a short summary, then write everything with
`node tools/first-run.mjs apply answers.json`: it saves `setup.json`, `setup-complete`, `budget.json`, the goals and
goal map under `$AGENTGLIM_DATA`, links the SuperAgent tools (scaffold) and can install the global note. The first
launch opens the normal dashboard (`/`), not the Harness page. The Setup page (`/setup`) stays for later changes.

## Setting up a new user (rules)

1. The interview above is the default. Read SETUP.md and schemas. Create a plans folder under the private data
   directory by default. A plans folder alone does not include a plans driver or worker routing: AgentGlim ships
   neither, and no setup step may claim it can spawn or route build agents.
2. Detect logged-in Claude, Codex, Pi and OpenCode independently (`first-run.mjs status`). Enable only subscriptions
   the user uses. Start built-in usage tracking immediately; no plans driver is required. Never write credentials and
   never ask for keys in chat.
3. Goals and the goal map come from the user's answers (`first-run.mjs apply`), validated against `schemas/`. Keep all
   private state outside this repository.
4. Propose one default budget: detected subscription prices plus a $5/day API tracking cap. Ask once to accept or
   change it. These are local tracking limits, not provider spending controls.
5. When setup is saved, run refresh/status, then say: "Refresh AgentGlim and send status to your AI agent." Offer to be
   their SuperAgent. Update the private `heartbeats/superagent` file at least every five minutes while supervising.
   Do not claim a running watcher without an actual heartbeat. No step assumes a particular AI harness.
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
