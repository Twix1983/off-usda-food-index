#!/bin/zsh
# A local Typesense 30.2 (the cloud cluster's version) for the food-index tests
# and dry runs — never a cloud host. Native macOS build, no Docker needed.
#   scripts/food-index/local-typesense.sh start | stop | status
# Serves http://localhost:8108 with admin key "local-admin"; data lives
# in ~/.cache/off-usda-food-index/typesense-local (throwaway).
set -euo pipefail
VERSION=30.2
DIR="$HOME/.cache/off-usda-food-index/typesense-$VERSION"
DATA="$HOME/.cache/off-usda-food-index/typesense-local"
PIDFILE="$DATA/typesense.pid"
KEY=local-admin
ARCH=$(uname -m | sed 's/x86_64/amd64/')

case "${1:-}" in
  start)
    mkdir -p "$DIR" "$DATA"
    if [[ ! -x "$DIR/typesense-server" ]]; then
      echo "downloading Typesense $VERSION ($ARCH)…"
      curl -fsSL "https://dl.typesense.org/releases/$VERSION/typesense-server-$VERSION-darwin-$ARCH.tar.gz" \
        | tar -xz -C "$DIR"
    fi
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    "$DIR/typesense-server" --data-dir "$DATA" --api-key "$KEY" --listen-port 8108 \
      --enable-cors > "$DATA/server.log" 2>&1 &
    echo $! > "$PIDFILE"
    for i in {1..60}; do
      curl -s localhost:8108/health | grep -q '"ok":true' && { echo "up on :8108"; exit 0; }
      sleep 0.5
    done
    echo "did not come up — see $DATA/server.log"; exit 1 ;;
  stop)
    [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"; rm -rf "$DATA"; echo "stopped" ;;
  status)
    curl -s localhost:8108/health || echo "not running" ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
