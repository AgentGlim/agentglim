# Settings

## Folders

Set these in your shell or in the service file (`Environment=NAME=value`). All are optional.

| Variable | Default | What it is |
|---|---|---|
| `AGENTGLIM_WORK` | `~/.local/share/agentglim` | Working folder: `data/`, `probes/`, `imported/` |
| `AGENTGLIM_DATA` | `$AGENTGLIM_WORK/data` | History, caches, approvals, Control page state |
| `AGENTGLIM_PLANS` | `~/dev/projects/plans` | The plans harness the dashboard watches, if you use one |
| `AGENTGLIM_RUN` | `$AGENTGLIM_PLANS/_run` | The harness run folder |
| `AGENTGLIM_PROJECTS` | `~/dev/projects` | Your projects folder, for the optional panels |

Panels whose folder or file is missing stay empty.

## Harness settings

Defaults are in `app/settings.defaults.json`. Do not edit that file. Put your own values in
`~/.config/agentglim/harness.json` (or the file named by `AGENTGLIM_CONFIG`) with the same shape and only
the keys you change, for example:

```json
{ "jev": { "routes": "~/agentglim-rules/jev-routes.json" } }
```

Check the merged result with `node app/settings.mjs`, or one value with `node app/settings.mjs --get jev.routes`.

## Jev routing rules

The Routing and Harness pages read the Jev rules file named by `jev.routes` (default: `harness/jev-routes.json`
in this repo). To change the rules, copy it somewhere outside the repo, edit it, and point `jev.routes` at
your copy.

## SuperAgent inbox resend

The dashboard can resend an unanswered chat message to the headed SuperAgent session. It re-touches
the pending inbox file, records `<ms>.json.resent`, and (only with a registered session) nudges the
session's tmux pane; the retry gap grows 2, 5, 15, 30 minutes. See
[inbox-resend.md](inbox-resend.md) for the delivery rules and safety checks.

| Variable | Default | What it does |
|---|---|---|
| `AGENTGLIM_INBOX_RESEND` | on | Set `0` to stop all resends; the Status line stays. |
| `AGENTGLIM_INBOX_RESEND_SECS` | `120` | Seconds before the first resend. |
| `AGENTGLIM_INBOX_RESEND_MAX_HOURS` | `24` | Stop resending a message older than this. |
| `AGENTGLIM_INBOX_RESEND_TMUX` | on | Set `0` to wake the file waiter without typing into the session. |
| `AGENTGLIM_INBOX_SESSION` | `<data>/inbox-session.json` | Registered session identity file. |

Register from inside the headed session with `node app/inbox-resend.mjs register`; check the current
state with `node app/inbox-resend.mjs status`.

## Private names

`~/.config/agentglim/private-names.txt` (one name per line) is optional. Plan documents that name you instead of
saying "the owner" are read as owner items, and `npm run privacy-check` flags any file that holds one of these
names. Keep this file out of every repo.
