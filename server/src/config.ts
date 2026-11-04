import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_PUBLIC_KEY } from './updates.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  port: number;
  host: string;
  /** Plik bazy SQLite albo ":memory:" (testy). */
  dbFile: string;
  /** Katalog zbudowanego panelu; null = nie serwuj panelu. */
  panelDir: string | null;
  /** Ciasteczko sesji tylko po HTTPS — włączyć na produkcji. */
  cookieSecure: boolean;
  /** Ufaj X-Forwarded-For — włączyć za reverse proxy (Caddy/nginx). */
  trustProxy: boolean;
  logLevel: string;
  sessionTtlMs: number;
  /** Plik z kluczem szyfrującym sekrety (np. TOTP); null = klucz tymczasowy w pamięci (testy). */
  keyFile: string | null;
  /** Wymuszaj 2FA dla właścicieli i administratorów (REQUIRE_2FA=0 wyłącza — tylko do developmentu). */
  requireMfa: boolean;
  /** Maks. rozmiar wysyłanego pliku (MAX_UPLOAD_MB, domyślnie 10 GB). */
  maxUploadBytes: number;
  /** Katalog wydań agenta (pobranych z GitHuba). */
  updatesDir: string;
  /** Pliki do wdrażania na komputery (zadania „Wdrożenie”). */
  packagesDir: string;
  /** Źródło wydań: prywatne repo GitHub (GITHUB_REPO=jurfader/overvnc, GITHUB_TOKEN tylko do odczytu). */
  github: { repo: string; token: string } | null;
  /** Klucz publiczny wydań (base64, Ed25519) — domyślnie wbudowany; zmiana tylko przy rotacji klucza. */
  releasePublicKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? path.join(root, 'data');
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '127.0.0.1',
    dbFile: path.join(dataDir, 'overvnc.db'),
    panelDir: env.PANEL_DIR ?? path.join(root, '../panel/dist'),
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: env.TRUST_PROXY === '1',
    logLevel: env.LOG_LEVEL ?? 'info',
    sessionTtlMs: 12 * 60 * 60 * 1000,
    keyFile: path.join(dataDir, 'secret.key'),
    requireMfa: env.REQUIRE_2FA !== '0',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 10 * 1024) * 1024 * 1024,
    updatesDir: path.join(dataDir, 'updates'),
    packagesDir: path.join(dataDir, 'packages'),
    github: env.GITHUB_REPO && env.GITHUB_TOKEN ? { repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN } : null,
    releasePublicKey: env.RELEASE_PUBLIC_KEY ?? RELEASE_PUBLIC_KEY,
  };
}
