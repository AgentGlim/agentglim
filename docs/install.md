# Install AgentGlim

AgentGlim is one Node server with no npm dependencies. It runs on Linux and needs Node 22 or newer
(Node 24 is what it is tested on).

## Get it

```sh
git clone https://github.com/<you>/agentglim.git ~/apps/agentglim
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

## Run it as a service

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

```sh
cd ~/apps/agentglim && git fetch --tags && git checkout vX.Y.Z
systemctl --user restart agentglim
```

To go back, check out the previous tag and restart.
