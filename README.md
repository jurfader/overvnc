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

## Funkcje (v0.4.0)

**Komputery**
- rejestracja tokenem (jednorazowym lub wielokrotnym, z terminem ważności, opcjonalnie od razu przypisującym klienta i lokalizację); każdy agent dostaje własny sekret
- status online/offline na żywo, CPU / RAM / dyski / sieć / czas pracy / zalogowani użytkownicy (co 15 s)
- inwentarz: system, sprzęt, dyski, interfejsy sieciowe, zainstalowane oprogramowanie (rejestr Windows, `/Applications`, dpkg/rpm/pacman/apk)

**Organizacja**
- klienci (firmy) z lokalizacjami, tagi, notatki do komputerów
- filtry listy (status, klient, lokalizacja, tag, wyszukiwarka) i operacje zbiorcze (przypisanie klienta, tagi)

**Praca zdalna** (rola Technik i wyżej, tylko komputery w zakresie konta)
- terminal w przeglądarce (xterm.js; PowerShell/cmd na Windows, zsh/bash/sh na macOS i Linuksie), pełny ekran, wiele sesji, wpis w dzienniku z czasem trwania
- procesy: lista z CPU i pamięcią, sortowanie, wyszukiwanie, odświeżanie na żywo, zakończenie procesu
- usługi: start, stop, restart, autostart (Windows, systemd, launchd)
- zasilanie: restart / wyłączenie z opóźnieniem i komunikatem dla użytkownika, anulowanie, wylogowanie, blokada ekranu — panel pokazuje tylko akcje obsługiwane przez dany system
- Wake-on-LAN przez inny włączony komputer z tej samej sieci (ta sama podsieć + to samo łącze lub klient)

**Zespół i bezpieczeństwo**
- role: **Właściciel** (wszystko), **Administrator** (bez zarządzania zespołem), **Technik** (praca zdalna, bez usuwania/ustawień), **Podgląd** (tylko odczyt)
- zawężenie konta do wybranych klientów — egzekwowane w API, zdarzeniach na żywo i panelu (cudze komputery zwracają 404)
- 2FA (TOTP, RFC 6238) — obowiązkowe dla właścicieli i administratorów; kody zapasowe; ochrona przed ponownym użyciem kodu; sekret szyfrowany AES-256-GCM kluczem z `DATA_DIR/secret.key`
- hasła tymczasowe z wymuszoną zmianą, blokada kont, lista aktywnych sesji z wylogowaniem, ochrona ostatniego właściciela
- dziennik zdarzeń (logowania, zmiany, rejestracje, operacje na komputerach)

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

Zmienne środowiskowe serwera: `PORT`, `HOST`, `DATA_DIR`, `PANEL_DIR`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `ADMIN_USER`/`ADMIN_PASSWORD` (tylko przy pierwszym starcie), `LOG_LEVEL`, `REQUIRE_2FA=0` (wyłącza obowiązkowe 2FA — **tylko do developmentu**).

Narzędzia awaryjne (na serwerze, w katalogu `server/`):

```bash
npm run cli -- users              # lista kont
npm run cli -- passwd <login>     # nowe hasło (lub nowe konto właściciela)
npm run cli -- reset-2fa <login>  # utracony telefon — 2FA do ponownej konfiguracji
npm run cli -- unlock <login>     # odblokowanie konta
```

**Kopia zapasowa:** cały katalog `DATA_DIR` — baza `overvnc.db` **oraz** klucz `secret.key`. Bez klucza sekrety 2FA z kopii są nie do odczytania (wtedy pomoże `reset-2fa`). Klucz trzymaj osobno od kopii bazy.

## Plan

| Etap | Zakres | Status |
|---|---|---|
| 0 | Fundament: git, testy, CI, migracje, moduły serwera, protokół poleceń | ✅ v0.2.0 |
| 1 | Organizacja: klienci, lokalizacje i tagi; zespół z rolami; 2FA | ✅ v0.3.0 |
| 2 | Praca zdalna: terminal interaktywny, procesy i usługi, zasilanie i Wake-on-LAN | ✅ v0.4.0 |
| 3 | Menedżer plików | ⏳ |
| 4 | Monitoring: historia i wykresy, stan bezpieczeństwa, historia zmian, alerty i powiadomienia | |
| 5 | Automatyzacja: biblioteka skryptów, zadania zaplanowane, wdrażanie programów i aktualizacji | |
| 6 | Pulpit zdalny + aplikacja w zasobniku (zgoda, czat) | |
| 7 | Dystrybucja: instalatory z tokenem, auto-aktualizacja, podpisywanie kodu | |

## Bezpieczeństwo — zasady

- Agent nigdy nie nasłuchuje na porcie — tylko połączenie wychodzące do serwera.
- Agent wymaga `https://` (wyjątek: `localhost` lub jawne `--insecure` do testów w LAN).
- Serwer przechowuje wyłącznie skróty (SHA-256 / scrypt) sekretów, tokenów i haseł.
- Usunięcie komputera w panelu natychmiast unieważnia jego sekret.
- Przejęcie serwera = dostęp do wszystkich komputerów: aktualizuj system VPS, używaj silnych haseł; 2FA jest obowiązkowe dla właścicieli i administratorów.
- Monitorowanie komputerów pracowników wymaga ich poinformowania (RODO, art. 22³ Kodeksu pracy).
