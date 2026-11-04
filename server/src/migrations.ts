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
];
