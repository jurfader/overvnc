#!/usr/bin/env bash
# Wdrożenie serwera OVERVNC na VPS: buduje panel, pakuje i instaluje przez SSH.
# Użycie: scripts/deploy.sh [host ssh, domyślnie srv]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${1:-srv}"
(cd "$ROOT/panel" && npm run build --silent >/dev/null)
T=$(mktemp -d)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$T/overvnc-release.tgz" -C "$ROOT" --exclude='server/node_modules' --exclude='server/data' server panel/dist deploy
scp -q "$T/overvnc-release.tgz" "$ROOT/deploy/install-srv.sh" "$HOST:/tmp/"
ssh "$HOST" 'bash /tmp/install-srv.sh && rm -f /tmp/overvnc-release.tgz /tmp/install-srv.sh'
rm -rf "$T"
