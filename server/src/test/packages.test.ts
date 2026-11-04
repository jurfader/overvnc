import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FakeAgent, setup, until } from './helpers.ts';

async function env() {
  const s = await setup();
  const c = await s.login();
  const port = await s.listen();
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
  return { s, c, port, a: a.clientId, b: b.clientId, k1, k2, other };
}

/** Wysyła plik kawałkami (tak jak panel), zwraca opis pliku. */
async function upload(e: Awaited<ReturnType<typeof env>>, name: string, data: Buffer, clientId: number | null, chunk = 7) {
  const r = await e.s.app.inject({ method: 'POST', url: '/api/packages', cookies: e.c, payload: { name, size: data.length, clientId } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id;
  let last: any;
  for (let off = 0; off < data.length; off += chunk) {
    const res = await e.s.app.inject({
      method: 'PUT',
      url: `/api/packages/${id}/data?offset=${off}`,
      cookies: e.c,
      headers: { 'content-type': 'application/octet-stream' },
      payload: data.subarray(off, off + chunk),
    });
    assert.equal(res.statusCode, 200, res.body);
    last = res.json();
  }
  return last;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('pliki: wysyłanie kawałkami, wznawianie od właściwego miejsca, suma SHA-256', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const data = randomBytes(30);
  const r = await e.s.app.inject({ method: 'POST', url: '/api/packages', cookies: e.c, payload: { name: 'setup.msi', size: data.length, clientId: e.a } });
  const id = r.json().id;
  assert.equal(r.json().chunkSize, 8 * 1024 * 1024);
  const put = (off: number, part: Buffer) =>
    e.s.app.inject({ method: 'PUT', url: `/api/packages/${id}/data?offset=${off}`, cookies: e.c, headers: { 'content-type': 'application/octet-stream' }, payload: part });
  assert.equal((await put(0, data.subarray(0, 10))).json().received, 10);
  // zły offset (np. powtórzony kawałek) — serwer mówi, ile ma
  const bad = await put(0, data.subarray(0, 10));
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().details.received, 10);
  // za dużo danych
  assert.equal((await put(10, Buffer.concat([data.subarray(10), Buffer.from('x')]))).statusCode, 413);
  const done = (await put(10, data.subarray(10))).json();
  assert.equal(done.ready, true);
  assert.equal(done.sha256, sha(data));
  assert.equal((await put(30, Buffer.from('x'))).statusCode, 409);
  // nazwa z folderem — odrzucona
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/packages', cookies: e.c, payload: { name: '..\\evil.exe', size: 5, clientId: e.a } })).statusCode, 400);
  // konto klienta widzi tylko pliki swojego klienta, nie tworzy wspólnych
  const scoped = (await e.s.createMember(e.c, { username: 'inna', role: 'tech', allClients: false, clientIds: [e.b] })).cookies;
  assert.deepEqual((await e.s.app.inject({ url: '/api/packages', cookies: scoped })).json(), []);
  assert.equal((await e.s.app.inject({ method: 'POST', url: '/api/packages', cookies: scoped, payload: { name: 'a.txt', size: 5, clientId: null } })).statusCode, 403);
});

test('wdrożenie: agent pobiera plik tylko z oczekującym zadaniem, wznawianie (Range), wynik i porządki', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const data = randomBytes(5000);
  const pkg = await upload(e, 'Kiosk Config.json', data, e.a, 2048);
  const agent = new FakeAgent(e.port, e.k1.agentId, e.k1.agentSecret);
  t.after(() => agent.close());
  await agent.open();
  agent.hello(['deploy.run', 'script.run']);
  await until(() => (e.s.ctx.hub.summary(e.k1.agentId)?.capabilities.length ?? 0) > 0);

  // plik innego klienta na komputer innego klienta — odrzucone
  const cross = await e.s.app.inject({
    method: 'POST',
    url: '/api/jobs',
    cookies: e.c,
    payload: { kind: 'deploy', agentIds: [e.other.agentId], params: { packageId: pkg.id, dir: 'C:\\Kiosk' } },
  });
  assert.equal(cross.statusCode, 400);

  const r = await e.s.app.inject({
    method: 'POST',
    url: '/api/jobs',
    cookies: e.c,
    payload: { kind: 'deploy', agentIds: [e.k1.agentId, e.k2.agentId], params: { packageId: pkg.id, dir: 'C:\\Kiosk', script: 'Write-Output ok' } },
  });
  assert.equal(r.statusCode, 200, r.body);
  const jobId = r.json().id;
  const msg = await agent.waitFor((m) => m.type === 'deploy.run');
  assert.equal(msg.data.url, `/api/agent/packages/${pkg.id}`);
  assert.equal(msg.data.sha256, sha(data));
  assert.equal(msg.data.size, data.length);
  assert.equal(msg.data.name, 'Kiosk Config.json');
  assert.equal(msg.data.dir, 'C:\\Kiosk');

  const base = `http://127.0.0.1:${e.port}/api/agent/packages/${pkg.id}`;
  const auth = (a: { agentId: string; agentSecret: string }) => ({ Authorization: `Bearer ${a.agentId}.${a.agentSecret}` });
  const full = await fetch(base, { headers: auth(e.k1) });
  assert.equal(full.status, 200);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
  const part = await fetch(base, { headers: { ...auth(e.k1), Range: 'bytes=4000-' } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(data.subarray(4000)));
  // komputer bez zadania z tym plikiem i brak klucza — odmowa
  assert.equal((await fetch(base, { headers: auth(e.other) })).status, 403);
  assert.equal((await fetch(base)).status, 401);
  // k2 jest offline, ale ma oczekujące zadanie — może pobrać po połączeniu
  assert.equal((await fetch(base, { headers: auth(e.k2) })).status, 200);

  // w trakcie wdrażania pliku nie da się usunąć
  assert.equal((await e.s.app.inject({ method: 'DELETE', url: `/api/packages/${pkg.id}`, cookies: e.c })).statusCode, 409);

  agent.send({ type: 'result', id: msg.id, data: { exitCode: 0, output: 'Zapisano: C:\\Kiosk\\Kiosk Config.json (4.9 KB)\nok\n' } });
  await until(async () => (await e.s.app.inject({ url: `/api/jobs/${jobId}`, cookies: e.c })).json().counts.ok === 1);
  const job = (await e.s.app.inject({ url: `/api/jobs/${jobId}`, cookies: e.c })).json();
  assert.equal(job.title, 'Wdrożenie: Kiosk Config.json');
  // po zakończeniu na k1 — k1 nie może już pobierać
  assert.equal((await fetch(base, { headers: auth(e.k1) })).status, 403);

  await e.s.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, cookies: e.c });
  const del = await e.s.app.inject({ method: 'DELETE', url: `/api/packages/${pkg.id}`, cookies: e.c });
  assert.equal(del.statusCode, 200);
  assert.equal(existsSync(path.join(e.s.ctx.config.packagesDir, `${pkg.id}.bin`)), false);
  assert.ok(e.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'job.create' AND details LIKE '%Kiosk Config.json%'").get());
});

test('wdrożenie: pliku niewysłanego w całości nie da się wdrożyć', async (t) => {
  const e = await env();
  t.after(e.s.close);
  const r = await e.s.app.inject({ method: 'POST', url: '/api/packages', cookies: e.c, payload: { name: 'pol.bin', size: 100, clientId: e.a } });
  const job = await e.s.app.inject({
    method: 'POST',
    url: '/api/jobs',
    cookies: e.c,
    payload: { kind: 'deploy', agentIds: [e.k1.agentId], params: { packageId: r.json().id, dir: '/tmp' } },
  });
  assert.equal(job.statusCode, 409);
});
