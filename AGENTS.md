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
interview below. Then arm the SuperAgent: run `node tools/first-run.mjs paths` and use its resolved `data`, `run`,
`heartbeat` and `waitCommand` (never guess paths or rely on unset `$AGENTGLIM_DATA`/`$AGENTGLIM_RUN`); touch the
heartbeat file (`<data>/heartbeats/superagent`) at least every five minutes; start `waitCommand` (`bash <run>/bin/auditq-wait.sh`) in a session whose
output you read; answer each request with `status-write.mjs`, `chat-write.mjs` or `owner-check.mjs`; **re-run the
listener after every exit** (it exits after each request and about every 50 minutes); and verify one dashboard Refresh
reply before you say you are ready. A heartbeat alone is not "ready". Codex, Pi and OpenCode chats cannot hold the
listener between turns: register the session (`node app/turn-delivery.mjs register --harness codex --session auto`) and
the server delivers each request as a resumed turn. `node tools/first-run.mjs doctor` checks writes, the localhost call,
tool links and freshness, and prints exact fixes (such as `codex --add-dir <data>`).
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
   directory by default. A plans folder alone does not include a plans driver or worker routing. AgentGlim ships one
   worker launcher (`bash <run>/bin/worker-launch.sh <codex|claude|pi|opencode> <cwd> <promptfile> <outdir> <timeoutSeconds> <effort>`,
   tracked by jobs-track, see the setup skill) but no driver, scheduler or mode handler; never claim those.
2. Detect logged-in Claude, Codex, Pi and OpenCode independently (`first-run.mjs status`). Enable only subscriptions
   the user uses. Start built-in usage tracking immediately; no plans driver is required. Never write credentials and
   never ask for keys in chat.
3. Goals and the goal map come from the user's answers (`first-run.mjs apply`), validated against `schemas/`. Keep all
   private state outside this repository.
4. Propose one default budget: detected subscription prices plus a $5/day API tracking cap. Ask once to accept or
   change it. These are local tracking limits, not provider spending controls.
5. When setup is saved (and the tools are linked: `first-run.mjs apply` reports `ready`), run refresh/status, then say:
   "Refresh AgentGlim and send status to your AI agent." Offer to be their SuperAgent and arm it as above.
   Do not claim a running listener without a fresh listener beat and a verified Refresh reply. No step assumes a
   particular AI harness. If `apply` reports `ready:false`, setup is not complete: fix the scaffold error and apply again.
6. Start with `node app/server.mjs` and report the local URL from the configured port.

Privacy checks are contributor checks before commits, never user setup steps. See CONTRIBUTING.md.

## Plans, merges and jobs on the board (2026-11-11)

- Plans: every `NN-slug` folder with a PLAN.md under the plans root is listed, with or without driver state (`app/plan-meta.mjs`).
- Merges: one source of truth, a `> **Folded into NN-slug** (date)` line at the top of the merged plan's PLAN.md. `subprojects.json` only adds names and item ids for older merges. Parents of folded plans (and plans the driver has not run yet) get a row in Active builds.
- Icons: hand picks in `app/plan-icons.js` (HAND, by plan number); any other plan gets a POOL glyph by keywords, saved in `data/plan-icons.json`. Never the default "i".
- Jobs: tag every launch with `--plan NN-slug` or a `[plan: NN-slug]` prompt tag; the inference order and end states are in `tools/addons/jobs-track.py`.
