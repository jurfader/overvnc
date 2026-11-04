import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeAgent, setup, until } from './helpers.ts';
import { newerVersion, UpdateStore } from '../updates.ts';
import { RECONNECT_UPDATE_DELAY } from '../routes/updates.ts';
import { openDb } from '../db.ts';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/release-manifest.mjs');

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

/** Wydanie zbudowane i podpisane prawdziwym skryptem wydań. */
function makeRelease(version: string, pem: string, platforms = ['windows-amd64', 'linux-amd64']) {
  const dir = mkdtempSync(path.join(tmpdir(), `rel-${version}-`));
  for (const p of platforms) writeFileSync(path.join(dir, `overvnc-agent-${p}${p.startsWith('windows') ? '.exe' : ''}`), `binarka ${p} ${version}`);
  execFileSync(process.execPath, [SCRIPT, dir, version], { env: { ...process.env, OVERVNC_SIGNING_KEY: pem }, stdio: 'pipe' });
  return dir;
}

test('wersje: porównanie zgodne z agentem', () => {
  assert.ok(newerVersion('0.6.0', '0.5.0'));
  assert.ok(newerVersion('0.6.0', '0.6.0-dev'));
  assert.ok(!newerVersion('0.6.0-dev', '0.6.0'));
  assert.ok(!newerVersion('0.6.0', '0.6.0'));
  assert.ok(newerVersion('1.0.0', '0.99.0'));
});

test('magazyn wydań: import, weryfikacja podpisu i sum, odrzucenie podróbek', async () => {
  const k = keypair();
  const db = openDb(':memory:');
  const store = new UpdateStore(db, mkdtempSync(path.join(tmpdir(), 'upd-')), k.pub);
  assert.equal(await store.importDir(makeRelease('0.6.0', k.pem)), true);
  assert.equal(store.latest()?.version, '0.6.0');
  assert.equal(await store.importDir(makeRelease('0.6.0', k.pem)), false, 'ta sama wersja drugi raz nic nie zmienia');

  // podpis innym kluczem
  await assert.rejects(store.importDir(makeRelease('0.7.0', keypair().pem)), /podpis/);
  // poprawnie podpisany manifest, ale podmieniona binarka
  const bad = makeRelease('0.8.0', k.pem);
  writeFileSync(path.join(bad, 'overvnc-agent-linux-amd64'), 'złośliwa binarka');
  await assert.rejects(store.importDir(bad), /suma kontrolna/);
  assert.deepEqual(store.versions(), ['0.6.0']);

  // po restarcie serwera wydanie jest wczytywane z dysku (z ponowną weryfikacją)
  const again = new UpdateStore(db, (store as any).dir, k.pub);
  assert.equal(again.latest()?.version, '0.6.0');
  assert.equal(new UpdateStore(db, (store as any).dir, keypair().pub).latest(), null, 'z innym kluczem nic nie jest zaufane');
  db.close();
});

test('polityka: automatyczna oferuje najnowszą, ręczna dopiero zatwierdzoną; stare wydania są usuwane', async () => {
  const k = keypair();
  const db = openDb(':memory:');
  const store = new UpdateStore(db, mkdtempSync(path.join(tmpdir(), 'upd-')), k.pub);
  await store.importDir(makeRelease('0.6.0', k.pem));
  assert.equal(store.offerFor('0.5.0', 'windows-amd64')?.version, '0.6.0');
  assert.equal(store.offerFor('0.6.0', 'windows-amd64'), null, 'aktualny agent nie dostaje oferty');
  assert.equal(store.offerFor('0.5.0', 'darwin-arm64'), null, 'brak binarki dla platformy');

  store.setPolicy('manual');
  await store.importDir(makeRelease('0.7.0', k.pem));
  assert.equal(store.target()?.version, '0.6.0', 'w trybie ręcznym nowe wydanie nie jest wdrażane samo');
  store.approve('0.7.0');
  assert.equal(store.offerFor('0.6.0', 'linux-amd64')?.version, '0.7.0');

  store.setPolicy('auto');
  await store.importDir(makeRelease('0.8.0', k.pem));
  await store.importDir(makeRelease('0.9.0', k.pem));
  assert.deepEqual(store.versions(), ['0.9.0', '0.8.0', '0.7.0'], 'zostają 3 najnowsze');
  db.close();
});

test('GitHub: pobranie najnowszego wydania z prywatnego repo (atrapa API)', async () => {
  const k = keypair();
  const rel = makeRelease('0.6.0', k.pem);
  const assets = ['manifest.json', 'manifest.json.sig', 'overvnc-agent-windows-amd64.exe', 'overvnc-agent-linux-amd64'];
  const calls: { url: string; auth: string | null; accept: string | null }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get('authorization'), accept: h.get('accept') });
    if (url.endsWith('/releases/latest')) {
      return Response.json({ tag_name: 'v0.6.0', assets: assets.map((n, i) => ({ name: n, url: `https://api.github.com/assets/${i}`, size: 1 })) });
    }
    const i = Number(url.split('/').pop());
    return new Response(readFileSync(path.join(rel, assets[i])));
  }) as typeof fetch;

  const db = openDb(':memory:');
  const store = new UpdateStore(db, mkdtempSync(path.join(tmpdir(), 'upd-')), k.pub);
  assert.equal(await store.syncFromGitHub({ repo: 'jurfader/overvnc', token: 'ghp_test' }, fakeFetch), '0.6.0');
  assert.ok(calls.every((c) => c.auth === 'Bearer ghp_test'));
  assert.equal(calls.filter((c) => c.accept === 'application/octet-stream').length, 4);
  // drugie sprawdzenie: tylko zapytanie o najnowsze, bez ponownego pobierania
  calls.length = 0;
  assert.equal(await store.syncFromGitHub({ repo: 'jurfader/overvnc', token: 'ghp_test' }, fakeFetch), null);
  assert.equal(calls.length, 1);
  db.close();
});

test('trasy: oferta i pobranie dla agenta, panel, wdrożenie tylko na nieaktualne', async (t) => {
  const k = keypair();
  const s = await setup({ releasePublicKey: k.pub });
  t.after(s.close);
  const c = await s.login();
  await s.ctx.updates.importDir(makeRelease('0.6.0', k.pem));

  const old = await s.enroll(c, 'stary');
  const fresh = await s.enroll(c, 'nowy');
  const port = await s.listen();
  const mk = async (cred: { agentId: string; agentSecret: string }, ver: string) => {
    const a = new FakeAgent(port, cred.agentId, cred.agentSecret);
    a.handlers['update.check'] = () => ({ status: 'restarting', version: ver });
    await a.open();
    a.send({ type: 'hello', data: { version: ver, protocol: 1, capabilities: ['update.check'] } });
    return a;
  };
  const aOld = await mk(old, '0.5.0');
  const aNew = await mk(fresh, '0.6.0');
  t.after(() => (aOld.close(), aNew.close()));
  await until(() => s.ctx.hub.summary(old.agentId)?.agentVersion === '0.5.0' && s.ctx.hub.summary(fresh.agentId)?.agentVersion === '0.6.0');

  // oferta wymaga klucza agenta
  const auth = { authorization: `Bearer ${old.agentId}.${old.agentSecret}` };
  assert.equal((await s.app.inject({ url: '/api/agent/update?version=0.5.0&platform=windows-amd64' })).statusCode, 401);
  const offer = await s.app.inject({ url: '/api/agent/update?version=0.5.0&platform=windows-amd64', headers: auth });
  assert.equal(offer.statusCode, 200);
  assert.equal(offer.json().version, '0.6.0');
  assert.equal((await s.app.inject({ url: '/api/agent/update?version=0.6.0&platform=windows-amd64', headers: auth })).statusCode, 204);
  const bin = await s.app.inject({ url: offer.json().download, headers: auth });
  assert.equal(bin.body, 'binarka windows-amd64 0.6.0');
  assert.equal((await s.app.inject({ url: '/api/agent/update/0.6.0/windows-amd64' })).statusCode, 401);

  const status = (await s.app.inject({ url: '/api/updates', cookies: c })).json();
  assert.equal(status.target, '0.6.0');
  assert.equal(status.outdated, 1);

  const r = await s.app.inject({ method: 'POST', url: '/api/updates/rollout', cookies: c });
  assert.equal(r.json().queued, 1);
  await aOld.waitFor((m) => m.type === 'update.check');
  assert.ok(!aNew.received.some((m) => m.type === 'update.check'), 'aktualny komputer nie dostaje polecenia');

  const viewer = (await s.createMember(c, { username: 'podglad', role: 'viewer' })).cookies;
  assert.equal((await s.app.inject({ url: '/api/updates', cookies: viewer })).statusCode, 403);
});

test('trasy: tryb ręczny — brak oferty do zatwierdzenia wersji', async (t) => {
  const k = keypair();
  const s = await setup({ releasePublicKey: k.pub });
  t.after(s.close);
  const c = await s.login();
  await s.app.inject({ method: 'PUT', url: '/api/updates/policy', cookies: c, payload: { policy: 'manual' } });
  await s.ctx.updates.importDir(makeRelease('0.6.0', k.pem));
  const { agentId, agentSecret } = await s.enroll(c);
  const auth = { authorization: `Bearer ${agentId}.${agentSecret}` };
  assert.equal((await s.app.inject({ url: '/api/agent/update?version=0.5.0&platform=linux-amd64', headers: auth })).statusCode, 204);
  const ok = await s.app.inject({ method: 'POST', url: '/api/updates/approve', cookies: c, payload: { version: '0.6.0' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await s.app.inject({ url: '/api/agent/update?version=0.5.0&platform=linux-amd64', headers: auth })).json().version, '0.6.0');
  assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'update.approve'").get());
});

test('aktualizacja po połączeniu: nieaktualny komputer, który był offline przy wydaniu, dostaje ją sam', async (t) => {
  const saved = { ...RECONNECT_UPDATE_DELAY };
  RECONNECT_UPDATE_DELAY.minMs = 0;
  RECONNECT_UPDATE_DELAY.spreadMs = 0;
  t.after(() => Object.assign(RECONNECT_UPDATE_DELAY, saved));
  const k = keypair();
  const s = await setup({ releasePublicKey: k.pub });
  t.after(s.close);
  const c = await s.login();
  // wydanie pojawia się, zanim komputery się połączą (np. restart serwera, kiosk jeszcze offline)
  await s.ctx.updates.importDir(makeRelease('0.10.0', k.pem));
  const port = await s.listen();
  const connect = async (ver: string) => {
    const cred = await s.enroll(c, `pc-${ver}`);
    const a = new FakeAgent(port, cred.agentId, cred.agentSecret);
    a.handlers['update.check'] = () => ({ status: 'restarting', version: '0.10.0' });
    await a.open();
    a.send({ type: 'hello', data: { version: ver, protocol: 1, capabilities: ['update.check'] } });
    return a;
  };
  const stary = await connect('0.7.0'); // 0.7.0 < 0.10.0 — porównanie liczbowe, nie tekstowe
  const aktualny = await connect('0.10.0');
  t.after(() => (stary.close(), aktualny.close()));
  await stary.waitFor((m) => m.type === 'update.check', 3000);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!aktualny.received.some((m) => m.type === 'update.check'), 'aktualny komputer nie dostaje polecenia');
});

test('instalacja jedną komendą: skrypty i binarka tylko z ważnym tokenem (nagłówek, nie adres)', async (t) => {
  const k = keypair();
  const s = await setup({ releasePublicKey: k.pub });
  t.after(s.close);
  const c = await s.login();
  const ps1 = await s.app.inject({ url: '/install.ps1', headers: { host: 'vnc.example.com' } });
  assert.equal(ps1.statusCode, 200);
  assert.match(ps1.body, /\$server = 'http:\/\/vnc\.example\.com'/);
  assert.match(ps1.body, /X-Enroll-Token/);
  assert.ok(!ps1.body.includes('__SERVER__'));
  const sh = await s.app.inject({ url: '/install.sh', headers: { host: 'vnc.example.com' } });
  assert.match(sh.body, /SERVER='http:\/\/vnc\.example\.com'/);
  assert.match(sh.body, /TOKEN="\$\{OVERVNC_TOKEN:-\}"/);

  const { token } = (await s.app.inject({ method: 'POST', url: '/api/enroll-tokens', cookies: c, payload: { label: 'inst', maxUses: 1 } })).json();
  const get = (tok?: string) => s.app.inject({ url: '/api/install/agent/windows-amd64', headers: tok ? { 'x-enroll-token': tok } : {} });
  // brak wydania na serwerze
  assert.equal((await get(token)).statusCode, 404);
  await s.ctx.updates.importDir(makeRelease('0.12.0', k.pem));
  assert.equal((await get()).statusCode, 403, 'bez tokenu');
  assert.equal((await get('ovnc_zly')).statusCode, 403, 'zły token');
  const ok = await get(token);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, 'binarka windows-amd64 0.12.0');
  assert.equal(ok.headers['x-agent-version'], '0.12.0');
  assert.equal(ok.headers['x-sha256'], createHash('sha256').update(ok.rawPayload).digest('hex'));
  assert.equal((await s.app.inject({ url: '/api/install/agent/plan9-mips', headers: { 'x-enroll-token': token } })).statusCode, 400);
  // pobranie nie zużywa tokenu — rejestracja nadal działa
  const enroll = await s.app.inject({ method: 'POST', url: '/api/agent/enroll', payload: { token, hostname: 'nowy-pc' } });
  assert.equal(enroll.statusCode, 200);
  // po zużyciu (maxUses: 1) — pobranie odrzucone
  assert.equal((await get(token)).statusCode, 403, 'token wykorzystany');
});
