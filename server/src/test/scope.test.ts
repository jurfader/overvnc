import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeAgent, setup, until } from './helpers.ts';

/** Dwóch klientów, po jednym komputerze + komputer bez klienta; technik z dostępem tylko do klienta A. */
async function fixture() {
  const s = await setup();
  const owner = await s.login();
  const A = await s.createClient(owner, 'Firma A', 'Biuro');
  const B = await s.createClient(owner, 'Firma B');
  const pcA = await s.enroll(owner, 'pc-a');
  const pcB = await s.enroll(owner, 'pc-b');
  const pcNone = await s.enroll(owner, 'pc-none');
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${pcA.agentId}`, cookies: owner, payload: { clientId: A.clientId, siteId: A.siteId } });
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${pcB.agentId}`, cookies: owner, payload: { clientId: B.clientId } });
  const tech = await s.createMember(owner, { username: 'tech-a', role: 'tech', allClients: false, clientIds: [A.clientId] });
  const admin = await s.createMember(owner, { username: 'adm-a', role: 'admin', allClients: false, clientIds: [A.clientId] });
  return { s, owner, A, B, pcA, pcB, pcNone, tech: tech.cookies, admin: admin.cookies, techId: tech.id };
}

test('zakres: konto widzi tylko komputery swoich klientów', async (t) => {
  const f = await fixture();
  t.after(f.s.close);
  const list = (await f.s.app.inject({ url: '/api/agents', cookies: f.tech })).json();
  assert.deepEqual(
    list.map((a: any) => a.hostname),
    ['pc-a'],
  );
  assert.equal(list[0].clientName, 'Firma A');
  assert.equal(list[0].siteName, 'Biuro');

  // cudzy i nieprzypisany komputer: 404 (nie zdradzamy istnienia)
  assert.equal((await f.s.app.inject({ url: `/api/agents/${f.pcB.agentId}`, cookies: f.tech })).statusCode, 404);
  assert.equal((await f.s.app.inject({ url: `/api/agents/${f.pcNone.agentId}`, cookies: f.tech })).statusCode, 404);
  assert.equal((await f.s.app.inject({ method: 'POST', url: `/api/agents/${f.pcB.agentId}/refresh`, cookies: f.tech })).statusCode, 404);

  const clients = (await f.s.app.inject({ url: '/api/clients', cookies: f.tech })).json();
  assert.deepEqual(
    clients.map((c: any) => c.name),
    ['Firma A'],
  );

  // właściciel widzi wszystko
  assert.equal((await f.s.app.inject({ url: '/api/agents', cookies: f.owner })).json().length, 3);
});

test('zakres: administrator z ograniczeniem nie przeniesie komputera do cudzego klienta', async (t) => {
  const f = await fixture();
  t.after(f.s.close);
  const move = await f.s.app.inject({ method: 'PATCH', url: `/api/agents/${f.pcA.agentId}`, cookies: f.admin, payload: { clientId: f.B.clientId } });
  assert.equal(move.statusCode, 400);
  const unassign = await f.s.app.inject({ method: 'PATCH', url: `/api/agents/${f.pcA.agentId}`, cookies: f.admin, payload: { clientId: null } });
  assert.equal(unassign.statusCode, 403);
  // operacje globalne (nowy klient, dziennik) wymagają pełnego zakresu
  assert.equal((await f.s.app.inject({ method: 'POST', url: '/api/clients', cookies: f.admin, payload: { name: 'C' } })).statusCode, 403);
  assert.equal((await f.s.app.inject({ url: '/api/audit', cookies: f.admin })).statusCode, 403);
  // token musi wskazywać jego klienta
  assert.equal((await f.s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies: f.admin, payload: {} })).statusCode, 403);
  assert.equal((await f.s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies: f.admin, payload: { clientId: f.A.clientId } })).statusCode, 200);
});

test('zakres: token z klientem przypisuje komputer przy rejestracji', async (t) => {
  const f = await fixture();
  t.after(f.s.close);
  const { token } = (
    await f.s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies: f.owner, payload: { clientId: f.A.clientId, siteId: f.A.siteId } })
  ).json();
  const { agentId } = (await f.s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: 'nowy' } })).json();
  const a = (await f.s.app.inject({ url: `/api/agents/${agentId}`, cookies: f.tech })).json();
  assert.equal(a.clientId, f.A.clientId);
  assert.equal(a.siteId, f.A.siteId);
});

test('zakres: zdarzenia na żywo tylko dla widocznych komputerów; przeniesienie = agent_removed', async (t) => {
  const f = await fixture();
  t.after(f.s.close);
  const port = await f.s.listen();

  const events: any[] = [];
  const panel = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { cookie: `overvnc_sid=${f.tech.overvnc_sid}` } });
  panel.on('message', (m) => events.push(JSON.parse(m.toString())));
  await new Promise((r) => panel.once('open', r));
  t.after(() => panel.close());

  const agentB = new FakeAgent(port, f.pcB.agentId, f.pcB.agentSecret);
  const agentA = new FakeAgent(port, f.pcA.agentId, f.pcA.agentSecret);
  await Promise.all([agentA.open(), agentB.open()]);
  t.after(() => (agentA.close(), agentB.close()));
  agentA.send({ type: 'metrics', data: { cpuPercent: 1 } });
  agentB.send({ type: 'metrics', data: { cpuPercent: 2 } });
  await until(() => events.some((e) => e.type === 'agent_metrics' && e.id === f.pcA.agentId));
  assert.ok(!events.some((e) => e.id === f.pcB.agentId), 'panel technika nie może dostać zdarzeń komputera klienta B');

  // właściciel przenosi pc-a do klienta B -> panel technika dostaje agent_removed
  await f.s.app.inject({ method: 'PATCH', url: `/api/agents/${f.pcA.agentId}`, cookies: f.owner, payload: { clientId: f.B.clientId } });
  await until(() => events.some((e) => e.type === 'agent_removed' && e.id === f.pcA.agentId));
});

test('zakres: zmiana zakresu konta rozłącza jego panel (odświeżenie widoku)', async (t) => {
  const f = await fixture();
  t.after(f.s.close);
  const port = await f.s.listen();
  const panel = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { cookie: `overvnc_sid=${f.tech.overvnc_sid}` } });
  await new Promise((r) => panel.once('open', r));
  const closed = new Promise<number>((r) => panel.once('close', (code) => r(code)));
  await f.s.app.inject({ method: 'PATCH', url: `/api/users/${f.techId}`, cookies: f.owner, payload: { clientIds: [f.A.clientId, f.B.clientId] } });
  assert.equal(await closed, 4003);
  assert.equal((await f.s.app.inject({ url: '/api/agents', cookies: f.tech })).json().length, 2);
});
