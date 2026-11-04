import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FakeAgent, setup, sleep, until } from './helpers.ts';
import { contentDisposition } from '../routes/files.ts';

const FS_CAPS = ['fs.roots', 'fs.list', 'fs.mkdir', 'fs.rename', 'fs.delete', 'fs.readText', 'fs.writeText', 'fs.read', 'fs.write', 'fs.commit', 'channel.close'];

async function env(overrides = {}) {
  const s = await setup(overrides);
  const cookies = await s.login();
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  agent.handlers['channel.close'] = () => ({ ok: true });
  await agent.open();
  agent.hello(FS_CAPS);
  await until(() => (s.ctx.hub.summary(agentId)?.capabilities.length ?? 0) > 0);
  const base = `http://127.0.0.1:${port}/api/agents/${agentId}`;
  const headers = { cookie: `overvnc_sid=${cookies.overvnc_sid}` };
  return { s, cookies, agentId, agent, base, headers };
}

test('Content-Disposition: polska nazwa i bezpieczny zapas ASCII', () => {
  const h = contentDisposition('zażółć "x".txt');
  assert.match(h, /^attachment; filename="zazolc _x_\.txt"; /);
  assert.match(h, /filename\*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87%20%22x%22\.txt$/);
});

test('pobieranie: strumień, nagłówki, potwierdzenia dla agenta', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const content = randomBytes(200_000);
  const acked = { n: 0 };
  e.agent.onFrame = (_ch, payload, kind) => kind === 2 && (acked.n += payload.readUInt32BE(0));
  e.agent.handlers['fs.read'] = (d) => {
    // dane wysyłamy od razu (zanim serwer dostanie odpowiedź) — serwer musi je zbuforować
    setImmediate(async () => {
      for (let off = 0; off < content.length; off += 65536) e.agent.sendFrame(d.channel, content.subarray(off, off + 65536));
      await until(() => acked.n === content.length, 5000);
      e.agent.send({ type: 'channel.closed', data: { channel: d.channel, exitCode: 0 } });
    });
    return { name: 'raport roczny.pdf', size: content.length };
  };

  const res = await fetch(`${e.base}/files/download?path=${encodeURIComponent('/home/a/raport roczny.pdf')}`, { headers: e.headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(content.length));
  assert.match(res.headers.get('content-disposition')!, /filename\*=UTF-8''raport%20roczny\.pdf/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(content));
  // potwierdzenia płyną po przekazaniu danych do gniazda — mogą dotrzeć tuż po treści
  await until(() => acked.n === content.length, 3000);
  await until(() => !!e.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'fs.download'").get());
});

test('pobieranie: błąd agenta (brak pliku) to zwykła odpowiedź JSON', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  e.agent.handlers['fs.read'] = () => {
    throw new Error('nie istnieje: /brak.txt');
  };
  const res = await fetch(`${e.base}/files/download?path=/brak.txt`, { headers: e.headers });
  assert.equal(res.status, 422);
  assert.match((await res.json()).message, /nie istnieje/);
});

test('pobieranie: anulowanie w przeglądarce zamyka kanał na komputerze', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  e.agent.handlers['fs.read'] = (d) => {
    setImmediate(() => e.agent.sendFrame(d.channel, Buffer.alloc(1000)));
    return { name: 'duzy.iso', size: 10_000_000_000 };
  };
  const ctrl = new AbortController();
  const res = await fetch(`${e.base}/files/download?path=/duzy.iso`, { headers: e.headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read();
  ctrl.abort();
  await e.agent.waitFor((m) => m.type === 'channel.close', 3000);
  await until(() => e.s.ctx.hub.openChannelCount() === 0);
});

/** Agent przyjmujący wysyłany plik; `ack` decyduje, czy potwierdza zapis. */
function receiver(agent: FakeAgent, opts: { ack: boolean }) {
  const st = { data: [] as Buffer[], bytes: 0, channel: 0 };
  agent.handlers['fs.write'] = (d) => ((st.channel = d.channel), { path: `${d.dir}/${d.name}` });
  agent.handlers['fs.commit'] = (d) => {
    if (d.size !== st.bytes) throw new Error('niezgodny rozmiar');
    return { path: '/tmp/plik.bin', size: d.size };
  };
  agent.onFrame = (ch, payload, kind) => {
    if (kind !== 1) return;
    st.data.push(Buffer.from(payload));
    st.bytes += payload.length;
    if (opts.ack) agent.sendAck(ch, payload.length);
  };
  return st;
}

test('wysyłanie: plik trafia do agenta bajt w bajt, zatwierdzenie i dziennik', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const st = receiver(e.agent, { ack: true });
  const body = randomBytes(700_000);
  const res = await fetch(`${e.base}/files/upload?dir=/tmp&name=${encodeURIComponent('faktura 01.pdf')}`, {
    method: 'POST',
    headers: { ...e.headers, 'content-type': 'application/octet-stream' },
    body,
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(Buffer.concat(st.data).equals(body));
  const open = e.agent.received.find((m) => m.type === 'fs.write');
  assert.deepEqual({ dir: open.data.dir, name: open.data.name, size: open.data.size, overwrite: open.data.overwrite }, { dir: '/tmp', name: 'faktura 01.pdf', size: 700_000, overwrite: false });
  assert.ok(e.s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'fs.upload' AND details LIKE '%\"ok\":true%'").get());
});

test('wysyłanie: bez potwierdzeń zapisu serwer wstrzymuje przesyłanie (kontrola przepływu)', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  const st = receiver(e.agent, { ack: false });
  const body = randomBytes(6 * 1024 * 1024);
  const upload = fetch(`${e.base}/files/upload?dir=/tmp&name=duzy.bin`, {
    method: 'POST',
    headers: { ...e.headers, 'content-type': 'application/octet-stream' },
    body,
  });
  await until(() => st.bytes >= 2 * 1024 * 1024, 5000);
  await sleep(300);
  assert.ok(st.bytes < 2.5 * 1024 * 1024, `bez potwierdzeń wysłano ${st.bytes} B — powinno stanąć w okolicy 2 MB`);

  // agent nadrabia zaległe potwierdzenia — transfer rusza i kończy się
  e.agent.onFrame = (ch, payload, kind) => {
    if (kind !== 1) return;
    st.data.push(Buffer.from(payload));
    st.bytes += payload.length;
    e.agent.sendAck(ch, payload.length);
  };
  e.agent.sendAck(st.channel, st.bytes);
  const res = await upload;
  assert.equal(res.status, 200);
  assert.ok(Buffer.concat(st.data).equals(body));
});

test('wysyłanie: błąd zapisu na komputerze (np. brak miejsca) wraca jako 422', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  e.agent.handlers['fs.write'] = (d) => {
    setImmediate(() => e.agent.send({ type: 'channel.closed', data: { channel: d.channel, exitCode: 1, error: 'no space left on device' } }));
    return { path: '/tmp/x' };
  };
  const res = await fetch(`${e.base}/files/upload?dir=/tmp&name=x.bin`, {
    method: 'POST',
    headers: { ...e.headers, 'content-type': 'application/octet-stream' },
    body: randomBytes(3 * 1024 * 1024),
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).message, /no space left/);
});

test('wysyłanie: limit rozmiaru i walidacja nazwy', async (t) => {
  const e = await env({ maxUploadBytes: 1000 });
  t.after(() => (e.agent.close(), e.s.close()));
  const big = await fetch(`${e.base}/files/upload?dir=/tmp&name=a.bin`, {
    method: 'POST',
    headers: { ...e.headers, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(2000),
  });
  assert.equal(big.status, 413);
  const bad = await fetch(`${e.base}/files/upload?dir=/tmp&name=${encodeURIComponent('../etc/passwd')}`, {
    method: 'POST',
    headers: { ...e.headers, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(10),
  });
  assert.equal(bad.status, 400);
});

test('operacje na plikach: przekazanie do agenta, dziennik, uprawnienia', async (t) => {
  const e = await env();
  t.after(() => (e.agent.close(), e.s.close()));
  e.agent.handlers['fs.list'] = (d) => ({ path: d.path, entries: [{ name: 'a.txt', type: 'file' }] });
  e.agent.handlers['fs.delete'] = (d) => ({ deleted: d.paths.length });
  e.agent.handlers['fs.writeText'] = (d) => ({ path: d.path, size: d.content.length, modified: 1 });

  const list = await e.s.app.inject({ url: `/api/agents/${e.agentId}/files?path=/home`, cookies: e.cookies });
  assert.equal(list.json().entries[0].name, 'a.txt');
  const del = await e.s.app.inject({ method: 'POST', url: `/api/agents/${e.agentId}/files/delete`, cookies: e.cookies, payload: { paths: ['/tmp/a', '/tmp/b'] } });
  assert.equal(del.json().deleted, 2);
  const edit = await e.s.app.inject({
    method: 'PUT',
    url: `/api/agents/${e.agentId}/files/text`,
    cookies: e.cookies,
    payload: { path: '/etc/hosts', content: 'x'.repeat(900_000), expectedModified: 5 },
  });
  assert.equal(edit.statusCode, 200, 'edycja ~1 MB mieści się w limicie trasy');
  const actions = (e.s.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'fs.%'").all() as { action: string }[]).map((r) => r.action);
  assert.deepEqual(actions.sort(), ['fs.delete', 'fs.edit']);

  const viewer = (await e.s.createMember(e.cookies, { username: 'podglad', role: 'viewer' })).cookies;
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/files?path=/`, cookies: viewer })).statusCode, 403);
  const { clientId } = await e.s.createClient(e.cookies, 'Inna');
  const scoped = (await e.s.createMember(e.cookies, { username: 'tech-y', role: 'tech', allClients: false, clientIds: [clientId] })).cookies;
  assert.equal((await e.s.app.inject({ url: `/api/agents/${e.agentId}/files?path=/`, cookies: scoped })).statusCode, 404);
});
