---
name: agentglim-setup
description: Set up AgentGlim and act as its SuperAgent. Use when the user says "set up AgentGlim", "be the AgentGlim SuperAgent", "be the SuperAgent", or opens an agent in the agentglim folder for the first time. Runs a one-question-at-a-time setup interview in chat (Claude Code or Codex), writes the setup and goals, links the tools, then runs the SuperAgent loop.
---

# AgentGlim: first-run setup and SuperAgent

AgentGlim is a local dashboard (a Node app in the agentglim folder) that tracks your coding agents' usage limits, your goals and your project plans. The SuperAgent is you, the user's own agent: you keep a heartbeat file fresh and answer the dashboard's Refresh, chat and check requests.

## 0. Find the folder

The AgentGlim folder has `tools/first-run.mjs` and `app/server.mjs`. Use the current folder or a parent that has them. If you are somewhere else, use the path in the user's global AgentGlim note (in `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`), `$AGENTGLIM_HOME`, or look in `~/agentglim`, `~/Downloads/agentglim*`, `~/dev/agentglim`, then `find ~ -maxdepth 4 -path '*/tools/first-run.mjs'`. Work from that folder. Never write personal data into it: goals, usage and state live in `$AGENTGLIM_DATA` (default `~/.agentglim`).

## 1. Is setup needed?

    node tools/first-run.mjs status

`questions` lists what is still open (`harnesses`, `jev`, `budget`, `goals`). If it is empty, setup is done: skip to section 4.

## 2. The interview (plan-mode style, in chat)

Rules: ask **one question at a time**, wait for the answer, then ask the next. Never batch questions or show a form. Give your recommended answer with each question so "yes" is enough. Keep each message to two or three lines. Never ask for keys or passwords in chat; credentials stay in login files or `.env`.

Ask only the questions listed in `questions`, in this order:

1. **Harnesses.** Say which of Claude Code, Codex, Pi and OpenCode `status` found logged in, and ask which ones to track. Recommend the logged-in ones.
2. **Jev routing.** Jev picks the model and effort for each subagent job (needs a Jev key). Recommend off unless the user has a key.
3. **Daily API budget.** A local tracking cap, not a provider limit. Recommend $5 per day.
4. **Goals.** Ask what the user wants their agents to move forward. Then, one question each: for every goal, what is the first concrete next step, and what would "done" look like? Ask "Anything else?" until the user says no. Suggest 1 to 3 goals; allow up to 12.
5. **Global note.** Ask once: "May I add a short AgentGlim note to your global agent instructions and install this skill, so any agent in any folder knows what AgentGlim is?" Recommend yes.

Then show a short summary and ask "Save this?" Do not write anything before the yes.

## 3. Save

Write the answers to a temporary JSON file (outside the repo) and apply them:

    node tools/first-run.mjs apply /path/to/answers.json

    { "harnesses": ["codex"], "jev": false, "apiDailyUsd": 5, "globalHints": true,
      "goals": [ { "title": "Ship the first feature", "next_action": "Write the acceptance list",
                   "outcome": "A customer can use it", "metric": "Paying users" } ] }

This saves `setup.json` and the `setup-complete` marker, writes `goals/goals.json` and `goal-map.json` (previous files are kept as `.bak-<time>`), links the SuperAgent tools into the run folder (`npm run scaffold-harness` does the same) and, with `globalHints`, installs the global note and this skill. If the dashboard is already running, tell the user to reload; it picks the data up within seconds. Setup can be changed later on the dashboard's Setup page (`/setup`).

## 4. Start the dashboard

If nothing answers on the configured port (default 18990), start `node app/server.mjs` in the background and give the URL `http://localhost:18990/`. The first launch opens the normal dashboard, not the Harness page. Tell the user: "Refresh AgentGlim and send status to your AI agent."

## 5. SuperAgent loop

Offer once to be the SuperAgent, or just do it if the user asked. Never claim a watcher is running without a heartbeat.

- Heartbeat: `mkdir -p "$AGENTGLIM_DATA/heartbeats" && touch "$AGENTGLIM_DATA/heartbeats/superagent"` now and at least every five minutes while you supervise.
- Wait for requests: `bash <run>/bin/auditq-wait.sh` (run folder is `$AGENTGLIM_RUN`, default `<plans>/_run`, scaffolded in step 3). It keeps its own heartbeat, prints `STATUS:`, `CHAT:`, `CHECK:` or `MODE:` lines when the dashboard needs you, and exits after about 50 minutes: re-run it.
- Answer: `node <run>/bin/status-write.mjs --done "..." --running "..." --blocked "..." --next "..." --optimize "..."` for a refresh; `node <run>/bin/chat-write.mjs --reply "..." --to <ms>` for chat; `node <run>/bin/owner-check.mjs list` for checks. Keep answers short.
- Sandboxes: Codex needs write access to the data folder (`--add-dir ~/.agentglim` or a workspace-write profile that includes it). If a write is refused, say so instead of pretending it worked.
- No plans driver, worker routing or build-agent spawning ships with AgentGlim; do not claim to have them.

Contributor checks such as `npm run privacy-check` are not setup steps.
