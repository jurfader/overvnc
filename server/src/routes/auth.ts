import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto.ts';
import { HttpError, parse } from '../errors.ts';
import { requireUser, SESSION_COOKIE } from '../auth.ts';

const LoginBody = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
});

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  // weryfikujemy hasło zawsze, żeby czas odpowiedzi nie zdradzał, czy login istnieje
  const dummyHash = await hashPassword(randomToken());

  app.post('/api/auth/login', async (req, reply) => {
    if (!ctx.limits.login.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób logowania. Spróbuj za kilka minut.');
    const { username, password } = parse(LoginBody, req.body);
    const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
      | { id: number; username: string; password_hash: string }
      | undefined;
    const ok = await verifyPassword(password, row?.password_hash ?? dummyHash);
    if (!row || !ok) {
      audit(db, `user:${username}`, 'auth.login_failed', null, null, req.ip);
      throw new HttpError(401, 'invalid_credentials', 'Nieprawidłowy login lub hasło.');
    }
    ctx.limits.login.reset(req.ip);

    const token = randomToken();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), row.id, Date.now() + config.sessionTtlMs);
    audit(db, `user:${row.username}`, 'auth.login', null, null, req.ip);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      path: '/',
      maxAge: config.sessionTtlMs / 1000,
    });
    return { username: row.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser(ctx) }, async (req) => ({ username: req.user!.username }));
}
