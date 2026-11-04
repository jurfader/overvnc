import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  };
}
