import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ADMIN, setup } from './helpers.ts';
import { base32Decode, currentStep, hotp } from '../totp.ts';

const codeAt = (secret: string, offset = 0) => hotp(base32Decode(secret), currentStep() + offset);

/** Właściciel konfiguruje 2FA; zwraca sekret i kody zapasowe. */
async function enableMfa(s: Awaited<ReturnType<typeof setup>>, cookies: Record<string, string>) {
  const { secret } = (await s.app.inject({ method: 'POST', url: '/api/auth/2fa/setup', cookies })).json();
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/2fa/enable', cookies, payload: { code: codeAt(secret) } });
  assert.equal(res.statusCode, 200, res.body);
  return { secret: secret as string, recoveryCodes: res.json().recoveryCodes as string[] };
}

test('2FA wymagane: właściciel bez 2FA ma dostęp tylko do konfiguracji', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const cookies = await s.login();

  const blocked = await s.app.inject({ url: '/api/agents', cookies });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'mfa_setup_required');

  const me = (await s.app.inject({ url: '/api/auth/me', cookies })).json();
  assert.equal(me.restriction, 'mfa_setup_required');
  assert.equal(me.mfaRequired, true);

  // panel WebSocket też zablokowany
  const port = await s.listen();
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { cookie: `overvnc_sid=${cookies.overvnc_sid}` } });
    ws.once('open', () => (ws.close(), resolve(101)));
    ws.once('unexpected-response', (_q, r) => resolve(r.statusCode!));
  });
  assert.equal(status, 403);

  await enableMfa(s, cookies);
  assert.equal((await s.app.inject({ url: '/api/agents', cookies })).statusCode, 200);
});

test('2FA: pełne logowanie dwuetapowe, kod nie działa dwa razy', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const { secret, recoveryCodes } = await enableMfa(s, await s.login());
  assert.equal(recoveryCodes.length, 10);

  // krok 1: hasło -> bilet zamiast sesji
  const step1 = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
  assert.equal(step1.statusCode, 200);
  assert.equal(step1.json().mfaRequired, true);
  assert.equal(step1.cookies.length, 0, 'bez sesji przed drugim krokiem');
  const { ticket } = step1.json();

  const wrong = await s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket, code: '000000' } });
  assert.equal(wrong.statusCode, 401);

  // kod z bieżącego kroku zużyto przy włączaniu — następny krok (tolerancja +1) działa
  const code = codeAt(secret, 1);
  const ok = await s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket, code } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.cookies.find((c) => c.name === 'overvnc_sid'));

  // ten sam kod ponownie (nowy bilet) — odrzucony
  const again = (await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json();
  const replay = await s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket: again.ticket, code } });
  assert.equal(replay.statusCode, 401);
});

test('2FA: kod zapasowy działa dokładnie raz', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const { recoveryCodes } = await enableMfa(s, await s.login());

  const use = async () => {
    const { ticket } = (await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json();
    return s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket, code: recoveryCodes[0].toUpperCase() } });
  };
  assert.equal((await use()).statusCode, 200);
  assert.equal((await use()).statusCode, 401);
});

test('2FA: bilet ginie po 5 błędnych kodach', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const { secret } = await enableMfa(s, await s.login());
  const { ticket } = (await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json();
  for (let i = 0; i < 5; i++) await s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket, code: '111111' } });
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/login/mfa', payload: { ticket, code: codeAt(secret, 1) } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'ticket_expired');
});

test('2FA: sekret w bazie jest zaszyfrowany', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const { secret } = await enableMfa(s, await s.login());
  const row = s.db.prepare('SELECT totp_secret FROM users WHERE username = ?').get(ADMIN.username) as { totp_secret: string };
  assert.match(row.totp_secret, /^v1:/);
  assert.ok(!row.totp_secret.includes(secret));
  const codes = s.db.prepare('SELECT code_hash FROM recovery_codes').all() as { code_hash: string }[];
  assert.ok(codes.every((c) => /^[0-9a-f]{64}$/.test(c.code_hash)), 'kody zapasowe tylko jako skróty');
});

test('2FA: właściciel nie może wyłączyć 2FA, gdy jest wymagane; technik może', async (t) => {
  const s = await setup({ requireMfa: true });
  t.after(s.close);
  const owner = await s.login();
  await enableMfa(s, owner);
  const res = await s.app.inject({ method: 'POST', url: '/api/auth/2fa/disable', cookies: owner, payload: { password: ADMIN.password } });
  assert.equal(res.statusCode, 403);

  const ownerCookies = owner;
  const tech = await s.createMember(ownerCookies, { username: 'technik', role: 'tech' });
  await enableMfa(s, tech.cookies);
  const off = await s.app.inject({ method: 'POST', url: '/api/auth/2fa/disable', cookies: tech.cookies, payload: { password: tech.password } });
  assert.equal(off.statusCode, 200);
});

test('2FA: właściciel resetuje 2FA innego konta (utracony telefon)', async (t) => {
  const s = await setup({ requireMfa: false });
  t.after(s.close);
  const owner = await s.login();
  const admin = await s.createMember(owner, { username: 'adm', role: 'admin' });
  await enableMfa(s, admin.cookies);

  const r = await s.app.inject({ method: 'POST', url: `/api/users/${admin.id}/reset-2fa`, cookies: owner });
  assert.equal(r.statusCode, 200);
  // sesje konta unieważnione, logowanie znów jednoetapowe
  assert.equal((await s.app.inject({ url: '/api/auth/me', cookies: admin.cookies })).statusCode, 401);
  const relog = await s.loginAs('adm', admin.password);
  assert.equal(relog.res.json().mfaRequired, undefined);
});
