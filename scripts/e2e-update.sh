#!/usr/bin/env bash
# Test e2e aktualizacji: agent 0.0.1 (rejestracja odroczona jak w obrazie ISO) sam pobiera podpisane
# wydanie 0.0.2 z serwera, podmienia się i wraca jako 0.0.2. Pętla w tle udaje menedżera usług.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${E2E_PORT:-18098}"
B="http://127.0.0.1:$PORT"
J="$WORK/cookies"
BIN="$WORK/bin/overvnc-agent"
PIDS=()
cleanup() {
  touch "$WORK/stop"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  pkill -f "$BIN run" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "✖ $*"; echo "--- server.log"; tail -15 "$WORK/server.log" || true; echo "--- agent.log"; tail -25 "$WORK/agent.log" || true; exit 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then echo "✖ port $PORT jest zajęty"; exit 1; fi

echo "→ klucz testowy i dwie wersje agenta"
PUB=$(node -e '
  const { generateKeyPairSync } = require("node:crypto"); const fs = require("node:fs");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(process.argv[1], privateKey.export({ type: "pkcs8", format: "pem" }));
  console.log(publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"));' "$WORK/key.pem")
PLAT="$(cd "$ROOT/agent" && go env GOOS)-$(cd "$ROOT/agent" && go env GOARCH)"
mkdir -p "$WORK/bin" "$WORK/rel"
(cd "$ROOT/agent" && go build -ldflags "-X main.version=0.0.1 -X main.updatePublicKeyB64=$PUB" -o "$BIN" .)
(cd "$ROOT/agent" && go build -ldflags "-X main.version=0.0.2 -X main.updatePublicKeyB64=$PUB" -o "$WORK/rel/overvnc-agent-$PLAT" .)
OVERVNC_SIGNING_KEY_FILE="$WORK/key.pem" node "$ROOT/scripts/release-manifest.mjs" "$WORK/rel" 0.0.2 >/dev/null

echo "→ import wydania i start serwera"
(cd "$ROOT/server" && DATA_DIR="$WORK/data" RELEASE_PUBLIC_KEY="$PUB" node src/cli.ts import-release "$WORK/rel") | grep -q "Zaimportowano wydanie 0.0.2" || fail "import wydania"
(cd "$ROOT/server" && DATA_DIR="$WORK/data" PORT=$PORT PANEL_DIR=/nonexistent LOG_LEVEL=warn REQUIRE_2FA=0 RELEASE_PUBLIC_KEY="$PUB" ADMIN_PASSWORD=e2e-password-123 exec node src/index.ts >"$WORK/server.log" 2>&1) &
PIDS+=($!)
for i in $(seq 100); do curl -s -o /dev/null "$B/api/auth/me" && break; [ "$i" = 100 ] && fail "serwer nie wystartował"; sleep 0.1; done
curl -sf -c "$J" -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"e2e-password-123"}' >/dev/null || fail "logowanie"
TOKEN=$(curl -sf -b "$J" -X POST "$B/api/enroll-tokens" -H 'content-type: application/json' -d '{"label":"kiosk","maxUses":null,"ttlHours":24}' | json .token)

echo "→ agent 0.0.1 z rejestracją odroczoną (jak w ISO) pod „menedżerem usług”"
"$BIN" enroll --defer --server "$B" --token "$TOKEN" --config "$WORK/agent.json" >/dev/null || fail "enroll --defer"
[ "$(json .agent_id < "$WORK/agent.json")" = "undefined" ] || fail "przy --defer nie powinno być tożsamości"
( while [ ! -f "$WORK/stop" ]; do "$BIN" run --updates --config "$WORK/agent.json" >>"$WORK/agent.log" 2>&1 || echo "[supervisor] exit $?" >>"$WORK/agent.log"; sleep 0.5; done ) &
PIDS+=($!)
for i in $(seq 100); do [ -n "$(json .agent_id < "$WORK/agent.json" 2>/dev/null | grep -v undefined)" ] && break; sleep 0.1; done
ID=$(json .agent_id < "$WORK/agent.json")
[ "$ID" != "undefined" ] || fail "agent nie zarejestrował się sam"
for i in $(seq 100); do [ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json .agentVersion)" = "0.0.1" ] && break; sleep 0.1; done
echo "✔ rejestracja przy pierwszym uruchomieniu ($ID), wersja 0.0.1"

[ "$(curl -sf -b "$J" "$B/api/updates" | json .outdated)" = "1" ] || fail "serwer nie widzi nieaktualnego agenta"
STATUS=$(curl -sf -b "$J" -X POST "$B/api/agents/$ID/update" | json .status) || fail "polecenie aktualizacji"
[ "$STATUS" = "restarting" ] || fail "status aktualizacji: $STATUS"
for i in $(seq 150); do [ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json .agentVersion)" = "0.0.2" ] && break; sleep 0.2; done
[ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json .agentVersion)" = "0.0.2" ] || fail "agent nie wrócił jako 0.0.2"
[ "$("$BIN" version)" = "0.0.2" ] || fail "plik binarki nie został podmieniony"
[ -f "$BIN.old" ] || fail "brak kopii poprzedniej wersji (.old)"
[ "$(json .to < "$WORK/update-state.json")" = "0.0.2" ] || fail "brak stanu aktualizacji"
echo "✔ aktualizacja 0.0.1 → 0.0.2: weryfikacja podpisu, podmiana, restart, powrót online"
[ "$(curl -sf -b "$J" "$B/api/updates" | json .outdated)" = "0" ] || fail "po aktualizacji nadal nieaktualny"
echo "E2E AKTUALIZACJI OK"
