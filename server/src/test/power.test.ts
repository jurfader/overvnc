import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent, setup, until } from './helpers.ts';
import { parsePowerPending } from '../hub.ts';

const CAPS = ['power.action', 'power.reboot', 'power.shutdown', 'power.cancel'];

async function env(caps: string[]) {
  const s = await setup();
  const c = await s.login();
  const { agentId, agentSecret } = await s.enroll(c, 'pc');
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  const summary = async () => (await s.app.inject({ url: `/api/agents/${agentId}`, cookies: c })).json().powerPending;
  const power = (payload: object) => s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/power`, cookies: c, payload });
  return { s, c, agentId, agent, summary, power, caps };
}

test('odliczanie: starszy agent — plan z naszego zlecenia, anulowanie, wygaśnięcie po restarcie', async (t) => {
  const e = await env(CAPS);
  t.after(e.s.close);
  e.agent.handlers['power.action'] = () => ({ ok: true });
  e.agent.hello(CAPS);
  await until(() => e.s.ctx.hub.summary(e.agentId)?.capabilities.length === CAPS.length);

  const before = Date.now();
  assert.equal((await e.power({ action: 'reboot', delayMinutes: 15, message: 'Aktualizacja' })).statusCode, 200);
  const p = await e.summary();
  assert.equal(p.action, 'reboot');
  assert.equal(p.message, 'Aktualizacja');
  assert.ok(p.at >= before + 15 * 60_000 && p.at <= Date.now() + 15 * 60_000);

  await e.power({ action: 'cancel' });
  assert.equal(await e.summary(), null);

  // plan po terminie (restart się odbył) — po ponownym połączeniu znika z bazy
  e.s.ctx.hub.setPowerPending(e.agentId, { action: 'reboot', at: Date.now() - 1000, message: '' });
  e.agent.hello(CAPS);
  await until(() => (e.s.db.prepare('SELECT power_pending FROM agents WHERE id = ?').get(e.agentId) as { power_pending: string | null }).power_pending === null);
  e.agent.close();
});

test('odliczanie: nowy agent zgłasza plan sam (zdarzenie i hello), termin zegarem serwera', async (t) => {
  const caps = [...CAPS, 'power.pending'];
  const e = await env(caps);
  t.after(e.s.close);
  e.agent.handlers['power.action'] = (d: { delayMinutes: number }) => {
    // agent: zdarzenie przed odpowiedzią; zegar komputera spieszy się o godzinę — liczy się pozostały czas
    e.agent.send({ type: 'power', data: { pending: { action: 'shutdown', at: Date.now() + 3600_000, remainingSec: d.delayMinutes * 60, message: '' } } });
    return { ok: true };
  };
  e.agent.hello(caps);
  await until(() => e.s.ctx.hub.summary(e.agentId)?.capabilities.includes('power.pending') ?? false);
  await e.power({ action: 'shutdown', delayMinutes: 5 });
  await until(async () => (await e.summary()) !== null);
  const p = await e.summary();
  assert.equal(p.action, 'shutdown');
  assert.ok(Math.abs(p.at - (Date.now() + 5 * 60_000)) < 5000);

  // po ponownym połączeniu agent mówi, że planu już nie ma
  e.agent.hello(caps);
  await until(async () => (await e.summary()) === null);

  // panel widzi zmianę na żywo (agent_updated z planem)
  e.agent.send({ type: 'power', data: { pending: { action: 'reboot', remainingSec: 60 } } });
  await until(async () => (await e.summary())?.action === 'reboot');
  e.agent.close();
});

test('odliczanie: walidacja planu od agenta', () => {
  assert.equal(parsePowerPending(null), null);
  assert.equal(parsePowerPending({ action: 'logoff', remainingSec: 10 }), null);
  assert.equal(parsePowerPending({ action: 'reboot', remainingSec: -1 }), null);
  assert.equal(parsePowerPending({ action: 'reboot', remainingSec: 999_999 }), null);
  assert.deepEqual(parsePowerPending({ action: 'reboot', remainingSec: 90, message: 'x'.repeat(300) }, 1000), { action: 'reboot', at: 91_000, message: 'x'.repeat(200) });
});
