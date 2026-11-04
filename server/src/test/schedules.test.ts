import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun } from '../schedules.ts';
import { setup } from './helpers.ts';

const ALL = 0x7f;
const MON = 1;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

test('harmonogram: najbliższe uruchomienie w czasie polskim (zima, lato, zmiana czasu, dni tygodnia)', () => {
  // środa 4.11.2026 23:00 w Polsce (CET) → czwartek 04:00 = 03:00 UTC
  assert.equal(iso(nextRun(Date.parse('2026-11-04T22:00:00Z'), ALL, '04:00')), '2026-11-05T03:00:00.000Z');
  // lato (CEST, UTC+2)
  assert.equal(iso(nextRun(Date.parse('2026-07-01T10:00:00Z'), ALL, '04:00')), '2026-07-02T02:00:00.000Z');
  // jeszcze dziś, jeśli godzina nie minęła
  assert.equal(iso(nextRun(Date.parse('2026-07-01T10:00:00Z'), ALL, '18:30')), '2026-07-01T16:30:00.000Z');
  // tylko poniedziałki: ze środy → poniedziałek 9.11
  assert.equal(iso(nextRun(Date.parse('2026-11-04T10:00:00Z'), MON, '04:00')), '2026-11-09T03:00:00.000Z');
  // dzień zmiany czasu na zimowy (25.10.2026): 04:00 jest już w CET
  assert.equal(iso(nextRun(Date.parse('2026-10-24T22:00:00Z'), ALL, '04:00')), '2026-10-25T03:00:00.000Z');
  // dzień zmiany na letni (29.03.2026): 01:00 jeszcze CET, 04:00 już CEST
  assert.equal(iso(nextRun(Date.parse('2026-03-28T22:00:00Z'), ALL, '01:00')), '2026-03-29T00:00:00.000Z');
  assert.equal(iso(nextRun(Date.parse('2026-03-28T22:00:00Z'), ALL, '04:00')), '2026-03-29T02:00:00.000Z');
  // 02:30 nie istnieje tego dnia — uruchomienie i tak następuje (nie przepada)
  const gap = nextRun(Date.parse('2026-03-28T22:00:00Z'), ALL, '02:30');
  assert.ok(gap && gap > Date.parse('2026-03-29T00:00:00Z') && gap < Date.parse('2026-03-29T02:00:00Z'), iso(gap)!);
  assert.equal(nextRun(Date.now(), 0, '04:00'), null);
});

async function env() {
  const s = await setup();
  const c = await s.login();
  const a = await s.createClient(c, 'BIGFOTO');
  const b = await s.createClient(c, 'Inna firma');
  const k1 = await s.enroll(c);
  const k2 = await s.enroll(c);
  const other = await s.enroll(c);
  for (const [id, cl] of [
    [k1.agentId, a.clientId],
    [k2.agentId, a.clientId],
    [other.agentId, b.clientId],
  ] as const)
    await s.app.inject({ method: 'PATCH', url: `/api/agents/${id}`, cookies: c, payload: { clientId: cl } });
  return { s, c, a: a.clientId, b: b.clientId, k1: k1.agentId, k2: k2.agentId, other: other.agentId };
}

const SCRIPT = { name: 'Czyszczenie kolejki wydruku', shell: 'powershell', body: 'Stop-Service Spooler\nStart-Service Spooler', timeoutSec: 120 };

test('biblioteka skryptów: zapis, zakres klientów, użycie w harmonogramie blokuje usunięcie', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const g = await e.s.app.inject({ method: 'POST', url: '/api/scripts', cookies: e.c, payload: SCRIPT });
  assert.equal(g.statusCode, 200, g.body);
  const own = await e.s.app.inject({ method: 'POST', url: '/api/scripts', cookies: e.c, payload: { ...SCRIPT, name: 'Tylko BIGFOTO', clientId: e.a } });
  assert.equal(own.statusCode, 200);

  // konto klienta: widzi tylko skrypty swojego klienta, nie może tworzyć wspólnych
  const scoped = (await e.s.createMember(e.c, { username: 'bigfoto', role: 'admin', allClients: false, clientIds: [e.a] })).cookies;
  const list = (await e.s.app.inject({ url: '/api/scripts', cookies: scoped })).json();
  assert.deepEqual(
    list.map((x: any) => x.name),
    ['Tylko BIGFOTO'],
  );
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/scripts', cookies: scoped, payload: SCRIPT })).statusCode, 403);
  assert.equal((await e.s.app.inject({ method: 'PUT', url: `/api/scripts/${g.json().id}`, cookies: scoped, payload: SCRIPT })).statusCode, 404);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/scripts', cookies: e.c, payload: { ...SCRIPT, shell: 'python' } })).statusCode, 400);

  const sch = await e.s.app.inject({
    method: 'POST',
    url: '/api/schedules',
    cookies: e.c,
    payload: { name: 'Nocny restart drukarki', kind: 'script', params: { scriptId: g.json().id }, clientId: e.a, target: { type: 'client' }, days: 127, time: '03:00' },
  });
  assert.equal(sch.statusCode, 200, sch.body);
  const del = await e.s.app.inject({ method: 'DELETE', url: `/api/scripts/${g.json().id}`, cookies: e.c });
  assert.equal(del.statusCode, 409);
  assert.match(del.json().message, /Nocny restart drukarki/);
  assert.equal((await e.s.app.inject({ method: 'DELETE', url: `/api/scripts/${own.json().id}`, cookies: e.c })).statusCode, 200);
});

test('harmonogram: cel liczony przy uruchomieniu, uruchomienie o czasie i ręczne, zaległe pominięte', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const sc = (await e.s.app.inject({ method: 'POST', url: '/api/scripts', cookies: e.c, payload: { ...SCRIPT, clientId: e.a } })).json();
  const r = await e.s.app.inject({
    method: 'POST',
    url: '/api/schedules',
    cookies: e.c,
    payload: { name: 'Kolejka wydruku', kind: 'script', params: { scriptId: sc.id }, clientId: e.a, target: { type: 'client' }, days: 127, time: '03:00', waitHours: 2 },
  });
  const sch = r.json();
  assert.equal(sch.targetCount, 2);
  assert.ok(sch.nextRunAt > Date.now());
  assert.equal(sch.scriptName, SCRIPT.name);

  // ręcznie „uruchom teraz” — zadanie z oboma kioskami (offline czekają 2 godz.)
  const run = await e.s.app.inject({ method: 'POST', url: `/api/schedules/${sch.id}/run`, cookies: e.c });
  assert.equal(run.statusCode, 200);
  const job = (await e.s.app.inject({ url: `/api/jobs/${run.json().jobId}`, cookies: e.c })).json();
  assert.equal(job.total, 2);
  assert.equal(job.title, 'Kolejka wydruku');
  assert.equal(job.createdBy, 'harmonogram');
  assert.equal(job.scheduleId, sch.id);
  assert.equal(job.params.script, SCRIPT.body);
  assert.ok(job.expiresAt - job.createdAt >= 2 * 3600_000 - 1000);

  // edycja skryptu w bibliotece obowiązuje w kolejnych uruchomieniach
  await e.s.app.inject({ method: 'PUT', url: `/api/scripts/${sc.id}`, cookies: e.c, payload: { ...SCRIPT, body: 'Restart-Service Spooler', clientId: e.a } });
  // o czasie
  const due = e.s.db.prepare('SELECT next_run_at FROM schedules WHERE id = ?').get(sch.id) as { next_run_at: number };
  e.s.ctx.scheduler.tick(due.next_run_at + 5_000);
  const last = e.s.db.prepare('SELECT last_job_id, next_run_at FROM schedules WHERE id = ?').get(sch.id) as { last_job_id: number; next_run_at: number };
  assert.notEqual(last.last_job_id, run.json().jobId);
  assert.ok(last.next_run_at > due.next_run_at + 23 * 3600_000, 'następne jutro');
  const j2 = (await e.s.app.inject({ url: `/api/jobs/${last.last_job_id}`, cookies: e.c })).json();
  assert.equal(j2.params.script, 'Restart-Service Spooler');

  // serwer był wyłączony 2 godz. — zaległego nie uruchamiamy, tylko przesuwamy
  const jobsBefore = (e.s.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
  e.s.ctx.scheduler.tick(last.next_run_at + 2 * 3600_000);
  assert.equal((e.s.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, jobsBefore);

  // wyłączony harmonogram nie ma następnego uruchomienia
  const off = await e.s.app.inject({
    method: 'PUT',
    url: `/api/schedules/${sch.id}`,
    cookies: e.c,
    payload: { name: 'Kolejka wydruku', kind: 'script', params: { scriptId: sc.id }, clientId: e.a, target: { type: 'client' }, days: 127, time: '03:00', enabled: false },
  });
  assert.equal(off.json().nextRunAt, null);
});

test('harmonogram: walidacja celu i zakres konta klienta', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const base = { name: 'Komunikat', kind: 'message', params: { text: 'Zamykamy o 20:00' }, days: 31, time: '19:45' };
  // komputer innego klienta w harmonogramie klienta A
  const bad = await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: e.a, target: { type: 'agents', agentIds: [e.k1, e.other] } } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: null, target: { type: 'client' } } })).statusCode, 400);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: e.a, target: { type: 'all' } } })).statusCode, 400);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: e.a, target: { type: 'client' }, time: '25:00' } })).statusCode, 400);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: e.a, target: { type: 'client' }, days: 0 } })).statusCode, 400);

  const ok = await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, clientId: e.a, target: { type: 'agents', agentIds: [e.k1] } } });
  assert.equal(ok.statusCode, 200, ok.body);
  const global = await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: e.c, payload: { ...base, name: 'Wszystkie', clientId: null, target: { type: 'all' } } });
  assert.equal(global.json().targetCount, 3);

  const scoped = (await e.s.createMember(e.c, { username: 'bigfoto2', role: 'tech', allClients: false, clientIds: [e.a] })).cookies;
  assert.deepEqual(
    (await e.s.app.inject({ url: '/api/schedules', cookies: scoped })).json().map((x: any) => x.name),
    ['Komunikat'],
  );
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/schedules/${global.json().id}/run`, cookies: scoped })).statusCode, 404);
  assert.equal(
    (await e.s.app.inject({ method: 'POST', url: '/api/schedules', cookies: scoped, payload: { ...base, clientId: e.b, target: { type: 'client' } } })).statusCode,
    403,
  );
  const viewer = (await e.s.createMember(e.c, { username: 'podglad3', role: 'viewer' })).cookies;
  assert.equal((await e.s.app.inject({ url: '/api/schedules', cookies: viewer })).statusCode, 403);
});
