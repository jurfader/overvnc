import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, setup } from './helpers.ts';

test('logowanie: poprawne dane ustawiają ciasteczko httpOnly + SameSite=Strict', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { username: 'admin' });
  const cookie = res.cookies.find((c) => c.name === 'overvnc_sid')!;
  assert.ok(cookie.httpOnly);
  assert.equal(cookie.sameSite, 'Strict');
});

test('logowanie: złe hasło i nieistniejący login dają ten sam błąd 401', async (t) => {
  const s = await setup();
  t.after(s.close);
  const bad = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' } });
  const ghost = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'nope' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(ghost.statusCode, 401);
  assert.equal(bad.json().error, ghost.json().error);
});

test('logowanie: walidacja danych wejściowych zwraca 400 validation', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: '' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation');
  assert.ok(Array.isArray(res.json().details));
});

test('logowanie: limit 10 prób na IP', async (t) => {
  const s = await setup();
  t.after(s.close);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'x' } });
    statuses.push(r.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
});

test('API bez sesji zwraca 401, a po wylogowaniu sesja jest unieważniona', async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await s.app.inject({ url: '/api/agents' })).statusCode, 401);

  const cookies = await s.login();
  assert.equal((await s.app.inject({ url: '/api/agents', cookies })).statusCode, 200);

  await s.app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
  assert.equal((await s.app.inject({ url: '/api/agents', cookies })).statusCode, 401);
});

test('nagłówki bezpieczeństwa są ustawione', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await s.app.inject({ url: '/api/auth/me' });
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
});
