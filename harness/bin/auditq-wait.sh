#!/usr/bin/env bash
# auditq-wait.sh - used by the watching SuperAgent session: keeps audit_queue/.alive
# fresh and exits (printing the requests) as soon as an untaken audit request appears,
# or after 50 minutes so the session re-arms it. Packaged in agentglim/harness/bin; the harness keeps a link at
# <run>/bin/auditq-wait.sh. Paths: AGENTGLIM_RUN, else the folder above the link this was started from
# (bash <run>/bin/auditq-wait.sh -> <run>), else harness config "run". AGENTGLIM_PLANS defaults to the folder above RUN.
if [ -n "${AGENTGLIM_RUN:-}" ]; then RUN=$AGENTGLIM_RUN
else
  RUN=$(cd "$(dirname "$0")/.." && pwd)
  if [ ! -d "$RUN/audit_queue" ]; then
    SOURCE=$0
    while [ -L "$SOURCE" ]; do
      BASE=$(cd "$(dirname "$SOURCE")" && pwd)
      SOURCE=$(readlink "$SOURCE")
      case "$SOURCE" in /*) ;; *) SOURCE=$BASE/$SOURCE ;; esac
    done
    RUN=$(node "$(dirname "$SOURCE")/../config.mjs" --get run 2>/dev/null)
  fi
fi
[ -d "$RUN/audit_queue" ] || { echo "auditq-wait: no audit_queue folder under '$RUN' (set AGENTGLIM_RUN)"; exit 2; }
PLANS=${AGENTGLIM_PLANS:-$(dirname "$RUN")}
# AGENTGLIM_WAIT_POLL / AGENTGLIM_WAIT_ROUNDS only make the loop testable; leave them unset for the 50-minute listener.
ROUNDS=${AGENTGLIM_WAIT_ROUNDS:-200}
POLL=${AGENTGLIM_WAIT_POLL:-15}
Q=$RUN/audit_queue
requests() {
  local file
  for file in "$1"/*.json; do
    [ -f "$file" ] || continue
    printf '%s ' "${file##*/}"
  done
}
printf -v STATUS_TOOL '%q' "$RUN/bin/status-write.mjs"
printf -v CHAT_TOOL '%q' "$RUN/bin/chat-write.mjs"
printf -v CHECK_TOOL '%q' "$RUN/bin/owner-check.mjs"
# heartbeat (owner 2026-11-10): the header dot reports this as the listener's own, extra information; the armed
# state is the SuperAgent's heartbeat (<data>/heartbeats/superagent) that AGENTS.md and SETUP.md tell the agent to touch.
mkdir -p "$RUN/heartbeats"
for i in $(seq 1 "$ROUNDS"); do
  touch "$Q/.alive" "$RUN/heartbeats/auditq-wait"
  pending=""
  for r in "$Q"/*.req; do
    [ -e "$r" ] || continue
    b=${r%.req}
    # plan on HOLD (owner pause, 2026-10-28): decline at once instead of waking the watcher
    plan=$(basename "$b"); plan=${plan%%__*}
    if [ -e "$PLANS/$plan/HOLD" ] && [ ! -e "$b.taken" ] && [ ! -e "$b.decline" ]; then echo "declined by watcher $(date '+%F %T'): plan on HOLD (owner pause)" > "$b.decline"; continue; fi
    [ -e "$r.taken" ] || [ -e "$r.decline" ] || [ -e "$b.taken" ] || [ -e "$b.decline" ] || pending="$pending $(basename "$b")"
  done
  # mode clicks from the Observatory Status card need a mode handler AgentGlim does not ship, so this listener
  # does not advertise or wake for them; a mode_queue file is left for the user's own automation.
  # "refresh now" on the Observatory Status card (owner 2026-11-01): wake the watcher for a status answer
  asks=$(requests "$RUN/status_ask")
  [ -n "$asks" ] && { echo "STATUS: $asks(owner pressed refresh now: run node $STATUS_TOOL --done ... --running ... --blocked ... --next ... --optimize ... with your own words; it marks the ask answered)"; [ -z "$pending" ] && exit 0; }
  # Control page Watcher thread (plan 55 control): messages from /control wake the watcher; answer with chat-write.mjs
  chats=$(requests "$RUN/chat_inbox")
  [ -n "$chats" ] && { echo "CHAT: $chats(read them, act, then: node $CHAT_TOOL --reply \"...\" --to <ms> [--ask Q --option A --option B --qid ID])"; [ -z "$pending" ] && exit 0; }
  # "done" clicks on the Status card blockers (owner 2026-11-01): the owner says an item is handled; check it before it closes
  checks=$(requests "$RUN/owner_check")
  [ -n "$checks" ] && { echo "CHECK: $checks(owner marked items done: run node $CHECK_TOOL list, verify each one as deeply as it needs, then node $CHECK_TOOL confirm <id> \"evidence\" or node $CHECK_TOOL reopen <id> \"what is still missing\")"; [ -z "$pending" ] && exit 0; }
  # watchdog findings (owner 2026-11-10): new warn/crit items from watchdog.mjs; read, act, then mv each into watchdog_queue/done/
  wd=$(requests "$RUN/watchdog_queue")
  [ -n "$wd" ] && { echo "WATCHDOG: $wd(read $RUN/watchdog_queue/<file>, act or relay, then mv it into watchdog_queue/done/)"; [ -z "$pending" ] && exit 0; }
  # verify first (owner 2026-11-03): take role=verify requests before any other
  if [ -n "$pending" ]; then v= o=; for b in $pending; do grep -q '^role=verify' "$Q/$b.req" 2>/dev/null && v="$v $b" || o="$o $b"; done; pending="$v$o"; [ -n "$v" ] && pending="$pending (verify first:$v)"; fi
  # cloud=only (owner 2026-11-04): no Claude slot but free cloud credit; leave for the user's cloud automation, never local
  if [ -n "$pending" ]; then c=; for b in $pending; do grep -q '^cloud=only' "$Q/$b.req" 2>/dev/null && c="$c $b"; done; [ -n "$c" ] && pending="$pending (CLOUD ONLY; leave untaken unless your own cloud automation handles it:$c)"; fi
  [ -n "$pending" ] && { echo "PENDING:$pending (answer with the tools in $RUN/bin, or leave them untaken; Claude 5h window)"; exit 0; }
  sleep "$POLL"
done
echo "NONE (re-arm)"
