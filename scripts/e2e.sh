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

# OVERVNC_DESKTOP_TEST=1: syntetyczny ekran testowy (prawdziwe przechwytywanie jest tylko na Windows)
OVERVNC_DESKTOP_TEST=1 "$WORK/agent" run --config "$WORK/agent.json" >"$WORK/agent.log" 2>&1 &
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

# pliki: wysłanie (> okno przepływu), lista, pobranie z porównaniem sumy, ZIP folderu, edycja tekstu, usunięcie
FD="$WORK/pliki"; mkdir -p "$FD"
head -c 3500000 /dev/urandom > "$WORK/src.bin"
UP=$(curl -s -b "$J" -X POST -H 'content-type: application/octet-stream' --data-binary @"$WORK/src.bin" \
  "$B/api/agents/$ID/files/upload?dir=$(node -pe 'encodeURIComponent(process.argv[1])' "$FD")&name=$(node -pe 'encodeURIComponent("zażółć.bin")')")
echo "$UP" | grep -q '"path"' || fail "wysłanie pliku: $UP"
[ "$(curl -sf -b "$J" "$B/api/agents/$ID/files?path=$(node -pe 'encodeURIComponent(process.argv[1])' "$FD")" | json '.entries.map(e=>e.name).join()')" = "zażółć.bin" ] || fail "lista po wysłaniu"
curl -sf -b "$J" -o "$WORK/back.bin" "$B/api/agents/$ID/files/download?path=$(node -pe 'encodeURIComponent(process.argv[1])' "$FD/zażółć.bin")" || fail "pobranie"
cmp -s "$WORK/src.bin" "$WORK/back.bin" || fail "pobrany plik różni się od wysłanego"
[ -z "$(ls -A "$FD" | grep overvnc-part)" ] || fail "pozostał plik tymczasowy"
curl -sf -b "$J" -o "$WORK/dir.zip" "$B/api/agents/$ID/files/download?path=$(node -pe 'encodeURIComponent(process.argv[1])' "$FD")" || fail "pobranie ZIP"
# systemowy unzip z macOS źle wyświetla nazwy UTF-8 — sprawdzamy archiwum biblioteką zipfile
python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); n=[i for i in z.infolist() if i.filename.endswith("zażółć.bin")]; sys.exit(0 if n and n[0].flag_bits & 0x800 and n[0].file_size == 3500000 else 1)' "$WORK/dir.zip" || fail "ZIP bez pliku lub bez flagi UTF-8"
echo "a=1" > "$FD/konfig.ini"
MOD=$(curl -sf -b "$J" "$B/api/agents/$ID/files/text?path=$(node -pe 'encodeURIComponent(process.argv[1])' "$FD/konfig.ini")" | json .modified)
curl -sf -b "$J" -X PUT -H 'content-type: application/json' -d "{\"path\":\"$FD/konfig.ini\",\"content\":\"a=2\\n\",\"expectedModified\":$MOD}" "$B/api/agents/$ID/files/text" >/dev/null || fail "edycja tekstu"
[ "$(cat "$FD/konfig.ini")" = "a=2" ] || fail "edycja nie zapisała zmian"
CONFLICT=$(curl -s -b "$J" -X PUT -H 'content-type: application/json' -d "{\"path\":\"$FD/konfig.ini\",\"content\":\"x\",\"expectedModified\":1}" "$B/api/agents/$ID/files/text" | json .error)
[ "$CONFLICT" = "conflict" ] || fail "brak wykrycia konfliktu edycji ($CONFLICT)"
curl -sf -b "$J" -X POST -H 'content-type: application/json' -d "{\"paths\":[\"$FD/zażółć.bin\",\"$FD/konfig.ini\"]}" "$B/api/agents/$ID/files/delete" >/dev/null || fail "usuwanie plików"
[ -z "$(ls -A "$FD")" ] || fail "pliki nie zostały usunięte"
echo "✔ pliki: wysłanie 3,5 MB, pobranie (zgodne bajt w bajt), ZIP, edycja z wykryciem konfliktu, usunięcie"

(cd "$ROOT/server" && SID="$SID" URL="ws://127.0.0.1:$PORT/ws/desktop/$ID" node -e '
  const { WebSocket } = require("ws");
  const ws = new WebSocket(process.env.URL, { headers: { cookie: "overvnc_sid=" + process.env.SID } });
  let info = false, frames = 0, clips = [], copied = false;
  const t = setTimeout(() => { console.error("timeout: info", info, "klatki", frames, "schowek", clips); process.exit(1); }, 15000);
  ws.on("message", (m, bin) => {
    if (!bin) { if (JSON.parse(m).type === "ready") ws.send(JSON.stringify({ t: "cfg", clipSync: true })); return; }
    const kind = String.fromCharCode(m[0]);
    if (kind === "I") info = JSON.parse(m.subarray(1)).monitors.length === 2;
    if (kind === "C") clips.push(m.subarray(1).toString());
    if (kind === "F") {
      frames++;
      ws.send("{\"t\":\"ack\"}");
      if (frames === 3) ws.send("{\"t\":\"k\",\"code\":\"KeyQ\",\"d\":true}");
      if (frames === 4) ws.send(JSON.stringify({ t: "clip", text: "zażółć gęślą" }));
      // F9 na ekranie testowym = ktoś skopiował tekst na komputerze; potem Ctrl+Alt+Del
      if (frames === 8 && !copied) { copied = true; ws.send(JSON.stringify({ t: "k", code: "F9", d: true })); ws.send(JSON.stringify({ t: "sas" })); }
    }
    if (frames >= 8 && info && clips.length > 0) { clearTimeout(t); setTimeout(() => ws.close(), 300); }
  });
  ws.on("close", () => {
    // wklejony przez nas tekst nie wraca echem — tylko to, co skopiowano na komputerze
    const ok = frames >= 8 && info && clips.length === 1 && clips[0] === "skopiowane na komputerze — zażółć";
    if (!ok) console.error("schowek z komputera:", JSON.stringify(clips));
    process.exit(ok ? 0 : 1);
  });
') || fail "pulpit zdalny"
for i in $(seq 50); do grep -q "wejście k code=KeyQ" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "wejście k code=KeyQ" "$WORK/agent.log" || fail "klawisz nie dotarł do komputera"
for i in $(seq 50); do grep -q "schowek: 12 znaków" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "schowek: 12 znaków" "$WORK/agent.log" || fail "tekst nie trafił do schowka komputera"
grep -q "wejście k code=KeyV b=0 d=true" "$WORK/agent.log" || fail "brak Ctrl+V po wklejeniu"
for i in $(seq 50); do grep -q "Ctrl+Alt+Del" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "Ctrl+Alt+Del" "$WORK/agent.log" || fail "Ctrl+Alt+Del nie dotarło do usługi agenta"
echo "✔ pulpit: monitory, klatki z potwierdzeniami (tempo), klawisz, wklejenie, schowek komputera → przeglądarka (bez echa), Ctrl+Alt+Del"

# kiosk: zrzut ekranu (osobny proces pomocnika w trybie „snapshot”) i komunikat na ekranie
CID=$(curl -sf -b "$J" -X POST -H 'content-type: application/json' -d '{"name":"Kioski e2e","consentMode":"none"}' "$B/api/clients" | json .id) || fail "klient kiosku"
curl -sf -b "$J" -X PATCH -H 'content-type: application/json' -d "{\"clientId\":$CID}" "$B/api/agents/$ID" >/dev/null || fail "przypisanie kiosku"
curl -sf -b "$J" -o "$WORK/shot.jpg" -D "$WORK/shot.h" "$B/api/agents/$ID/screenshot?w=320" || fail "zrzut ekranu"
[ "$(head -c 3 "$WORK/shot.jpg" | od -An -tx1 | tr -d ' ')" = "ffd8ff" ] || fail "zrzut nie jest JPEG"
grep -qi "x-screen-size: 320x" "$WORK/shot.h" || fail "zrzut ma złą szerokość: $(grep -i x-screen-size "$WORK/shot.h")"
curl -sf -b "$J" -X POST -H 'content-type: application/json' -d '{"text":"Przerwa techniczna e2e","seconds":30}' "$B/api/agents/$ID/message" >/dev/null || fail "komunikat"
for _ in $(seq 50); do grep -q "Przerwa techniczna e2e" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "Przerwa techniczna e2e" "$WORK/agent.log" || fail "komunikat nie dotarł do komputera"
echo "✔ kiosk: zrzut ekranu (JPEG $(wc -c <"$WORK/shot.jpg" | tr -d ' ') B, 320 px) i komunikat na ekranie"

# zadanie: skrypt w prawdziwej powłoce, wynik i kod wyjścia zapisane przez serwer
JOB=$(curl -sf -b "$J" -X POST "$B/api/jobs" -H 'content-type: application/json' \
  -d "{\"kind\":\"script\",\"agentIds\":[\"$ID\"],\"waitHours\":0,\"params\":{\"shell\":\"sh\",\"script\":\"echo zażółć-e2e; exit 4\",\"timeoutSec\":60}}" | json .id) || fail "utworzenie zadania"
for _ in $(seq 100); do [ "$(curl -sf -b "$J" "$B/api/jobs/$JOB" | json '.finishedAt !== null')" = "true" ] && break; sleep 0.1; done
JD=$(curl -sf -b "$J" "$B/api/jobs/$JOB")
[ "$(echo "$JD" | json '.targets[0].exitCode')" = "4" ] || fail "zadanie: kod wyjścia ($(echo "$JD" | json '.targets[0].status'))"
curl -sf -b "$J" "$B/api/jobs/$JOB/output/$ID" | grep -q 'zażółć-e2e' || fail "zadanie: wyjście skryptu"
echo "✔ zadanie: skrypt w powłoce, wyjście UTF-8 i kod wyjścia"

curl -sf -b "$J" -X DELETE "$B/api/agents/$ID" >/dev/null || fail "usuwanie"
for _ in $(seq 50); do grep -q "odrzucił" "$WORK/agent.log" && break; sleep 0.1; done
grep -q "odrzucił" "$WORK/agent.log" || fail "agent nie został odrzucony po usunięciu"
echo "✔ usunięty agent rozłączony i odrzucony"
echo "E2E OK"
