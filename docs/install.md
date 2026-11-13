# Install AgentGlim

AgentGlim is one Node server with no npm dependencies. It runs on Linux, macOS and Windows, and needs Node 22.13
or newer (Node 24 is what it is tested on). The SuperAgent listener requires Bash (Git Bash or WSL on Windows); the dashboard itself runs with Node.

## Get it

```sh
git clone https://github.com/AgentGlim/agentglim.git ~/apps/agentglim
cd ~/apps/agentglim
cp .env.example .env && chmod 600 .env   # optional: add the keys you use, see keys.md
```

## Run it

```sh
cd ~/apps/agentglim/app
node server.mjs            # dashboard on http://127.0.0.1:18990, plan pages on 18991
```

Only if port 18990 is already taken, pass another port: `node server.mjs <port>` (plan pages use the next port up).

Runtime data (history, caches, settings the page saves) goes to a working folder outside the repo.
See settings.md to choose it.

A plans harness is optional and is not shipped. For the dashboard's Status, Watcher and queue controls,
run `npm run scaffold-harness` after cloning; it creates `$AGENTGLIM_RUN` and links the small tools
AgentGlim does ship. It does not add a plans driver, worker lanes or model routing. See
[SETUP.md](../SETUP.md#plans-harness-and-superagent-tools).

## Run it as a service (Linux)

`~/.config/systemd/user/agentglim.service`:

```ini
[Unit]
Description=AgentGlim dashboard

[Service]
WorkingDirectory=%h/apps/agentglim/app
ExecStart=/usr/bin/env node server.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agentglim
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18990/   # 200
```

## Update

One method, from the clone, on `main`:

```sh
cd ~/apps/agentglim && npm run update
systemctl --user restart agentglim   # or restart `node server.mjs`
```

`npm run update` runs `git pull --ff-only` on `main`, re-links the SuperAgent tools in your run folder and
refreshes the global note and skill copies that setup wrote (only where they already exist; custom run-folder files are
kept, and replaced skills are backed up). Your data folder is never touched. If Git refuses because you have local changes, stash or commit them first;
do not reset or re-clone.
