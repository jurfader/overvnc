import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { notFound, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';

const CreateBody = z.object({
  label: z.string().trim().max(100).default(''),
  ttlHours: z.number().int().min(1).max(24 * 365).default(24),
  maxUses: z.number().int().min(1).max(10_000).nullable().default(1),
});
const IdParams = z.object({ id: z.coerce.number().int().positive() });

export async function tokenRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/enroll-tokens', auth, async () =>
    db
      .prepare(
        `SELECT t.id, t.label, t.uses_left AS usesLeft, t.expires_at AS expiresAt, t.created_at AS createdAt, u.username AS createdBy
         FROM enroll_tokens t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC`,
      )
      .all(),
  );

  app.post('/api/enroll-tokens', auth, async (req) => {
    const body = parse(CreateBody, req.body);
    const label = body.label || 'bez nazwy';
    const token = `ovnc_${randomToken(24)}`;
    const now = Date.now();
    const res = db
      .prepare('INSERT INTO enroll_tokens (token_hash, label, uses_left, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), label, body.maxUses, now + body.ttlHours * 3600_000, req.user!.id, now);
    const id = Number(res.lastInsertRowid);
    audit(db, actorOf(req), 'enroll_token.create', String(id), { label, ttlHours: body.ttlHours, maxUses: body.maxUses }, req.ip);
    // token w postaci jawnej zwracamy tylko raz — w bazie jest wyłącznie jego skrót
    return { id, token };
  });

  app.delete('/api/enroll-tokens/:id', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    if (db.prepare('DELETE FROM enroll_tokens WHERE id = ?').run(id).changes === 0) throw notFound();
    audit(db, actorOf(req), 'enroll_token.delete', String(id), null, req.ip);
    return { ok: true };
  });
}
