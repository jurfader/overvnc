import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { parse } from '../errors.ts';
import { requireUser } from '../auth.ts';

const Query = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });

export async function auditRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/audit', { preHandler: requireUser(ctx) }, async (req) => {
    const { limit } = parse(Query, req.query);
    return ctx.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  });
}
