import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeAgent, setup, sleep, until } from './helpers.ts';

async function env() {
  const s = await setup();
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'Kioski');
  await s.app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, cookies: c, payload: { consentMode: 'none' } });
  const { agentId, agentSecret } = await s.enroll(c);
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId } });
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  const chan = { id: 0, open: null as any, data: [] as any[], acks: 0 };
  agent.handlers['desktop.open'] = (d) => {
    chan.id = d.channel;
    chan.open = d;
    setImmediate(() => {
      agent.sendFrame(d.channel, Buffer.concat([Buffer.from('I'), Buffer.from(JSON.stringify({ monitors: [{ index: 0, w: 800, h: 600 }], current: 0 }))]));
      agent.sendFrame(d.channel, Buffer.concat([Buffer.from('F'), Buffer.alloc(30, 7)]));
    });
    return { ok: true };
  };
  agent.handlers['channel.close'] = () => ({ ok: true });
  agent.onFrame = (_ch, payload, kind) => {
    if (kind === 2) chan.acks++;
    else chan.data.push(JSON.parse(payload.toString()));
  };
  await agent.open();
  agent.hello(['desktop.open', 'channel.close']);
  await until(() => (s.ctx.hub.summary(agentId)?.capabilities.length ?? 0) > 0);
  return { s, c, agentId, agent, port, chan, clientId };
}

function openDesktop(port: number, agentId: string, cookies: Record<string, string>, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desktop/${agentId}${query}`, { headers: { cookie: `overvnc_sid=${cookies.overvnc_sid}` } });
  const text: any[] = [];
  const bin: Buffer[] = [];
  ws.on('message', (m, isBinary) => (isBinary ? bin.push(m as Buffer) : text.push(JSON.parse(m.toString()))));
  const status = new Promise<number>((r) => {
    ws.once('open', () => r(101));
    ws.once('unexpected-response', (_q, res) => r(res.statusCode!));
  });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  return { ws, text, bin, status, closed };
}

test('pulpit: klatki do przeglądarki, potwierdzenia do komputera, wejście, zgoda z klienta', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const d = openDesktop(e.port, e.agentId, e.c, '?quality=high&monitor=0');
  assert.equal(await d.status, 101);
  await until(() => d.text.some((m) => m.type === 'ready'));
  assert.equal(e.chan.open.consent, 'none', 'tryb zgody pochodzi z ustawień klienta');
  assert.equal(e.chan.open.quality, 'high');
  assert.equal(e.chan.open.viewer, 'admin');

  await until(() => d.bin.length === 2);
  assert.equal(String.fromCharCode(d.bin[0][0]), 'I');
  assert.equal(String.fromCharCode(d.bin[1][0]), 'F');

  d.ws.send(JSON.stringify({ t: 'ack' }));
  await until(() => e.chan.acks === 1);

  d.ws.send(JSON.stringify({ t: 'm', x: 0.5, y: 0.25 }));
  d.ws.send(JSON.stringify({ t: 'k', code: 'KeyA', d: true }));
  d.ws.send(JSON.stringify({ t: 'k', code: 'KeyA; rm -rf /', d: true })); // odrzucone przez walidację
  d.ws.send(JSON.stringify({ t: 'm', x: 7, y: 0 })); // poza zakresem — odrzucone
  d.ws.send('to nie JSON');
  await until(() => e.chan.data.length >= 2);
  await sleep(50);
  assert.deepEqual(e.chan.data, [
    { t: 'm', x: 0.5, y: 0.25 },
    { t: 'k', code: 'KeyA', d: true },
  ]);

  d.ws.close();
  await e.agent.waitFor((m) => m.type === 'channel.close');
  await until(() => !!e.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'desktop.close'").get());
  const det = JSON.parse((e.s.db.prepare("SELECT details FROM audit_log WHERE action = 'desktop.close'").get() as any).details);
  assert.equal(det.frames, 1);
});

test('pulpit: tryb podglądu blokuje wejście na serwerze (ustawienia nadal działają)', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const d = openDesktop(e.port, e.agentId, e.c, '?viewOnly=1');
  await until(() => d.text.some((m) => m.type === 'ready'));
  assert.equal(e.chan.open.viewOnly, true);
  d.ws.send(JSON.stringify({ t: 'b', x: 0.1, y: 0.1, b: 0, d: true }));
  d.ws.send(JSON.stringify({ t: 'k', code: 'Enter', d: true }));
  d.ws.send(JSON.stringify({ t: 'cfg', quality: 'low' }));
  await until(() => e.chan.data.length === 1);
  await sleep(50);
  assert.deepEqual(e.chan.data, [{ t: 'cfg', quality: 'low' }]);
});

test('pulpit: odmowa zgody przez użytkownika komputera', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  await e.s.app.inject({ method: 'PATCH', url: `/api/clients/${e.clientId}`, cookies: e.c, payload: { consentMode: 'ask' } });
  e.agent.handlers['desktop.open'] = (d) => {
    assert.equal(d.consent, 'ask');
    const err = new Error('użytkownik komputera nie zgodził się na połączenie');
    throw err;
  };
  // FakeAgent zgłasza błędy z kodem 'failed' — symulujemy odpowiedź agenta z kodem consent_denied
  e.agent.handlers['desktop.open'] = undefined as any;
  e.agent.ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(raw.toString());
    if (m.type === 'desktop.open') e.agent.send({ type: 'error', id: m.id, error: { code: 'consent_denied', message: 'odmowa' } });
  });
  const d = openDesktop(e.port, e.agentId, e.c);
  assert.equal(await d.closed, 4400);
  assert.match(d.text.find((m) => m.type === 'closed').message, /nie zgodził się/);
});

test('pulpit: uprawnienia i zakres', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const viewer = (await e.s.createMember(e.c, { username: 'podglad', role: 'viewer' })).cookies;
  assert.equal(await openDesktop(e.port, e.agentId, viewer).status, 403);
  const { clientId } = await e.s.createClient(e.c, 'Inna firma');
  const scoped = (await e.s.createMember(e.c, { username: 'tech-z', role: 'tech', allClients: false, clientIds: [clientId] })).cookies;
  assert.equal(await openDesktop(e.port, e.agentId, scoped).status, 404);
});

test('klienci: tryb zgody — domyślnie notify, walidacja', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'Biuro');
  assert.equal((await s.app.inject({ url: '/api/clients', cookies: c })).json()[0].consentMode, 'notify');
  assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, cookies: c, payload: { consentMode: 'zawsze' } })).statusCode, 400);
});
