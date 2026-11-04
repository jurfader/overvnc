import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, currentStep, generateRecoveryCodes, generateSecret, hotp, verifyTotp } from '../totp.ts';

// Wektory testowe z RFC 6238, dodatek B (SHA1, sekret "12345678901234567890", 8 cyfr)
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('TOTP: zgodność z wektorami RFC 6238', () => {
  for (const [time, expected] of RFC_VECTORS) {
    assert.equal(hotp(RFC_SECRET, Math.floor(time / 30), 8), expected, `T=${time}`);
  }
});

test('TOTP: weryfikacja 6-cyfrowego kodu, tolerancja ±1 krok', () => {
  const secretB32 = base32Encode(RFC_SECRET);
  const now = 59_000;
  assert.notEqual(verifyTotp(secretB32, '287082', 0, now), null); // 94287082 -> ostatnie 6 cyfr
  assert.notEqual(verifyTotp(secretB32, '287082', 0, now + 30_000), null); // krok później — jeszcze OK
  assert.equal(verifyTotp(secretB32, '287082', 0, now + 90_000), null); // za stary
  assert.equal(verifyTotp(secretB32, '000000', 0, now), null);
  assert.equal(verifyTotp(secretB32, 'abc', 0, now), null);
});

test('TOTP: ten sam kod nie zadziała drugi raz (ochrona przed powtórzeniem)', () => {
  const secretB32 = base32Encode(RFC_SECRET);
  const step = verifyTotp(secretB32, '287082', 0, 59_000);
  assert.notEqual(step, null);
  assert.equal(verifyTotp(secretB32, '287082', step!, 59_000), null);
});

test('base32: kodowanie w obie strony', () => {
  for (let i = 0; i < 50; i++) {
    const s = generateSecret();
    assert.equal(s.length, 32);
    assert.equal(base32Encode(base32Decode(s)), s);
  }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI'); // RFC 4648
});

test('kody zapasowe: format i unikalność', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.ok(currentStep() > 0);
});
