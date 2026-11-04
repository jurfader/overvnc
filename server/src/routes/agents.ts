import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit, tx } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess, assertPlacement } from '../scope.ts';

const IdParams = z.object({ id: z.uuid() });
const TagIds = z.array(z.number().int().positive()).max(100);
const PatchBody = z.object({
  label: z.string().trim().max(100).optional(),
  notes: z.string().max(5000).optional(),
  clientId: z.number().int().positive().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  tagIds: TagIds.optional(),
});
const BulkBody = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  clientId: z.number().int().positive().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  addTagIds: TagIds.default([]),
  removeTagIds: TagIds.default([]),
});
const EnrollBody = z.object({
  token: z.string().min(1).max(200),
  hostname: z.string().max(255).default('unknown'),
  os: z.string().max(50).default(''),
  arch: z.string().max(50).default(''),
});

export async function agentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const view = { preHandler: requireUser(ctx, 'agents.view') };
  const manage = { preHandler: requireUser(ctx, 'agents.manage') };
  const refresh = { preHandler: requireUser(ctx, 'agents.refresh') };

  const assertTagsExist = (ids: number[]) => {
    if (ids.length === 0) return;
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number };
    if (n !== new Set(ids).size) throw new HttpError(400, 'validation', 'Nieznany tag.');
  };

  const pushUpdate = (id: string) => hub.broadcastAgent(id, { type: 'agent_updated', id, data: hub.summary(id) });

  /** Dostęp do komputera w zakresie konta (404 poza zakresem). */
  const access = (req: FastifyRequest) => {
    const { id } = parse(IdParams, req.params);
    return { id, ...assertAgentAccess(db, req.user!, id) };
  };

  app.get('/api/agents', view, async (req) => hub.listSummaries(req.user!));

  app.get('/api/agents/:id', view, async (req) => {
    const { id } = access(req);
    const inv = db.prepare('SELECT inventory_json FROM agents WHERE id = ?').get(id) as { inventory_json: string | null };
    return { ...hub.summary(id)!, inventory: inv.inventory_json ? JSON.parse(inv.inventory_json) : null };
  });

  app.patch('/api/agents/:id', manage, async (req) => {
    const { id, clientId: curClient } = access(req);
    const body = parse(PatchBody, req.body);
    const cur = db.prepare('SELECT label, notes, site_id FROM agents WHERE id = ?').get(id) as { label: string; notes: string; site_id: number | null };

    const clientId = body.clientId !== undefined ? body.clientId : curClient;
    // zmiana klienta bez podania lokalizacji czyści lokalizację (należała do starego klienta)
    const siteId = body.siteId !== undefined ? body.siteId : body.clientId !== undefined && body.clientId !== curClient ? null : cur.site_id;
    if (body.clientId !== undefined || body.siteId !== undefined) assertPlacement(db, req.user!, clientId, siteId);
    if (body.tagIds) assertTagsExist(body.tagIds);

    tx(db, () => {
      db.prepare('UPDATE agents SET label = ?, notes = ?, client_id = ?, site_id = ? WHERE id = ?').run(
        body.label ?? cur.label,
        body.notes ?? cur.notes,
        clientId,
        siteId,
        id,
      );
      if (body.tagIds) {
        db.prepare('DELETE FROM agent_tags WHERE agent_id = ?').run(id);
        const ins = db.prepare('INSERT INTO agent_tags (agent_id, tag_id) VALUES (?, ?)');
        for (const t of new Set(body.tagIds)) ins.run(id, t);
      }
    });
    audit(db, actorOf(req), 'agent.update', id, body, req.ip);
    pushUpdate(id);
    return hub.summary(id);
  });

  app.post('/api/agents/bulk', manage, async (req) => {
    const body = parse(BulkBody, req.body);
    const ids = [...new Set(body.ids)];
    for (const id of ids) assertAgentAccess(db, req.user!, id);
    const placing = body.clientId !== undefined;
    if (placing) assertPlacement(db, req.user!, body.clientId!, body.siteId ?? null);
    else if (body.siteId !== undefined) throw new HttpError(400, 'validation', 'Lokalizację ustawia się razem z klientem.');
    assertTagsExist([...body.addTagIds, ...body.removeTagIds]);

    tx(db, () => {
      const place = db.prepare('UPDATE agents SET client_id = ?, site_id = ? WHERE id = ?');
      const add = db.prepare('INSERT OR IGNORE INTO agent_tags (agent_id, tag_id) VALUES (?, ?)');
      const remove = db.prepare('DELETE FROM agent_tags WHERE agent_id = ? AND tag_id = ?');
      for (const id of ids) {
        if (placing) place.run(body.clientId!, body.siteId ?? null, id);
        for (const t of body.addTagIds) add.run(id, t);
        for (const t of body.removeTagIds) remove.run(id, t);
      }
    });
    audit(db, actorOf(req), 'agent.bulk_update', null, { count: ids.length, clientId: body.clientId, siteId: body.siteId, add: body.addTagIds, remove: body.removeTagIds }, req.ip);
    for (const id of ids) pushUpdate(id);
    return { updated: ids.length };
  });

  app.post('/api/agents/:id/refresh', refresh, async (req) => {
    const { id } = access(req);
    const inventory = await hub.request<Record<string, unknown>>(id, 'inventory.refresh', undefined, { timeoutMs: 90_000 });
    hub.storeInventory(id, inventory);
    audit(db, actorOf(req), 'agent.refresh_inventory', id, null, req.ip);
    pushUpdate(id);
    return { ok: true };
  });

  app.delete('/api/agents/:id', manage, async (req) => {
    const { id } = access(req);
    hub.broadcastAgent(id, { type: 'agent_removed', id }); // zanim zniknie wiersz z client_id
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    // sekret agenta jest usunięty, więc nie połączy się ponownie
    hub.disconnectAgent(id, 'removed');
    audit(db, actorOf(req), 'agent.delete', id, null, req.ip);
    return { ok: true };
  });

  // ---------- rejestracja agenta (bez sesji — uwierzytelnia token) ----------

  app.post('/api/agent/enroll', async (req) => {
    if (!ctx.limits.enroll.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób rejestracji.');
    const body = parse(EnrollBody, req.body);
    const now = Date.now();

    const result = tx(db, () => {
      const t = db.prepare('SELECT id, label, uses_left, expires_at, client_id, site_id FROM enroll_tokens WHERE token_hash = ?').get(sha256(body.token)) as
        | { id: number; label: string; uses_left: number | null; expires_at: number; client_id: number | null; site_id: number | null }
        | undefined;
      if (!t || t.expires_at < now || (t.uses_left !== null && t.uses_left <= 0)) return null;
      if (t.uses_left !== null) db.prepare('UPDATE enroll_tokens SET uses_left = uses_left - 1 WHERE id = ?').run(t.id);

      const agentId = crypto.randomUUID();
      const secret = randomToken(32);
      db.prepare(
        'INSERT INTO agents (id, secret_hash, hostname, os, arch, enrolled_at, last_ip, client_id, site_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentId, sha256(secret), body.hostname, body.os, body.arch, now, req.ip, t.client_id, t.site_id);
      return { agentId, secret, tokenLabel: t.label };
    });

    if (!result) {
      audit(db, 'system', 'agent.enroll_rejected', null, { hostname: body.hostname }, req.ip);
      throw new HttpError(403, 'invalid_token', 'Token jest nieprawidłowy, wygasł lub został wykorzystany.');
    }
    audit(db, `agent:${result.agentId}`, 'agent.enroll', result.agentId, { hostname: body.hostname, token: result.tokenLabel }, req.ip);
    hub.broadcastAgent(result.agentId, { type: 'agent_added', id: result.agentId, data: hub.summary(result.agentId) });
    return { agentId: result.agentId, agentSecret: result.secret };
  });
}
