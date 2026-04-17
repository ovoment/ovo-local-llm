#!/usr/bin/env bash
# Run OVO sidecar in dev mode.
# Uses a local APFS venv to avoid SMB/network-mount permission issues.
set -euo pipefail

export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$HOME/Library/Caches/ovo-dev/sidecar-venv}"

cd "$(dirname "$0")/.."

if [ ! -d "$UV_PROJECT_ENVIRONMENT" ]; then
  echo "→ first run: uv sync to $UV_PROJECT_ENVIRONMENT"
  uv sync
fi

# Exec the venv console-script directly so Tauri's SIGKILL lands on the real
# python PID. Going through `uv run` leaves python as a grandchild that
# survives the kill and keeps holding ports 11435–11437, making the next
# restart fail to bind.
BIN="$UV_PROJECT_ENVIRONMENT/bin/ovo-sidecar"
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi
exec uv run --no-sync ovo-sidecar "$@"
