import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../config.ts';
import { iceServersFor } from '../ice.ts';

test('ICE: domyślnie STUN Cloudflare, bez TURN', () => {
  const c = loadConfig({});
  assert.deepEqual(iceServersFor(c, 'u1'), [{ urls: ['stun:stun.cloudflare.com:3478'] }]);
});

test('ICE: P2P=0 wyłącza połączenie bezpośrednie', () => {
  assert.deepEqual(iceServersFor(loadConfig({ P2P: '0' }), 'u1'), []);
});

test('ICE: TURN z jednorazowym hasłem zgodnym z coturn (use-auth-secret)', () => {
  const c = loadConfig({ TURN_URLS: 'turn:turn.example.pl:3478?transport=udp, turn:turn.example.pl:3478?transport=tcp', TURN_SECRET: 's3kret', TURN_TTL_HOURS: '2' });
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const [stun, turn] = iceServersFor(c, 'u7', now);
  assert.deepEqual(stun.urls, ['stun:stun.cloudflare.com:3478']);
  assert.deepEqual(turn.urls, ['turn:turn.example.pl:3478?transport=udp', 'turn:turn.example.pl:3478?transport=tcp']);
  assert.equal(turn.username, `${now / 1000 + 7200}:u7`);
  assert.equal(turn.credential, crypto.createHmac('sha1', 's3kret').update(turn.username!).digest('base64'));
});
