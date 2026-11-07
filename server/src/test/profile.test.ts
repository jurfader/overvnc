import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent, setup, until } from './helpers.ts';

test('kiosk: token „Dodaj kiosk” rejestruje kiosk, profil trafia do agenta po połączeniu i po zmianie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { token } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies: c, payload: { label: 'Kiosk Galeria', kind: 'kiosk' } })).json();
  const tokens = (await s.app.inject({ url: '/api/enroll-tokens', cookies: c })).json() as { kind: string }[];
  assert.equal(tokens[0].kind, 'kiosk');
  const reg = (await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: 'KIOSK-01', os: 'windows', arch: 'amd64' } })).json();
  const agentId = reg.agentId as string;
  assert.equal(s.ctx.hub.summary(agentId)?.kind, 'kiosk');
  assert.equal(s.ctx.hub.summary(agentId)?.phoneApp, false);

  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, reg.agentSecret);
  const got: unknown[] = [];
  agent.handlers['agent.profile'] = (d) => {
    got.push(d);
    return { ok: true, note: (d as { phoneApp: boolean }).phoneApp ? 'Tryb kiosku zaktualizowany' : '' };
  };
  await agent.open();
  agent.hello(['agent.profile']);
  await until(() => got.length === 1);
  assert.deepEqual(got[0], { kiosk: true, phoneApp: false, endButton: false });

  const res = (await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { phoneApp: true } })).json();
  assert.equal(res.phoneApp, true);
  assert.equal(res.profileNote, 'Tryb kiosku zaktualizowany');
  assert.deepEqual(got[1], { kiosk: true, phoneApp: true, endButton: false });

  // przycisk „Zakończ i usuń moje dane”
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { endButton: true } });
  assert.deepEqual(got[2], { kiosk: true, phoneApp: true, endButton: true });
  // klient zakończył sesję — wpis w dzienniku; nieznane zdarzenia agenta są pomijane
  agent.send({ type: 'audit', data: { action: 'kiosk.session_end', details: { uwf: true } } });
  agent.send({ type: 'audit', data: { action: 'user.create', details: {} } });
  await until(() => !!s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'kiosk.session_end'").get());
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor LIKE 'agent:%' AND action = 'user.create'").get()!.n, 0);

  // zwykły komputer: funkcje kiosku wyłączone niezależnie od przełącznika
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { kind: 'computer' } });
  assert.deepEqual(got[3], { kiosk: false, phoneApp: false, endButton: false });
  // ta sama wartość — bez ponownego wysyłania
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { kind: 'computer', label: 'X' } });
  assert.equal(got.length, 4);
  agent.close();
});

test('kiosk: zwykły token rejestruje zwykły komputer', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId } = await s.enroll(c, 'pc');
  assert.equal(s.ctx.hub.summary(agentId)?.kind, 'computer');
});
