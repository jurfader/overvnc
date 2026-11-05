# Protokół agent ↔ serwer

Agent łączy się z serwerem przez WebSocket: `wss://<serwer>/ws/agent`. Połączenie jest zawsze **wychodzące**, więc agent nigdy nie nasłuchuje na porcie.

Wersja protokołu: **1** (`protocolVersion` w `agent/protocol.go`, `PROTOCOL_VERSION` w `server/src/hub.ts`).

## Uwierzytelnienie

Nagłówek przy otwieraniu połączenia:

```
Authorization: Bearer <agentId>.<agentSecret>
```

Sekret jest generowany przy rejestracji (`POST /api/agent/enroll`) i zwracany agentowi tylko raz. Serwer przechowuje wyłącznie jego SHA-256. Zły sekret dostaje `401` jeszcze przed upgrade'em do WebSocketu. Usunięcie komputera w panelu zamyka połączenie kodem `4001`.

## Ramki

Ramki tekstowe zawierają JSON w jednej kopercie:

```ts
{ type: string, id?: string, data?: any, error?: { code: string, message: string } }
```

Zdarzenia serwer → panel (`/ws/panel`) są filtrowane zakresem klientów zalogowanego konta: `agent_online`, `agent_offline`, `agent_updated`, `agent_metrics`, `agent_added`, `agent_removed` (także gdy komputer wypadnie z zakresu) oraz `org_changed` (zmienili się klienci/lokalizacje/tagi — panel pobiera słowniki ponownie). Zmiana roli lub zakresu konta zamyka jego panel kodem `4003`; panel łączy się ponownie z nowym zakresem.

### Ramki binarne (strumienie)

```
[1 bajt: rodzaj][4 bajty: numer kanału, big-endian][dane]
rodzaj 1 = dane, rodzaj 2 = potwierdzenie (ack: 4 bajty — liczba bajtów)
```

**Kontrola przepływu (pliki).** Nadawca wysyła najwyżej **2 MB** bez potwierdzenia. Odbiorca potwierdza dopiero wtedy, gdy dane naprawdę poszły dalej: serwer, gdy Node przekazał je do gniazda przeglądarki, a agent, gdy zapisał je na dysk. Wolny odbiorca spowalnia więc nadawcę i nic nie gromadzi się w pamięci serwera. Wysyłanie trafia do pliku tymczasowego `.<nazwa>.overvnc-part-*`, a `fs.commit` czeka na zapis wszystkich bajtów, synchronizuje dysk, zamyka plik i dopiero wtedy zmienia jego nazwę na docelową. Przerwane wysyłanie usuwa plik tymczasowy.

Kanał otwiera serwer poleceniem (np. `term.open` z polem `channel`). Odbiorcę rejestruje **przed** wysłaniem żądania, bo agent może nadawać dane przed odpowiedzią. Ramki z kanałem, który nie należy do nadającego agenta, serwer odrzuca. Koniec strumienia po stronie agenta to zdarzenie `channel.closed { channel, exitCode }`, a zamknięcie z inicjatywy serwera to polecenie `channel.close { channel }`. Zerwanie połączenia kończy wszystkie kanały, a agent zabija wtedy swoje powłoki.

### Terminal w przeglądarce (`/ws/term/:agentId?shell=&cols=&rows=`)

- Wymaga sesji, uprawnienia `agents.remote`, komputera w zakresie konta i komputera online. W przeciwnym razie odpowiedź 401/403/404/409 przed upgrade'em.
- Przeglądarka wysyła naciśnięcia klawiszy jako ramki binarne (surowe bajty) oraz `{"type":"resize","cols","rows"}` jako tekst.
- Serwer wysyła wyjście powłoki jako ramki binarne, a sterowanie tekstem: `{"type":"ready","shell"}` oraz `{"type":"closed","message"}`.
- Kody zamknięcia: `4100` koniec powłoki, `4101` 30 min bezczynności, `4102` komputer się rozłączył, `4103` przeglądarka nie nadąża (bufor > 8 MB), `4400` nie udało się otworzyć.
- W dzienniku zapisywane są `term.open` i `term.close` (czas trwania, liczba bajtów w obie strony).

### Zdarzenia agent → serwer (bez `id`)

| type | kiedy | data |
|---|---|---|
| `hello` | zaraz po połączeniu | `{ version, protocol, capabilities: string[], inventory }` |
| `metrics` | co 15 s | `Metrics` (CPU, RAM, dyski, sieć, uptime, zalogowani) |
| `inventory` | co 6 h | `Inventory` (system, sprzęt, dyski, sieć, oprogramowanie) |

### Żądania serwer → agent (z `id`)

```json
{ "type": "inventory.refresh", "id": "6f1c…", "data": null }
```

Agent odpowiada **dokładnie raz** tym samym `id`:

```json
{ "type": "result", "id": "6f1c…", "data": { … } }
{ "type": "error",  "id": "6f1c…", "error": { "code": "unknown_command", "message": "…" } }
```

- Agent wykonuje żądania równolegle (najwyżej 16 naraz, ponad limit zwraca `busy`), każde z limitem czasu 5 min.
- Serwer czeka domyślnie 30 s, po czym zwraca `504 agent_timeout`.
- Rozłączenie agenta przerywa jego oczekujące żądania błędem `agent_disconnected`.
- Odpowiedź z cudzym `id` (wysłanym do innego agenta) jest ignorowana.

### Możliwości (`capabilities`)

W `hello` agent wysyła listę obsługiwanych poleceń. Serwer odrzuca polecenie nieobsługiwane przez daną wersję agenta (`501 unsupported`), więc stary agent nie dostaje poleceń, których nie zna. Panel na tej podstawie ukrywa lub wyłącza funkcje.

| Polecenie | Od wersji | Opis |
|---|---|---|
| `inventory.refresh` | 0.2.0 | zbiera i zwraca pełny inwentarz |
| `term.open` `{channel, cols, rows, shell}` | 0.4.0 | powłoka w PTY (ConPTY na Windows); limit 8 sesji na komputer |
| `term.resize` `{channel, cols, rows}` | 0.4.0 | zmiana rozmiaru terminala |
| `channel.close` `{channel}` | 0.4.0 | zamyka kanał (zabija proces) |
| `proc.list` | 0.4.0 | procesy z CPU (% całej maszyny, z dwóch próbek) i pamięcią |
| `proc.kill` `{pid, force}` | 0.4.0 | kończy proces; PID 1/4 i sam agent są chronione |
| `svc.list` | 0.4.0 | usługi: Windows SCM, systemd, launchd (domena system) |
| `svc.control` `{name, action}` | 0.4.0 | `start`/`stop`/`restart`/`enable`/`disable`; usługa agenta chroniona |
| `power.action` `{action, delayMinutes, message}` | 0.4.0 | zasilanie; obsługiwane akcje ogłaszane jako `power.<akcja>` |
| `wol.send` `{macs, broadcasts}` | 0.4.0 | agent-przekaźnik wysyła magiczny pakiet (UDP 9 i 7, SO_BROADCAST) |
| `fs.roots` | 0.5.0 | dyski (z zajętością) i skróty użytkownika (Pulpit, Dokumenty, Pobrane) |
| `fs.list` `{path}` | 0.5.0 | zawartość katalogu (najpierw foldery, maks. 5000 pozycji) |
| `fs.mkdir` / `fs.rename` / `fs.delete` | 0.5.0 | operacje na plikach; rename nie nadpisuje; katalogi systemowe i korzenie dysków chronione |
| `fs.readText` / `fs.writeText` | 0.5.0 | podgląd i edycja tekstu ≤ 1 MB; zapis atomowy, zachowuje uprawnienia, wykrywa konflikt (`expectedModified`) |
| `fs.read` `{channel, path, zip}` | 0.5.0 | strumień pobierania; katalog jako ZIP w locie (nazwy UTF-8) |
| `fs.write` `{channel, dir, name, size, overwrite}` + `fs.commit` | 0.5.0 | strumień wysyłania do pliku tymczasowego, zatwierdzenie atomowe |

| `desktop.open` `{channel, monitor, quality, consent, viewer, viewOnly}` | 0.7.0 | pulpit zdalny (Windows; macOS od 0.16.0 — CoreGraphics/CGEvent przez purego, pomocnik w sesji użytkownika przez `launchctl asuser`, zgody „Nagrywanie ekranu” i „Dostępność”; brakujące zgłaszane w `notice` informacji o pulpicie); szczegóły niżej |
| `update.check` | 0.6.0 | natychmiastowe sprawdzenie i instalacja aktualizacji; wynik `{status: up_to_date \| restarting \| skipped \| disabled}` | Od 0.17.0 agent na macOS aktualizuje się pakietem aplikacji „OVERVNC Agent.app” (klucz manifestu `darwin-<arch>-app`, zip); agent zainstalowany jako pojedynczy plik przenosi się do pakietu sam (plik w `/usr/local/bin` staje się dowiązaniem).
| `script.run` `{runId, shell, script, timeoutSec, asUser}` | 0.13.0 | jednorazowy skrypt (zadania); wynik `{exitCode, output, truncated, timedOut, durationMs, user}`; wyjście: pierwsze 48 KB + ostatnie 16 KB. Skrypt działa niezależnie od połączenia; ten sam `runId` nie uruchamia go drugi raz. `asUser` (możliwość `script.user`): w sesji zalogowanego użytkownika |
| `script.result` `{runId}` | 0.13.0 | wynik uruchomienia sprzed rozłączenia (czeka, jeśli trwa); wyniki trzymane 1 h; `unknown_run` po restarcie agenta |
| `deploy.run` `{runId, url, name, size, sha256, dir, overwrite, shell, script, timeoutSec, asUser}` | 0.15.0 | wdrożenie pliku: pobranie z serwera (`GET /api/agent/packages/:id`, klucz agenta, wznawianie przez `Range`; serwer udostępnia plik tylko komputerom z oczekującym zadaniem), weryfikacja rozmiaru i SHA-256, zapis atomowy w `dir`, opcjonalny skrypt instalacji (ścieżka w `OVERVNC_FILE`); wynik jak `script.run`, odbiór po rozłączeniu przez `script.result` |

### Pulpit zdalny

**Agent.** Usługa w sesji 0 nie widzi ekranu, więc uruchamia `overvnc-agent desktop-helper` jako SYSTEM w sesji konsoli (token z `TokenSessionId`, `CreateProcessAsUser` na `winsta0\default`). Pomocnik przechwytuje ekran przez GDI w trybie Per-Monitor-DPI-V2 i przełącza się na bieżący pulpit wejściowy (ekran blokady/UAC). Wejście wstrzykuje przez `SetCursorPos` i `SendInput` (scancode'y). Usługa i pomocnik komunikują się przez stdin/stdout: `[typ][długość u32][dane]` (`F` klatka, `I` monitory, `L` log, `N` zgoda na klatkę, `E` zdarzenie, `Q` koniec).

**Klatka** (`F`) to `seq u32, szer u16, wys u16, n u16` i `n` × (`x, y, w, h` u16, `długość` u32, JPEG). Wysyłane są tylko kafelki 128×128, które się zmieniły.

**Tempo.** Najwyżej 2 klatki w drodze. Przeglądarka wysyła `{"t":"ack"}` po narysowaniu klatki, serwer zamienia to na ramkę ack dla agenta, a ten pozwala pomocnikowi wysłać następną klatkę (maks. ~15 kl./s).

**Przeglądarka** (`/ws/desktop/:id?quality=low|medium|high&monitor=&viewOnly=0|1`) wysyła zdarzenia JSON:
- `m` — ruch (x, y w zakresie 0..1 monitora);
- `b` — przycisk;
- `w` — kółko;
- `k` — klawisz (`KeyboardEvent.code`);
- `cfg` — jakość lub monitor;
- `kf` — pełna klatka.

Serwer waliduje każde zdarzenie, a w trybie podglądu odrzuca wejście. **Zgoda** wynika z `clients.consent_mode`: `none` | `notify` (WTSSendMessage, bez blokowania) | `ask` (Tak/Nie, 30 s, brak odpowiedzi oznacza odmowę, `consent_denied`).

Na macOS i Linuksie pulpit nie jest jeszcze dostępny. `OVERVNC_DESKTOP_TEST=1` włącza syntetyczny ekran testowy (e2e).

### Aktualizacje (HTTP, uwierzytelnienie kluczem agenta)

- `GET /api/agent/update?version=&platform=windows-amd64` zwraca `204`, gdy agent jest aktualny, albo `{version, manifest (base64), signature (base64), download}`. Agent sprawdza podpis Ed25519 manifestu kluczem wbudowanym w binarkę, potem rozmiar i SHA-256 pobranego pliku.
- `GET /api/agent/update/<wersja>/<platforma>` zwraca binarkę.
- Agent pyta 2 min po starcie i potem co ok. 6 h, a natychmiast po `update.check`.

W `hello` agent wysyła też `shells` (dostępne powłoki) i `runAs` (konto, na którym działa).

### Zgodność

- Serwer ignoruje nieznane typy zdarzeń, więc nowszy agent działa ze starszym serwerem.
- Agent na nieznane polecenie odpowiada `unknown_command`.
- Zmiana niezgodna wstecz wymaga podbicia wersji protokołu.

## Kody błędów API

Każda odpowiedź błędu z API ma ten sam format:

```json
{ "error": "agent_offline", "message": "Komputer jest offline." }
```

| HTTP | error | znaczenie |
|---|---|---|
| 400 | `validation` | nieprawidłowe dane (`details`: lista pól) |
| 401 | `unauthorized`, `invalid_credentials`, `invalid_code`, `ticket_expired` | brak sesji / złe dane logowania / zły kod 2FA / wygasł drugi krok logowania |
| 403 | `forbidden` | rola nie ma uprawnienia albo operacja wymaga dostępu do wszystkich klientów |
| 403 | `password_change_required`, `mfa_setup_required` | konto musi najpierw ustawić hasło / skonfigurować 2FA |
| 403 | `account_disabled`, `invalid_token`, `bad_origin` | konto zablokowane / zły token rejestracji / obce Origin WebSocketu |
| 404 | `not_found` | brak zasobu **lub zasób poza zakresem klientów konta** (celowo nieodróżnialne) |
| 409 | `name_taken`, `username_taken`, `last_owner`, `self_delete`, `self_disable` | konflikt nazw / ochrona ostatniego właściciela i własnego konta |
| 409 | `agent_offline` | komputer offline |
| 422 | kod z agenta | agent zgłosił błąd wykonania |
| 429 | `too_many_attempts` | limit prób |
| 501 | `unsupported` | wersja agenta nie obsługuje funkcji |
| 502 | `agent_disconnected` | agent rozłączył się w trakcie |
| 504 | `agent_timeout` | agent nie odpowiedział na czas |
