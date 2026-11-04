#!/usr/bin/env bash
# Pełna weryfikacja projektu — to samo, co uruchamia CI. Użycie: scripts/check.sh [--no-e2e]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

step "agent: gofmt / vet / testy"
cd "$ROOT/agent"
unformatted=$(gofmt -l .); [ -z "$unformatted" ] || { echo "Niesformatowane pliki: $unformatted"; exit 1; }
go vet ./...
for os in linux windows darwin; do GOOS=$os go vet ./...; done
go test -race -count=1 ./...

step "agent: kompilacja na wszystkie platformy"
for t in windows/amd64 windows/arm64 darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  CGO_ENABLED=0 GOOS=${t%/*} GOARCH=${t#*/} go build -o /dev/null . && echo "  ✔ $t"
done

step "serwer: typy / testy"
cd "$ROOT/server"
npx tsc --noEmit -p .
npm test --silent

step "panel: typy / build"
cd "$ROOT/panel"
npm run build --silent >/dev/null && echo "  ✔ build"

if [ "${1:-}" != "--no-e2e" ]; then
  step "end-to-end"
  "$ROOT/scripts/e2e.sh"
  step "end-to-end: automatyczna aktualizacja agenta"
  "$ROOT/scripts/e2e-update.sh"
fi
printf '\n\033[1;32m✔ Wszystko OK\033[0m\n'
