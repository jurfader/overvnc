import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSecurity, diffInventory, diffSecurity } from '../security.ts';
import { FakeAgent, setup, until } from './helpers.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7);

test('zabezpieczenia: ocena Windows — wszystko w porządku', () => {
  const s = assessSecurity(
    {
      checkedAt: NOW,
      antivirus: { defender: true, enabled: true, realTime: true, signatureAgeDays: 1 },
      firewall: { enabled: true },
      encryption: { name: 'BitLocker', enabled: true },
      updates: { pending: 0, security: 0, rebootRequired: false, lastInstalled: NOW - 10 * DAY },
    },
    'windows',
    NOW,
  );
  assert.deepEqual(s, { level: 'ok', issues: [], checkedAt: NOW });
});

test('zabezpieczenia: ocena Windows — problemy uporządkowane od najpoważniejszych', () => {
  const s = assessSecurity(
    {
      antivirus: { defender: true, enabled: true, realTime: false, signatureAgeDays: 30 },
      firewall: { enabled: false, profiles: [{ name: 'publiczny', enabled: false }, { name: 'prywatny', enabled: true }] },
      encryption: { name: 'BitLocker', enabled: false, status: 'dysk systemowy niezaszyfrowany' },
      updates: { pending: 5, security: 2, rebootRequired: true, lastInstalled: NOW - 90 * DAY },
    },
    'windows',
    NOW,
  )!;
  assert.equal(s.level, 'critical');
  assert.deepEqual(
    s.issues.map((i) => `${i.severity}:${i.code}`),
    ['critical:av_off', 'critical:firewall_off', 'warning:reboot_required', 'warning:updates_security', 'info:encryption_off', 'info:updates_stale'],
  );
  assert.equal(s.issues[1].detail, 'Profile: publiczny');
  assert.equal(s.issues[3].title, '2 poprawki bezpieczeństwa do zainstalowania');
});

test('zabezpieczenia: inny antywirus aktywny — wyłączony Defender to nie problem; BitLocker niedostępny — pomijany', () => {
  const s = assessSecurity(
    {
      antivirus: { defender: true, enabled: false, realTime: false, signatureAgeDays: 90, products: [{ name: 'ESET Security', enabled: true, upToDate: true }] },
      encryption: { name: 'BitLocker', enabled: false, status: 'niedostępny w tej edycji Windows' },
    },
    'windows',
    NOW,
  )!;
  assert.deepEqual(s.issues, []);
});

test('zabezpieczenia: macOS — zapora to tylko informacja, SIP krytyczny', () => {
  const s = assessSecurity({ firewall: { enabled: false }, sip: false, gatekeeper: true, encryption: { name: 'FileVault', enabled: true } }, 'darwin', NOW)!;
  assert.deepEqual(
    s.issues.map((i) => `${i.severity}:${i.code}`),
    ['critical:sip_off', 'info:firewall_off'],
  );
});

test('historia zmian: programy, system, sprzęt; błąd spisu programów nie udaje odinstalowania', () => {
  const prev = {
    host: { hostname: 'PC1', platform: 'Windows 11', platformVersion: '24H2', kernelVersion: '10.0.26100.1' },
    memory: { total: 8 * 1024 ** 3 },
    cpu: { model: 'Pentium' },
    disks: [{ mountpoint: 'C:', total: 256 * 1024 ** 3 }],
    software: [
      { name: '7-Zip', version: '22.01' },
      { name: 'Chrome', version: '120' },
      { name: 'Stary program', version: '1.0' },
    ],
  };
  const next = {
    host: { hostname: 'PC1', platform: 'Windows 11', platformVersion: '24H2', kernelVersion: '10.0.26100.2' },
    memory: { total: 16 * 1024 ** 3 },
    cpu: { model: 'Pentium' },
    disks: [
      { mountpoint: 'C:', total: 256 * 1024 ** 3 },
      { mountpoint: 'D:', total: 1000 * 1024 ** 3 },
    ],
    software: [
      { name: '7-zip', version: '26.05' },
      { name: 'Chrome', version: '120' },
      { name: 'LibreOffice', version: '24.8' },
    ],
  };
  assert.deepEqual(
    diffInventory(prev, next).map((c) => `${c.kind}|${c.title}|${c.detail ?? ''}`),
    [
      'os|Wersja systemu: 10.0.26100.1 → 10.0.26100.2|',
      'hardware|Pamięć RAM: 8 GB → 16 GB|',
      'hardware|Nowy dysk: D: (1000 GB)|',
      'software|Zaktualizowano: 7-zip|22.01 → 26.05',
      'software|Zainstalowano: LibreOffice|24.8',
      'software|Odinstalowano: Stary program|1.0',
    ],
  );
  assert.deepEqual(diffInventory(prev, { ...next, software: [], softwareError: 'odmowa dostępu' }).filter((c) => c.kind === 'software'), []);
  assert.deepEqual(diffInventory(null, next), [], 'pierwszy inwentarz nie generuje zmian');
});

test('historia zmian: zabezpieczenia — nowe i rozwiązane problemy (bez informacji)', () => {
  const a = assessSecurity({ firewall: { enabled: false }, updates: { pending: 3, security: 0 } }, 'windows', NOW);
  const b = assessSecurity({ firewall: { enabled: true }, updates: { pending: 1, security: 0 }, antivirus: { defender: true, enabled: false } }, 'windows', NOW);
  assert.deepEqual(
    diffSecurity(a, b).map((c) => c.title),
    ['Antywirus wyłączony', 'Rozwiązano: Zapora wyłączona'],
  );
});

test('zabezpieczenia: agent zgłasza stan — ocena na liście, historia zmian, alert krytyczny', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.login();
  const { agentId, agentSecret } = await s.enroll(c, 'pc');
  const port = await s.listen();
  const agent = new FakeAgent(port, agentId, agentSecret);
  await agent.open();
  const inv = (sec: unknown, software: { name: string; version: string }[]) => ({
    host: { hostname: 'pc', os: 'windows', platform: 'Windows 11', platformVersion: '24H2' },
    software,
    security: sec,
  });
  const good = { antivirus: { defender: true, enabled: true, realTime: true, signatureAgeDays: 0 }, firewall: { enabled: true } };
  agent.send({ type: 'hello', data: { version: 'test', protocol: 1, capabilities: [], inventory: inv(good, [{ name: 'Chrome', version: '1' }]) } });
  await until(() => (s.ctx.hub.summary(agentId)?.security?.level ?? '') === 'ok');

  // inwentarz: nowy program; potem co godzinę sam stan zabezpieczeń — zapora wyłączona
  agent.send({ type: 'inventory', data: inv(good, [{ name: 'Chrome', version: '1' }, { name: 'TeamViewer', version: '15' }]) });
  agent.send({ type: 'security', data: { ...good, firewall: { enabled: false } } });
  await until(() => s.ctx.hub.summary(agentId)?.security?.level === 'critical');

  const changes = (await s.app.inject({ url: `/api/agents/${agentId}/changes`, cookies: c })).json().items as { kind: string; title: string }[];
  assert.deepEqual(
    changes.map((x) => `${x.kind}|${x.title}`),
    ['security|Zapora wyłączona', 'software|Zainstalowano: TeamViewer'],
  );
  const found = (await s.app.inject({ url: '/api/changes?q=teamviewer', cookies: c })).json().items as { hostname: string }[];
  assert.deepEqual(
    found.map((x) => x.hostname),
    ['pc'],
  );

  // domyślna reguła: krytyczne problemy z zabezpieczeniami
  const alerts = (await s.app.inject({ url: '/api/alerts?state=open', cookies: c })).json() as { kind: string; detail: string }[];
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'security');
  assert.equal(alerts[0].detail, 'Zapora wyłączona');

  // naprawione — alert zamknięty, w historii „Rozwiązano”
  agent.send({ type: 'security', data: good });
  await until(() => s.ctx.hub.summary(agentId)?.security?.level === 'ok');
  assert.equal((await s.app.inject({ url: '/api/alerts?state=open', cookies: c })).json().length, 0);
  agent.close();
});
