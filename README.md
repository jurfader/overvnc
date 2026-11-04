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

## Funkcje (v0.7.0)

**Komputery**
- rejestracja tokenem (jednorazowym lub wielokrotnym, z terminem ważności, opcjonalnie od razu przypisującym klienta i lokalizację); każdy agent dostaje własny sekret
- status online/offline na żywo, CPU / RAM / dyski / sieć / czas pracy / zalogowani użytkownicy (co 15 s)
- inwentarz: system, sprzęt, dyski, interfejsy sieciowe, zainstalowane oprogramowanie (rejestr Windows, `/Applications`, dpkg/rpm/pacman/apk)

**Organizacja**
- klienci (firmy) z lokalizacjami, tagi, notatki do komputerów
- filtry listy (status, klient, lokalizacja, tag, wyszukiwarka) i operacje zbiorcze (przypisanie klienta, tagi)

**Praca zdalna** (rola Technik i wyżej, tylko komputery w zakresie konta)
- **pulpit zdalny (Windows):**
  - podgląd i sterowanie myszą i klawiaturą (fizyczne klawisze, więc polskie znaki z AltGr działają), wybór monitora i jakości, tryb podglądu wymuszany przez serwer, pełny ekran;
  - widoczny także ekran blokady i okna UAC (pomocnik działa jako SYSTEM w sesji użytkownika);
  - wysyłane są tylko zmienione kafelki, a tempo wyznaczają potwierdzenia z przeglądarki (wolne łącze obniża liczbę klatek, a nie zwiększa opóźnienia);
  - zgoda użytkownika per klient: bez komunikatu (kioski), z powiadomieniem albo z pytaniem Tak/Nie.
- terminal w przeglądarce (xterm.js; PowerShell/cmd na Windows, zsh/bash/sh na macOS i Linuksie), pełny ekran, wiele sesji, wpis w dzienniku z czasem trwania
- procesy: lista z CPU i pamięcią, sortowanie, wyszukiwanie, odświeżanie na żywo, zakończenie procesu
- usługi: start, stop, restart, autostart (Windows, systemd, launchd)
- zasilanie: restart / wyłączenie z opóźnieniem i komunikatem dla użytkownika, anulowanie, wylogowanie, blokada ekranu — panel pokazuje tylko akcje obsługiwane przez dany system
- **pliki**: przeglądanie dysków i skrótów, wysyłanie (przeciągnij i upuść, postęp, kolejka, pytanie o nadpisanie), pobieranie plików i folderów (ZIP w locie), nowy folder, zmiana nazwy, usuwanie, podgląd i edycja plików tekstowych z wykrywaniem konfliktu; kontrola przepływu — wolne łącze nie zapycha pamięci serwera; katalogi systemowe chronione
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

## Wydania i automatyczne aktualizacje

```bash
git tag v0.6.1 && git push origin v0.6.1
```

GitHub Actions ([release.yml](.github/workflows/release.yml)) uruchamia testy i buduje agenta na 6 platform. Potem podpisuje manifest kluczem Ed25519 z sekretu `OVERVNC_SIGNING_KEY`, sprawdza, czy podpis pasuje do klucza wbudowanego w agenta, i publikuje Release. Serwer co 15 min sprawdza GitHuba (`GITHUB_REPO`, `GITHUB_TOKEN` tylko do odczytu), **sam weryfikuje podpis i sumy kontrolne**, a w trybie automatycznym rozsyła wersję do komputerów z odstępem 2 s. W trybie ręcznym czeka na „Zatwierdź” w panelu (System → Aktualizacje).

Agent pobiera binarkę z serwera i **weryfikuje podpis kluczem wbudowanym w siebie**, więc przejęty serwer nie podsunie mu obcego pliku. Potem podmienia plik i kończy działanie, a menedżer usług uruchamia nową wersję. Jeśli nowa wersja 3 razy nie połączy się z serwerem, agent przywraca poprzednią i nie instaluje już tej wersji.

- Klucz prywatny: `~/.overvnc/signing-key.pem` (kopia zapasowa poza repozytorium!) oraz sekret repozytorium. Utrata klucza oznacza konieczność nowego klucza i reinstalacji agentów.
- Serwer bez GitHuba: `npm run cli -- import-release <katalog z manifest.json, .sig i binarkami>`.

## Obraz ISO (kiosk)

```bash
scripts/kiosk-package.sh https://vnc.overmedia.pl ovnc_TOKEN 0.6.0
```

Polecenie tworzy `dist/overvnc-kiosk/` z agentem, `install-overvnc.cmd`, `SetupComplete.cmd` i instrukcją `README-ISO.txt` (NTLite, `$OEM$`, sysprep). W obrazie jest tylko token, bez tożsamości. Każdy komputer rejestruje się sam przy pierwszym połączeniu z siecią (`install --defer`), a sklonowany dysk wykrywa zmianę sprzętu (identyfikator systemu i MAC fizycznych kart) i rejestruje się jako nowy komputer. Token w panelu powinien być wielokrotnego użytku, z długą ważnością i przypisanym klientem.

## Wdrożenie na VPS

```bash
scripts/deploy.sh srv      # buduje panel, przesyła i instaluje (deploy/install-srv.sh)
```

Instalacja jest idempotentna:

- użytkownik systemowy `overvnc`;
- własny Node w `/opt/overvnc/node` (systemowy zostaje nietknięty);
- aplikacja w `/opt/overvnc/app`, dane w `/var/lib/overvnc`;
- konfiguracja w `/etc/overvnc/server.env`;
- usługa systemd `overvnc` z utwardzeniem (zapis tylko do katalogu danych), nasłuch tylko na `127.0.0.1:20300`.

Za Cloudflare Tunnel (jak na `srv`) wystarczy dopisać do `/etc/cloudflared/config.yml` pozycję przed `http_status:404`:

```yaml
  - hostname: vnc.overmedia.pl
    service: http://localhost:20300
```

Do tego rekord DNS `CNAME vnc → <id-tunelu>.cfargotunnel.com` (z proxy) albo `cloudflared tunnel route dns <tunel> vnc.overmedia.pl`. Nie trzeba otwierać żadnych portów na routerze. `TRUST_PROXY=1` jest wymagane, bo bez niego wszyscy mają adres `127.0.0.1`, a limit prób logowania blokowałby wszystkich naraz. Cloudflare zamyka bezczynne WebSockety po ok. 100 s, dlatego serwer i agent wysyłają ping co 30 s.

Przed serwerem reverse proxy z HTTPS, np. Caddy (certyfikat Let's Encrypt automatycznie):

```
vnc.twojadomena.pl {
    reverse_proxy 127.0.0.1:8080
}
```

Zmienne środowiskowe serwera: `PORT`, `HOST`, `DATA_DIR`, `PANEL_DIR`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, `ADMIN_USER`/`ADMIN_PASSWORD` (tylko przy pierwszym starcie), `LOG_LEVEL`, `REQUIRE_2FA=0` (wyłącza obowiązkowe 2FA — **tylko do developmentu**), `MAX_UPLOAD_MB` (limit wysyłanego pliku, domyślnie 10240).

W Caddy/nginx przed serwerem nie ustawiaj limitu treści żądania mniejszego niż `MAX_UPLOAD_MB` i nie buforuj żądań — wysyłanie jest strumieniowe.

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
| 3 | Menedżer plików | ✅ v0.5.0 |
| — | Obraz ISO kiosku: rejestracja przy pierwszym uruchomieniu, wykrywanie klonów, podpisane automatyczne aktualizacje z wycofaniem | ✅ v0.6.0 |
| 6 (część) | Pulpit zdalny dla Windows (zgoda per klient, ekran blokady/UAC) | ✅ v0.7.0 |
| 4 | Monitoring: historia i wykresy, stan bezpieczeństwa, historia zmian, alerty i powiadomienia | ⏳ |
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
