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

## Private names

`~/.config/agentglim/private-names.txt` (one name per line) is optional. Plan documents that name you instead of
saying "the owner" are read as owner items, and `npm run privacy-check` flags any file that holds one of these
names. Keep this file out of every repo.
