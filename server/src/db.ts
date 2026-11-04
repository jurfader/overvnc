import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
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
  uses_left  INTEGER,             -- NULL = bez limitu
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
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  actor    TEXT NOT NULL,          -- 'user:<name>', 'agent:<id>', 'system'
  action   TEXT NOT NULL,
  target   TEXT,
  details  TEXT,
  ip       TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts DESC);
`;

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'overvnc.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function audit(
  db: Db,
  actor: string,
  action: string,
  target: string | null = null,
  details: unknown = null,
  ip: string | null = null,
): void {
  db.prepare('INSERT INTO audit_log (ts, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    target,
    details == null ? null : JSON.stringify(details),
    ip,
  );
}
