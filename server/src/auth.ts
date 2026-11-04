import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Ctx, Restriction, SessionUser } from './context.ts';
import { audit, type Db } from './db.ts';
import { hashPassword, randomToken, safeEqualHex, sha256 } from './crypto.ts';
import { HttpError } from './errors.ts';
import { can, MFA_REQUIRED_ROLES, type Permission, type Role } from './permissions.ts';

export const SESSION_COOKIE = 'overvnc_sid';
const TOUCH_INTERVAL_MS = 60_000;

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  all_clients: number;
  disabled: number;
  must_change_password: number;
  totp_enabled: number;
}

export function restrictionOf(config: Config, u: { role: Role; mustChangePassword: boolean; mfaEnabled: boolean }): Restriction {
  if (u.mustChangePassword) return 'password_change_required';
  if (config.requireMfa && MFA_REQUIRED_ROLES.includes(u.role) && !u.mfaEnabled) return 'mfa_setup_required';
  return null;
}

export function clientIdsOf(db: Db, userId: number): number[] {
  return (db.prepare('SELECT client_id FROM user_clients WHERE user_id = ? ORDER BY client_id').all(userId) as { client_id: number }[]).map(
    (r) => r.client_id,
  );
}

/** Odczytuje sesję z ciasteczka. Konto zablokowane lub sesja wygasła = brak sesji. */
export function userFromRequest(ctx: Ctx, req: FastifyRequest): SessionUser | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { db } = ctx;
  const tokenHash = sha256(token);
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.all_clients,
              u.disabled, u.must_change_password, u.totp_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as (UserRow & { session_id: string; expires_at: number; last_seen_at: number }) | undefined;
  const now = Date.now();
  if (!row || row.expires_at < now || row.disabled) return null;
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE token_hash = ?').run(now, req.ip, tokenHash);
  }
  const user: SessionUser = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    allClients: !!row.all_clients,
    clientIds: row.all_clients ? [] : clientIdsOf(db, row.id),
    sessionId: row.session_id,
    mfaEnabled: !!row.totp_enabled,
    restriction: null,
  };
  user.restriction = restrictionOf(ctx.config, { role: user.role, mustChangePassword: !!row.must_change_password, mfaEnabled: user.mfaEnabled });
  return user;
}

/**
 * preHandler: wymaga zalogowanego konta, opcjonalnie uprawnienia.
 * Konto z ograniczeniem (zmiana hasła / konfiguracja 2FA) ma dostęp tylko do tras z allowRestricted.
 */
export function requireUser(ctx: Ctx, perm?: Permission, opts: { allowRestricted?: boolean } = {}) {
  return async (req: FastifyRequest) => {
    const user = userFromRequest(ctx, req);
    if (!user) throw new HttpError(401, 'unauthorized', 'Zaloguj się ponownie.');
    if (user.restriction && !opts.allowRestricted) {
      throw new HttpError(
        403,
        user.restriction,
        user.restriction === 'password_change_required' ? 'Najpierw ustaw nowe hasło.' : 'Najpierw skonfiguruj weryfikację dwuetapową (2FA).',
      );
    }
    if (perm && !can(user.role, perm)) throw new HttpError(403, 'forbidden', 'Nie masz uprawnień do tej operacji.');
    req.user = user;
  };
}

/** Uprawnienie wymagające dodatkowo dostępu do wszystkich klientów (operacje globalne). */
export function requireGlobal(req: FastifyRequest): void {
  if (!req.user?.allClients) throw new HttpError(403, 'forbidden', 'Ta operacja wymaga dostępu do wszystkich klientów.');
}

export const actorOf = (req: FastifyRequest) => `user:${req.user?.username ?? '?'}`;

/** Tworzy sesję i ustawia ciasteczko. */
export function startSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: number): void {
  const { db, config } = ctx;
  const token = randomToken();
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare(
    'INSERT INTO sessions (token_hash, id, user_id, expires_at, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), randomToken(9), userId, now + config.sessionTtlMs, now, now, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, userId);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlMs / 1000,
  });
}

/** Agent uwierzytelnia się nagłówkiem "Authorization: Bearer <agentId>.<secret>". */
export function agentFromRequest(db: Db, req: FastifyRequest): string | null {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const row = db.prepare('SELECT secret_hash FROM agents WHERE id = ?').get(m[1]) as { secret_hash: string } | undefined;
  if (!row || !safeEqualHex(row.secret_hash, sha256(m[2]))) return null;
  return m[1];
}

/** Przy pierwszym starcie tworzy konto właściciela. Zwraca wygenerowane hasło (jeśli było generowane). */
export async function ensureAdmin(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<{ username: string; password: string } | null> {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return null;
  const username = env.ADMIN_USER ?? 'admin';
  const password = env.ADMIN_PASSWORD ?? randomToken(12);
  db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    username,
    await hashPassword(password),
    Date.now(),
  );
  audit(db, 'system', 'user.create', username, { role: 'owner' });
  return env.ADMIN_PASSWORD ? null : { username, password };
}
