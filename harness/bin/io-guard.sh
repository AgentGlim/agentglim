#!/usr/bin/env bash
# io-guard.sh CMD... : run one heavy disk job (git add, big finds, copies) at idle IO priority and pause it
# (SIGSTOP/SIGCONT on its process group) while the disk is busier than IO_GUARD_PCT (default 80), resuming
# once it drops below IO_GUARD_PCT - 20. Packaged in agentglim/harness/bin; the harness keeps a link at
# <plans>/_run/bin/io-guard.sh. Settings: app/settings.defaults.json "ioGuard" (documentation only; env wins here).
#   IO_GUARD_DEV  block device to watch, as in /sys/block (default: the disk holding the current folder)
#   IO_GUARD_PCT  pause threshold in percent busy (default 80)
# With no readable /sys/block/<dev>/stat the job still runs at idle priority, just without pausing.
PCT="${IO_GUARD_PCT:-80}"
disk_of() { # whole-disk name for the filesystem holding $1, e.g. nvme0n1 for /dev/nvme0n1p8
  local src; src=$(findmnt -no SOURCE -T "$1" 2>/dev/null | head -n1); src=${src%%[*}
  [ -b "$src" ] || return 1
  lsblk -nsro NAME,TYPE "$src" 2>/dev/null | awk '$2 == "disk" { print $1; exit }'
}
DEV="${IO_GUARD_DEV:-$(disk_of "$PWD")}"
DEV="${DEV:-nvme0n1}"
STAT="/sys/block/$DEV/stat"
busy() { # % of the last second the device had IO in flight (field 10 = io_ticks ms)
  local a b; a=$(awk '{print $10}' "$STAT"); sleep 1; b=$(awk '{print $10}' "$STAT")
  echo $(( (b - a) / 10 ))
}
setsid ionice -c3 nice -n 19 "$@" &
pid=$!; paused=0
if [ ! -r "$STAT" ]; then
  echo "io-guard: no $STAT, running at idle priority without pausing" >&2
  wait "$pid"; exit
fi
while kill -0 "$pid" 2>/dev/null; do
  u=$(busy)
  if [ "$u" -ge "$PCT" ] && [ $paused = 0 ]; then kill -STOP -"$pid" 2>/dev/null; paused=1; echo "io-guard: $DEV ${u}% busy, paused" >&2
  elif [ "$u" -lt $((PCT - 20)) ] && [ $paused = 1 ]; then kill -CONT -"$pid" 2>/dev/null; paused=0; echo "io-guard: $DEV ${u}% busy, resumed" >&2
  fi
done
wait "$pid"
