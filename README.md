# OVERVNC

Własny system zdalnego zarządzania komputerami (Windows / macOS / Linux).

```
[overvnc-agent (Go)] ──wss──▶ [serwer (Node/TS + SQLite)] ◀──https── [panel (React)]
  zarządzane komputery          VPS                           przeglądarka admina
```

| Katalog | Zawartość |
|---|---|
| `agent/` | Agent w Go — jedna binarka, działa jako usługa systemowa, łączy się wychodząco z serwerem |
| `server/` | Serwer API + WebSocket (Fastify, `node:sqlite`), uruchamiany bezpośrednio przez Node ≥ 24 (bez kompilacji) |
| `panel/` | Panel webowy (React + Vite), po zbudowaniu serwowany przez serwer |
| `scripts/build-agents.sh` | Buduje agenta na 6 platform do `dist/agents/` |

## Status: etap 1 — monitoring i inwentarz ✅

- rejestracja komputerów tokenem (jednorazowym lub wielokrotnym, z terminem ważności); każdy agent dostaje własny sekret
- status online/offline na żywo, CPU / RAM / dyski / sieć / czas pracy / zalogowani użytkownicy (co 15 s)
- inwentarz: system, sprzęt, dyski, interfejsy sieciowe, zainstalowane oprogramowanie (rejestr Windows, `/Applications`, dpkg/rpm/pacman/apk)
- logowanie administratora (scrypt, sesje httpOnly, limit prób), dziennik zdarzeń

## Uruchomienie lokalne (dev)

```bash
# 1. serwer (port 8080); przy pierwszym starcie wypisze login i hasło admina
cd server && npm install && npm run dev

# 2. panel z hot-reloadem na http://localhost:5173 (albo: npm run build — wtedy panel jest pod :8080)
cd panel && npm install && npm run dev

# 3. agent na tym samym komputerze
cd agent && go run . enroll --server http://localhost:8080 --token <token z panelu> --config ./dev-agent.json
go run . run --config ./dev-agent.json
```

## Dodanie komputera

1. Panel → **Dodaj komputer** → utwórz token.
2. Skopiuj na komputer odpowiednią binarkę z `dist/agents/` i uruchom polecenie wyświetlone w panelu, np.:
   - Windows (PowerShell jako Administrator): `.\overvnc-agent.exe install --server https://vnc.twojadomena.pl --token ovnc_...`
   - macOS / Linux: `sudo ./overvnc-agent install --server https://vnc.twojadomena.pl --token ovnc_...`
3. Agent rejestruje się, instaluje jako usługa (`overvnc-agent`) i startuje automatycznie z systemem.

Konfiguracja agenta (z sekretem, dostęp tylko admin/root):
Windows `C:\ProgramData\OVERVNC\agent.json` · macOS `/Library/Application Support/OVERVNC/agent.json` · Linux `/etc/overvnc/agent.json`

Odinstalowanie: `overvnc-agent uninstall --purge`

## Wdrożenie na VPS

```bash
cd panel && npm ci && npm run build
cd ../server && npm ci --omit=dev
HOST=127.0.0.1 PORT=8080 COOKIE_SECURE=1 TRUST_PROXY=1 DATA_DIR=/var/lib/overvnc node src/index.ts
```

Przed serwerem reverse proxy z HTTPS, np. Caddy (certyfikat Let's Encrypt automatycznie):

```
vnc.twojadomena.pl {
    reverse_proxy 127.0.0.1:8080
}
```

Zmienne środowiskowe serwera: `PORT`, `HOST`, `DATA_DIR`, `PANEL_DIR`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `ADMIN_USER`/`ADMIN_PASSWORD` (tylko przy pierwszym starcie), `LOG_LEVEL`.
Zmiana hasła / nowe konto: `npm run cli -- passwd <login>`.

**Kopia zapasowa:** wystarczy katalog `DATA_DIR` (plik `overvnc.db`).

## Plan dalszych etapów

2. **Zdalne komendy** — PowerShell/bash z wynikiem na żywo, zapis w dzienniku
3. **Pliki i instalacje** — przesyłanie plików, winget/brew/apt, restart/wyłączenie
4. **Pulpit zdalny** — podgląd i sterowanie (najpierw JPEG po WebSocket, potem WebRTC); powiadomienie/zgoda użytkownika na komputerze
5. **Wdrożenie** — 2FA dla adminów, auto-aktualizacja agenta, instalatory MSI/pkg/deb, podpisywanie kodu

## Bezpieczeństwo — zasady

- Agent nigdy nie nasłuchuje na porcie — tylko połączenie wychodzące do serwera.
- Agent wymaga `https://` (wyjątek: `localhost` lub jawne `--insecure` do testów w LAN).
- Serwer przechowuje wyłącznie skróty (SHA-256 / scrypt) sekretów, tokenów i haseł.
- Usunięcie komputera w panelu natychmiast unieważnia jego sekret.
- Przejęcie serwera = dostęp do wszystkich komputerów: aktualizuj system VPS, używaj silnych haseł, (etap 5) włącz 2FA.
- Monitorowanie komputerów pracowników wymaga ich poinformowania (RODO, art. 22³ Kodeksu pracy).
