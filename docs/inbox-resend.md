# SuperAgent inbox resend

AgentGlim can keep an unanswered message in the plans harness chat inbox from sitting unseen. The
SuperAgent stays a headed, interactive session: this job only nudges it and records that it tried.

## What it does

The inbox is `<run>/chat_inbox/<ms>.json`; an answer renames it to `<ms>.json.answered` (see
`_run/bin/chat-write.mjs`). When a message is still pending after `AGENTGLIM_INBOX_RESEND_SECS`
(default 120 seconds), AgentGlim:

1. re-touches the pending `<ms>.json` (no content change, no new message),
2. when a headed session is registered, nudges that session's tmux pane,
3. writes `<ms>.json.resent` with the time, count and reason, and
4. waits longer before the next try: 2, 5, 15, then 30 minutes, and every 30 minutes after that.

The `.resent` mark tells the SuperAgent this is the same message, not new work. Resending twice is
harmless; answering the message ends the resends. A message older than 24 hours is left alone and
shown as stale.

## Delivery: what is used and why

**The pending message file is the wake file.** The harness waiter (`_run/bin/auditq-wait.sh`) checks
`chat_inbox/*.json` every 15 seconds and exits with `CHAT: ...` when one appears. Re-touching the file
also changes its modification time, which is what mtime-based watchers (such as the Codex watcher
bridge's event signature) notice. This is the always-on part: it needs no session registration, cannot
inject a wrong keystroke, and never adds a message. If the waiter is not armed, however, a file touch
alone cannot wake an interactive session.

**A registered headed session can also be nudged in tmux.** This reaches a session whose waiter is not
armed. Identity is never guessed: it comes only from `<data>/inbox-session.json`, written by running

```sh
node app/inbox-resend.mjs register
```

from inside the headed session. That command walks its own parent chain to the nearest `claude`
process, reads Claude Code's own registry record at `~/.claude/sessions/<pid>.json`, and requires the
session working folder to be under the plans folder. Before every keystroke AgentGlim re-checks:

- the pid is still running and its process start time matches the registration (no pid reuse),
- the working folder is still under the plans folder,
- the recorded tmux pane still exists, is owned by that process, and is running `claude`.

Then it pastes one short line and presses Enter, the same way the Control page sends text. A busy
session queues the text for its next turn. `AGENTGLIM_INBOX_RESEND_TMUX=0` keeps the wake-file touch
and turns the keystroke off.

**Not used: Claude's cross-session `SendMessage` / peer socket.** It is an internal, model-invoked
tool: there is no CLI or queue command for another process to call it, its socket envelope is
undocumented, and its inbound policy is a per-session setting. The Control page's peer client only
speaks a documented-by-us test protocol, not the real one. Delivering through it would be a guess.
Codex's `codex queue --thread <id> --message ... --resume` is a real external wake, but it is
Codex-only; the SuperAgent here is a headed Claude Code session. There is no headless fallback agent.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `AGENTGLIM_INBOX_RESEND` | on | Set `0`/`off` to stop all resends (status stays visible). |
| `AGENTGLIM_INBOX_RESEND_SECS` | `120` | Seconds an answer may wait before the first resend (10-86400). |
| `AGENTGLIM_INBOX_RESEND_MAX_HOURS` | `24` | Stop resending a message older than this (1-720). |
| `AGENTGLIM_INBOX_RESEND_TMUX` | on | Set `0`/`off` to re-touch the wake file but never type into the session. |
| `AGENTGLIM_INBOX_SESSION` | `<data>/inbox-session.json` | The registered session identity file. |
| `AGENTGLIM_CHAT_INBOX` | `<run>/chat_inbox` | The inbox folder, when it is not under the run folder. |

The job runs on the shared scheduler every 30 seconds, so it needs no service of its own. Until that
scheduler is in the running build, a temporary user timer can call the one-shot command:

```sh
node app/inbox-resend.mjs run-once
```

A lock file in the data folder keeps the server and a timer from resending at the same moment. Remove
the timer once the scheduler runs the job.

## `.resent` format

```json
{"at":"2026-11-12T16:05:00.000Z","count":2,"reason":"auto-resent: unanswered after 245s","via":"wake+tmux","session":"plans-53","delivered":true,"error":null}
```

`via` is `wake` (touch only) or `wake+tmux` (touch and a session nudge). `error` names the reason a
keystroke was refused. The next retry comes 2/5/15/30 minutes after the recorded time, depending on
`count`.

## Commands

```sh
node app/inbox-resend.mjs status          # counts, last resend, session state, per-message timing
node app/inbox-resend.mjs status --json
node app/inbox-resend.mjs run-once        # one check, for a timer or a manual retry
node app/inbox-resend.mjs register        # from inside the headed SuperAgent session
node app/inbox-resend.mjs register --pid <pid> --name <name>
```

The dashboard Status card shows the same numbers: pending messages, resend count and the last resend
time, plus whether a session is registered for delivery.

## Safety rules

- Only files named `<digits>.json` are considered; `.answered`, `.accepted`, temporary and unrelated
  files are ignored.
- Message text is never copied into status, changed or answered. No file is deleted.
- No keystroke happens without an explicit registration that still validates.
- Resends stop after the max age, and the 30-minute interval caps the rate.
- Everything binds to local files; no network, no paid call.
