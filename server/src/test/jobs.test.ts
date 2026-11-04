import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent, setup, until } from './helpers.ts';

const CAPS = ['script.run', 'script.user', 'screen.message', 'power.reboot', 'inventory.refresh'];

async function env() {
  const s = await setup();
  const c = await s.login();
  const port = await s.listen();
  const connect = async (id: string, secret: string, caps = CAPS, handlers: FakeAgent['handlers'] = {}) => {
    const a = new FakeAgent(port, id, secret);
    Object.assign(a.handlers, handlers);
    await a.open();
    a.hello(caps);
    await until(() => (s.ctx.hub.summary(id)?.capabilities.length ?? 0) > 0);
    return a;
  };
  return { s, c, connect, port };
}

const job = async (e: { s: any; c: any }, id: number) => (await e.s.app.inject({ url: `/api/jobs/${id}`, cookies: e.c })).json();
const create = (e: { s: any; c: any }, body: unknown, cookies = e.c) => e.s.app.inject({ method: 'POST', url: '/api/jobs', cookies, payload: body });

test('zadania: skrypt na komputerze online od razu, na offline — po połączeniu', async (t) => {
  const e = await env();
  const one = await e.s.enroll(e.c);
  const two = await e.s.enroll(e.c);
  const a1 = await e.connect(one.agentId, one.agentSecret);
  const runs: any[] = [];
  a1.handlers['script.run'] = (d) => (runs.push(d), { exitCode: 0, output: 'zażółć\nOK\n', durationMs: 12 });
  t.after(() => (a1.close(), e.s.close()));

  const r = await create(e, { kind: 'script', agentIds: [one.agentId, two.agentId], params: { shell: 'powershell', script: '# komentarz\nGet-Date\n', timeoutSec: 60 } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id;
  await until(async () => (await job(e, id)).counts.ok === 1);
  let j = await job(e, id);
  assert.equal(j.title, 'Get-Date', 'tytuł z pierwszej linii poza komentarzem');
  assert.equal(j.counts.queued, 1, 'drugi komputer czeka');
  assert.equal(j.finishedAt, null);
  assert.equal(runs[0].shell, 'powershell');
  assert.equal(runs[0].asUser, false);
  assert.match(runs[0].runId, /^[A-Za-z0-9_-]{8,}$/);
  const t1 = j.targets.find((x: any) => x.agentId === one.agentId);
  assert.equal(t1.preview, 'OK');
  const out = await e.s.app.inject({ url: `/api/jobs/${id}/output/${one.agentId}`, cookies: e.c });
  assert.equal(out.json().output, 'zażółć\nOK\n');

  // drugi komputer włącza się — dostaje zadanie
  const a2 = await e.connect(two.agentId, two.agentSecret, CAPS, { 'script.run': () => ({ exitCode: 2, output: 'błąd' }) });
  t.after(() => a2.close());
  await until(async () => (await job(e, id)).finishedAt !== null);
  j = await job(e, id);
  assert.deepEqual([j.counts.ok, j.counts.failed], [1, 1]);
  assert.equal(j.targets.find((x: any) => x.agentId === two.agentId).exitCode, 2);
  assert.ok(e.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'job.create' AND details LIKE '%Get-Date%'").get());

  // ponowienie tylko dla nieudanych
  const retry = await e.s.app.inject({ method: 'POST', url: `/api/jobs/${id}/retry`, cookies: e.c });
  assert.equal(retry.statusCode, 200);
  await until(async () => (await job(e, retry.json().id)).finishedAt !== null);
  assert.equal((await job(e, retry.json().id)).total, 1);

  const list = (await e.s.app.inject({ url: '/api/jobs', cookies: e.c })).json();
  assert.equal(list.length, 2);
  const forAgent = (await e.s.app.inject({ url: `/api/jobs?agentId=${one.agentId}`, cookies: e.c })).json();
  assert.equal(forAgent.length, 1);
});

test('zadania: bez czekania komputer offline od razu „nie połączył się”; anulowanie oczekujących', async (t) => {
  const e = await env();
  t.after(() => e.s.close());
  const off = await e.s.enroll(e.c);
  const now = (await create(e, { kind: 'inventory', agentIds: [off.agentId], waitHours: 0 })).json().id;
  const j = await job(e, now);
  assert.equal(j.counts.expired, 1);
  assert.ok(j.finishedAt);

  const later = (await create(e, { kind: 'message', agentIds: [off.agentId], params: { text: 'Przerwa' } })).json().id;
  assert.equal((await job(e, later)).counts.queued, 1);
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/jobs/${later}/cancel`, cookies: e.c })).statusCode, 200);
  const k = await job(e, later);
  assert.equal(k.counts.canceled, 1);
  assert.ok(k.canceledAt && k.finishedAt);
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/jobs/${later}/cancel`, cookies: e.c })).statusCode, 409);
});

test('zadania: skrypt przeżywa rozłączenie — wynik odebrany po ponownym połączeniu', async (t) => {
  const e = await env();
  t.after(() => e.s.close());
  const m = await e.s.enroll(e.c);
  const a = await e.connect(m.agentId, m.agentSecret);
  // brak obsługi script.run — agent „wykonuje” i nie odpowiada
  const id = (await create(e, { kind: 'script', agentIds: [m.agentId], params: { shell: 'sh', script: 'sleep 100', timeoutSec: 600 } })).json().id;
  const sent = await a.waitFor((x) => x.type === 'script.run');
  a.close();
  await until(() => !e.s.ctx.hub.isOnline(m.agentId));
  assert.equal((await job(e, id)).counts.running, 1, 'po rozłączeniu nadal „w trakcie”');

  const b = new FakeAgent(e.port, m.agentId, m.agentSecret);
  const asked: any[] = [];
  b.handlers['script.result'] = (d) => (asked.push(d), { exitCode: 0, output: 'gotowe' });
  await b.open();
  t.after(() => b.close());
  b.hello(CAPS);
  await until(async () => (await job(e, id)).counts.ok === 1);
  assert.equal(asked[0].runId, sent.data.runId);
});

test('zadania: agent nie zna uruchomienia (restart komputera) — wynik utracony', async (t) => {
  const e = await env();
  t.after(() => e.s.close());
  const m = await e.s.enroll(e.c);
  const a = await e.connect(m.agentId, m.agentSecret);
  const id = (await create(e, { kind: 'script', agentIds: [m.agentId], params: { shell: 'sh', script: 'reboot', timeoutSec: 60 } })).json().id;
  await a.waitFor((x) => x.type === 'script.run');
  a.close();
  await until(() => !e.s.ctx.hub.isOnline(m.agentId));
  const b = new FakeAgent(e.port, m.agentId, m.agentSecret);
  await b.open();
  t.after(() => b.close());
  b.hello(CAPS);
  const q = await b.waitFor((x) => x.type === 'script.result');
  b.send({ type: 'error', id: q.id, error: { code: 'unknown_run', message: 'nie znam' } });
  await until(async () => (await job(e, id)).counts.lost === 1);
  assert.match((await job(e, id)).targets[0].error, /ponownie/);
});

test('zadania: „jako użytkownik” wymaga obsługi przez agenta; walidacja, uprawnienia i zakres', async (t) => {
  const e = await env();
  t.after(() => e.s.close());
  const m = await e.s.enroll(e.c);
  const a = await e.connect(m.agentId, m.agentSecret, ['script.run']);
  t.after(() => a.close());
  const id = (await create(e, { kind: 'script', agentIds: [m.agentId], params: { shell: 'cmd', script: 'echo', asUser: true } })).json().id;
  await until(async () => (await job(e, id)).finishedAt !== null);
  const tg = (await job(e, id)).targets[0];
  assert.equal(tg.status, 'failed');
  assert.match(tg.error, /zaktualizuj agenta/);

  assert.equal((await create(e, { kind: 'script', agentIds: [m.agentId], params: { shell: 'cmd', script: '   ' } })).statusCode, 400);
  assert.equal((await create(e, { kind: 'script', agentIds: [m.agentId], params: { shell: 'python', script: 'x' } })).statusCode, 400);
  assert.equal((await create(e, { kind: 'power', agentIds: [], params: { action: 'reboot' } })).statusCode, 400);

  const viewer = (await e.s.createMember(e.c, { username: 'podglad', role: 'viewer' })).cookies;
  assert.equal((await create(e, { kind: 'inventory', agentIds: [m.agentId] }, viewer)).statusCode, 403);
  assert.equal((await e.s.app.inject({ url: '/api/jobs', cookies: viewer })).statusCode, 403);

  const { clientId: other } = await e.s.createClient(e.c, 'Inna firma');
  const scoped = (await e.s.createMember(e.c, { username: 'tech-inny', role: 'tech', allClients: false, clientIds: [other] })).cookies;
  assert.equal((await create(e, { kind: 'inventory', agentIds: [m.agentId] }, scoped)).statusCode, 404);
  assert.deepEqual((await e.s.app.inject({ url: '/api/jobs', cookies: scoped })).json(), []);
  assert.equal((await e.s.app.inject({ url: `/api/jobs/${id}`, cookies: scoped })).statusCode, 404);
});

test('zadania: restart — rozłączenie po poleceniu to sukces', async (t) => {
  const e = await env();
  t.after(() => e.s.close());
  const m = await e.s.enroll(e.c);
  const a = await e.connect(m.agentId, m.agentSecret);
  const id = (await create(e, { kind: 'power', agentIds: [m.agentId], params: { action: 'reboot' }, waitHours: 0 })).json().id;
  await a.waitFor((x) => x.type === 'power.action');
  a.close();
  await until(async () => (await job(e, id)).finishedAt !== null);
  const j = await job(e, id);
  assert.equal(j.counts.ok, 1);
  assert.equal(j.title, 'Restart');
});
