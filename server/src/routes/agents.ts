import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit, tx } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import type { AgentRow } from '../hub.ts';

const IdParams = z.object({ id: z.uuid() });
const PatchBody = z.object({ label: z.string().trim().max(100) });
const EnrollBody = z.object({
  token: z.string().min(1).max(200),
  hostname: z.string().max(255).default('unknown'),
  os: z.string().max(50).default(''),
  arch: z.string().max(50).default(''),
});

export async function agentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const auth = { preHandler: requireUser(ctx) };

  app.get('/api/agents', auth, async () => hub.listSummaries());

  app.get('/api/agents/:id', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!row) throw notFound();
    return { ...hub.rowToSummary(row), inventory: row.inventory_json ? JSON.parse(row.inventory_json) : null };
  });

  app.patch('/api/agents/:id', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { label } = parse(PatchBody, req.body);
    if (db.prepare('UPDATE agents SET label = ? WHERE id = ?').run(label, id).changes === 0) throw notFound();
    audit(db, actorOf(req), 'agent.label', id, { label }, req.ip);
    hub.broadcast({ type: 'agent_updated', id, data: hub.summary(id) });
    return { ok: true };
  });

  app.post('/api/agents/:id/refresh', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    const inventory = await hub.request<Record<string, unknown>>(id, 'inventory.refresh', undefined, { timeoutMs: 90_000 });
    hub.storeInventory(id, inventory);
    audit(db, actorOf(req), 'agent.refresh_inventory', id, null, req.ip);
    hub.broadcast({ type: 'agent_updated', id, data: hub.summary(id) });
    return { ok: true };
  });

  app.delete('/api/agents/:id', auth, async (req) => {
    const { id } = parse(IdParams, req.params);
    if (db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes === 0) throw notFound();
    // sekret agenta jest usunięty, więc nie połączy się ponownie
    hub.disconnectAgent(id, 'removed');
    audit(db, actorOf(req), 'agent.delete', id, null, req.ip);
    hub.broadcast({ type: 'agent_removed', id });
    return { ok: true };
  });

  // ---------- rejestracja agenta (bez sesji — uwierzytelnia token) ----------

  app.post('/api/agent/enroll', async (req) => {
    if (!ctx.limits.enroll.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób rejestracji.');
    const body = parse(EnrollBody, req.body);
    const now = Date.now();

    const result = tx(db, () => {
      const t = db.prepare('SELECT id, label, uses_left, expires_at FROM enroll_tokens WHERE token_hash = ?').get(sha256(body.token)) as
        | { id: number; label: string; uses_left: number | null; expires_at: number }
        | undefined;
      if (!t || t.expires_at < now || (t.uses_left !== null && t.uses_left <= 0)) return null;
      if (t.uses_left !== null) db.prepare('UPDATE enroll_tokens SET uses_left = uses_left - 1 WHERE id = ?').run(t.id);

      const agentId = crypto.randomUUID();
      const secret = randomToken(32);
      db.prepare('INSERT INTO agents (id, secret_hash, hostname, os, arch, enrolled_at, last_ip) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        agentId,
        sha256(secret),
        body.hostname,
        body.os,
        body.arch,
        now,
        req.ip,
      );
      return { agentId, secret, tokenLabel: t.label };
    });

    if (!result) {
      audit(db, 'system', 'agent.enroll_rejected', null, { hostname: body.hostname }, req.ip);
      throw new HttpError(403, 'invalid_token', 'Token jest nieprawidłowy, wygasł lub został wykorzystany.');
    }
    audit(db, `agent:${result.agentId}`, 'agent.enroll', result.agentId, { hostname: body.hostname, token: result.tokenLabel }, req.ip);
    hub.broadcast({ type: 'agent_added', id: result.agentId, data: hub.summary(result.agentId) });
    return { agentId: result.agentId, agentSecret: result.secret };
  });
}
