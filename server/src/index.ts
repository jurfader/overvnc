import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, openDb } from './db.ts';
import { hashPassword, randomToken, safeEqualHex, sha256, verifyPassword } from './crypto.ts';
import { Hub, type AgentRow } from './hub.ts';
import { RateLimiter } from './ratelimit.ts';

// ---------- konfiguracja (zmienne środowiskowe) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, '../data');
const PANEL_DIR = process.env.PANEL_DIR ?? path.resolve(__dirname, '../../panel/dist');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // ustaw 1 na produkcji (HTTPS)
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // ustaw 1 za reverse proxy (Caddy/nginx)
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'overvnc_sid';

const db = openDb(DATA_DIR);
const hub = new Hub(db);
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000); // 10 prób / 15 min / IP
const enrollLimiter = new RateLimiter(20, 15 * 60 * 1000);

await ensureAdmin();
const DUMMY_HASH = await hashPassword(randomToken());

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: TRUST_PROXY,
  bodyLimit: 1024 * 1024,
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  );
});

// ---------- uwierzytelnianie administratora ----------

interface SessionUser {
  id: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

function userFromRequest(req: FastifyRequest): SessionUser | null {
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

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

const actor = (req: FastifyRequest) => `user:${req.user?.username ?? '?'}`;

app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
  if (!loginLimiter.hit(req.ip)) return reply.code(429).send({ error: 'too_many_attempts' });
  const { username = '', password = '' } = req.body ?? {};
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;
  // weryfikujemy hasło zawsze, żeby czas odpowiedzi nie zdradzał, czy login istnieje
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    audit(db, `user:${username}`, 'auth.login_failed', null, null, req.ip);
    return reply.code(401).send({ error: 'invalid_credentials' });
  }
  loginLimiter.reset(req.ip);
  const token = randomToken();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), row.id, Date.now() + SESSION_TTL_MS);
  audit(db, `user:${row.username}`, 'auth.login', null, null, req.ip);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  return { username: row.username };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({ username: req.user!.username }));

// ---------- komputery ----------

app.get('/api/agents', { preHandler: requireUser }, async () => hub.listSummaries());

app.get<{ Params: { id: string } }>('/api/agents/:id', { preHandler: requireUser }, async (req, reply) => {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as AgentRow | undefined;
  if (!row) return reply.code(404).send({ error: 'not_found' });
  return { ...hub.rowToSummary(row), inventory: row.inventory_json ? JSON.parse(row.inventory_json) : null };
});

app.patch<{ Params: { id: string }; Body: { label?: string } }>('/api/agents/:id', { preHandler: requireUser }, async (req, reply) => {
  const label = String(req.body?.label ?? '').slice(0, 100);
  const res = db.prepare('UPDATE agents SET label = ? WHERE id = ?').run(label, req.params.id);
  if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
  audit(db, actor(req), 'agent.label', req.params.id, { label }, req.ip);
  hub.broadcast({ type: 'agent_updated', id: req.params.id, data: hub.summary(req.params.id) });
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/agents/:id/refresh', { preHandler: requireUser }, async (req, reply) => {
  if (!hub.sendToAgent(req.params.id, { type: 'refresh_inventory' })) return reply.code(409).send({ error: 'offline' });
  audit(db, actor(req), 'agent.refresh_inventory', req.params.id, null, req.ip);
  return { ok: true };
});

app.delete<{ Params: { id: string } }>('/api/agents/:id', { preHandler: requireUser }, async (req, reply) => {
  const res = db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
  if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
  // sekret agenta jest usunięty, więc nie połączy się ponownie
  hub.disconnectAgent(req.params.id, 'removed');
  audit(db, actor(req), 'agent.delete', req.params.id, null, req.ip);
  hub.broadcast({ type: 'agent_removed', id: req.params.id });
  return { ok: true };
});

// ---------- tokeny rejestracji ----------

app.get('/api/enroll-tokens', { preHandler: requireUser }, async () =>
  db
    .prepare(
      `SELECT t.id, t.label, t.uses_left AS usesLeft, t.expires_at AS expiresAt, t.created_at AS createdAt, u.username AS createdBy
       FROM enroll_tokens t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC`,
    )
    .all(),
);

app.post<{ Body: { label?: string; ttlHours?: number; maxUses?: number | null } }>(
  '/api/enroll-tokens',
  { preHandler: requireUser },
  async (req) => {
    const label = String(req.body?.label ?? '').slice(0, 100) || 'bez nazwy';
    const ttlHours = clamp(Number(req.body?.ttlHours ?? 24), 1, 24 * 365);
    const maxUses = req.body?.maxUses == null ? null : clamp(Number(req.body.maxUses), 1, 10_000);
    const token = `ovnc_${randomToken(24)}`;
    const now = Date.now();
    const res = db
      .prepare('INSERT INTO enroll_tokens (token_hash, label, uses_left, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), label, maxUses, now + ttlHours * 3600_000, req.user!.id, now);
    audit(db, actor(req), 'enroll_token.create', String(res.lastInsertRowid), { label, ttlHours, maxUses }, req.ip);
    // token w postaci jawnej zwracamy tylko raz
    return { id: Number(res.lastInsertRowid), token };
  },
);

app.delete<{ Params: { id: string } }>('/api/enroll-tokens/:id', { preHandler: requireUser }, async (req) => {
  db.prepare('DELETE FROM enroll_tokens WHERE id = ?').run(Number(req.params.id));
  audit(db, actor(req), 'enroll_token.delete', req.params.id, null, req.ip);
  return { ok: true };
});

// ---------- dziennik zdarzeń ----------

app.get<{ Querystring: { limit?: string } }>('/api/audit', { preHandler: requireUser }, async (req) => {
  const limit = clamp(Number(req.query.limit ?? 200), 1, 1000);
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
});

// ---------- rejestracja agenta ----------

app.post<{ Body: { token?: string; hostname?: string; os?: string; arch?: string } }>('/api/agent/enroll', async (req, reply) => {
  if (!enrollLimiter.hit(req.ip)) return reply.code(429).send({ error: 'too_many_attempts' });
  const token = String(req.body?.token ?? '');
  const hostname = String(req.body?.hostname ?? 'unknown').slice(0, 255);
  const now = Date.now();

  // atomowo: sprawdź token i zużyj jedno użycie
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare('SELECT id, label, uses_left, expires_at FROM enroll_tokens WHERE token_hash = ?').get(sha256(token)) as
      | { id: number; label: string; uses_left: number | null; expires_at: number }
      | undefined;
    if (!t || t.expires_at < now || (t.uses_left !== null && t.uses_left <= 0)) {
      db.exec('ROLLBACK');
      audit(db, 'system', 'agent.enroll_rejected', null, { hostname }, req.ip);
      return reply.code(403).send({ error: 'invalid_token' });
    }
    if (t.uses_left !== null) db.prepare('UPDATE enroll_tokens SET uses_left = uses_left - 1 WHERE id = ?').run(t.id);

    const agentId = crypto.randomUUID();
    const secret = randomToken(32);
    db.prepare(
      'INSERT INTO agents (id, secret_hash, hostname, os, arch, enrolled_at, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(agentId, sha256(secret), hostname, String(req.body?.os ?? '').slice(0, 50), String(req.body?.arch ?? '').slice(0, 50), now, req.ip);
    db.exec('COMMIT');

    audit(db, `agent:${agentId}`, 'agent.enroll', agentId, { hostname, token: t.label }, req.ip);
    hub.broadcast({ type: 'agent_added', id: agentId, data: hub.summary(agentId) });
    return { agentId, agentSecret: secret };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// ---------- WebSockety ----------

/** Agent: nagłówek "Authorization: Bearer <agentId>.<secret>". */
function agentFromRequest(req: FastifyRequest): string | null {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const row = db.prepare('SELECT secret_hash FROM agents WHERE id = ?').get(m[1]) as { secret_hash: string } | undefined;
  if (!row || !safeEqualHex(row.secret_hash, sha256(m[2]))) return null;
  return m[1];
}

app.register(async (scope) => {
  scope.get(
    '/ws/agent',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!agentFromRequest(req)) {
          audit(db, 'system', 'agent.auth_failed', null, null, req.ip);
          return reply.code(401).send({ error: 'unauthorized' });
        }
      },
    },
    (socket, req) => {
      hub.attachAgent(agentFromRequest(req)!, socket, req.ip);
    },
  );

  scope.get(
    '/ws/panel',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        // ochrona przed cross-site WebSocket hijacking
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'bad_origin' });
        if (!userFromRequest(req)) return reply.code(401).send({ error: 'unauthorized' });
      },
    },
    (socket) => hub.attachPanel(socket),
  );
});

// ---------- panel (pliki statyczne) ----------

if (existsSync(PANEL_DIR)) {
  await app.register(fastifyStatic, { root: PANEL_DIR }); // dynamicznie — przebudowa panelu nie wymaga restartu
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
} else {
  app.log.warn(`Brak zbudowanego panelu w ${PANEL_DIR} — uruchom "npm run build" w katalogu panel/ (albo "npm run dev" dla trybu deweloperskiego).`);
}

await app.listen({ port: PORT, host: HOST });

// ---------- pomocnicze ----------

async function ensureAdmin(): Promise<void> {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return;
  const username = process.env.ADMIN_USER ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? randomToken(12);
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(username, await hashPassword(password), Date.now());
  audit(db, 'system', 'user.create', username);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('\n==================================================');
    console.log(' Utworzono konto administratora (pokazywane tylko raz):');
    console.log(`   login: ${username}`);
    console.log(`   hasło: ${password}`);
    console.log(' Zmiana hasła: npm run cli -- passwd <login>');
    console.log('==================================================\n');
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : min;
}
