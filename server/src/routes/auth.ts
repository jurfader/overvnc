import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit, tx } from '../db.ts';
import { decryptSecret, encryptSecret, hashPassword, randomToken, sha256, verifyPassword } from '../crypto.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireUser, SESSION_COOKIE, startSession } from '../auth.ts';
import { generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../totp.ts';
import { MFA_REQUIRED_ROLES, permissionsOf, ROLE_LABELS, type Role } from '../permissions.ts';

const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_MAX_ATTEMPTS = 5;
export const MIN_PASSWORD = 10;

const LoginBody = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });
const MfaBody = z.object({ ticket: z.string().min(1).max(200), code: z.string().min(1).max(50) });
const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(500),
  newPassword: z.string().min(MIN_PASSWORD, `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`).max(500),
});
const CodeBody = z.object({ code: z.string().min(1).max(20) });
const PasswordOnly = z.object({ password: z.string().min(1).max(500) });
const SessionParams = z.object({ id: z.string().min(1).max(50) });

interface AuthRow {
  id: number;
  username: string;
  password_hash: string;
  disabled: number;
  role: Role;
  totp_enabled: number;
  totp_secret: string | null;
  totp_last_step: number;
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  // hasło sprawdzamy zawsze, żeby czas odpowiedzi nie zdradzał, czy login istnieje
  const dummyHash = await hashPassword(randomToken());
  const authed = { preHandler: requireUser(ctx, undefined, { allowRestricted: true }) };

  const loadAuth = (userId: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as AuthRow;

  /** Sprawdza kod TOTP albo kod zapasowy; zapisuje zużycie (ochrona przed powtórzeniem). */
  const verifySecondFactor = (u: AuthRow, code: string): 'totp' | 'recovery' | null => {
    if (u.totp_secret && /^\d{6}$/.test(code.replace(/\s/g, ''))) {
      const step = verifyTotp(decryptSecret(ctx.secretKey, u.totp_secret), code, u.totp_last_step);
      if (step === null) return null;
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
      return 'totp';
    }
    const hash = sha256(normalizeRecoveryCode(code));
    const res = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(Date.now(), u.id, hash);
    return res.changes > 0 ? 'recovery' : null;
  };

  const loginLimit = (req: FastifyRequest) => {
    if (!ctx.limits.login.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób logowania. Spróbuj za kilka minut.');
  };

  // ---------- logowanie ----------

  app.post('/api/auth/login', async (req, reply) => {
    loginLimit(req);
    const { username, password } = parse(LoginBody, req.body);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as AuthRow | undefined;
    const ok = await verifyPassword(password, u?.password_hash ?? dummyHash);
    if (!u || !ok) {
      audit(db, `user:${username}`, 'auth.login_failed', null, null, req.ip);
      throw new HttpError(401, 'invalid_credentials', 'Nieprawidłowy login lub hasło.');
    }
    if (u.disabled) {
      audit(db, `user:${u.username}`, 'auth.login_disabled', null, null, req.ip);
      throw new HttpError(403, 'account_disabled', 'Konto jest zablokowane. Skontaktuj się z właścicielem.');
    }

    if (u.totp_enabled) {
      // drugi krok: bilet zamiast sesji
      const ticket = randomToken();
      db.prepare('DELETE FROM login_tickets WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT INTO login_tickets (ticket_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(ticket), u.id, Date.now() + TICKET_TTL_MS);
      return { mfaRequired: true, ticket };
    }

    ctx.limits.login.reset(req.ip);
    startSession(ctx, req, reply, u.id);
    audit(db, `user:${u.username}`, 'auth.login', null, null, req.ip);
    return { username: u.username };
  });

  app.post('/api/auth/login/mfa', async (req, reply) => {
    loginLimit(req);
    const { ticket, code } = parse(MfaBody, req.body);
    const t = db.prepare('SELECT user_id, expires_at, attempts FROM login_tickets WHERE ticket_hash = ?').get(sha256(ticket)) as
      | { user_id: number; expires_at: number; attempts: number }
      | undefined;
    if (!t || t.expires_at < Date.now() || t.attempts >= TICKET_MAX_ATTEMPTS) {
      throw new HttpError(401, 'ticket_expired', 'Sesja logowania wygasła. Zaloguj się ponownie.');
    }
    const u = loadAuth(t.user_id);
    if (!u || u.disabled) throw new HttpError(401, 'ticket_expired', 'Sesja logowania wygasła. Zaloguj się ponownie.');

    const method = verifySecondFactor(u, code);
    if (!method) {
      db.prepare('UPDATE login_tickets SET attempts = attempts + 1 WHERE ticket_hash = ?').run(sha256(ticket));
      audit(db, `user:${u.username}`, 'auth.mfa_failed', null, null, req.ip);
      throw new HttpError(401, 'invalid_code', 'Nieprawidłowy kod.');
    }
    db.prepare('DELETE FROM login_tickets WHERE ticket_hash = ?').run(sha256(ticket));
    ctx.limits.login.reset(req.ip);
    startSession(ctx, req, reply, u.id);
    audit(db, `user:${u.username}`, 'auth.login', null, { mfa: method }, req.ip);
    return { username: u.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', authed, async (req) => {
    const u = req.user!;
    const unusedCodes = (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(u.id) as { n: number }).n;
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role],
      permissions: permissionsOf(u.role),
      allClients: u.allClients,
      clientIds: u.clientIds,
      mfaEnabled: u.mfaEnabled,
      mfaRequired: config.requireMfa && MFA_REQUIRED_ROLES.includes(u.role),
      recoveryCodesLeft: unusedCodes,
      restriction: u.restriction,
    };
  });

  // ---------- hasło ----------

  app.post('/api/auth/password', authed, async (req) => {
    const { currentPassword, newPassword } = parse(PasswordBody, req.body);
    const u = loadAuth(req.user!.id);
    if (!(await verifyPassword(currentPassword, u.password_hash))) throw new HttpError(400, 'invalid_password', 'Obecne hasło jest nieprawidłowe.');
    if (currentPassword === newPassword) throw new HttpError(400, 'validation', 'Nowe hasło musi różnić się od obecnego.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(newPassword), u.id);
    // wyloguj pozostałe sesje — ktoś mógł znać stare hasło
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(u.id, req.user!.sessionId);
    audit(db, actorOf(req), 'auth.password_change', null, null, req.ip);
    return { ok: true };
  });

  // ---------- 2FA ----------

  app.post('/api/auth/2fa/setup', authed, async (req) => {
    const u = req.user!;
    if (u.mfaEnabled) throw new HttpError(409, 'mfa_already_enabled', 'Weryfikacja dwuetapowa jest już włączona.');
    const secret = generateSecret();
    // sekret czeka na potwierdzenie kodem (totp_enabled = 0)
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(encryptSecret(ctx.secretKey, secret), u.id);
    return { secret, otpauthUrl: otpauthUrl(secret, u.username) };
  });

  app.post('/api/auth/2fa/enable', authed, async (req) => {
    const { code } = parse(CodeBody, req.body);
    const u = loadAuth(req.user!.id);
    if (u.totp_enabled) throw new HttpError(409, 'mfa_already_enabled', 'Weryfikacja dwuetapowa jest już włączona.');
    if (!u.totp_secret) throw new HttpError(400, 'mfa_not_started', 'Najpierw wygeneruj kod QR.');
    const step = verifyTotp(decryptSecret(ctx.secretKey, u.totp_secret), code);
    if (step === null) throw new HttpError(400, 'invalid_code', 'Nieprawidłowy kod. Sprawdź, czy czas w telefonie jest ustawiony automatycznie.');
    const codes = generateRecoveryCodes();
    tx(db, () => {
      db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, u.id);
      replaceRecoveryCodes(u.id, codes);
    });
    audit(db, actorOf(req), 'auth.mfa_enable', null, null, req.ip);
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/2fa/disable', authed, async (req) => {
    const { password } = parse(PasswordOnly, req.body);
    const u = loadAuth(req.user!.id);
    if (config.requireMfa && MFA_REQUIRED_ROLES.includes(u.role)) {
      throw new HttpError(403, 'mfa_required', `Rola „${ROLE_LABELS[u.role]}” wymaga weryfikacji dwuetapowej.`);
    }
    if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'invalid_password', 'Nieprawidłowe hasło.');
    disableMfa(u.id);
    audit(db, actorOf(req), 'auth.mfa_disable', null, null, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery-codes', authed, async (req) => {
    const { password } = parse(PasswordOnly, req.body);
    const u = loadAuth(req.user!.id);
    if (!u.totp_enabled) throw new HttpError(400, 'mfa_not_enabled', 'Weryfikacja dwuetapowa nie jest włączona.');
    if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'invalid_password', 'Nieprawidłowe hasło.');
    const codes = generateRecoveryCodes();
    replaceRecoveryCodes(u.id, codes);
    audit(db, actorOf(req), 'auth.recovery_codes_regenerate', null, null, req.ip);
    return { recoveryCodes: codes };
  });

  // ---------- sesje ----------

  app.get('/api/auth/sessions', authed, async (req) => {
    const rows = db
      .prepare('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(req.user!.id, Date.now()) as { id: string; created_at: number; last_seen_at: number; ip: string | null; user_agent: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      ip: r.ip,
      userAgent: r.user_agent,
      current: r.id === req.user!.sessionId,
    }));
  });

  app.delete('/api/auth/sessions/:id', authed, async (req) => {
    const { id } = parse(SessionParams, req.params);
    if (db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, req.user!.id).changes === 0) throw notFound();
    audit(db, actorOf(req), 'auth.session_revoke', id, null, req.ip);
    return { ok: true };
  });

  app.delete('/api/auth/sessions', authed, async (req) => {
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user!.id, req.user!.sessionId).changes;
    audit(db, actorOf(req), 'auth.session_revoke_others', null, { count: n }, req.ip);
    return { revoked: Number(n) };
  });

  // ---------- pomocnicze ----------

  function replaceRecoveryCodes(userId: number, codes: string[]): void {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, sha256(normalizeRecoveryCode(c)));
  }

  function disableMfa(userId: number): void {
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?').run(userId);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  }

}
