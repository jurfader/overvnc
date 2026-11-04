import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) — zgodny z Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden itd.
 * HMAC-SHA1, krok 30 s, 6 cyfr, tolerancja ±1 krok (zegar telefonu może się spieszyć/późnić).
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('nieprawidłowy znak base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Nowy sekret: 160 bitów, jak zaleca RFC 4226. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226) dla danego licznika. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Sprawdza kod. Zwraca numer kroku, którym kod pasuje (do ochrony przed ponownym użyciem), albo null.
 * `afterStep` — kody z kroków <= afterStep są odrzucane (już zużyte).
 */
export function verifyTotp(secretB32: string, code: string, afterStep = 0, nowMs = Date.now()): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = currentStep(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (step <= afterStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

/** Adres do kodu QR dla aplikacji uwierzytelniającej. */
export function otpauthUrl(secretB32: string, account: string, issuer = 'OVERVNC'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** Kody zapasowe w formacie "abcde-fghij" (bez łatwych do pomylenia znaków). */
export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const chars = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s/g, '');
}
