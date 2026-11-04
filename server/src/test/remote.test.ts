import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { FakeAgent, setup, until } from './helpers.ts';

const TERM_CAPS = ['term.open', 'term.resize', 'channel.close', 'proc.list', 'proc.kill', 'svc.list', 'svc.control', 'power.action', 'power.reboot', 'wol.send'];

/** Agent online z obsługą terminala „echo wielkimi literami”. */
async function withAgent(s: Awaited<ReturnType<typeof setup>>, cookies: Record<string, string>, caps = TERM_CAPS) {
  const { agentId, agentSecret } = await s.enroll(cookies);
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  const channels: number[] = [];
  agent.handlers['term.open'] = (d) => (channels.push(d.channel), { shell: d.shell || 'bash', pid: 4242 });
  agent.handlers['term.resize'] = () => ({ ok: true });
  agent.handlers['channel.close'] = () => ({ ok: true });
  agent.onFrame = (ch, payload) => agent.sendFrame(ch, payload.toString().toUpperCase());
  await agent.open();
  agent.hello(caps);
  await until(() => (s.ctx.hub.summary(agentId)?.capabilities.length ?? 0) > 0);
  return { agentId, agent, port, channels };
}

function openTerm(port: number, agentId: string, cookies: Record<string, string>, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${agentId}${query}`, { headers: { cookie: `overvnc_sid=${cookies.overvnc_sid}` } });
  const text: any[] = [];
  const binary: Buffer[] = [];
  ws.on('message', (m, isBinary) => (isBinary ? binary.push(m as Buffer) : text.push(JSON.parse(m.toString()))));
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  const status = new Promise<number>((resolve) => {
    ws.once('open', () => resolve(101));
    ws.once('unexpected-response', (_q, res) => resolve(res.statusCode!));
  });
  return { ws, text, binary, closed, status };
}

test('terminal: otwarcie, dane w obie strony, zmiana rozmiaru, koniec powłoki', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent, port, channels } = await withAgent(s, c);
  t.after(() => agent.close());

  const term = openTerm(port, agentId, c, '?shell=zsh&cols=100&rows=30');
  assert.equal(await term.status, 101);
  await until(() => term.text.some((m) => m.type === 'ready'));
  assert.equal(term.text[0].shell, 'zsh');
  const open = agent.received.find((m) => m.type === 'term.open');
  assert.deepEqual({ cols: open.data.cols, rows: open.data.rows, shell: open.data.shell }, { cols: 100, rows: 30, shell: 'zsh' });

  term.ws.send(Buffer.from('ls -la\n'));
  await until(() => Buffer.concat(term.binary).toString() === 'LS -LA\n');

  term.ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40 }));
  await agent.waitFor((m) => m.type === 'term.resize' && m.data.cols === 140 && m.data.channel === channels[0]);

  // powłoka kończy się po stronie agenta -> panel dostaje 4100
  agent.send({ type: 'channel.closed', data: { channel: channels[0], exitCode: 0 } });
  assert.equal(await term.closed, 4100);
  await until(() => (s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'term.close'").get() as any).n === 1);
  const log = s.db.prepare("SELECT details FROM audit_log WHERE action = 'term.close'").get() as any;
  assert.equal(JSON.parse(log.details).bytesIn, 7);
  assert.equal(s.ctx.hub.openChannelCount(), 0);
});

test('terminal: zamknięcie karty w przeglądarce zamyka powłokę na komputerze', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent, port, channels } = await withAgent(s, c);
  t.after(() => agent.close());
  const term = openTerm(port, agentId, c);
  await until(() => term.text.some((m) => m.type === 'ready'));
  term.ws.close();
  await agent.waitFor((m) => m.type === 'channel.close' && m.data.channel === channels[0]);
  await until(() => s.ctx.hub.openChannelCount() === 0);
});

test('terminal: rozłączenie komputera zamyka sesję w panelu (4102)', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent, port } = await withAgent(s, c);
  const term = openTerm(port, agentId, c);
  await until(() => term.text.some((m) => m.type === 'ready'));
  agent.close();
  assert.equal(await term.closed, 4102);
});

test('terminal: agent nie może pisać do kanału innego agenta', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const a = await withAgent(s, c);
  const { agentId: bId, agentSecret: bSecret } = await s.enroll(c, 'intruz');
  const b = new FakeAgent(a.port, bId, bSecret);
  await b.open();
  t.after(() => (a.agent.close(), b.close()));

  const term = openTerm(a.port, a.agentId, c);
  await until(() => term.text.some((m) => m.type === 'ready'));
  b.sendFrame(a.channels[0], 'rm -rf / # wstrzyknięte');
  a.agent.sendFrame(a.channels[0], 'prawdziwe');
  await until(() => term.binary.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Buffer.concat(term.binary).toString(), 'prawdziwe');
});

test('terminal: uprawnienia, zakres i stan komputera', async (t) => {
  const s = await setup();
  t.after(s.close);
  const owner = await s.login();
  const { agentId, agent, port } = await withAgent(s, owner);
  t.after(() => agent.close());
  const viewer = (await s.createMember(owner, { username: 'podglad', role: 'viewer' })).cookies;
  const { clientId } = await s.createClient(owner, 'Inna firma');
  const scoped = (await s.createMember(owner, { username: 'tech-x', role: 'tech', allClients: false, clientIds: [clientId] })).cookies;

  assert.equal(await openTerm(port, agentId, viewer).status, 403);
  assert.equal(await openTerm(port, agentId, scoped).status, 404);
  const { agentId: offline } = await s.enroll(owner, 'wylaczony');
  assert.equal(await openTerm(port, offline, owner).status, 409);
});

test('procesy: lista i zakończenie (z wpisem w dzienniku), podgląd nie ma dostępu', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent } = await withAgent(s, c);
  t.after(() => agent.close());
  agent.handlers['proc.list'] = () => [{ pid: 10, name: 'chrome', cpu: 12.5 }];
  agent.handlers['proc.kill'] = (d) => {
    if (d.pid === 1) throw new Error('tego procesu nie można zakończyć zdalnie');
    return { ok: true };
  };

  const list = await s.app.inject({ url: `/api/agents/${agentId}/processes`, cookies: c });
  assert.equal(list.json()[0].name, 'chrome');
  const kill = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/processes/10/kill`, cookies: c, payload: { force: true, name: 'chrome' } });
  assert.equal(kill.statusCode, 200);
  const req = agent.received.find((m) => m.type === 'proc.kill');
  assert.deepEqual(req.data, { pid: 10, force: true });
  const entry = s.db.prepare("SELECT details FROM audit_log WHERE action = 'proc.kill'").get() as any;
  assert.equal(JSON.parse(entry.details).name, 'chrome');

  const refused = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/processes/1/kill`, cookies: c, payload: {} });
  assert.equal(refused.statusCode, 422);
  assert.match(refused.json().message, /nie można/);

  const viewer = (await s.createMember(c, { username: 'viewer1', role: 'viewer' })).cookies;
  assert.equal((await s.app.inject({ url: `/api/agents/${agentId}/processes`, cookies: viewer })).statusCode, 403);
});

test('usługi: sterowanie i walidacja nazwy', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent } = await withAgent(s, c);
  t.after(() => agent.close());
  agent.handlers['svc.control'] = () => ({ ok: true });
  const ok = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/services/nginx/restart`, cookies: c });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(agent.received.find((m) => m.type === 'svc.control').data, { name: 'nginx', action: 'restart' });
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/services/nginx/explode`, cookies: c })).statusCode, 400);
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/services/a%20b/stop`, cookies: c })).statusCode, 400);
});

test('zasilanie: tylko akcje obsługiwane przez agenta', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agent } = await withAgent(s, c); // ogłasza tylko power.reboot
  t.after(() => agent.close());
  agent.handlers['power.action'] = () => ({ ok: true });

  const lock = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/power`, cookies: c, payload: { action: 'lock' } });
  assert.equal(lock.statusCode, 501);
  const reboot = await s.app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/power`,
    cookies: c,
    payload: { action: 'reboot', delayMinutes: 5, message: 'Aktualizacja' },
  });
  assert.equal(reboot.statusCode, 200);
  assert.deepEqual(agent.received.find((m) => m.type === 'power.action').data, { action: 'reboot', delayMinutes: 5, message: 'Aktualizacja' });
  assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'power.reboot'").get());
  const bad = await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/power`, cookies: c, payload: { action: 'reboot', delayMinutes: 99999 } });
  assert.equal(bad.statusCode, 400);
});

test('Wake-on-LAN: przekaźnik z tej samej sieci wysyła pakiet', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const relay = await withAgent(s, c);
  t.after(() => relay.agent.close());
  let wol: any = null;
  relay.agent.handlers['wol.send'] = (d) => ((wol = d), { sent: 4 });

  const { agentId: target } = await s.enroll(c, 'wylaczony');
  const inv = (name: string, ip: string, mac: string) => JSON.stringify({ network: [{ name, mac, addrs: [`${ip}/24`] }] });
  s.db.prepare('UPDATE agents SET inventory_json = ?, last_ip = ? WHERE id = ?').run(inv('eth0', '192.168.10.20', 'AA:BB:CC:00:11:22'), '83.1.2.3', target);
  s.db.prepare('UPDATE agents SET inventory_json = ?, last_ip = ? WHERE id = ?').run(inv('eth0', '192.168.10.5', '11:22:33:44:55:66'), '83.1.2.3', relay.agentId);

  const preview = (await s.app.inject({ url: `/api/agents/${target}/wake`, cookies: c })).json();
  assert.equal(preview.possible, true);
  assert.equal(preview.relay.id, relay.agentId);

  const res = await s.app.inject({ method: 'POST', url: `/api/agents/${target}/wake`, cookies: c });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(wol, { macs: ['aa:bb:cc:00:11:22'], broadcasts: ['192.168.10.255'] });

  // komputer, który nigdy nie przesłał inwentarza -> nieznany MAC
  const { agentId: fresh } = await s.enroll(c, 'nowy');
  const noMac = await s.app.inject({ method: 'POST', url: `/api/agents/${fresh}/wake`, cookies: c });
  assert.equal(noMac.json().error, 'no_mac');
  assert.equal((await s.app.inject({ url: `/api/agents/${fresh}/wake`, cookies: c })).json().reason, 'no_mac');

  // inny publiczny IP i brak wspólnego klienta -> brak przekaźnika
  s.db.prepare('UPDATE agents SET last_ip = ? WHERE id = ?').run('5.6.7.8', relay.agentId);
  const none = await s.app.inject({ method: 'POST', url: `/api/agents/${target}/wake`, cookies: c });
  assert.equal(none.statusCode, 409);
  assert.equal(none.json().error, 'no_relay');
});
