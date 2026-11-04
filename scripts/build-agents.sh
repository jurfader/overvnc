#!/usr/bin/env bash
# Buduje agenta OVERVNC na wszystkie wspierane platformy do dist/agents/.
# Użycie: scripts/build-agents.sh [wersja]
set -euo pipefail
cd "$(dirname "$0")/../agent"
VERSION="${1:-$(date +%Y.%m.%d)-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
OUT=../dist/agents
mkdir -p "$OUT"
for target in windows/amd64 windows/arm64 darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  os=${target%/*}; arch=${target#*/}
  ext=""; [ "$os" = windows ] && ext=".exe"
  name="overvnc-agent-${os}-${arch}${ext}"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o "$OUT/$name" .
  echo "  $name ($(du -h "$OUT/$name" | cut -f1))"
done
echo "Gotowe: wersja ${VERSION} → dist/agents/"
