import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Stosuje brakujące migracje, każdą w osobnej transakcji. Zwraca bieżącą wersję schematu. */
export function migrate(db: Db): number {
  let version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > MIGRATIONS.length) {
    throw new Error(`Baza ma schemat v${version}, a ta wersja serwera zna tylko v${MIGRATIONS.length} — zaktualizuj serwer.`);
  }
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migracja v${next} nie powiodła się: ${(err as Error).message}`);
    }
    version = next;
  }
  return version;
}

/** Transakcja synchroniczna (node:sqlite jest synchroniczne, więc nic nie wejdzie pomiędzy). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
