# OVERVNC

Własny system zdalnego zarządzania komputerami (Windows / macOS / Linux).

```
[overvnc-agent (Go)] ──wss──▶ [serwer (Node/TS + SQLite)] ◀──https── [panel (React)]
  zarządzane komputery          VPS                           przeglądarka admina
```

| Katalog | Zawartość |
|---|---|
| `agent/` | Agent w Go — jedna binarka, działa jako usługa systemowa, łączy się wychodząco z serwerem |
| `server/` | Serwer API + WebSocket (Fastify, `node:sqlite`, zod), uruchamiany bezpośrednio przez Node ≥ 24 (bez kompilacji) |
| `panel/` | Panel webowy (React + Vite), po zbudowaniu serwowany przez serwer |
| `docs/protocol.md` | Protokół agent ↔ serwer i kody błędów API |
| `scripts/check.sh` | Pełna weryfikacja (formatowanie, typy, testy, kompilacja na 6 platform, e2e) — to samo co CI |
| `scripts/e2e.sh` | Test end-to-end: prawdziwy serwer + prawdziwa binarka agenta |
| `scripts/build-agents.sh` | Buduje agenta na 6 platform do `dist/agents/` |

## Testy

```bash
scripts/check.sh            # wszystko (ok. 1 min)
cd server && npm test       # testy serwera (node:test)
cd agent && go test ./...   # testy agenta
```

## Funkcje (v0.2.0)

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

## Plan

| Etap | Zakres | Status |
|---|---|---|
| 0 | Fundament: git, testy, CI, migracje, moduły serwera, protokół poleceń | ✅ v0.2.0 |
| 1 | Organizacja: klienci, grupy i tagi; zespół z rolami; 2FA | ⏳ |
| 2 | Praca zdalna: terminal interaktywny, procesy i usługi, zasilanie i Wake-on-LAN | |
| 3 | Menedżer plików | |
| 4 | Monitoring: historia i wykresy, stan bezpieczeństwa, historia zmian, alerty i powiadomienia | |
| 5 | Automatyzacja: biblioteka skryptów, zadania zaplanowane, wdrażanie programów i aktualizacji | |
| 6 | Pulpit zdalny + aplikacja w zasobniku (zgoda, czat) | |
| 7 | Dystrybucja: instalatory z tokenem, auto-aktualizacja, podpisywanie kodu | |

## Bezpieczeństwo — zasady

- Agent nigdy nie nasłuchuje na porcie — tylko połączenie wychodzące do serwera.
- Agent wymaga `https://` (wyjątek: `localhost` lub jawne `--insecure` do testów w LAN).
- Serwer przechowuje wyłącznie skróty (SHA-256 / scrypt) sekretów, tokenów i haseł.
- Usunięcie komputera w panelu natychmiast unieważnia jego sekret.
- Przejęcie serwera = dostęp do wszystkich komputerów: aktualizuj system VPS, używaj silnych haseł, (etap 5) włącz 2FA.
- Monitorowanie komputerów pracowników wymaga ich poinformowania (RODO, art. 22³ Kodeksu pracy).
