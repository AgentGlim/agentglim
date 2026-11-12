# Desktop apps: where they store sessions

Research note for plan 68 (02-adapters-parity). Status of each claim: **verified** = confirmed from a first-party
document in this round; **unverified** = third-party write-up or inference, to be checked on a real machine.
Nothing here was checked against a real install (no real tool files exist in the build environment).

## Claude desktop

| Item | macOS | Windows | Linux | Status |
|---|---|---|---|---|
| App config `claude_desktop_config.json` | `~/Library/Application Support/Claude/` | `%APPDATA%\Claude\` (Store/MSIX installs: a sandboxed `%LOCALAPPDATA%\Packages\Anthropic.Claude_<id>\LocalCache\Local\Claude\`) | no official build; community builds use `~/.config/Claude/` or `~/.config/claude-desktop/` | macOS/Windows verified by several guides, Store path and Linux unverified |
| Chat history | server side (claude.ai account); local Electron caches only | same | same | unverified |
| Claude Code sessions started from the desktop app | `~/.claude/projects/` (same store as the CLI) | `%USERPROFILE%\.claude\projects\` | `~/.claude/projects/` | unverified: the app embeds Claude Code, so the claude-code adapter should see them; confirm on a real install |

Shares `~/.claude` with the CLI: expected yes (unverified). The chat side has no local transcript store worth
tailing; only Claude Code sessions are watchable.

## Codex desktop app (OpenAI)

| Item | macOS | Windows | Linux | Status |
|---|---|---|---|---|
| Config `config.toml` | `~/.codex/` | `%USERPROFILE%\.codex\` | `~/.codex/` | verified for CLI + IDE extension (OpenAI docs), unverified for the desktop app (third-party) |
| Sessions | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `%USERPROFILE%\.codex\sessions\...` | same as macOS | unverified for the app; CLI layout matches the codex adapter fixture |

Shares `~/.codex` with the CLI and IDE extension: yes per OpenAI docs and third-party guides (verified for
config, unverified for sessions). Caveat from one blog: the desktop app may not list CLI sessions created while its
app-server was not running; this does not matter for file tailing. The codex adapter already covers it.

## DeepSeek desktop

DeepSeek publishes a web app and mobile apps; no first-party desktop app or storage documentation was found.
Existing "DeepSeek desktop" projects are third-party Electron wrappers that keep data in the web view's
localStorage and cookies (location not documented). Status: **unverified / no official app**. Recommendation: no
adapter in v1; local DeepSeek models are covered by the Ollama and llama.cpp runtimes. Re-check if DeepSeek ships
an official desktop client.

## CLI adapters added in this round

Same caveat: all three are built from third-party descriptions (fixtures are synthetic; the owner must record real
scrubbed sessions and bless them with `AG_BLESS=1`).

- **opencode** (`~/.local/share/opencode/storage/`): `session/<projectID>/<ses_id>.json`, `message/<ses_id>/<msg_id>.json`,
  `part/<msg_id>/<prt_id>.json` (parts skipped). Message JSON carries `role`, `modelID`, `cost`,
  `tokens{input,output,reasoning,cache{read,write}}`, `time{created,completed}`. Unverified; a source notes
  that other releases used SQLite or JSONL, which the adapter does not read.
- **agy** (Google Antigravity): `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
  (CLI); the IDE variant uses `~/.gemini/antigravity-ide/` (the older IDE used `~/.gemini/antigravity/`, with
  `conversations/<uuid>.pb` protobuf files that are not readable). Layout unverified, per-line schema is a best
  guess (`format: unverified` in `agy.rs`). Override the root with `"roots": {"agy": "..."}`.
- **pi** (`~/.pi/agent/sessions/<project>/<timestamp>_<uuid>.jsonl`): header `{"type":"session","version":3,...}`,
  `message` entries with `usage{input,output,cacheRead,cacheWrite,cost{total}}`. Taken from pi's session-format
  docs via search snippets (the pi.dev page itself could not be fetched here), so marked unverified.

## Sources

- https://developers.openai.com/codex/local-config (Codex config shared by CLI and IDE extension)
- https://codex.danielvaughan.com/2026/04/08/four-surface-architecture/ (app, CLI, IDE share config)
- https://codex.danielvaughan.com/2026/04/08/cross-surface-session-sync/ (`~/.codex/sessions` shared across surfaces)
- https://claude.com/docs/third-party/claude-desktop/configuration.md (Claude desktop configuration)
- https://inventivehq.com/knowledge-base/claude/where-configuration-files-are-stored (config file locations)
- https://github.com/HaoyueQin/deepseek-harness-desktop/releases/tag/v0.1.0 (third-party DeepSeek desktop shell)
- https://www.sourcepulse.org/projects/1843249 (third-party deepseek-desktop wrapper)
- https://docs.rs/lore-cli/0.1.12/src/lore_cli/capture/watchers/opencode.rs.html (opencode storage layout, third-party parser)
- https://docs.rs/pond-db/0.9.0/src/pond/adapter/opencode.rs.html (opencode project-ID layout)
- https://docs.rs/crate/i-self/latest/source/src/share/opencode.rs (opencode layout drift)
- https://dev.to/iromin/antigravity-cli-tutorial-series-part-2-conversations-conversations-and-conversations-j39 (agy transcripts)
- https://dev.to/mohamadawwaad/how-to-migrate-your-conversation-history-to-the-new-antigravity-ide-macos-a85 (antigravity-ide path)
- https://pi.dev/docs/latest/session-format (pi session format)
- https://docs.rs/crate/cctop/latest/source/docs/providers/pi.md (pi usage fields, third-party parser)
