import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hasło użytkownika -> "scrypt$<salt>$<hash>" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT_OPTS);
  return timingSafeEqual(actual, expected);
}

/** Losowy token o wysokiej entropii (do sesji, sekretów agentów, tokenów rejestracji). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokeny o wysokiej entropii wystarczy przechowywać jako SHA-256. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------- szyfrowanie sekretów w bazie (AES-256-GCM) ----------
// Klucz leży w osobnym pliku (DATA_DIR/secret.key, 0600), więc wyciek samej bazy lub jej kopii
// nie ujawnia sekretów 2FA. Klucz trzeba backupować razem z bazą.

/** Wczytuje klucz serwera albo tworzy go przy pierwszym starcie. null = klucz tymczasowy (testy). */
export function loadOrCreateKey(file: string | null): Buffer {
  if (!file) return randomBytes(32);
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Nieprawidłowy klucz w ${file} (oczekiwano 32 bajtów base64).`);
    return key;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

export function decryptSecret(key: Buffer, stored: string): string {
  if (!stored.startsWith('v1:')) throw new Error('nieznany format zaszyfrowanego sekretu');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
