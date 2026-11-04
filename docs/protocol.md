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

Ramki binarne są zarezerwowane na strumienie: pulpit zdalny i przesył plików.

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
