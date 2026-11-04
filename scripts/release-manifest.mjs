#!/usr/bin/env node
// Tworzy i podpisuje manifest wydania agenta.
// Użycie: node scripts/release-manifest.mjs <katalog z binarkami> <wersja>
// Klucz prywatny Ed25519 (PEM): zmienna OVERVNC_SIGNING_KEY albo plik z OVERVNC_SIGNING_KEY_FILE.
// Wynik w tym samym katalogu: manifest.json + manifest.json.sig (surowy podpis, 64 bajty).
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('Użycie: release-manifest.mjs <katalog> <wersja np. 0.6.0>');
  process.exit(2);
}
const pem = process.env.OVERVNC_SIGNING_KEY || (process.env.OVERVNC_SIGNING_KEY_FILE && readFileSync(process.env.OVERVNC_SIGNING_KEY_FILE, 'utf8'));
if (!pem) {
  console.error('Brak klucza podpisu (OVERVNC_SIGNING_KEY lub OVERVNC_SIGNING_KEY_FILE).');
  process.exit(2);
}
const key = createPrivateKey(pem);

const files = {};
for (const name of readdirSync(dir).sort()) {
  const m = /^overvnc-agent-(windows|darwin|linux)-(amd64|arm64)(\.exe)?$/.exec(name);
  if (!m) continue;
  const data = readFileSync(path.join(dir, name));
  files[`${m[1]}-${m[2]}`] = { name, size: statSync(path.join(dir, name)).size, sha256: createHash('sha256').update(data).digest('hex') };
}
if (Object.keys(files).length === 0) {
  console.error(`Brak binarek overvnc-agent-* w ${dir}`);
  process.exit(1);
}
const manifest = Buffer.from(JSON.stringify({ version, created: new Date().toISOString(), files }, null, 2) + '\n');
const sig = sign(null, manifest, key);
writeFileSync(path.join(dir, 'manifest.json'), manifest);
writeFileSync(path.join(dir, 'manifest.json.sig'), sig);
const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
console.log(`Podpisano wydanie ${version}: ${Object.keys(files).join(', ')} (klucz publiczny ${pub})`);
