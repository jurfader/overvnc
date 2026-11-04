import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { audit } from '../db.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { actorOf, requireGlobal, requireUser } from '../auth.ts';
import { canSeeClient, scopeSql } from '../scope.ts';

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Color = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6})?$/, 'Kolor w formacie #RRGGBB.')
  .default('');
const Name = z.string().trim().min(1, 'Nazwa jest wymagana.').max(100);
const ClientBody = z.object({ name: Name, notes: z.string().max(2000).default(''), color: Color });
const ClientPatch = z.object({ name: Name.optional(), notes: z.string().max(2000).optional(), color: Color.optional() });
const SiteBody = z.object({ name: Name });
const TagBody = z.object({ name: Name.max(40), color: Color });
const TagPatch = z.object({ name: Name.max(40).optional(), color: Color.optional() });

/** Unikalność nazw (COLLATE NOCASE) — zamieniamy błąd SQLite na czytelny komunikat. */
function uniqueGuard<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) throw new HttpError(409, 'name_taken', message);
    throw err;
  }
}

export async function clientRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx;
  const view = { preHandler: requireUser(ctx, 'agents.view') };
  // po udanej zmianie klientów/lokalizacji/tagów panele przeładowują słowniki
  const manage = {
    preHandler: requireUser(ctx, 'clients.manage'),
    onResponse: async (_req: unknown, reply: { statusCode: number }) => {
      if (reply.statusCode < 400) hub.broadcastAll({ type: 'org_changed' });
    },
  };

  /** Po zmianie nazw/kolorów odśwież komputery w panelach. */
  const rebroadcast = (where: string, param: number) => {
    const ids = db.prepare(`SELECT id FROM agents WHERE ${where}`).all(param) as { id: string }[];
    for (const { id } of ids) hub.broadcastAgent(id, { type: 'agent_updated', id, data: hub.summary(id) });
  };

  const assertClientVisible = (scope: Parameters<typeof canSeeClient>[0], id: number) => {
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id) || !canSeeClient(scope, id)) throw notFound();
  };

  // ---------- klienci ----------

  app.get('/api/clients', view, async (req) => {
    const where = scopeSql(req.user!, 'c.id');
    const clients = db
      .prepare(
        `SELECT c.id, c.name, c.notes, c.color, c.created_at AS createdAt,
                (SELECT COUNT(*) FROM agents a WHERE a.client_id = c.id) AS agentCount
         FROM clients c WHERE ${where.sql} ORDER BY c.name`,
      )
      .all(...where.params) as { id: number }[];
    const sites = db
      .prepare('SELECT s.id, s.client_id AS clientId, s.name, (SELECT COUNT(*) FROM agents a WHERE a.site_id = s.id) AS agentCount FROM sites s ORDER BY s.name')
      .all() as { clientId: number }[];
    return clients.map((c) => ({ ...c, sites: sites.filter((s) => s.clientId === c.id) }));
  });

  app.post('/api/clients', manage, async (req) => {
    requireGlobal(req);
    const body = parse(ClientBody, req.body);
    const res = uniqueGuard(
      () => db.prepare('INSERT INTO clients (name, notes, color, created_at) VALUES (?, ?, ?, ?)').run(body.name, body.notes, body.color, Date.now()),
      'Klient o tej nazwie już istnieje.',
    );
    audit(db, actorOf(req), 'client.create', body.name, null, req.ip);
    return { id: Number(res.lastInsertRowid) };
  });

  app.patch('/api/clients/:id', manage, async (req) => {
    const { id } = parse(IdParams, req.params);
    assertClientVisible(req.user!, id);
    const body = parse(ClientPatch, req.body);
    const cur = db.prepare('SELECT name, notes, color FROM clients WHERE id = ?').get(id) as { name: string; notes: string; color: string };
    uniqueGuard(
      () => db.prepare('UPDATE clients SET name = ?, notes = ?, color = ? WHERE id = ?').run(body.name ?? cur.name, body.notes ?? cur.notes, body.color ?? cur.color, id),
      'Klient o tej nazwie już istnieje.',
    );
    audit(db, actorOf(req), 'client.update', cur.name, body, req.ip);
    rebroadcast('client_id = ?', id);
    return { ok: true };
  });

  app.delete('/api/clients/:id', manage, async (req) => {
    requireGlobal(req);
    const { id } = parse(IdParams, req.params);
    const cur = db.prepare('SELECT name FROM clients WHERE id = ?').get(id) as { name: string } | undefined;
    if (!cur) throw notFound();
    const affected = db.prepare('SELECT id FROM agents WHERE client_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM clients WHERE id = ?').run(id); // komputery -> bez klienta, lokalizacje kaskadowo
    audit(db, actorOf(req), 'client.delete', cur.name, { agents: affected.length }, req.ip);
    for (const { id: a } of affected) hub.broadcastAgent(a, { type: 'agent_updated', id: a, data: hub.summary(a) });
    return { ok: true };
  });

  // ---------- lokalizacje ----------

  app.post('/api/clients/:id/sites', manage, async (req) => {
    const { id } = parse(IdParams, req.params);
    assertClientVisible(req.user!, id);
    const { name } = parse(SiteBody, req.body);
    const res = uniqueGuard(
      () => db.prepare('INSERT INTO sites (client_id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now()),
      'Ta lokalizacja już istnieje u tego klienta.',
    );
    audit(db, actorOf(req), 'site.create', name, { clientId: id }, req.ip);
    return { id: Number(res.lastInsertRowid) };
  });

  const siteOf = (scope: Parameters<typeof canSeeClient>[0], id: number) => {
    const s = db.prepare('SELECT id, client_id, name FROM sites WHERE id = ?').get(id) as { id: number; client_id: number; name: string } | undefined;
    if (!s || !canSeeClient(scope, s.client_id)) throw notFound();
    return s;
  };

  app.patch('/api/sites/:id', manage, async (req) => {
    const { id } = parse(IdParams, req.params);
    const site = siteOf(req.user!, id);
    const { name } = parse(SiteBody, req.body);
    uniqueGuard(() => db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(name, id), 'Ta lokalizacja już istnieje u tego klienta.');
    audit(db, actorOf(req), 'site.update', site.name, { name }, req.ip);
    rebroadcast('site_id = ?', id);
    return { ok: true };
  });

  app.delete('/api/sites/:id', manage, async (req) => {
    const { id } = parse(IdParams, req.params);
    const site = siteOf(req.user!, id);
    const affected = db.prepare('SELECT id FROM agents WHERE site_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    audit(db, actorOf(req), 'site.delete', site.name, { agents: affected.length }, req.ip);
    for (const { id: a } of affected) hub.broadcastAgent(a, { type: 'agent_updated', id: a, data: hub.summary(a) });
    return { ok: true };
  });

  // ---------- tagi (globalne) ----------

  app.get('/api/tags', view, async () =>
    db.prepare('SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM agent_tags x WHERE x.tag_id = t.id) AS agentCount FROM tags t ORDER BY t.name').all(),
  );

  app.post('/api/tags', manage, async (req) => {
    requireGlobal(req);
    const body = parse(TagBody, req.body);
    const res = uniqueGuard(
      () => db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)').run(body.name, body.color, Date.now()),
      'Taki tag już istnieje.',
    );
    audit(db, actorOf(req), 'tag.create', body.name, null, req.ip);
    return { id: Number(res.lastInsertRowid) };
  });

  app.patch('/api/tags/:id', manage, async (req) => {
    requireGlobal(req);
    const { id } = parse(IdParams, req.params);
    const cur = db.prepare('SELECT name, color FROM tags WHERE id = ?').get(id) as { name: string; color: string } | undefined;
    if (!cur) throw notFound();
    const body = parse(TagPatch, req.body);
    uniqueGuard(() => db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(body.name ?? cur.name, body.color ?? cur.color, id), 'Taki tag już istnieje.');
    audit(db, actorOf(req), 'tag.update', cur.name, body, req.ip);
    rebroadcast('id IN (SELECT agent_id FROM agent_tags WHERE tag_id = ?)', id);
    return { ok: true };
  });

  app.delete('/api/tags/:id', manage, async (req) => {
    requireGlobal(req);
    const { id } = parse(IdParams, req.params);
    const cur = db.prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string } | undefined;
    if (!cur) throw notFound();
    const affected = db.prepare('SELECT agent_id AS id FROM agent_tags WHERE tag_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    audit(db, actorOf(req), 'tag.delete', cur.name, null, req.ip);
    for (const { id: a } of affected) hub.broadcastAgent(a, { type: 'agent_updated', id: a, data: hub.summary(a) });
    return { ok: true };
  });
}
