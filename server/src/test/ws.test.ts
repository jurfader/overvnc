import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeAgent, setup, until } from './helpers.ts';

test('agent: zły sekret dostaje 401 przed upgrade', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId } = await s.enroll(cookies);
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, 'wrong-secret');
  await assert.rejects(agent.open(), /HTTP 401/);
});

test('agent: hello zapisuje inwentarz i możliwości, metryki trafiają do panelu', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();

  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  t.after(() => agent.close());
  agent.hello(['inventory.refresh']);
  await until(() => s.ctx.hub.summary(agentId)?.agentVersion === 'test');

  const detail = (await s.app.inject({ url: `/api/agents/${agentId}`, cookies })).json();
  assert.equal(detail.online, true);
  assert.equal(detail.hostname, 'fake');
  assert.equal(detail.platform, 'ubuntu 24.04');
  assert.deepEqual(detail.capabilities, ['inventory.refresh']);

  agent.send({ type: 'metrics', data: { cpuPercent: 42 } });
  await until(() => (s.ctx.hub.summary(agentId)?.metrics as any)?.cpuPercent === 42);
});

test('protokół: żądanie -> odpowiedź (odświeżenie inwentarza)', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();

  const agent = new FakeAgent(port, agentId, agentSecret);
  agent.handlers['inventory.refresh'] = () => ({ host: { hostname: 'odswiezony', os: 'linux' } });
  await agent.open();
  t.after(() => agent.close());
  agent.hello();
  await until(() => s.ctx.hub.isOnline(agentId));

  const res = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/refresh`, cookies });
  assert.equal(res.statusCode, 200);
  assert.equal(s.ctx.hub.summary(agentId)?.hostname, 'odswiezony');
});

test('protokół: błąd agenta, timeout, brak możliwości, offline', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();

  // offline
  await assert.rejects(s.ctx.hub.request(agentId, 'x'), { code: 'agent_offline' });

  const agent = new FakeAgent(port, agentId, agentSecret);
  agent.handlers['boom'] = () => {
    throw new Error('nie da się');
  };
  await agent.open();
  t.after(() => agent.close());
  agent.hello(['boom']);
  await until(() => s.ctx.hub.summary(agentId)?.capabilities.length === 1);

  await assert.rejects(s.ctx.hub.request(agentId, 'boom'), { status: 422, message: 'nie da się' });
  await assert.rejects(s.ctx.hub.request(agentId, 'silent', null, { timeoutMs: 50 }), { code: 'agent_timeout' });
  await assert.rejects(s.ctx.hub.request(agentId, 'boom', null, { capability: 'other' }), { code: 'unsupported' });
});

test('protokół: rozłączenie agenta przerywa oczekujące żądania', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  agent.hello();
  await until(() => s.ctx.hub.isOnline(agentId));

  const pending = s.ctx.hub.request(agentId, 'never-answered', null, { timeoutMs: 5000 });
  agent.close();
  await assert.rejects(pending, { code: 'agent_disconnected' });
});

test('usunięcie komputera rozłącza agenta i blokuje ponowne połączenie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  await until(() => s.ctx.hub.isOnline(agentId));

  const closed = agent.closed();
  assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/agents/${agentId}`, cookies })).statusCode, 200);
  assert.equal((await closed).code, 4001);
  await assert.rejects(new FakeAgent(port, agentId, agentSecret).open(), /HTTP 401/);
});

test('panel: WebSocket wymaga sesji i odrzuca obcy Origin', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const port = await s.listen();
  const cookie = `overvnc_sid=${cookies.overvnc_sid}`;

  const connect = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers });
      ws.once('open', () => (ws.close(), resolve(101)));
      ws.once('unexpected-response', (_q, r) => resolve(r.statusCode!));
    });

  assert.equal(await connect({}), 401);
  assert.equal(await connect({ cookie, origin: 'https://evil.example' }), 403);
  assert.equal(await connect({ cookie, origin: `http://127.0.0.1:${port}` }), 101);
});

test('panel: dostaje zdarzenia online/offline na żywo', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();

  const events: any[] = [];
  const panel = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { cookie: `overvnc_sid=${cookies.overvnc_sid}` } });
  panel.on('message', (m) => events.push(JSON.parse(m.toString())));
  await new Promise((r) => panel.once('open', r));
  t.after(() => panel.close());

  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  await until(() => events.some((e) => e.type === 'agent_online' && e.id === agentId));
  agent.close();
  await until(() => events.some((e) => e.type === 'agent_offline' && e.id === agentId));
});
