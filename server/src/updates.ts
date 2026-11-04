import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import { getSetting, setSetting } from './settings.ts';

/**
 * Wydania agenta: serwer pobiera je z GitHub Releases (prywatne repo — token tylko na serwerze),
 * weryfikuje podpis Ed25519 i sumy kontrolne, przechowuje lokalnie i udostępnia agentom.
 * Agenci weryfikują podpis ponownie — przejęcie serwera nie pozwala podsunąć im obcej binarki.
 */

/** Klucz publiczny wydań — ten sam, który jest wbudowany w agenta (agent/update.go). */
export const RELEASE_PUBLIC_KEY = 'OQCYoIyr/Z7O2jbaEyFXJOwOVV4Ep9S/cbFDy//dZBs=';

export interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  version: string;
  created?: string;
  files: Record<string, ManifestFile>;
}

export interface Release {
  version: string;
  manifest: Manifest;
  manifestRaw: Buffer;
  signature: Buffer;
  dir: string;
}

export type UpdatePolicy = 'auto' | 'manual';

const KEEP_RELEASES = 3;

export function rawPublicKey(b64: string): KeyObject {
  // klucz Ed25519 jako surowe 32 bajty -> SPKI DER (prefiks algorytmu + klucz)
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });
}

export function verifyManifest(raw: Buffer, sig: Buffer, key: KeyObject): Manifest {
  if (!edVerify(null, raw, key, sig)) throw new Error('nieprawidłowy podpis wydania');
  const m = JSON.parse(raw.toString('utf8')) as Manifest;
  if (!m || typeof m.version !== 'string' || !m.files || typeof m.files !== 'object') throw new Error('nieprawidłowy manifest');
  return m;
}

// ---------- porównywanie wersji (jak w agencie) ----------

function parseVersion(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
}

export function newerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  if (pa.pre === pb.pre) return false;
  if (!pa.pre || !pb.pre) return !pa.pre;
  return pa.pre > pb.pre;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface GitHubSource {
  repo: string;
  token: string;
}

export class UpdateStore {
  private dir: string;
  private key: KeyObject;
  private db: Db;
  private releases = new Map<string, Release>();
  lastCheck: number | null = null;
  lastError: string | null = null;

  constructor(db: Db, dir: string, publicKeyB64 = RELEASE_PUBLIC_KEY) {
    this.db = db;
    this.dir = dir;
    this.key = rawPublicKey(publicKeyB64);
    mkdirSync(dir, { recursive: true });
    this.loadFromDisk();
  }

  /** Wczytuje zweryfikowane wydania z dysku (po restarcie serwera). Uszkodzone pomija. */
  private loadFromDisk(): void {
    for (const name of readdirSync(this.dir)) {
      const d = path.join(this.dir, name);
      try {
        const raw = readFileSync(path.join(d, 'manifest.json'));
        const sig = readFileSync(path.join(d, 'manifest.json.sig'));
        const manifest = verifyManifest(raw, sig, this.key);
        this.releases.set(manifest.version, { version: manifest.version, manifest, manifestRaw: raw, signature: sig, dir: d });
      } catch {
        /* niekompletne/uszkodzone — zostanie pobrane ponownie */
      }
    }
  }

  latest(): Release | null {
    let best: Release | null = null;
    for (const r of this.releases.values()) if (!best || newerVersion(r.version, best.version)) best = r;
    return best;
  }

  get(version: string): Release | null {
    return this.releases.get(version) ?? null;
  }

  versions(): string[] {
    return [...this.releases.keys()].sort((a, b) => (newerVersion(a, b) ? -1 : 1));
  }

  policy(): UpdatePolicy {
    return getSetting(this.db, 'update.policy') === 'manual' ? 'manual' : 'auto';
  }

  setPolicy(p: UpdatePolicy): void {
    setSetting(this.db, 'update.policy', p);
    if (p === 'auto') this.syncTargetWithPolicy();
  }

  /** Wersja oferowana agentom: w trybie auto — najnowsza; w ręcznym — zatwierdzona przez administratora. */
  target(): Release | null {
    if (this.policy() === 'auto') return this.latest();
    const v = getSetting(this.db, 'update.target');
    return v ? this.get(v) : null;
  }

  approve(version: string): void {
    if (!this.get(version)) throw new Error(`brak wydania ${version}`);
    setSetting(this.db, 'update.target', version);
  }

  private syncTargetWithPolicy(): void {
    const l = this.latest();
    if (l) setSetting(this.db, 'update.target', l.version);
  }

  /** Oferta dla agenta: tylko gdy docelowa wersja jest nowsza i ma binarkę dla jego platformy. */
  offerFor(agentVersion: string, platform: string): Release | null {
    const t = this.target();
    if (!t || !t.manifest.files[platform] || !newerVersion(t.version, agentVersion)) return null;
    return t;
  }

  filePath(version: string, platform: string): { path: string; file: ManifestFile } | null {
    const r = this.get(version);
    const f = r?.manifest.files[platform];
    if (!r || !f || !/^[\w.-]+$/.test(f.name)) return null;
    const p = path.join(r.dir, f.name);
    return existsSync(p) ? { path: p, file: f } : null;
  }

  stream(p: string) {
    return createReadStream(p);
  }

  /**
   * Dodaje wydanie z bajtów (GitHub lub import ręczny). Weryfikuje podpis i KAŻDĄ binarkę,
   * zapisuje atomowo (katalog tymczasowy -> rename). Zwraca true, jeśli wydanie jest nowe.
   */
  async addRelease(manifestRaw: Buffer, signature: Buffer, fetchFile: (name: string) => Promise<Buffer>): Promise<boolean> {
    const manifest = verifyManifest(manifestRaw, signature, this.key);
    if (this.releases.has(manifest.version)) return false;
    const final = path.join(this.dir, manifest.version.replace(/[^\w.-]/g, '_'));
    const tmp = `${final}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      for (const [platform, f] of Object.entries(manifest.files)) {
        if (!/^[\w.-]+$/.test(f.name)) throw new Error(`nieprawidłowa nazwa pliku ${f.name}`);
        const data = await fetchFile(f.name);
        if (data.length !== f.size || sha256(data) !== f.sha256.toLowerCase()) throw new Error(`suma kontrolna ${platform} się nie zgadza`);
        writeFileSync(path.join(tmp, f.name), data);
      }
      writeFileSync(path.join(tmp, 'manifest.json'), manifestRaw);
      writeFileSync(path.join(tmp, 'manifest.json.sig'), signature);
      rmSync(final, { recursive: true, force: true });
      renameSync(tmp, final);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    this.releases.set(manifest.version, { version: manifest.version, manifest, manifestRaw, signature, dir: final });
    if (this.policy() === 'auto') this.syncTargetWithPolicy();
    this.prune();
    return true;
  }

  /** Zostawia KEEP_RELEASES najnowszych wydań (oraz zatwierdzone w trybie ręcznym). */
  private prune(): void {
    const keep = new Set(this.versions().slice(0, KEEP_RELEASES));
    const target = getSetting(this.db, 'update.target');
    if (target) keep.add(target);
    for (const [v, r] of this.releases) {
      if (keep.has(v)) continue;
      rmSync(r.dir, { recursive: true, force: true });
      this.releases.delete(v);
    }
  }

  /** Sprawdza najnowsze wydanie na GitHubie i pobiera je, jeśli jest nowe. */
  async syncFromGitHub(src: GitHubSource, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    this.lastCheck = Date.now();
    try {
      const api = `https://api.github.com/repos/${src.repo}`;
      const headers = { Authorization: `Bearer ${src.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'overvnc-server' };
      const res = await fetchImpl(`${api}/releases/latest`, { headers: { ...headers, Accept: 'application/vnd.github+json' } });
      if (res.status === 404) {
        this.lastError = null;
        return null; // brak wydań
      }
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
      const rel = (await res.json()) as { tag_name: string; assets: { name: string; url: string; size: number }[] };
      const version = rel.tag_name.replace(/^v/, '');
      if (this.releases.has(version)) {
        this.lastError = null;
        return null;
      }
      const asset = async (name: string): Promise<Buffer> => {
        const a = rel.assets.find((x) => x.name === name);
        if (!a) throw new Error(`w wydaniu ${rel.tag_name} brak pliku ${name}`);
        // API przekierowuje na podpisany adres S3 — fetch nie przekazuje tam nagłówka Authorization
        const r = await fetchImpl(a.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
        if (!r.ok) throw new Error(`pobieranie ${name}: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      };
      const added = await this.addRelease(await asset('manifest.json'), await asset('manifest.json.sig'), asset);
      this.lastError = null;
      return added ? version : null;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  /** Import wydania z katalogu (bez GitHuba — np. serwer bez dostępu do internetu, testy). */
  async importDir(dir: string): Promise<boolean> {
    return this.addRelease(readFileSync(path.join(dir, 'manifest.json')), readFileSync(path.join(dir, 'manifest.json.sig')), async (n) =>
      readFileSync(path.join(dir, n)),
    );
  }

  diskUsage(): number {
    let n = 0;
    for (const r of this.releases.values()) for (const f of readdirSync(r.dir)) n += statSync(path.join(r.dir, f)).size;
    return n;
  }
}
