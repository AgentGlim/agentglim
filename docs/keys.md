# API keys

AgentGlim reads API keys from `.env` in the repo root. Start from the example:

```sh
cp .env.example .env
chmod 600 .env
```

Every key is listed in `.env.example` with what it is for, where to get it and whether it is optional.
Today there is one:

| Key | Needed for | Optional |
|---|---|---|
| `JEV_API_KEY` | Labels for new model names, plan priorities and the model pick for subagent jobs (https://typesafe.ai) | Yes. Without it those features use name rules or the default pick. |

Order, first match wins:

1. your shell or service environment
2. `.env` (or the file named by `AGENTGLIM_ENV_FILE`)
3. an `export NAME=value` line in `~/.bashrc`, which still works but prints a note asking you to move it

The Harness page shows where the Jev key came from, never the key itself. `.env` is git-ignored: never commit it.
Claude and Codex usage readings need no key here; they come from those tools' own login files.
