import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent, setup, until } from './helpers.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

async function env(consentMode: 'none' | 'notify' | 'ask' = 'none') {
  const s = await setup();
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'Kioski');
  await s.app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, cookies: c, payload: { consentMode } });
  const { agentId, agentSecret } = await s.enroll(c);
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId } });
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  const calls = { capture: [] as any[], message: [] as any[] };
  agent.handlers['screen.capture'] = (d) => {
    calls.capture.push(d);
    return { jpeg: JPEG.toString('base64'), w: 640, h: 360, ts: Date.now() };
  };
  agent.handlers['screen.message'] = (d) => {
    calls.message.push(d);
    return { ok: true };
  };
  await agent.open();
  agent.hello(['screen.capture', 'screen.message']);
  await until(() => (s.ctx.hub.summary(agentId)?.capabilities.length ?? 0) > 0);
  return { s, c, agentId, agent, calls, clientId };
}

test('kiosk: zrzut ekranu — JPEG, pamięć podręczna i łączenie równoczesnych żądań', async (t) => {
  const e = await env('none');
  t.after(() => (e.agent.close(), e.s.close()));
  const [a, b] = await Promise.all([
    e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot?w=480`, cookies: e.c }),
    e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot?w=480`, cookies: e.c }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers['content-type'], 'image/jpeg');
  assert.equal(a.headers['x-screen-size'], '640x360');
  assert.deepEqual(a.rawPayload, JPEG);
  assert.deepEqual(b.rawPayload, JPEG);
  // trzecie żądanie w ciągu 2 s — z pamięci podręcznej
  await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot?w=480`, cookies: e.c });
  assert.equal(e.calls.capture.length, 1, 'agent dostał jedno polecenie zrzutu');
  assert.deepEqual(e.calls.capture[0], { maxWidth: 480 });
  // dziennik: jeden wpis mimo kilku podglądów
  const n = (e.s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'screen.view'").get() as { n: number }).n;
  assert.equal(n, 1);
  // zła szerokość
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot?w=99999`, cookies: e.c })).statusCode, 400);
});

test('kiosk: zrzut bez powiadomienia tylko przy trybie zgody „Bez komunikatu”', async (t) => {
  const e = await env('notify');
  t.after(() => (e.agent.close(), e.s.close()));
  const r = await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot`, cookies: e.c });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'consent_required');
  // komputer bez klienta — też chroniony
  await e.s.app.inject({ method: 'PATCH', url: `/api/agents/${e.agentId}`, cookies: e.c, payload: { clientId: null } });
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot`, cookies: e.c })).statusCode, 403);
  assert.equal(e.calls.capture.length, 0, 'agent nie dostał polecenia zrzutu');
});

test('kiosk: komunikat na ekranie — treść do agenta, dziennik, walidacja, uprawnienia i zakres', async (t) => {
  const e = await env('none');
  t.after(() => (e.agent.close(), e.s.close()));
  const ok = await e.s.app.inject({
    method: 'POST',
    url: `/api/agents/${e.agentId}/message`,
    cookies: e.c,
    payload: { text: 'Przerwa techniczna do 14:00', title: 'BIGFOTO', seconds: 120 },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(e.calls.message[0], { text: 'Przerwa techniczna do 14:00', title: 'BIGFOTO', seconds: 120 });
  const row = e.s.db.prepare("SELECT details FROM audit_log WHERE action = 'screen.message'").get() as { details: string };
  assert.match(row.details, /Przerwa techniczna/);
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/agents/${e.agentId}/message`, cookies: e.c, payload: { text: '   ' } })).statusCode, 400);

  const viewer = (await e.s.createMember(e.c, { username: 'podglad', role: 'viewer' })).cookies;
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot`, cookies: viewer })).statusCode, 403);
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/agents/${e.agentId}/message`, cookies: viewer, payload: { text: 'x' } })).statusCode, 403);
  const { clientId: other } = await e.s.createClient(e.c, 'Inna firma');
  const scoped = (await e.s.createMember(e.c, { username: 'tech-inny', role: 'tech', allClients: false, clientIds: [other] })).cookies;
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/screenshot`, cookies: scoped })).statusCode, 404);
});

test('kiosk: agent bez obsługi zrzutów — czytelny błąd', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'K');
  await s.app.inject({ method: 'PATCH', url: `/api/clients/${clientId}`, cookies: c, payload: { consentMode: 'none' } });
  const { agentId, agentSecret } = await s.enroll(c);
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId } });
  const agent = new FakeAgent(await s.listen(), agentId, agentSecret);
  t.after(() => agent.close());
  await agent.open();
  agent.hello(['proc.list']);
  await until(() => (s.ctx.hub.summary(agentId)?.capabilities.length ?? 0) > 0);
  const r = await s.app.inject({ url: `/api/agents/${agentId}/screenshot`, cookies: c });
  assert.equal(r.statusCode, 501);
});
