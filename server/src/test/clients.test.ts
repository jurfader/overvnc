import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('klienci: tworzenie, unikalne nazwy (bez względu na wielkość liter), edycja', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'Firma A');
  const dup = await s.app.inject({ method: 'POST', url: '/api/clients', cookies: c, payload: { name: 'firma a' } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error, 'name_taken');
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/clients', cookies: c, payload: { name: '  ' } })).statusCode, 400);
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/clients', cookies: c, payload: { name: 'X', color: 'red' } })).statusCode, 400);

  await s.app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, cookies: c, payload: { name: 'Firma A sp. z o.o.', color: '#E91E8C' } });
  const list = (await s.app.inject({ url: '/api/clients', cookies: c })).json();
  assert.equal(list[0].name, 'Firma A sp. z o.o.');
  assert.equal(list[0].color, '#E91E8C');
});

test('lokalizacje: muszą należeć do klienta komputera', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const A = await s.createClient(c, 'A', 'Kraków');
  const B = await s.createClient(c, 'B', 'Warszawa');
  const { agentId } = await s.enroll(c);

  const wrong = await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId: A.clientId, siteId: B.siteId } });
  assert.equal(wrong.statusCode, 400);
  const ok = await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId: A.clientId, siteId: A.siteId } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().siteName, 'Kraków');

  // zmiana klienta bez lokalizacji czyści lokalizację
  const moved = await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId: B.clientId } });
  assert.equal(moved.json().siteId, null);
});

test('tagi: przypisanie, operacje zbiorcze, usunięcie tagu', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const tag = async (name: string) => (await s.app.inject({ method: 'POST', url: '/api/tags', cookies: c, payload: { name, color: '#22C55E' } })).json().id;
  const serwer = await tag('serwer');
  const vip = await tag('VIP');
  const a1 = (await s.enroll(c, 'a1')).agentId;
  const a2 = (await s.enroll(c, 'a2')).agentId;
  const { clientId } = await s.createClient(c, 'Firma');

  const bulk = await s.app.inject({ method: 'POST', url: '/api/agents/bulk', cookies: c, payload: { ids: [a1, a2], clientId, addTagIds: [serwer, vip] } });
  assert.equal(bulk.json().updated, 2);
  let a = (await s.app.inject({ url: `/api/agents/${a1}`, cookies: c })).json();
  assert.deepEqual(
    a.tags.map((x: any) => x.name),
    ['serwer', 'VIP'],
  );
  assert.equal(a.clientName, 'Firma');

  await s.app.inject({ method: 'POST', url: '/api/agents/bulk', cookies: c, payload: { ids: [a1], removeTagIds: [vip] } });
  a = (await s.app.inject({ url: `/api/agents/${a1}`, cookies: c })).json();
  assert.deepEqual(
    a.tags.map((x: any) => x.name),
    ['serwer'],
  );

  await s.app.inject({ method: 'DELETE', url: `/api/tags/${serwer}`, cookies: c });
  a = (await s.app.inject({ url: `/api/agents/${a1}`, cookies: c })).json();
  assert.deepEqual(a.tags, []);

  assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/agents/${a1}`, cookies: c, payload: { tagIds: [9999] } })).statusCode, 400);
});

test('usunięcie klienta odpina komputery i kasuje lokalizacje', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const A = await s.createClient(c, 'A', 'Biuro');
  const { agentId } = await s.enroll(c);
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId: A.clientId, siteId: A.siteId } });

  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/clients/${A.clientId}`, cookies: c })).statusCode, 200);
  const a = (await s.app.inject({ url: `/api/agents/${agentId}`, cookies: c })).json();
  assert.equal(a.clientId, null);
  assert.equal(a.siteId, null);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM sites').get() as any).n, 0);
});

test('notatki i nazwa komputera', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId } = await s.enroll(c);
  const r = await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { label: 'Recepcja', notes: 'Drukarka na USB' } });
  assert.equal(r.json().label, 'Recepcja');
  assert.equal(r.json().notes, 'Drukarka na USB');
});

test('zmiana klientów/tagów jest rozgłaszana do paneli (org_changed)', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const port = await s.listen();
  const { WebSocket } = await import('ws');
  const events: any[] = [];
  const panel = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { cookie: `overvnc_sid=${c.overvnc_sid}` } });
  panel.on('message', (m) => events.push(JSON.parse(m.toString())));
  await new Promise((r) => panel.once('open', r));
  t.after(() => panel.close());

  await s.app.inject({ method: 'POST', url: '/api/tags', cookies: c, payload: { name: 'nowy' } });
  const { until } = await import('./helpers.ts');
  await until(() => events.some((e) => e.type === 'org_changed'));

  // nieudana zmiana (duplikat) nie rozgłasza
  const before = events.length;
  await s.app.inject({ method: 'POST', url: '/api/tags', cookies: c, payload: { name: 'nowy' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, before);
});
