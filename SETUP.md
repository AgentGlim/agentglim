# Setting up AgentGlim

Quick setup is the default and should take under a minute. Supported runtimes: Node 22.13-24, Python 3.11+.
Node 22.13.0 or newer is required; Python is needed only for Python utilities. Other add-ons are optional.

Open an AI agent (Claude Code, Codex, Pi or OpenCode) in the agentglim folder and ask it to set up AgentGlim.
When it is done, ask it to be your SuperAgent. The agent infers important projects and useful metrics from this
machine and creates a private plans folder by default. It asks once to accept a default budget or change it.

Start the dashboard with `node app/server.mjs`, then open http://127.0.0.1:18990/setup.
Use `/setup` on your configured port if it differs. Detect logged-in harnesses and begin usage polling immediately;
a plans harness is optional. After setup, refresh AgentGlim and send status to your AI agent.

## Private data

Runtime data defaults to `~/.agentglim`. `AGENTGLIM_DATA` overrides the data folder. If `AGENTGLIM_WORK` is set,
data defaults to its `data/` subfolder. No machine automatically uses another project's working directory.

- Goals: `goals/goals.json` and `goals/goal-map.json`, validated against `schemas/` using `examples/`.
- Setup: `setup.json`; completion: `setup-complete`.
- Budget: `budget.json`. Start with detected subscription totals and a $5/day API tracking cap; accept or edit once.
- Usage: `usage-limits.json` and `flags/`. Credentials are read from login files or .env, never written here.
- Monitoring: `proc-guard.json`, `proc-guard.ndjson`, `claude-resets.json`.

Optional workspace overrides: `AGENTGLIM_PROJECTS`, `AGENTGLIM_PLANS`, `AGENTGLIM_RUN`, and `AGENTGLIM_GOALS`.
A fresh clone works without any plans folder. Only create a plans workspace in private data for a new user;
never copy another person's projects, goals, logs or skill library.

## Subscriptions and keys

Each subscription is a list: one tier, monthly price and login-file/environment-variable reference per account.
Choose Claude Pro, Max or legacy Max tiers; ChatGPT Free, Go, Plus, Pro 100/200/500 or organizational tiers;
and OpenCode Go or Go Plus. The source-backed catalog is `app/prices.json`. Runtime HTTP checks update the private
`prices.json` daily, preserve the last verified prices on failures, and show changes on Setup. Prices are USD
before tax; custom organizational prices need an explicit entry. Legacy tier choices stay available for existing users.

Use `FOO_API_KEY`, `FOO_API_KEY_2`, `FOO_API_KEY_3`, and so on for API accounts. Claude OAuth tokens may use
`CLAUDE_CODE_OAUTH_TOKEN_2`; Codex access tokens may use `CODEX_ACCESS_TOKEN_2`. For multiple OAuth logins, use
separate login JSON files on each subscription entry. Never paste a credential into the Setup page or chat.
OpenCode's older DATA/INFO key names continue to work. Removing a row leaves the underlying .env credential intact.

Without a live driver, enabled Codex and Go accounts poll every two minutes and Claude every fifteen minutes.
429 responses honor Retry-After or exponential backoff up to thirty minutes. Cards become stale at twice their interval.
Set `pollMs` in private `budget.json` or the configured harness config to override intervals. No model calls are made.
Claude's `/usage` CLI fallback is used only after non-rate-limit endpoint failures for the default account.

## Optional add-ons

Setup lists detected dependencies, missing-feature behavior, licenses and copyable OS installation steps.
`npm run install-addons` installs links for the bundled notification, routing and tracking utilities and project skills.
Existing commands/skills are preserved. Python 3.11+ is needed for Python utilities. No external project is required.

For automatic Claude reset checks, install Playwright and system Chromium, then use **Sign in to claude.ai once**.
The browser uses a dedicated `~/.config/agentglim-claude-profile`. Daily checks read Settings → Usage only;
AgentGlim never clicks reset buttons or sends reset requests. Until signed in, check resets manually each day.
To import private manual evidence, run `node app/claude-resets.mjs --seed FILE.json`; existing readings are preserved unless `--replace` is explicit.
Screenshots are opt-in debugging output kept in private data. All daily jobs and the process guard are disabled in dev.

The Linux process guard excludes tracked jobs, servers, the driver and terminals. Auto-stop is off by default.
Stop uses the exact PID plus process identity, SIGTERM and a revalidated SIGKILL after ten seconds. Allow lasts only
for that process lifetime. Stale subagent transcripts are reported without stopping anything.

The Skill Editor (`/skills`) maps this machine's installed skills and lets you read and edit their files.
The read-only inventory is at `/skills/inventory`. Bundled helpers live in `skills/`, with project
harness links installed on request. Personal global skills and plugin libraries are never packaged.

The sun/moon button at the top right of the dashboard and Skill Editor switches the whole page between
dark (the default) and light. Both pages share the choice in `$AGENTGLIM_DATA/prefs.json` through
`GET`/`PUT /api/prefs`; writes require the app's own Origin and JSON content type. A localStorage cache
applies the choice before the first paint, and the server copy survives restarts and browser cache clearing.

## Optional local integrations

Copy `integrations.example.json` to `$AGENTGLIM_DATA/integrations.json` (default `~/.agentglim/integrations.json`)
or `~/.config/agentglim/integrations.json`. Restart AgentGlim after editing it. Keep this file outside the repository.
The first existing file wins: `AGENTGLIM_INTEGRATIONS` (an exclusive file override), then the data directory,
then `$XDG_CONFIG_HOME/agentglim/integrations.json` (`~/.config` when unset). Invalid JSON disables integrations.
Paths support `~/`; relative paths resolve from the config file's directory. Missing or null entries are disabled.

| Key | Optional behavior |
| --- | --- |
| `auditPlan` | Plan folder name under the plans root whose feature list and loop status stay visible. |
| `remotePlan` | Plan folder name under the plans root with a separate mean of completed feature audit scores. |
| `fleetSnapshot` | Fleet snapshot JSON file for the Containers panel; `AGENTBOX_FLEET_SNAPSHOT` overrides it. |
| `leadsPath` | Campaign project root for its read-only panel, `model_prices.json` ledger, and optional `tools/update_prices.py` updater. |
| `emailSequencePath` | Email sequence project root; the panel reads only aggregate counts and latest commit metadata. |
| `playwrightModule` | Path to a Playwright package or entry file for browser tests. `PLAYWRIGHT_MODULE` overrides it; otherwise tests use a locally installed `playwright` package. |
| `skillsUrl` | Header Skill Editor button destination. Defaults to `/skills`; accepts app-relative paths or HTTP(S) URLs. |
| `updateCheck` | New-release check in the dashboard header. On by default; set `false` to turn it off (equivalent to `AGENTGLIM_NO_UPDATE_CHECK=1`). |

With no config, campaign, email sequence, and Containers panels stay hidden. Configured campaign and email panels
appear under Custom projects, preserving any order saved in Setup. The built-in `/skills` page always stays available.

## Update notice

When a newer public release exists, the dashboard and `/skills` show a small header pill with the release link and
copyable update commands (git pull and the tarball download). It never installs anything. The server asks the public
GitHub API once every 12 hours at most and caches the answer in your private data folder; it sends no user data and no
token. A `dev` build never shows the pill. Turn the check off with `"updateCheck": false` in the integrations file
above or with `AGENTGLIM_NO_UPDATE_CHECK=1` in the environment. Dismissing the pill hides it for that release only.

## SuperAgent and refresh

A SuperAgent can be any AI harness. It touches private `heartbeats/superagent` while actually supervising.
The "Your AI agent" popup appears only while the setup file is not filled out (no `setup.json` saved by Setup and no
`setup-complete` marker), on every load until it is. On a configured install the dashboard never shows that popup: a
small banner under the header asks you to send status when data is stale or the connection is lost, or to start your
SuperAgent when no heartbeat exists. The rule lives in `app/agent-notice.mjs`; "filled out" is `setupFilled()` in
`app/setup.mjs`.

For contribution and release checks, see CONTRIBUTING.md.
