import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import type { PushMessage } from '../notify.ts';

const TOKEN = 'a'.repeat(30);
const USER = 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG';

async function env() {
  const s = await setup();
  const c = await s.login();
  const A = await s.createClient(c, 'Firma A');
  const B = await s.createClient(c, 'Firma B');
  const pcA = await s.enroll(c, 'pc-a');
  const pcB = await s.enroll(c, 'pc-b');
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${pcA.agentId}`, cookies: c, payload: { clientId: A.clientId } });
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${pcB.agentId}`, cookies: c, payload: { clientId: B.clientId } });
  const sent: PushMessage[] = [];
  s.ctx.notifier.transport = async (_cfg, msg) => void sent.push(msg);
  const open = async (cookies = c) => (await s.app.inject({ url: '/api/alerts?state=open', cookies })).json() as any[];
  return { s, c, A, B, a: pcA.agentId, b: pcB.agentId, sent, open };
}

const rule = (s: any, kind: string) => (s.db.prepare('SELECT id FROM alert_rules WHERE kind = ?').get(kind) as { id: number }).id;

test('alerty: procesor — warunek musi trwać nieprzerwanie, histereza przy zamykaniu', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const E = e.s.ctx.alerts;
  const t0 = Date.now();
  // domyślna reguła: procesor ≥ 95% przez 15 min
  E.onMetrics(e.a, { cpuPercent: 97 }, t0);
  E.onMetrics(e.a, { cpuPercent: 50 }, t0 + 5 * 60_000); // przerwa — liczenie od nowa
  E.onMetrics(e.a, { cpuPercent: 97 }, t0 + 10 * 60_000);
  E.onMetrics(e.a, { cpuPercent: 97 }, t0 + 20 * 60_000);
  assert.equal((await e.open()).length, 0, '10 min ciągłego obciążenia to za mało');
  E.onMetrics(e.a, { cpuPercent: 98 }, t0 + 25 * 60_000);
  const [al] = await e.open();
  assert.equal(al.kind, 'cpu');
  assert.equal(al.title, 'Wysokie obciążenie procesora');
  assert.equal(al.startedAt, t0 + 10 * 60_000, 'alert liczony od początku ciągłego obciążenia');
  assert.equal(al.hostname, 'pc-a');

  E.onMetrics(e.a, { cpuPercent: 93 }, t0 + 26 * 60_000); // poniżej progu, ale w histerezie
  assert.equal((await e.open()).length, 1);
  E.onMetrics(e.a, { cpuPercent: 40 }, t0 + 27 * 60_000);
  assert.equal((await e.open()).length, 0);
  const hist = (await e.s.app.inject({ url: '/api/alerts?state=all', cookies: e.c })).json();
  assert.ok(hist[0].resolvedAt >= t0 + 27 * 60_000);
});

test('alerty: dysk — najbardziej zapełniony wolumen w opisie', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const t0 = Date.now();
  const m = { disks: [{ mountpoint: 'C:\\', usedPercent: 60 }, { mountpoint: 'D:\\', usedPercent: 96 }] };
  e.s.ctx.alerts.onMetrics(e.a, m, t0);
  e.s.ctx.alerts.onMetrics(e.a, m, t0 + 5 * 60_000);
  const [al] = await e.open();
  assert.equal(al.kind, 'disk');
  assert.equal(al.detail, 'D:\\');
  assert.equal(al.value, 96);
});

test('alerty: offline po czasie z reguły, z karencją po starcie serwera; połączenie zamyka alert', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const E = e.s.ctx.alerts;
  const start = Date.now();
  e.s.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(start - 3600_000, e.a);
  E.tick(start + 5 * 60_000);
  assert.equal((await e.open()).length, 0, 'karencja: serwer działa dopiero 5 min');
  E.tick(start + 11 * 60_000);
  const [al] = await e.open();
  assert.equal(al.kind, 'offline');
  assert.equal(al.agentId, e.a);
  assert.equal(al.startedAt, start - 3600_000, 'alert od ostatniego kontaktu');
  // komputer, który nigdy się nie połączył, nie generuje alertu
  assert.ok(!(await e.open()).some((x) => x.agentId === e.b));
  E.onConnected(e.a);
  assert.equal((await e.open()).length, 0);
});

test('powiadomienia: Pushover zaszyfrowany, grupowanie wielu alertów w jedną wiadomość', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const put = await e.s.app.inject({ method: 'PUT', url: '/api/settings/notifications', cookies: e.c, headers: { host: 'vnc.example.com' }, payload: { token: TOKEN, user: USER } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().pushover, { configured: true, userHint: `…${USER.slice(-4)}` });
  const stored = (e.s.db.prepare("SELECT value FROM settings WHERE key = 'notify.pushover'").get() as { value: string }).value;
  assert.ok(!stored.includes(TOKEN) && !stored.includes(USER), 'klucze w bazie tylko zaszyfrowane');
  // GET nie zwraca sekretów
  assert.ok(!JSON.stringify((await e.s.app.inject({ url: '/api/settings/notifications', cookies: e.c })).json()).includes(USER));

  const t0 = Date.now();
  const full = { disks: [{ mountpoint: '/', usedPercent: 99 }] };
  for (const id of [e.a, e.b]) {
    e.s.ctx.alerts.onMetrics(id, full, t0);
    e.s.ctx.alerts.onMetrics(id, full, t0 + 5 * 60_000);
  }
  await e.s.ctx.notifier.flush();
  assert.equal(e.sent.length, 1, 'dwa alerty naraz = jedno powiadomienie');
  assert.match(e.sent[0].title, /2 powiadomień/);
  assert.match(e.sent[0].message, /pc-a \(Firma A\): Prawie pełny dysk/);

  // pojedynczy alert: pełna treść i link do komputera
  e.sent.length = 0;
  e.s.ctx.alerts.onMetrics(e.a, { disks: [{ mountpoint: '/', usedPercent: 10 }] }, t0 + 6 * 60_000);
  await e.s.ctx.notifier.flush();
  assert.equal(e.sent.length, 1);
  assert.match(e.sent[0].title, /pc-a \(Firma A\): Prawie pełny dysk — koniec/);
  assert.equal(e.sent[0].url, `http://vnc.example.com/#/m/${e.a}`);
});

test('powiadomienia: walidacja kluczy, test wysyłki i błąd Pushovera', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const bad = await e.s.app.inject({ method: 'PUT', url: '/api/settings/notifications', cookies: e.c, payload: { token: 'krotki', user: USER } });
  assert.equal(bad.statusCode, 400);
  // test bez konfiguracji
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/settings/notifications/test', cookies: e.c })).statusCode, 422);
  await e.s.app.inject({ method: 'PUT', url: '/api/settings/notifications', cookies: e.c, payload: { token: TOKEN, user: USER } });
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/settings/notifications/test', cookies: e.c })).statusCode, 200);
  assert.match(e.sent[0].title, /testowe/);
  e.s.ctx.notifier.transport = async () => {
    throw new Error('user identifier is invalid');
  };
  const fail = await e.s.app.inject({ method: 'POST', url: '/api/settings/notifications/test', cookies: e.c });
  assert.equal(fail.statusCode, 422);
  assert.match(fail.json().message, /user identifier is invalid/);
  // usunięcie konfiguracji
  const cleared = await e.s.app.inject({ method: 'PUT', url: '/api/settings/notifications', cookies: e.c, payload: { clear: true } });
  assert.equal(cleared.json().pushover.configured, false);
});

test('alerty: zakres konta, potwierdzanie, uprawnienia do reguł', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const t0 = Date.now();
  const full = { disks: [{ mountpoint: '/', usedPercent: 99 }] };
  for (const id of [e.a, e.b]) {
    e.s.ctx.alerts.onMetrics(id, full, t0);
    e.s.ctx.alerts.onMetrics(id, full, t0 + 5 * 60_000);
  }
  const tech = (await e.s.createMember(e.c, { username: 'tech-a', role: 'tech', allClients: false, clientIds: [e.A.clientId] })).cookies;
  const viewer = (await e.s.createMember(e.c, { username: 'podglad', role: 'viewer' })).cookies;
  const mine = await e.open(tech);
  assert.deepEqual(mine.map((x) => x.hostname), ['pc-a'], 'konto widzi tylko alerty swoich komputerów');
  const other = (await e.open()).find((x) => x.agentId === e.b)!;
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/alerts/${other.id}/ack`, cookies: tech })).statusCode, 404);
  assert.equal((await e.s.app.inject({ method: 'POST', url: `/api/alerts/${mine[0].id}/ack`, cookies: viewer })).statusCode, 403);
  const acked = await e.s.app.inject({ method: 'POST', url: `/api/alerts/${mine[0].id}/ack`, cookies: tech });
  assert.equal(acked.statusCode, 200);
  assert.equal(acked.json().ackBy, 'tech-a');

  // reguły: tylko pełny zakres
  const scopedAdmin = (await e.s.createMember(e.c, { username: 'adm-a', role: 'admin', allClients: false, clientIds: [e.A.clientId] })).cookies;
  assert.equal((await e.s.app.inject({ url: '/api/alert-rules', cookies: scopedAdmin })).statusCode, 403);
  assert.equal((await e.s.app.inject({ url: '/api/alert-rules', cookies: tech })).statusCode, 403);
  const invalid = await e.s.app.inject({ method: 'POST', url: '/api/alert-rules', cookies: e.c, payload: { name: 'X', kind: 'offline', durationMin: 0 } });
  assert.equal(invalid.statusCode, 400);

  // wyłączenie reguły zamyka jej otwarte alerty
  const diskRule = rule(e.s, 'disk');
  const r = await e.s.app.inject({
    method: 'PUT',
    url: `/api/alert-rules/${diskRule}`,
    cookies: e.c,
    payload: { name: 'Prawie pełny dysk', kind: 'disk', threshold: 90, durationMin: 5, clientId: null, enabled: false, notify: true },
  });
  assert.equal(r.statusCode, 200);
  assert.equal((await e.open()).length, 0);

  // reguła tylko dla klienta B
  const created = await e.s.app.inject({
    method: 'POST',
    url: '/api/alert-rules',
    cookies: e.c,
    payload: { name: 'Dysk B', kind: 'disk', threshold: 50, durationMin: 0, clientId: e.B.clientId },
  });
  assert.equal(created.statusCode, 200);
  for (const id of [e.a, e.b]) e.s.ctx.alerts.onMetrics(id, full, t0 + 10 * 60_000);
  assert.deepEqual((await e.open()).map((x) => x.hostname), ['pc-b']);
  assert.equal((await e.s.app.inject({ method: 'DELETE', url: `/api/alert-rules/${created.json().id}`, cookies: e.c })).statusCode, 200);
  assert.equal((await e.open()).length, 0, 'usunięcie reguły zamyka jej alerty');
});
