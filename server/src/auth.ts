import type { FastifyRequest } from 'fastify';
import type { Ctx, SessionUser } from './context.ts';
import { audit, type Db } from './db.ts';
import { hashPassword, randomToken, safeEqualHex, sha256 } from './crypto.ts';
import { HttpError } from './errors.ts';

export const SESSION_COOKIE = 'overvnc_sid';

export function userFromRequest(db: Db, req: FastifyRequest): SessionUser | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as { id: number; username: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

/** preHandler: wymaga zalogowanego administratora. */
export function requireUser(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const user = userFromRequest(ctx.db, req);
    if (!user) throw new HttpError(401, 'unauthorized', 'Zaloguj się ponownie.');
    req.user = user;
  };
}

export const actorOf = (req: FastifyRequest) => `user:${req.user?.username ?? '?'}`;

/** Agent uwierzytelnia się nagłówkiem "Authorization: Bearer <agentId>.<secret>". */
export function agentFromRequest(db: Db, req: FastifyRequest): string | null {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const row = db.prepare('SELECT secret_hash FROM agents WHERE id = ?').get(m[1]) as { secret_hash: string } | undefined;
  if (!row || !safeEqualHex(row.secret_hash, sha256(m[2]))) return null;
  return m[1];
}

/** Przy pierwszym starcie tworzy konto administratora. Zwraca wygenerowane hasło (jeśli było generowane). */
export async function ensureAdmin(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<{ username: string; password: string } | null> {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return null;
  const username = env.ADMIN_USER ?? 'admin';
  const password = env.ADMIN_PASSWORD ?? randomToken(12);
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(username, await hashPassword(password), Date.now());
  audit(db, 'system', 'user.create', username);
  return env.ADMIN_PASSWORD ? null : { username, password };
}
