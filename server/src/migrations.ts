/**
 * Migracje schematu bazy. Numer wersji trzymamy w PRAGMA user_version.
 * ZASADA: nigdy nie edytuj migracji, która trafiła na produkcję — dopisz nową na końcu.
 */
export const MIGRATIONS: string[] = [
  // 1 — schemat początkowy (v0.1.0). IF NOT EXISTS, bo bazy deweloperskie sprzed migracji już go mają.
  `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enroll_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL,
    uses_left  INTEGER,
    expires_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id             TEXT PRIMARY KEY,
    secret_hash    TEXT NOT NULL,
    hostname       TEXT NOT NULL,
    os             TEXT NOT NULL DEFAULT '',
    platform       TEXT NOT NULL DEFAULT '',
    arch           TEXT NOT NULL DEFAULT '',
    agent_version  TEXT NOT NULL DEFAULT '',
    label          TEXT NOT NULL DEFAULT '',
    inventory_json TEXT,
    metrics_json   TEXT,
    last_ip        TEXT,
    enrolled_at    INTEGER NOT NULL,
    last_seen      INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT,
    details TEXT,
    ip      TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts DESC);
  `,

  // 2 — organizacja (klienci, lokalizacje, tagi), zespół z rolami, 2FA, sesje z metadanymi (v0.3.0)
  `
  CREATE TABLE clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    notes      TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    UNIQUE (client_id, name)
  );

  CREATE TABLE tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE agent_tags (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, tag_id)
  );

  ALTER TABLE agents ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
  ALTER TABLE agents ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;
  ALTER TABLE agents ADD COLUMN notes TEXT NOT NULL DEFAULT '';
  CREATE INDEX agents_client ON agents(client_id);

  ALTER TABLE enroll_tokens ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
  ALTER TABLE enroll_tokens ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;

  -- istniejące konta (sprzed ról) stają się właścicielami
  ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
  ALTER TABLE users ADD COLUMN all_clients INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;            -- zaszyfrowany kluczem serwera (AES-256-GCM)
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login_at INTEGER;

  CREATE TABLE user_clients (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, client_id)
  );

  CREATE TABLE recovery_codes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   INTEGER
  );

  -- drugi krok logowania (kod 2FA) — bilet ważny kilka minut
  CREATE TABLE login_tickets (
    ticket_hash TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
  );

  -- sesje dostają publiczne id i metadane (lista aktywnych sesji); stare sesje unieważniamy
  DELETE FROM sessions;
  ALTER TABLE sessions ADD COLUMN id TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  ALTER TABLE sessions ADD COLUMN user_agent TEXT;
  CREATE INDEX sessions_user ON sessions(user_id);
  `,

  // 3 — ustawienia serwera (polityka aktualizacji agentów itp.) (v0.6.0)
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // 4 — pulpit zdalny: tryb zgody użytkownika per klient (none | notify | ask) (v0.7.0)
  `
  ALTER TABLE clients ADD COLUMN consent_mode TEXT NOT NULL DEFAULT 'notify';
  `,

  // 5 — historia metryk (wykresy): próbki ~1/min, przycinane wg retencji (v0.8.0)
  `
  CREATE TABLE metrics_history (
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ts           INTEGER NOT NULL,
    cpu          REAL NOT NULL,
    mem_percent  REAL NOT NULL,
    mem_used     INTEGER NOT NULL,
    disk_percent REAL NOT NULL,
    net_rx       REAL NOT NULL,
    net_tx       REAL NOT NULL,
    PRIMARY KEY (agent_id, ts)
  );
  CREATE INDEX metrics_history_ts ON metrics_history(ts);
  `,

  // 6 — alerty: reguły (offline / procesor / pamięć / dysk) i zdarzenia alertów (v0.9.0)
  `
  CREATE TABLE alert_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,                 -- offline | cpu | mem | disk
    threshold    REAL NOT NULL DEFAULT 0,       -- % (dla offline nieużywany)
    duration_min INTEGER NOT NULL DEFAULT 0,    -- jak długo warunek musi trwać
    client_id    INTEGER REFERENCES clients(id) ON DELETE CASCADE, -- NULL = wszystkie komputery
    enabled      INTEGER NOT NULL DEFAULT 1,
    notify       INTEGER NOT NULL DEFAULT 1,    -- powiadomienie push (Pushover)
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id     INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    value       REAL,
    started_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    ack_by      TEXT,
    ack_at      INTEGER
  );
  CREATE INDEX alerts_started ON alerts(started_at DESC);
  CREATE INDEX alerts_agent ON alerts(agent_id, started_at DESC);
  -- najwyżej jeden otwarty alert danej reguły na komputer
  CREATE UNIQUE INDEX alerts_one_open ON alerts(rule_id, agent_id) WHERE resolved_at IS NULL;

  INSERT INTO alert_rules (name, kind, threshold, duration_min, created_at) VALUES
    ('Komputer offline', 'offline', 0, 10, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    ('Prawie pełny dysk', 'disk', 90, 5, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    ('Wysokie obciążenie procesora', 'cpu', 95, 15, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    ('Mało wolnej pamięci', 'mem', 95, 15, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  `,

  // 7 — alert „kończy się wersja próbna Windows” (próg w dniach) (v0.12.0)
  `
  INSERT INTO alert_rules (name, kind, threshold, duration_min, created_at) VALUES
    ('Kończy się wersja próbna Windows', 'license', 14, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  `,

  // 8 — zadania (polecenia/skrypty na wielu komputerach, w tle; komputery offline dostają je po połączeniu) (v0.13.0)
  `
  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,                 -- script | message | power | inventory
    title       TEXT NOT NULL,
    params_json TEXT NOT NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by  TEXT NOT NULL,                 -- login autora (zostaje po usunięciu konta)
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,              -- do kiedy czekamy na komputery offline
    finished_at INTEGER,
    canceled_at INTEGER
  );
  CREATE INDEX jobs_created ON jobs(created_at DESC);

  CREATE TABLE job_targets (
    job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    run_id      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | ok | failed | expired | canceled | lost
    started_at  INTEGER,
    finished_at INTEGER,
    exit_code   INTEGER,
    output      TEXT,
    error       TEXT,
    run_as      TEXT,
    PRIMARY KEY (job_id, agent_id)
  );
  CREATE INDEX job_targets_agent ON job_targets(agent_id, status);
  `,

  // 9 — biblioteka skryptów i harmonogram zadań (v0.14.0)
  `
  CREATE TABLE scripts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    shell       TEXT NOT NULL,
    body        TEXT NOT NULL,
    timeout_sec INTEGER NOT NULL DEFAULT 600,
    as_user     INTEGER NOT NULL DEFAULT 0,
    client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE, -- NULL = wspólny (konta z dostępem do wszystkich)
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_by  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,                  -- script | message | power | inventory
    params_json TEXT NOT NULL,                  -- script: { scriptId }
    client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE, -- zakres harmonogramu; NULL = wszyscy klienci
    target_type TEXT NOT NULL,                  -- agents | client | tag | all
    target_json TEXT NOT NULL,                  -- { agentIds } | { tagId }
    days        INTEGER NOT NULL,               -- maska dni: bit 0 = poniedziałek … bit 6 = niedziela
    time        TEXT NOT NULL,                  -- HH:MM (czas polski)
    wait_hours  REAL NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_job_id INTEGER,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  ALTER TABLE jobs ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
  `,

  // 10 — pliki do wdrażania (instalatory, konfiguracje); dane na dysku w DATA_DIR/packages (v0.15.0)
  `
  CREATE TABLE packages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    size         INTEGER NOT NULL,
    received     INTEGER NOT NULL DEFAULT 0,  -- wysyłanie kawałkami (wznawialne)
    sha256       TEXT,                        -- po zakończeniu wysyłania
    client_id    INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  `,

  // 11 — stan zabezpieczeń (ocena) i historia zmian komputera (v0.19.0)
  `
  ALTER TABLE agents ADD COLUMN security_json TEXT;

  CREATE TABLE agent_changes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ts       INTEGER NOT NULL,
    kind     TEXT NOT NULL,           -- software | os | hardware | security | system
    title    TEXT NOT NULL,
    detail   TEXT
  );
  CREATE INDEX agent_changes_agent ON agent_changes(agent_id, ts DESC);
  CREATE INDEX agent_changes_ts ON agent_changes(ts DESC);

  -- domyślnie tylko problemy krytyczne (antywirus/zapora/SIP wyłączone); próg 1 = także ostrzeżenia
  INSERT INTO alert_rules (name, kind, threshold, duration_min, created_at) VALUES
    ('Krytyczny problem z zabezpieczeniami', 'security', 2, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  `,

  // 12 — profil komputera: zwykły komputer albo kiosk (funkcje kiosku tylko na kioskach) (v0.20.0)
  `
  ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'computer';      -- computer | kiosk
  ALTER TABLE agents ADD COLUMN phone_app INTEGER NOT NULL DEFAULT 0;       -- kiosk: „Zdjęcia z telefonu”
  ALTER TABLE enroll_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'computer';
  `,

  // 13 — kiosk: przycisk „Zakończ i usuń moje dane” (v0.20.0)
  `
  ALTER TABLE agents ADD COLUMN end_button INTEGER NOT NULL DEFAULT 0;
  `,

  // 14 — powód rozłączenia: shutdown / stopped / update (agent się pożegnał) albo lost (zerwane) (v0.20.1)
  `
  ALTER TABLE agents ADD COLUMN offline_reason TEXT;
  `,

  // 15 — kiosk: udział sieciowy folderu Pobrane dla pracowników (v0.21.0)
  `
  ALTER TABLE agents ADD COLUMN share_mode TEXT NOT NULL DEFAULT 'off';   -- off | read | delete
  ALTER TABLE agents ADD COLUMN share_allow TEXT NOT NULL DEFAULT '';     -- adresy/sieci; puste = sieć lokalna
  `,

  // 16 — czat użytkownika komputera ze wsparciem (ikona w zasobniku) (v0.22.0)
  `
  CREATE TABLE chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ts           INTEGER NOT NULL,
    direction    TEXT NOT NULL,      -- in (od użytkownika komputera) | out (od wsparcia)
    author       TEXT NOT NULL,
    user_id      INTEGER,            -- out: konto w panelu
    text         TEXT NOT NULL,
    delivered_at INTEGER,            -- out: doręczone do okna na komputerze
    read_at      INTEGER             -- in: przeczytane w panelu
  );
  CREATE INDEX chat_agent ON chat_messages(agent_id, id DESC);
  `,
];
