import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent, setup, until } from './helpers.ts';
import type { PushMessage } from '../notify.ts';

test('czat: wiadomość od użytkownika komputera, nieprzeczytane, odpowiedź doręczona od razu i po połączeniu', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agentSecret } = await s.enroll(c, 'biuro');
  const pushes: PushMessage[] = [];
  s.ctx.notifier.transport = async (_cfg, msg) => void pushes.push(msg);
  await s.app.inject({ method: 'PUT', url: '/api/settings/notifications', cookies: c, headers: { host: 'vnc.example.com' }, payload: { token: 'a'.repeat(30), user: 'u'.repeat(30) } });
  const port = await s.listen();

  // komputer offline: odpowiedź czeka
  const pending = (await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/chat`, cookies: c, payload: { text: 'Dzień dobry, w czym pomóc?' } })).json();
  assert.equal(pending.direction, 'out');
  assert.equal(pending.deliveredAt, null);

  const agent = new FakeAgent(port, agentId, agentSecret);
  const got: unknown[] = [];
  agent.handlers['chat.send'] = (d) => (got.push(d), { delivered: false });
  await agent.open();
  agent.hello(['chat.send']);
  // po połączeniu: zaległa wiadomość doręczona
  await until(() => got.length === 1);
  assert.equal((got[0] as { text: string }).text, 'Dzień dobry, w czym pomóc?');
  await until(() => !!(s.db.prepare("SELECT delivered_at FROM chat_messages WHERE direction = 'out'").get() as { delivered_at: number | null }).delivered_at);

  // użytkownik pisze z okna czatu
  agent.send({ type: 'chat', data: { from: 'user', author: 'anna', text: 'Nie drukuje drukarka', ts: Date.now() } });
  await until(() => (s.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE direction = 'in'").get() as { n: number }).n === 1);
  const unread = (await s.app.inject({ url: '/api/chat/unread', cookies: c })).json() as { agentId: string; count: number }[];
  assert.deepEqual(
    unread.map((u) => [u.agentId, u.count]),
    [[agentId, 1]],
  );
  await s.ctx.notifier.flush();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /fake: wiadomość \(anna\)/);

  // przeczytane w panelu
  await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/chat/read`, cookies: c });
  assert.deepEqual((await s.app.inject({ url: '/api/chat/unread', cookies: c })).json(), []);

  // odpowiedź przy połączonym komputerze — od razu
  const now = (await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/chat`, cookies: c, payload: { text: 'Już się łączę' } })).json();
  assert.ok(now.deliveredAt);
  const list = (await s.app.inject({ url: `/api/agents/${agentId}/chat`, cookies: c })).json().items as { direction: string; text: string }[];
  assert.deepEqual(
    list.map((m) => `${m.direction}:${m.text}`),
    ['out:Dzień dobry, w czym pomóc?', 'in:Nie drukuje drukarka', 'out:Już się łączę'],
  );
  agent.close();
});

test('czat: konto podglądu (viewer) czyta, ale nie pisze', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId } = await s.enroll(c, 'pc');
  const { cookies: viewer } = await s.createMember(c, { username: 'podglad', role: 'viewer' });
  assert.equal((await s.app.inject({ url: `/api/agents/${agentId}/chat`, cookies: viewer })).statusCode, 200);
  assert.equal((await s.app.inject({ method: 'POST', url: `/api/agents/${agentId}/chat`, cookies: viewer, payload: { text: 'x' } })).statusCode, 403);
});
