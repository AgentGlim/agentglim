# Changelog

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
