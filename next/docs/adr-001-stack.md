# ADR-001: Stack decision

## Status
Accepted (phase 01-spec-core).

## Context
The app watches local AI agent sessions and runtimes and must work on desktop, Android and iPhone, survive window
closes and reboots, and stay small. The original brief proposed a stack; this ADR reviews each part critically.

## Decision
| Part | Decision | Reason |
|---|---|---|
| Server | Keep Rust + Axum: one binary `agentglimd` on Tokio + Axum | Single static binary per OS, no runtime to ship, WebSocket support. Go is the only close rival and is not worth a second language. |
| UI | Keep plain TypeScript, no framework, using signal primitives (or a small local copy until they ship) | Existing views port over; a browser UI does the job with less code for the MVP. |
| Desktop | Defer Tauri 2 to phase 05. MVP: the daemon serves the UI on 127.0.0.1 and `agentglimd open` launches the default browser | Tauri only adds tray, autostart toggle and notifications, so it is a thin client and never owns the server. |
| Android + iOS | Keep PWA: same bundle, responsive, installable; native only if a must-have fails | Web Push works for home-screen web apps on iOS/iPadOS 16.4+ and Chrome Android; both need HTTPS, which `tailscale serve` provides. |
| Storage | Keep SQLite via rusqlite (bundled), WAL, numbered migrations table | WAL lets readers run during writes; bundled build avoids system library skew. |
| Realtime | Keep REST `/api/v1/*` plus one WebSocket `/api/v1/events` | One stream, typed events, resumable by sequence number. |
| Remote | Keep Tailscale; app-level auth is still required | No custom VPN; WireGuard underneath. |

## Alternatives rejected
- Electron: ships Chromium and Node per app; footprint and update surface.
- Python: packaging a runtime per OS; idle RAM.
- Web UI only: accepted for the MVP, with a Tauri tray in 05; it misses tray, autostart toggle and native notifications.

## Consequences
- One crate (`agentglimd`) owns all server logic; clients are thin and replaceable.
- No desktop shell until 05; users open the UI in a browser.
- Remote access depends on Tailscale HTTPS for push notifications on phones.
- Dependencies are limited to a short approved list; anything else needs a written reason.
