#!/usr/bin/env bash
# worker-launch.sh: start one worker on codex, claude, pi or opencode, tracked by jobs-track so the dashboard shows it.
#   bash worker-launch.sh <harness> <cwd> <promptfile> <outdir> <timeoutSeconds> <effort> [--model M] [--plan NN-slug]
#                         [--label L] [--background] [--no-track] [--dry-run]
# Thin wrapper: the work is in worker-launch.mjs next to this file (bash + node, nothing else). Symlinks to this
# file (<run>/bin/worker-launch.sh) are followed back to the AgentGlim checkout.
SOURCE=$0
while [ -L "$SOURCE" ]; do
  BASE=$(cd "$(dirname "$SOURCE")" && pwd)
  SOURCE=$(readlink "$SOURCE")
  case "$SOURCE" in /*) ;; *) SOURCE=$BASE/$SOURCE ;; esac
done
DIR=$(cd "$(dirname "$SOURCE")" 2>/dev/null && pwd)
command -v node >/dev/null 2>&1 || { echo "worker-launch: node is not installed (Node 22.13 or newer)" >&2; exit 127; }
# Git Bash on Windows: a relative link seen through a mount (/tmp is the user's Temp folder) climbs bash's view of the
# path, not the real folders, so it can miss; node resolves the link natively.
[ -f "$DIR/worker-launch.mjs" ] || DIR=$(node -e 'process.stdout.write(require("path").dirname(require("fs").realpathSync(process.argv[1])))' "$0")
exec node "$DIR/worker-launch.mjs" "$@"
