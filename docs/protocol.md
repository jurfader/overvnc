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
[1 bajt: rodzaj = 1 (dane)][4 bajty: numer kanału, big-endian][dane]
```

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
