# API v1

Base path `/api/v1`. JSON only. Every response carries the header `api_version: 1`. Requests that contain unknown
JSON fields are rejected with 422.

## Authentication
- Install token: stored in the data dir file `token` (mode 0600). Send it as `Authorization: Bearer <token>` or as
  the header `X-Agentglim-Token: <token>`. The `Bearer` scheme is case-insensitive (`bearer`, `BEARER` work).
- Device tokens (issued by pairing) arrive in a later phase and are sent the same way.
- `GET /health` needs no token on localhost; elsewhere it needs `read` scope.
- Scopes: `read`, `control`, `admin`. A token with too small a scope gets 403 `forbidden_scope`.

## Errors
Every error uses one envelope:
```json
{"error":{"code":"forbidden_scope","message":"token lacks scope","need":"control"}}
```
`need` appears only on scope errors. Codes and HTTP status:

| Code | Status | When |
|---|---|---|
| `bad_host` | 400 | `Host` header is not `127.0.0.1`, `localhost` or `::1` (DNS-rebinding defence) |
| `bad_query` | 400 | query string does not parse, or a bad value (e.g. `/logs?level=loud`) |
| `unauthorized` | 401 | missing or invalid token |
| `forbidden_scope` | 403 | token scope too small (device tokens, later phase) |
| `not_found` | 404 | unknown route, unknown task id |
| `method_not_allowed` | 405 | known path, wrong method (e.g. `DELETE /tasks`) |
| `duplicate_task` | 409 | `POST /tasks` with an id that already exists |
| `invalid_body` | 422 | body does not parse, unknown field, bad type, or failed validation |
| `rate_limited` | 429 | too many requests (later phase) |
| `internal` | 500 | storage or other internal failure |
| `draining` | 503 | daemon is shutting down and refuses new tasks |

## Routes
Ships in 01: health, status, config, tasks, logs. Later: sessions, devices, runtimes, costs, events.

| Method + path | Scope | Phase | Purpose |
|---|---|---|---|
| GET `/health` | none (localhost) / read | 01 | liveness; never leaks paths |
| GET `/status` | read | 01 | sources, runtimes, sessions summary, counts needing you |
| GET `/config` | read | 01 | bind, port, sources, retention, roots, flags dir, runtime URLs |
| PATCH `/config` | admin | 01 | validated, audited update |
| GET `/tasks` | read | 01 | list daemon-owned tasks |
| POST `/tasks` | control | 01 | create a task; duplicate id returns 409 |
| POST `/tasks/{id}/cancel` | control | 01 | cancel a task |
| GET `/logs?since=&level=` | read | 01 | structured log tail, secrets redacted |
| GET `/sessions`, GET `/sessions/{id}` | read | later | per agent session state, model, tokens, cost, last step |
| POST `/sessions/{id}/send`, `/answer`, `/pause`, `/resume`, `/kill` | control | later | only if the adapter declares the capability |
| GET `/devices` | admin | later | list paired devices |
| POST `/devices/pair/start`, `/devices/pair/confirm` | admin (localhost) | later | QR pairing |
| DELETE `/devices/{id}` | admin | later | revoke a device |
| GET `/runtimes` | read | later | Ollama `/api/ps` (size_vram vs size), llama.cpp `/health` + `/slots` |
| GET `/costs?range=7d\|30d\|90d` | read | later | tokens and USD by source and model |
| WS `/events` | read | later | typed events with `seq`; `since` replay; ping every 20 s |

## Examples (01 routes)
Each example marked `<!-- example: METHOD PATH [body] -->` is checked against the live daemon by
`tests/api_doc.rs` (object keys and value types, recursively; `null` matches any type; array elements are compared
when both sides are non-empty). Values are illustrative.

### GET /health
<!-- example: GET /health -->
```json
{"ok":true,"version":"0.1.0","api_version":1,"uptime_s":42}
```

### GET /status
Reads the poller's cached state; a request never probes a runtime or waits on the network. Sources and runtimes are
keyed by `id`. `reason` is `null` when detected; `paths` lists what was found; `sessions` is the number of stored
sessions of that source and `sessions.total` is their sum. `updated_ms` is the Unix ms of the last cache refresh
(`0` = never refreshed yet: sources come from a quick detect pass and every runtime is `{"state":"unknown"}`).
Runtime `state` is one of `up`, `down`, `owner_off`, `unknown`.
<!-- example: GET /status -->
```json
{"version":"0.1.0","api_version":1,"uptime_s":42,"updated_ms":1793828684610,
 "sources":[{"id":"plans-harness","kind":"harness","detected":false,"reason":"plans dir not found","paths":[],
   "sessions":0,"caps":["watch"]}],
 "runtimes":[{"id":"ollama","state":{"state":"down"}}],
 "sessions":{"total":0,"active":0},"needs_you":0,
 "tasks":{"running":0,"interrupted":0,"total":0},"last_seq":1}
```
An `up` runtime adds `models` (names), `vram_bytes`, `ram_bytes`, `slots`, `ctx`, `tps`. A value of `0` means "not
measured" (e.g. Ollama reports no `slots`, `ctx` or `tps`). Runtime entry only:
<!-- example-up: GET /status -->
```json
{"id":"ollama","state":{"state":"up","models":["llama3.2:3b"],"vram_bytes":3600000000,"ram_bytes":400000000,
  "slots":0,"ctx":0,"tps":0.0}}
```

### GET /config
<!-- example: GET /config -->
```json
{"config":{"bind":"127.0.0.1","port":19360,"allow_remote":false,"sources":{"plans-harness":true},
  "retention_days":30,"history_days":30,"roots":{"codex":"/data/codex"},"flags_dir":null,
  "runtime_urls":{"ollama":"http://127.0.0.1:11434"}},
 "restart_required_for":["bind","port","sources","history_days"]}
```
Config keys:
- `bind`: IP address; non-loopback needs `allow_remote: true`.
- `port`: 1024-65535 allowed. Tests and dev use 19360-19379 only. `bind` and `port` apply after a restart.
- `sources`: adapter id -> on/off. Changing this requires a restart; the running poller keeps its startup registry until then.
- `retention_days`: events older than this are pruned from `state.db`.
- `history_days`: files older than this (mtime) are adopted at EOF without ingesting backlog. Applies after a restart.
- `roots`: adapter id -> root dir override (default derived from `HOME`).
- `flags_dir`: harness flags dir; if `<flags_dir>/local_off_owner` exists the Strata runtime reports `owner_off`.
- `runtime_urls`: runtime id (`ollama`, `llamacpp`, `strata`) -> base URL override.

### PATCH /config (admin)
Patchable: `bind`, `port`, `allow_remote`, `sources`, `retention_days`, `history_days`. Response is the full new config plus
`restart_required_for` (the fields that only take effect after a daemon restart):
<!-- example: PATCH /config {"retention_days":14} -->
```json
{"config":{"bind":"127.0.0.1","port":19360,"allow_remote":false,"sources":{},"retention_days":14,
  "history_days":30,"roots":{},"flags_dir":null,"runtime_urls":{}},
 "restart_required_for":["bind","port","sources","history_days"]}
```
An unknown field returns 422:
<!-- example: PATCH /config {"colour":"red"} -->
```json
{"error":{"code":"invalid_body","message":"unknown field `colour`"}}
```

### POST /tasks (control)
Kinds: `noop`, `status-refresh` (asks the poller for an immediate pass over sources and runtimes), `sleep` (needs `ms` <= 3600000). Ids are short slugs.
Response 201 (`created`, `updated` are Unix ms):
<!-- example: POST /tasks {"id":"sleep-1","kind":"sleep","ms":60000} -->
```json
{"task":{"id":"sleep-1","kind":"sleep","state":"running","created":1793828684610,"updated":1793828684610,
  "detail":""}}
```
Posting the same id again returns 409:
<!-- example: POST /tasks {"id":"sleep-1","kind":"sleep","ms":60000} -->
```json
{"error":{"code":"duplicate_task","message":"task sleep-1 already exists"}}
```

### GET /tasks
<!-- example: GET /tasks -->
```json
{"tasks":[{"id":"sleep-1","kind":"sleep","state":"running","created":1793828684610,"updated":1793828684610,
  "detail":""}]}
```

### POST /tasks/{id}/cancel (control)
<!-- example: POST /tasks/sleep-1/cancel -->
```json
{"task":{"id":"sleep-1","kind":"sleep","state":"cancelled","created":1793828684610,"updated":1793828690000,
  "detail":""}}
```
A finished task keeps its final state. Unknown id returns 404 `not_found`.

### GET /logs?since=&level=
`since` is an opaque cursor (default 0); pass back the previous `next`. At most 500 lines per call; `next` is the
position after the last line scanned, so following it never skips lines. If the cursor is past the end of the current
file (rotation or truncation) the daemon restarts from the beginning and returns `"reset": true`. `level` is
`trace|debug|info|warn|error`. Lines are the JSON log records with secrets and home paths redacted.
<!-- example: GET /logs?level=info -->
```json
{"lines":[{"timestamp":"2026-11-04T10:00:05.000000Z","level":"INFO","target":"agentglimd",
  "fields":{"message":"agentglimd started"}}],"next":1,"reset":false}
```

### Wrong method
<!-- example: DELETE /tasks -->
```json
{"error":{"code":"method_not_allowed","message":"method not allowed for this route"}}
```

## Later routes (shapes may be refined in their phase)
- `GET /sessions` -> `{"sessions":[{"id":"s1","state":"running","model":"m","tokens":1200,"cost_usd":0.02,"last_step":"edit"}]}`
- `POST /sessions/{id}/send` with `{"text":"continue"}` -> `{"ok":true}`
- `POST /devices/pair/start` -> `{"code":"123456","expires_s":120}`; `/pair/confirm` with `{"code":"123456","name":"phone"}`
- `GET /runtimes` -> `{"runtimes":[{"kind":"ollama","models":[{"name":"m","size":100,"size_vram":100}]}]}`
- `GET /costs?range=7d` -> `{"range":"7d","total_usd":1.5,"by_source":[],"by_model":[]}`
- WS `/events?since=N` -> `{"seq":N,"type":"session.updated","data":{}}`
