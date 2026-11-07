import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { notFound, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertPlacement, canSeeClient, scopeSql } from '../scope.ts';

const CreateBody = z.object({
  label: z.string().trim().max(100).default(''),
  ttlHours: z.number().int().min(1).max(24 * 365).default(24),
  maxUses: z.number().int().min(1).max(10_000).nullable().default(1),
  clientId: z.number().int().positive().nullable().default(null),
  siteId: z.number().int().positive().nullable().default(null),
  // komputery z tego tokenu rejestrują się jako kioski („Dodaj kiosk”)
  kind: z.enum(['computer', 'kiosk']).default('computer'),
});
const IdParams = z.object({ id: z.coerce.number().int().positive() });

export async function tokenRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const auth = { preHandler: requireUser(ctx, 'tokens.manage') };

  app.get('/api/enroll-tokens', auth, async (req) => {
    const where = scopeSql(req.user!, 't.client_id');
    return db
      .prepare(
        `SELECT t.id, t.label, t.kind, t.uses_left AS usesLeft, t.expires_at AS expiresAt, t.created_at AS createdAt, u.username AS createdBy,
                t.client_id AS clientId, c.name AS clientName, t.site_id AS siteId, s.name AS siteName
         FROM enroll_tokens t
         LEFT JOIN users u ON u.id = t.created_by
         LEFT JOIN clients c ON c.id = t.client_id
         LEFT JOIN sites s ON s.id = t.site_id
         WHERE ${where.sql} ORDER BY t.created_at DESC`,
      )
      .all(...where.params);
  });

  app.post('/api/enroll-tokens', auth, async (req) => {
    const body = parse(CreateBody, req.body);
    // konto z ograniczonym zakresem musi wskazać jednego ze swoich klientów
    assertPlacement(db, req.user!, body.clientId, body.siteId);
    const label = body.label || 'bez nazwy';
    const token = `ovnc_${randomToken(24)}`;
    const now = Date.now();
    const res = db
      .prepare(
        'INSERT INTO enroll_tokens (token_hash, label, uses_left, expires_at, created_by, created_at, client_id, site_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sha256(token), label, body.maxUses, now + body.ttlHours * 3600_000, req.user!.id, now, body.clientId, body.siteId, body.kind);
    const id = Number(res.lastInsertRowid);
    audit(db, actorOf(req), 'enroll_token.create', String(id), { label, ttlHours: body.ttlHours, maxUses: body.maxUses, clientId: body.clientId }, req.ip);
    // token w postaci jawnej zwracamy tylko raz — w bazie jest wyłącznie jego skrót
    return { id, token };
  });

  app.delete('/api/enroll-tokens/:id', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    const t = db.prepare('SELECT client_id FROM enroll_tokens WHERE id = ?').get(id) as { client_id: number | null } | undefined;
    if (!t || !canSeeClient(req.user!, t.client_id)) throw notFound();
    db.prepare('DELETE FROM enroll_tokens WHERE id = ?').run(id);
    audit(db, actorOf(req), 'enroll_token.delete', String(id), null, req.ip);
    return { ok: true };
  });
}
