import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWake, privateSubnets, wakeMacs, type WolHost } from '../wol.ts';

const host = (id: string, ip: string, opts: Partial<WolHost> & { mac?: string; nic?: string } = {}): WolHost => ({
  id,
  clientId: opts.clientId ?? null,
  siteId: opts.siteId ?? null,
  lastIp: opts.lastIp ?? null,
  online: opts.online ?? true,
  network: opts.network ?? [{ name: opts.nic ?? 'eth0', mac: opts.mac ?? '02:00:00:00:00:01', addrs: [ip] }],
});

test('podsieci: tylko prywatne IPv4, poprawny broadcast', () => {
  const nets = privateSubnets([{ addrs: ['192.168.1.20/24', '10.1.2.3/8', '172.20.0.5/16', '8.8.8.8/24', 'fe80::1/64', '100.89.1.2/32'] }]);
  assert.deepEqual(
    nets.map((n) => n.broadcast),
    ['192.168.1.255', '10.255.255.255', '172.20.255.255'],
  );
});

test('MAC: pomija interfejsy wirtualne i bez adresu prywatnego', () => {
  const macs = wakeMacs([
    { name: 'eth0', mac: 'AA:BB:CC:DD:EE:01', addrs: ['192.168.1.5/24'] },
    { name: 'docker0', mac: '02:42:00:00:00:01', addrs: ['172.17.0.1/16'] },
    { name: 'utun3', mac: '', addrs: ['100.64.0.1/32'] },
    { name: 'wlan0', mac: 'AA:BB:CC:DD:EE:02', addrs: ['fe80::1/64'] },
  ]);
  assert.deepEqual(macs, ['aa:bb:cc:dd:ee:01']);
});

test('przekaźnik: ta sama podsieć + ten sam publiczny IP', () => {
  const target = host('t', '192.168.1.20/24', { lastIp: '1.1.1.1', online: false });
  const plan = planWake(target, [host('r', '192.168.1.5/24', { lastIp: '1.1.1.1' })]);
  assert.deepEqual(plan, { relayId: 'r', macs: ['02:00:00:00:00:01'], broadcasts: ['192.168.1.255'] });
});

test('przekaźnik: ta sama podsieć u INNEJ firmy (inny NAT, inny klient) — odrzucony', () => {
  const target = host('t', '192.168.1.20/24', { lastIp: '1.1.1.1', clientId: 1, online: false });
  assert.equal(planWake(target, [host('r', '192.168.1.5/24', { lastIp: '2.2.2.2', clientId: 2 })]), null);
});

test('przekaźnik: ten sam klient wystarcza (np. biuro z kilkoma łączami)', () => {
  const target = host('t', '10.0.0.20/24', { lastIp: '1.1.1.1', clientId: 7, online: false });
  assert.equal(planWake(target, [host('r', '10.0.0.5/24', { lastIp: '3.3.3.3', clientId: 7 })])?.relayId, 'r');
});

test('przekaźnik: preferuje tę samą lokalizację, pomija offline i inne podsieci', () => {
  const target = host('t', '10.0.0.20/24', { clientId: 7, siteId: 1, online: false });
  const plan = planWake(target, [
    host('offline', '10.0.0.6/24', { clientId: 7, siteId: 1, online: false }),
    host('inna-siec', '10.0.1.5/24', { clientId: 7, siteId: 1 }),
    host('inna-lokalizacja', '10.0.0.7/24', { clientId: 7, siteId: 2 }),
    host('ta-sama', '10.0.0.8/24', { clientId: 7, siteId: 1 }),
  ]);
  assert.equal(plan?.relayId, 'ta-sama');
});

test('przekaźnik: brak MAC celu = brak planu', () => {
  const target = host('t', '10.0.0.20/24', { clientId: 7, online: false, mac: '' });
  assert.equal(planWake(target, [host('r', '10.0.0.5/24', { clientId: 7 })]), null);
});
