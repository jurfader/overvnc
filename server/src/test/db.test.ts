import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDb } from '../db.ts';
import { MIGRATIONS } from '../migrations.ts';

test('migracje: nowa baza dostaje najnowszy schemat', () => {
  const db = openDb(':memory:');
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, MIGRATIONS.length);
  db.close();
});

test('migracje: ponowne uruchomienie nic nie zmienia', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db), MIGRATIONS.length);
  db.close();
});

test('migracje: baza deweloperska sprzed systemu migracji (user_version 0) jest przyjmowana', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('stary', 'x', 1);
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.equal((db.prepare('SELECT username FROM users').get() as any).username, 'stary');
  db.close();
});

test('migracje: baza z przyszłości (nowszy schemat) jest odrzucana', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), /zaktualizuj serwer/);
  db.close();
});
