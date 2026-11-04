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
];
