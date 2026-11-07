import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit, tx } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { HttpError, parse } from '../errors.ts';
import { actorOf, requireUser } from '../auth.ts';
import { assertAgentAccess, assertPlacement, scopeSql } from '../scope.ts';
import { pushProfile } from '../profile.ts';

const IdParams = z.object({ id: z.uuid() });
const TagIds = z.array(z.number().int().positive()).max(100);
const PatchBody = z.object({
  label: z.string().trim().max(100).optional(),
  notes: z.string().max(5000).optional(),
  clientId: z.number().int().positive().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  tagIds: TagIds.optional(),
  // profil: zwykły komputer albo kiosk; dla kiosku aplikacja „Zdjęcia z telefonu”
  kind: z.enum(['computer', 'kiosk']).optional(),
  phoneApp: z.boolean().optional(),
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

  // historia zmian: programy, system, sprzęt, zabezpieczenia (porównanie kolejnych inwentarzy)
  const ChangesQuery = z.object({
    kind: z.enum(['software', 'os', 'hardware', 'security', 'system']).optional(),
    before: z.coerce.number().int().positive().optional(), // id ostatniego wpisu z poprzedniej strony
    limit: z.coerce.number().int().min(1).max(200).default(100),
  });
  const CHANGE_COLS = 'x.id, x.agent_id AS agentId, x.ts, x.kind, x.title, x.detail';
  app.get('/api/agents/:id/changes', view, async (req) => {
    const { id } = access(req);
    const q = parse(ChangesQuery, req.query);
    const rows = db
      .prepare(
        `SELECT ${CHANGE_COLS} FROM agent_changes x WHERE x.agent_id = ?${q.kind ? ' AND x.kind = ?' : ''}${q.before ? ' AND x.id < ?' : ''} ORDER BY x.id DESC LIMIT ?`,
      )
      .all(...([id, q.kind, q.before, q.limit].filter((v) => v !== undefined) as (string | number)[]));
    return { items: rows };
  });

  // zmiany na wszystkich widocznych komputerach (np. „gdzie zainstalowano X”)
  const AllChangesQuery = ChangesQuery.extend({ q: z.string().trim().max(100).optional() });
  app.get('/api/changes', view, async (req) => {
    const q = parse(AllChangesQuery, req.query);
    const where = scopeSql(req.user!, 'a.client_id');
    const conds = [where.sql];
    const params: (string | number)[] = [...where.params];
    if (q.kind) conds.push('x.kind = ?'), params.push(q.kind);
    if (q.before) conds.push('x.id < ?'), params.push(q.before);
    if (q.q) conds.push("(x.title LIKE ? ESCAPE '\\' OR x.detail LIKE ? ESCAPE '\\')"), params.push(...Array(2).fill(`%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`));
    const rows = db
      .prepare(
        `SELECT ${CHANGE_COLS}, a.hostname, a.label, c.name AS clientName FROM agent_changes x JOIN agents a ON a.id = x.agent_id LEFT JOIN clients c ON c.id = a.client_id
         WHERE ${conds.join(' AND ')} ORDER BY x.id DESC LIMIT ?`,
      )
      .all(...params, q.limit);
    return { items: rows };
  });

  // historia metryk do wykresów monitoringu
  const RANGES: Record<string, number> = { '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };
  const MetricsQuery = z.object({ range: z.enum(['1h', '6h', '24h', '7d']).default('24h') });
  app.get('/api/agents/:id/metrics', view, async (req) => {
    const { id } = access(req);
    const { range } = parse(MetricsQuery, req.query);
    return { range, samples: ctx.metrics.history(id, Date.now() - RANGES[range]) };
  });

  app.patch('/api/agents/:id', manage, async (req) => {
    const { id, clientId: curClient } = access(req);
    const body = parse(PatchBody, req.body);
    const cur = db.prepare('SELECT label, notes, site_id, kind, phone_app FROM agents WHERE id = ?').get(id) as {
      label: string;
      notes: string;
      site_id: number | null;
      kind: string;
      phone_app: number;
    };

    const clientId = body.clientId !== undefined ? body.clientId : curClient;
    // zmiana klienta bez podania lokalizacji czyści lokalizację (należała do starego klienta)
    const siteId = body.siteId !== undefined ? body.siteId : body.clientId !== undefined && body.clientId !== curClient ? null : cur.site_id;
    if (body.clientId !== undefined || body.siteId !== undefined) assertPlacement(db, req.user!, clientId, siteId);
    if (body.tagIds) assertTagsExist(body.tagIds);

    tx(db, () => {
      db.prepare('UPDATE agents SET label = ?, notes = ?, client_id = ?, site_id = ?, kind = ?, phone_app = ? WHERE id = ?').run(
        body.label ?? cur.label,
        body.notes ?? cur.notes,
        clientId,
        siteId,
        body.kind ?? cur.kind,
        body.phoneApp === undefined ? cur.phone_app : body.phoneApp ? 1 : 0,
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
    // zmiana profilu: od razu do agenta (gdy offline — po połączeniu); uwaga agenta wraca do panelu
    let note: string | null = null;
    if ((body.kind !== undefined && body.kind !== cur.kind) || (body.phoneApp !== undefined && (body.phoneApp ? 1 : 0) !== cur.phone_app)) {
      try {
        note = await pushProfile(db, hub, id);
      } catch (e) {
        note = `Komputer nie zastosował profilu: ${(e as Error).message}`;
      }
    }
    return { ...hub.summary(id), profileNote: note };
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

  /**
   * Nazwa komputera w panelu = nazwa wpisana przy tworzeniu tokenu (nie nazwa z systemu).
   * Token na kilka komputerów: kolejne dostają numer („Kiosk”, „Kiosk 2”, „Kiosk 3”…).
   */
  const labelFromToken = (name: string): string => {
    if (!name || name === 'bez nazwy') return '';
    const taken = new Set(
      (db.prepare('SELECT label FROM agents WHERE label = ? OR label LIKE ?').all(name, `${name} %`) as { label: string }[]).map((r) => r.label),
    );
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
  };

  app.post('/api/agent/enroll', async (req) => {
    if (!ctx.limits.enroll.hit(req.ip)) throw new HttpError(429, 'too_many_attempts', 'Zbyt wiele prób rejestracji.');
    const body = parse(EnrollBody, req.body);
    const now = Date.now();

    const result = tx(db, () => {
      const t = db.prepare('SELECT id, label, uses_left, expires_at, client_id, site_id, kind FROM enroll_tokens WHERE token_hash = ?').get(sha256(body.token)) as
        | { id: number; label: string; uses_left: number | null; expires_at: number; client_id: number | null; site_id: number | null; kind: string }
        | undefined;
      if (!t || t.expires_at < now || (t.uses_left !== null && t.uses_left <= 0)) return null;
      if (t.uses_left !== null) db.prepare('UPDATE enroll_tokens SET uses_left = uses_left - 1 WHERE id = ?').run(t.id);

      const agentId = crypto.randomUUID();
      const secret = randomToken(32);
      db.prepare(
        'INSERT INTO agents (id, secret_hash, hostname, label, os, arch, enrolled_at, last_ip, client_id, site_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentId, sha256(secret), body.hostname, labelFromToken(t.label), body.os, body.arch, now, req.ip, t.client_id, t.site_id, t.kind);
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
