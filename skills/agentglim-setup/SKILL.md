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

## 5. SuperAgent loop: arm it, then prove it

Offer once to be the SuperAgent, or just do it if the user asked. Never claim a listener is running without evidence.

1. **Resolve the paths from the app.** Run `node tools/first-run.mjs paths` in the AgentGlim folder, with the same environment as the dashboard, and use its `data`, `run`, `heartbeat` and `waitCommand` values everywhere below. Do not assume `$AGENTGLIM_DATA` or `$AGENTGLIM_RUN` are set (they usually are not) and do not guess `_run` or `~/.agentglim/plans`. If it prints `restartNeeded` or a warning, tell the user to restart AgentGlim first. If `toolsReady` is false, run `npm run scaffold-harness` and read its output.
2. **Check you can write there.** Codex needs write access to the data and run folders (`--add-dir <data>` or a workspace-write profile that includes them). If a write is refused, say so instead of pretending it worked.
3. **Heartbeat.** `mkdir -p "$(dirname <heartbeat>)" && touch <heartbeat>` now and at least every five minutes while you supervise.
4. **Start the listener in a session whose output you read:** run the printed `waitCommand` (`bash <run>/bin/auditq-wait.sh`). It keeps its own heartbeat (extra information for the header dot; your heartbeat above is what arms it) and prints `STATUS:`, `CHAT:`, `CHECK:` or `PENDING:` when the dashboard needs you. It never prints `MODE:`: AgentGlim ships no mode handler, so a mode click in the dashboard is not applied and you should say so. A background job whose output nobody reads answers nothing.
5. **Handle each request, then re-run it.** The listener exits after every request and after about 50 minutes. Answer, then start it again, every time.
   - `STATUS:` `node <run>/bin/status-write.mjs --done "..." --running "..." --blocked "..." --next "..." --optimize "..."`
   - `CHAT:` `node <run>/bin/chat-write.mjs --reply "..." --to <ms>`
   - `CHECK:` `node <run>/bin/owner-check.mjs list`, then confirm or reopen with evidence
6. **Verify before you say "ready".** Ask the user to click Refresh in the dashboard (or click it yourself) and confirm that one reply arrives (a handled `status_ask`, then `status-write.mjs`). A fresh heartbeat alone is not proof. Then say exactly what is running: heartbeat, listener, and that no worker launcher ships.

The dashboard's header shows "Dashboard listener not running" with a Copy button when the heartbeat is fresh but the listener is not; the copied prompt is this section.

No plans driver, worker routing or build-agent spawning ships with AgentGlim; do not claim to have them.

## 6. After an update

To update, run `npm run update` in the AgentGlim folder (`git pull --ff-only` on `main`, then it refreshes the global note, the skill copies and the run folder's linked tools; it keeps your files and data), restart the dashboard, and re-read this skill: your installed copy may be older than the folder's.

Contributor checks such as `npm run privacy-check` are not setup steps.
