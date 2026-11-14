# Security notes

AgentGlim is a local dashboard. The server listens on localhost and rejects requests whose Host or Origin is not the
dashboard itself (`app/server.mjs` host and origin guards). Report a vulnerability through a private GitHub security
advisory on this repository, not a public issue.

## Dashboard chat reaches a headless agent (v0.2.17)

With turn-based delivery (`node app/turn-delivery.mjs register ...`), the server resumes the registered Codex, Claude,
Pi or OpenCode session **headless**, with no person watching, and hands it each dashboard request: Refresh, Watcher
chat text and done-checks. Chat text is passed as written. That means:

- Anyone who can post to the dashboard can make your agent act, with that session's permissions. Keep the dashboard on
  localhost; do not expose port 18990 through a tunnel, reverse proxy or `0.0.0.0` bind.
- A bug in the host or origin guards would now be a command-execution bug, not only a data leak.
- Resumed turns get write access to the AgentGlim data and run folders (Codex `-s workspace-write --add-dir`, Claude
  `--allowedTools` for `status-write.mjs`, `chat-write.mjs` and `owner-check.mjs`). Widen this with
  `AGENTGLIM_SEND_CODEX_ARGS` / `AGENTGLIM_SEND_CLAUDE_ARGS` only if you accept that.
- Failed deliveries stop after five tries; to stop delivery at once run `node app/turn-delivery.mjs unregister`.

The worker launcher (`harness/bin/worker-launch.mjs`) never stores credentials or the environment, and never puts a
prompt on a command line it passes through `cmd.exe`.
