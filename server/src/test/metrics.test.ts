import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('metryki: historia ~1/min, dysk = najbardziej zapełniony, downsampling, zakres konta', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { clientId } = await s.createClient(c, 'Firma A');
  const { agentId } = await s.enroll(c);
  await s.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, cookies: c, payload: { clientId } });

  // 40 próbek co 60 s — wszystkie zapisane
  const t0 = Date.now() - 3600_000;
  for (let i = 0; i < 40; i++) {
    s.ctx.metrics.record(agentId, {
      ts: t0 + i * 60_000,
      cpuPercent: i,
      memPercent: 50,
      memUsed: 1000,
      disks: [{ usedPercent: 10 }, { usedPercent: 80 }],
      netRxBps: 100,
      netTxBps: 200,
    });
  }
  // próbka 30 s po ostatniej — poniżej progu, pomijana
  s.ctx.metrics.record(agentId, { ts: t0 + 39 * 60_000 + 30_000, cpuPercent: 999, memPercent: 1, memUsed: 1, disks: [], netRxBps: 0, netTxBps: 0 });

  const res = await s.app.inject({ method: 'GET', url: `/api/agents/${agentId}/metrics?range=24h`, cookies: c });
  assert.equal(res.statusCode, 200);
  const { range, samples } = res.json() as { range: string; samples: { ts: number; cpu: number; disk: number }[] };
  assert.equal(range, '24h');
  assert.equal(samples.length, 40, 'throttling: 30-sekundowa próbka pominięta');
  assert.equal(samples[0].disk, 80, 'dysk = najbardziej zapełniony wolumen');
  assert.ok(samples[0].ts < samples[39].ts, 'próbki rosnąco wg czasu');

  // downsampling: ogranicza liczbę punktów do maxPoints
  const few = s.ctx.metrics.history(agentId, 0, 10);
  assert.ok(few.length > 0 && few.length <= 10, `downsampling: ${few.length} <= 10`);

  // retencja: stara próbka (na osobnym agencie — świeży throttling) jest usuwana
  const { agentId: old } = await s.enroll(c, 'old-pc');
  s.ctx.metrics.record(old, { ts: Date.now() - 30 * 24 * 3600_000, cpuPercent: 1, memPercent: 1, memUsed: 1, disks: [], netRxBps: 0, netTxBps: 0 });
  const removed = s.ctx.metrics.prune();
  assert.ok(removed >= 1, 'prune usuwa próbki starsze niż retencja');

  // zakres konta: technik bez tego klienta dostaje 404
  const scoped = (await s.createMember(c, { username: 'tech-x', role: 'tech', allClients: false, clientIds: [] })).cookies;
  const denied = await s.app.inject({ method: 'GET', url: `/api/agents/${agentId}/metrics?range=24h`, cookies: scoped });
  assert.equal(denied.statusCode, 404, 'poza zakresem konta — 404');
});

test('metryki: zły zakres odrzucony', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId } = await s.enroll(c);
  const bad = await s.app.inject({ method: 'GET', url: `/api/agents/${agentId}/metrics?range=rok`, cookies: c });
  assert.equal(bad.statusCode, 400);
});
