#!/usr/bin/env bash
# auditq-wait.sh - used by the watching Claude Code session: keeps audit_queue/.alive
# fresh and exits (printing the requests) as soon as an untaken audit request appears,
# or after 50 minutes so the session re-arms it. Packaged in agentglim/harness/bin; the harness keeps a link at
# <run>/bin/auditq-wait.sh. Paths: AGENTGLIM_RUN, else the folder above the link this was started from
# (bash _run/bin/auditq-wait.sh -> _run), else harness config "run". AGENTGLIM_PLANS defaults to the folder above RUN.
if [ -n "${AGENTGLIM_RUN:-}" ]; then RUN=$AGENTGLIM_RUN
else
  RUN=$(cd "$(dirname "$0")/.." && pwd)
  [ -d "$RUN/audit_queue" ] || RUN=$(node "$(dirname "$(readlink -f "$0")")/../config.mjs" --get run 2>/dev/null)
fi
[ -d "$RUN/audit_queue" ] || { echo "auditq-wait: no audit_queue folder under '$RUN' (set AGENTGLIM_RUN)"; exit 2; }
PLANS=${AGENTGLIM_PLANS:-$(dirname "$RUN")}
NODE=${AGENTGLIM_NODE:-$HOME/.local/bin/node}; [ -x "$NODE" ] || NODE=node
Q=$RUN/audit_queue
# heartbeat (owner 2026-11-10): AgentGlim header dot is green only while this and superagent-check.sh beat
mkdir -p "$RUN/heartbeats"
for i in $(seq 1 200); do
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
  # mode clicks from the Observatory Status card (owner 2026-11-01): wake the watcher to apply them
  modes=$(ls "$RUN"/mode_queue/*.json 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
  [ -n "$modes" ] && { echo "MODE: $modes(run: node _run/bin/modes.mjs apply-queue)"; [ -z "$pending" ] && exit 0; }
  # "refresh now" on the Observatory Status card (owner 2026-11-01): wake the watcher for a status answer
  asks=$(ls "$RUN"/status_ask/*.json 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
  [ -n "$asks" ] && { echo "STATUS: $asks(owner pressed refresh now: run node _run/bin/status-write.mjs --done ... --running ... --blocked ... --next ... --optimize ... with your own words; it marks the ask answered)"; [ -z "$pending" ] && exit 0; }
  # Control page Watcher thread (plan 55 control): messages from /control wake the watcher; answer with chat-write.mjs
  chats=$(ls "$RUN"/chat_inbox/*.json 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
  [ -n "$chats" ] && { echo "CHAT: $chats(read them, act, then: node _run/bin/chat-write.mjs --reply \"...\" --to <ms> [--ask Q --option A --option B --qid ID])"; [ -z "$pending" ] && exit 0; }
  # "done" clicks on the Status card blockers (owner 2026-11-01): the owner says an item is handled; check it before it closes
  checks=$(ls "$RUN"/owner_check/*.json 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
  [ -n "$checks" ] && { echo "CHECK: $checks(owner marked items done: run node _run/bin/owner-check.mjs list, verify each one as deeply as it needs, then owner-check.mjs confirm <id> \"evidence\" or reopen <id> \"what is still missing\")"; [ -z "$pending" ] && exit 0; }
  # watchdog findings (owner 2026-11-10): new warn/crit items from watchdog.mjs; read, act, then mv each into watchdog_queue/done/
  wd=$(ls "$RUN"/watchdog_queue/*.json 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
  [ -n "$wd" ] && { echo "WATCHDOG: $wd(read $RUN/watchdog_queue/<file>, act or relay, then mv it into watchdog_queue/done/)"; [ -z "$pending" ] && exit 0; }
  # verify first (owner 2026-11-03): take role=verify requests before any other
  if [ -n "$pending" ]; then v= o=; for b in $pending; do grep -q '^role=verify' "$Q/$b.req" 2>/dev/null && v="$v $b" || o="$o $b"; done; pending="$v$o"; [ -n "$v" ] && pending="$pending (verify first:$v)"; fi
  # cloud=only (owner 2026-11-04): no Claude slot but free cloud credit; send to cloud-take.sh only, never local
  if [ -n "$pending" ]; then c=; for b in $pending; do grep -q '^cloud=only' "$Q/$b.req" 2>/dev/null && c="$c $b"; done; [ -n "$c" ] && pending="$pending (CLOUD ONLY, cloud-take.sh or leave untaken:$c)"; fi
  [ -n "$pending" ] && { echo "PENDING:$pending (decline at $("$NODE" "$RUN/bin/modes.mjs" decline-at 2>/dev/null)% Claude 5h)"; exit 0; }
  sleep 15
done
echo "NONE (re-arm)"
