#!/usr/bin/env bash
# Test end-to-end: prawdziwy serwer + prawdziwa binarka agenta.
# Rejestracja -> połączenie -> inwentarz -> polecenie z odpowiedzią -> usunięcie -> agent odrzucony.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${E2E_PORT:-18099}"
B="http://127.0.0.1:$PORT"
J="$WORK/cookies"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "✖ $*"; echo "--- server.log"; tail -20 "$WORK/server.log" || true; echo "--- agent.log"; tail -20 "$WORK/agent.log" || true; exit 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }

echo "→ budowanie agenta"
(cd "$ROOT/agent" && go build -o "$WORK/agent" .)

if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then echo "✖ port $PORT jest zajęty (E2E_PORT=... aby zmienić)"; exit 1; fi
echo "→ start serwera na :$PORT"
# exec: PID w PIDS ma wskazywać na sam proces node, nie na podpowłokę — inaczej sprzątanie zostawi serwer na porcie
(cd "$ROOT/server" && DATA_DIR="$WORK/data" PORT=$PORT PANEL_DIR=/nonexistent LOG_LEVEL=warn REQUIRE_2FA=0 ADMIN_PASSWORD=e2e-password-123 exec node src/index.ts >"$WORK/server.log" 2>&1) &
PIDS+=($!)
for i in $(seq 100); do curl -s -o /dev/null "$B/api/auth/me" && break; [ "$i" = 100 ] && fail "serwer nie wystartował"; sleep 0.1; done

curl -sf -c "$J" -X POST "$B/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"e2e-password-123"}' >/dev/null || fail "logowanie"
TOKEN=$(curl -sf -b "$J" -X POST "$B/api/enroll-tokens" -H 'content-type: application/json' -d '{"label":"e2e","maxUses":1}' | json .token)
echo "✔ logowanie i token"

"$WORK/agent" enroll --server "$B" --token "$TOKEN" --config "$WORK/agent.json" >/dev/null || fail "rejestracja agenta"
ID=$(json .agent_id < "$WORK/agent.json")
echo "✔ rejestracja ($ID)"

"$WORK/agent" run --config "$WORK/agent.json" >"$WORK/agent.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 100); do
  [ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json .online)" = "true" ] && [ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json '.inventory?.host?.hostname ?? ""')" != "" ] && break
  sleep 0.1
done
DETAIL=$(curl -sf -b "$J" "$B/api/agents/$ID")
[ "$(echo "$DETAIL" | json .online)" = "true" ] || fail "agent nie połączył się"
[ "$(echo "$DETAIL" | json '.capabilities.includes("inventory.refresh")')" = "true" ] || fail "brak capabilities"
echo "✔ agent online, inwentarz: $(echo "$DETAIL" | json .inventory.host.hostname), $(echo "$DETAIL" | json '.inventory.software?.length ?? 0') programów"

for _ in $(seq 100); do [ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json '.metrics?.ts ?? 0')" != "0" ] && break; sleep 0.1; done
[ "$(curl -sf -b "$J" "$B/api/agents/$ID" | json '.metrics?.ts ?? 0')" != "0" ] || fail "brak metryk"
echo "✔ metryki"

curl -sf -b "$J" -X POST "$B/api/agents/$ID/refresh" | grep -q '"ok":true' || fail "polecenie inventory.refresh"
echo "✔ polecenie z odpowiedzią (inventory.refresh)"

NPROC=$(curl -sf -b "$J" "$B/api/agents/$ID/processes" | json .length) || fail "lista procesów"
[ "$NPROC" -gt 5 ] || fail "za mało procesów: $NPROC"
NSVC=$(curl -sf -b "$J" "$B/api/agents/$ID/services" | json .length) || fail "lista usług"
echo "✔ procesy ($NPROC) i usługi ($NSVC)"

SID=$(awk '$6 == "overvnc_sid" {print $7}' "$J")
(cd "$ROOT/server" && SID="$SID" URL="ws://127.0.0.1:$PORT/ws/term/$ID" node -e '
  const { WebSocket } = require("ws");
  const ws = new WebSocket(process.env.URL, { headers: { cookie: "overvnc_sid=" + process.env.SID } });
  let out = ""; let ok = false;
  const t = setTimeout(() => { console.error("timeout, wyjście:", JSON.stringify(out.slice(-300))); process.exit(1); }, 15000);
  ws.on("message", (m, bin) => {
    if (!bin) { const msg = JSON.parse(m); if (msg.type === "ready") ws.send(Buffer.from("echo OVERVNC_E2E_$((6*7))\n")); return; }
    out += m.toString();
    if (!ok && out.includes("OVERVNC_E2E_42")) { ok = true; ws.send(Buffer.from("exit\n")); }
  });
  ws.on("close", (code) => { clearTimeout(t); if (ok && code === 4100) process.exit(0); console.error("zamknięcie", code, "ok", ok); process.exit(1); });
') || fail "terminal"
echo "✔ terminal: polecenie w prawdziwej powłoce i zakończenie sesji"

curl -sf -b "$J" -X DELETE "$B/api/agents/$ID" >/dev/null || fail "usuwanie"
for _ in $(seq 50); do grep -q "odrzucił" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "odrzucił" "$WORK/agent.log" || fail "agent nie został odrzucony po usunięciu"
echo "✔ usunięty agent rozłączony i odrzucony"
echo "E2E OK"
