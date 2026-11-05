import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('rejestracja: token jednorazowy działa tylko raz', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { token } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: { label: 'x', maxUses: 1 } })).json();
  assert.match(token, /^ovnc_/);

  const first = await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: 'pc1' } });
  assert.equal(first.statusCode, 200);
  assert.match(first.json().agentId, /^[0-9a-f-]{36}$/);

  const second = await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: 'pc2' } });
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().error, 'invalid_token');
});

test('rejestracja: token bez limitu (maxUses: null) działa wielokrotnie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { token } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: { maxUses: null } })).json();
  for (const h of ['a', 'b', 'c']) {
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: h } })).statusCode, 200);
  }
  assert.equal((await s.app.inject({ url: '/api/agents', cookies })).json().length, 3);
});

test('rejestracja: komputer dostaje nazwę wpisaną przy tworzeniu tokenu, kolejne z numerem', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { token } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: { label: 'Kiosk Galeria', maxUses: null } })).json();
  for (const h of ['DESKTOP-A1', 'DESKTOP-B2', 'DESKTOP-C3']) {
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: h } })).statusCode, 200);
  }
  const names = ((await s.app.inject({ url: '/api/agents', cookies })).json() as { hostname: string; label: string }[])
    .map((a) => `${a.hostname}=${a.label}`)
    .sort();
  assert.deepEqual(names, ['DESKTOP-A1=Kiosk Galeria', 'DESKTOP-B2=Kiosk Galeria 2', 'DESKTOP-C3=Kiosk Galeria 3']);

  // token bez nazwy — zostaje nazwa systemowa
  const { token: bare } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: {} })).json();
  await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token: bare, hostname: 'PC-X' } });
  const x = ((await s.app.inject({ url: '/api/agents', cookies })).json() as { hostname: string; label: string }[]).find((a) => a.hostname === 'PC-X');
  assert.equal(x?.label, '');
});

test('rejestracja: wygasły token jest odrzucany', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { token, id } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: {} })).json();
  s.db.prepare('UPDATE enroll_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token } })).statusCode, 403);
});

test('rejestracja: w bazie są tylko skróty tokenu i sekretu', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentSecret, agentId } = await s.enroll(cookies);
  const dump = JSON.stringify([s.db.prepare('SELECT * FROM agents').all(), s.db.prepare('SELECT * FROM enroll_tokens').all()]);
  assert.ok(!dump.includes(agentSecret), 'sekret agenta nie może leżeć w bazie jawnie');
  assert.ok(dump.includes(agentId));
});

test('tokeny: walidacja i usuwanie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const bad = await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: { ttlHours: 0 } });
  assert.equal(bad.statusCode, 400);

  const { id } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies, payload: {} })).json();
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/enroll-tokens/${id}`, cookies })).statusCode, 200);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/enroll-tokens/${id}`, cookies })).statusCode, 404);
});
