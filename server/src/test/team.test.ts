import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, setup } from './helpers.ts';

test('role: macierz uprawnień', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const { agentId } = await s.enroll(owner);
  const admin = (await s.createMember(owner, { username: 'adm', role: 'admin' })).cookies;
  const tech = (await s.createMember(owner, { username: 'tech', role: 'tech' })).cookies;
  const viewer = (await s.createMember(owner, { username: 'view', role: 'viewer' })).cookies;

  const status = async (cookies: Record<string, string>, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    (await s.app.inject({ method, url, cookies, payload })).statusCode;

  // podgląd: tylko odczyt
  assert.equal(await status(viewer, 'GET', '/api/agents'), 200);
  assert.equal(await status(viewer, 'GET', `/api/agents/${agentId}`), 200);
  assert.equal(await status(viewer, 'PATCH', `/api/agents/${agentId}`, { label: 'x' }), 403);
  assert.equal(await status(viewer, 'POST', `/api/agents/${agentId}/refresh`), 403);
  assert.equal(await status(viewer, 'GET', '/api/enroll-tokens'), 403);
  assert.equal(await status(viewer, 'GET', '/api/audit'), 403);

  // technik: odświeżanie tak (409 = offline, czyli przeszedł uprawnienia), zarządzanie nie
  assert.equal(await status(tech, 'POST', `/api/agents/${agentId}/refresh`), 409);
  assert.equal(await status(tech, 'DELETE', `/api/agents/${agentId}`), 403);
  assert.equal(await status(tech, 'POST', '/api/clients', { name: 'X' }), 403);

  // administrator: zarządzanie tak, zespół nie
  assert.equal(await status(admin, 'PATCH', `/api/agents/${agentId}`, { label: 'Recepcja' }), 200);
  assert.equal(await status(admin, 'GET', '/api/audit'), 200);
  assert.equal(await status(admin, 'POST', '/api/clients', { name: 'Firma' }), 200);
  assert.equal(await status(admin, 'GET', '/api/users'), 403);

  // /me zwraca uprawnienia do sterowania panelem
  const me = (await s.app.inject({ url: '/api/auth/me', cookies: viewer })).json();
  assert.deepEqual(me.permissions, ['agents.view']);
  assert.equal(me.roleLabel, 'Podgląd');
});

test('nowe konto: hasło tymczasowe wymusza zmianę przed dostępem', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const { temporaryPassword } = (
    await s.app.inject({ method: 'POST', url: '/api/users', cookies: owner, payload: { username: 'nowy', role: 'tech', allClients: true, clientIds: [] } })
  ).json();
  assert.ok(temporaryPassword.length >= 12);

  const { cookies } = await s.loginAs('nowy', temporaryPassword);
  const blocked = await s.app.inject({ url: '/api/agents', cookies });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'password_change_required');

  const short = await s.app.inject({ method: 'POST', url: '/api/auth/password', cookies, payload: { currentPassword: temporaryPassword, newPassword: 'krotkie' } });
  assert.equal(short.statusCode, 400);

  const ok = await s.app.inject({ method: 'POST', url: '/api/auth/password', cookies, payload: { currentPassword: temporaryPassword, newPassword: 'dobre-dlugie-haslo' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await s.app.inject({ url: '/api/agents', cookies })).statusCode, 200);
});

test('ochrona ostatniego właściciela i własnego konta', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const me = (await s.app.inject({ url: '/api/auth/me', cookies: owner })).json();

  const demote = await s.app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, cookies: owner, payload: { role: 'admin' } });
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.json().error, 'last_owner');
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/users/${me.id}`, cookies: owner })).statusCode, 409);
  assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, cookies: owner, payload: { disabled: true } })).statusCode, 409);

  // z drugim właścicielem degradacja jest możliwa
  await s.createMember(owner, { username: 'owner2', role: 'owner' });
  assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, cookies: owner, payload: { role: 'admin' } })).statusCode, 200);
});

test('blokada konta: natychmiast unieważnia sesje i blokuje logowanie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const tech = await s.createMember(owner, { username: 'tech', role: 'tech' });
  assert.equal((await s.app.inject({ url: '/api/agents', cookies: tech.cookies })).statusCode, 200);

  await s.app.inject({ method: 'PATCH', url: `/api/users/${tech.id}`, cookies: owner, payload: { disabled: true } });
  assert.equal((await s.app.inject({ url: '/api/agents', cookies: tech.cookies })).statusCode, 401);
  const relog = await s.loginAs('tech', tech.password);
  assert.equal(relog.res.statusCode, 403);
  assert.equal(relog.res.json().error, 'account_disabled');
});

test('reset hasła przez właściciela daje hasło tymczasowe i wylogowuje', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const tech = await s.createMember(owner, { username: 'tech', role: 'tech' });
  const { temporaryPassword } = (await s.app.inject({ method: 'POST', url: `/api/users/${tech.id}/reset-password`, cookies: owner })).json();
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: tech.cookies })).statusCode, 401);
  assert.equal((await s.loginAs('tech', tech.password)).res.statusCode, 401);
  const relog = await s.loginAs('tech', temporaryPassword);
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: relog.cookies })).json().restriction, 'password_change_required');
});

test('sesje: lista, wylogowanie innej sesji, zmiana hasła wylogowuje pozostałe', async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.login();
  const b = await s.login();
  const list = (await s.app.inject({ url: '/api/auth/sessions', cookies: a })).json();
  assert.equal(list.length, 2);
  assert.equal(list.filter((x: any) => x.current).length, 1);

  const other = list.find((x: any) => !x.current);
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${other.id}`, cookies: a })).statusCode, 200);
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: b })).statusCode, 401);

  const c = await s.login();
  await s.app.inject({ method: 'POST', url: '/api/auth/password', cookies: a, payload: { currentPassword: ADMIN.password, newPassword: 'zupelnie-nowe-haslo' } });
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: c })).statusCode, 401);
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: a })).statusCode, 200, 'bieżąca sesja zostaje');
});

test('zespół: walidacja loginu i duplikaty', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const bad = await s.app.inject({ method: 'POST', url: '/api/users', cookies: owner, payload: { username: 'a b', role: 'tech', allClients: true, clientIds: [] } });
  assert.equal(bad.statusCode, 400);
  const dup = await s.app.inject({ method: 'POST', url: '/api/users', cookies: owner, payload: { username: ADMIN.username, role: 'tech', allClients: true, clientIds: [] } });
  assert.equal(dup.statusCode, 409);
  const badRole = await s.app.inject({ method: 'POST', url: '/api/users', cookies: owner, payload: { username: 'x1', role: 'root', allClients: true, clientIds: [] } });
  assert.equal(badRole.statusCode, 400);
});
